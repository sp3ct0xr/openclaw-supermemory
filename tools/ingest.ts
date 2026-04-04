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
				"Ingest content into long-term memory. Accepts URLs (web pages, PDFs, YouTube), raw text, markdown, HTML, or base64-encoded files. Supermemory auto-detects the content type and extracts memories.",
			parameters: Type.Object({
				content: Type.String({
					description:
						"URL (web page, PDF, YouTube video, hosted image) or raw text/markdown/HTML to ingest. Supermemory auto-detects format.",
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

				log.debug(
					`ingest tool: ${isUrl ? "URL" : "text"} (${params.content.length} chars) customId="${params.customId ?? "none"}" containerTag="${tag ?? "default"}"`,
				)

				const result = await client.addMemory(
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

				const preview = isUrl
					? params.content
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
