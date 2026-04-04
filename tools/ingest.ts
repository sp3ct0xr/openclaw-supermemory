import { Type } from "@sinclair/typebox"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { SupermemoryClient } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { log } from "../logger.ts"

export function registerIngestTool(
	api: OpenClawPluginApi,
	client: SupermemoryClient,
	cfg: SupermemoryConfig,
): void {
	api.registerTool(
		{
			name: "supermemory_ingest",
			label: "Memory Ingest",
			description:
				"Ingest content into long-term memory. Accepts URLs (web pages, PDFs, YouTube, hosted images), raw text/markdown/HTML, or base64-encoded files (PDF, images, audio, video). Supermemory auto-detects the content type.",
			parameters: Type.Object({
				content: Type.String({
					description:
						"URL, raw text/markdown/HTML, or base64-encoded binary (PDF, image, audio, video). URLs are fetched server-side. Text is clamped at ~100k chars. Base64 is sent raw (up to 50MB).",
				}),
				customId: Type.Optional(
					Type.String({
						description:
							"Your ID for this content (e.g. doc_123, url slug). Same customId = same document — only new/changed content is re-processed. Prevents duplicates on re-ingestion.",
					}),
				),
				containerTag: Type.Optional(
					Type.String({
						description: "Container tag to scope this document",
					}),
				),
				metadata: Type.Optional(
					Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]), {
						description:
							"Key-value metadata for filtering (e.g. { source: 'firecrawl', type: 'docs' })",
					}),
				),
			}),
			async execute(
				_toolCallId: string,
				params: {
					content: string
					customId?: string
					containerTag?: string
					metadata?: Record<string, string | number | boolean>
				},
			) {
				const tag = params.containerTag ?? undefined
				const isUrl = /^https?:\/\//.test(params.content.trim())
				// Detect base64: starts with data URI or looks like base64 blob
				const isBase64 =
					params.content.startsWith("data:") ||
					(/^[A-Za-z0-9+/]{100,}={0,2}$/.test(
						params.content.trim().slice(0, 200),
					) &&
						params.content.length > 1000)

				const contentType = isUrl
					? "URL"
					: isBase64
						? "base64"
						: "text"

				log.debug(
					`ingest tool: ${contentType} (${params.content.length} chars) customId="${params.customId ?? "none"}" containerTag="${tag ?? "default"}"`,
				)

				let result: { id: string }

				if (isBase64) {
					// Base64 content: use raw client.add() to bypass sanitizeContent
					// which would truncate at 100k chars and corrupt the payload
					result = await (client as any).client.add({
						content: params.content,
						...(tag && { containerTag: tag }),
						...(params.customId && { customId: params.customId }),
						...(cfg.entityContext && { entityContext: cfg.entityContext }),
						metadata: {
							source: "openclaw_ingest",
							documentDate: new Date().toISOString(),
							...params.metadata,
						},
					})
				} else {
					// URL or text: use addMemory() which sanitizes content
					result = await client.addMemory(
						params.content,
						{
							source: "openclaw_ingest",
							documentDate: new Date().toISOString(),
							...(isUrl && { contentUrl: params.content }),
							...params.metadata,
						},
						params.customId,
						tag,
						cfg.entityContext,
					)
				}

				const preview = isUrl
					? params.content
					: isBase64
						? `[base64 ${(params.content.length / 1024).toFixed(0)}KB]`
						: params.content.length > 80
							? `${params.content.slice(0, 80)}…`
							: params.content

				return {
					content: [
						{
							type: "text" as const,
							text: `Ingested: ${preview}\nDocument ID: ${result.id}${params.customId ? `\nCustom ID: ${params.customId}` : ""}`,
						},
					],
					details: {
						id: result.id,
						customId: params.customId,
						isUrl,
					},
				}
			},
		},
		{ name: "supermemory_ingest" },
	)
}
