import { Type } from "@sinclair/typebox"
import * as fs from "node:fs"
import * as path from "node:path"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { SupermemoryClient } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { log } from "../logger.ts"

// ---------- workspace boundary ----------

const WORKSPACE_DIR = '/data/.openclaw/workspace'

function isInsideWorkspace(filePath: string): boolean {
	const resolved = fs.realpathSync(filePath)
	return resolved.startsWith(WORKSPACE_DIR + '/') || resolved === WORKSPACE_DIR
}

// ---------- local-file helpers ----------

const TEXT_EXTENSIONS = new Set([
	".md", ".txt", ".json", ".csv", ".html", ".xml",
	".yaml", ".yml", ".ts", ".js", ".py", ".sh",
	".jsx", ".tsx", ".css", ".scss", ".sql", ".toml",
	".ini", ".cfg", ".conf", ".log", ".env", ".rst",
])

const BINARY_EXTENSIONS: Record<string, string> = {
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".mp4": "video/mp4",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".zip": "application/zip",
	".tar": "application/x-tar",
	".gz": "application/gzip",
}

/**
 * Heuristic: content looks like a local file path (not multi-line text/markdown).
 * Must start with `/`, `./`, `../`, or `~/`, contain no newlines, and be
 * reasonably short (under 1024 chars — paths longer than that are almost
 * certainly content, not a file path).
 */
function looksLikeLocalPath(content: string): boolean {
	const trimmed = content.trim()
	if (trimmed.length > 1024) return false
	if (trimmed.includes("\n")) return false
	return /^(\/|\.\/|\.\.\/|~\/)/.test(trimmed)
}

function resolvePath(p: string): string {
	const trimmed = p.trim()
	if (trimmed.startsWith("~/")) {
		return path.join(process.env.HOME ?? "/root", trimmed.slice(2))
	}
	return path.resolve(trimmed)
}

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
				let content = params.content
				let localFilePath: string | undefined

				// --- Local file auto-read ---
				if (looksLikeLocalPath(content)) {
					const resolved = resolvePath(content)
					if (fs.existsSync(resolved)) {
						if (!isInsideWorkspace(resolved)) {
							log.warn(`supermemory_ingest: path outside workspace, skipping file read: ${resolved}`)
							// fall through to treat as plain text
						} else {
						localFilePath = resolved
						const ext = path.extname(resolved).toLowerCase()
						const mime = BINARY_EXTENSIONS[ext]

						if (mime) {
							// Binary file → base64-encode
							const buf = fs.readFileSync(resolved)
							content = `data:${mime};base64,${buf.toString("base64")}`
							log.debug(`ingest: read binary file ${resolved} (${buf.length} bytes, ${mime})`)
						} else {
							// Text file (known text ext OR unknown ext → default to text)
							content = fs.readFileSync(resolved, "utf-8")
							log.debug(`ingest: read text file ${resolved} (${content.length} chars)`)
						}
						}
					} else {
						log.debug(`ingest: path-like content but file not found: ${resolved}`)
					}
				}

				const isUrl = /^https?:\/\//.test(content.trim())
				// Detect base64: starts with data URI or looks like base64 blob
				const isBase64 =
					content.startsWith("data:") ||
					(/^[A-Za-z0-9+/]{100,}={0,2}$/.test(
						content.trim().slice(0, 200),
					) &&
						content.length > 1000)

				const contentType = localFilePath
					? `local-file (${path.basename(localFilePath)})`
					: isUrl
						? "URL"
						: isBase64
							? "base64"
							: "text"

				log.debug(
					`ingest tool: ${contentType} (${content.length} chars) customId="${params.customId ?? "none"}" containerTag="${tag ?? "default"}"`,
				)

				let result: { id: string }

				if (isBase64) {
					// Base64 content: use addRawContent() to bypass sanitizeContent
					// which would truncate at 100k chars and corrupt the payload
					result = await client.addRawContent({
						content,
						containerTag: tag,
						customId: params.customId,
						entityContext: cfg.entityContext,
						metadata: {
							source: "openclaw_ingest",
							documentDate: new Date().toISOString(),
							...(localFilePath && { sourceFile: localFilePath }),
							...params.metadata,
						},
					})
				} else {
					// URL or text: use addMemory() which sanitizes content
					result = await client.addMemory(
						content,
						{
							source: "openclaw_ingest",
							documentDate: new Date().toISOString(),
							...(isUrl && { contentUrl: content }),
							...(localFilePath && { sourceFile: localFilePath }),
							...params.metadata,
						},
						params.customId,
						tag,
						cfg.entityContext,
					)
				}

				const preview = localFilePath
					? `📁 ${path.basename(localFilePath)} (${isBase64 ? "binary" : "text"}, ${content.length > 1024 ? `${(content.length / 1024).toFixed(0)}KB` : `${content.length} chars`})`
					: isUrl
						? content
						: isBase64
							? `[base64 ${(content.length / 1024).toFixed(0)}KB]`
							: content.length > 80
								? `${content.slice(0, 80)}…`
								: content

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
						...(localFilePath && { localFile: localFilePath }),
					},
				}
			},
		},
		{ name: "supermemory_ingest" },
	)
}
