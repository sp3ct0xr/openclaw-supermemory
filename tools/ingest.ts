import fs from "node:fs"
import path from "node:path"
import { Type } from "@sinclair/typebox"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { SupermemoryClient } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { deriveFileType, isTextMime, lookupMime } from "../mime-utils.ts"
import { log } from "../logger.ts"

// ---------- local-file helpers ----------

/** Fallback set for dotfiles/config files that mime-types returns false for. */
const TEXT_FALLBACK_EXTENSIONS = new Set([
	".env", ".cfg", ".conf", ".log", ".ini", ".rst",
	".toml", ".editorconfig", ".gitignore", ".dockerignore",
])

/**
 * Classify a file as text or binary using mime-types, fallback sets, and null-byte peek.
 * Returns { isText: true } or { isText: false, detectedMime: string }.
 */
function classifyFile(filePath: string): { isText: true } | { isText: false; detectedMime: string } {
	const ext = path.extname(filePath).toLowerCase()
	const detected = lookupMime(filePath)

	if (detected) {
		if (isTextMime(detected)) return { isText: true }
		return { isText: false, detectedMime: detected }
	}

	// mime-types returned false — use fallback.
	// path.extname(".env") returns "" for dotfiles without a second dot,
	// so also check the full basename for dotfile names.
	const basename = path.basename(filePath).toLowerCase()
	if (TEXT_FALLBACK_EXTENSIONS.has(ext) || TEXT_FALLBACK_EXTENSIONS.has(basename)) return { isText: true }

	// Unknown extension: peek first 8KB for null bytes
	let fd: number | undefined
	try {
		fd = fs.openSync(filePath, "r")
		const buf = Buffer.alloc(8192)
		const bytesRead = fs.readSync(fd, buf, 0, 8192, 0)
		for (let i = 0; i < bytesRead; i++) {
			if (buf[i] === 0) return { isText: false, detectedMime: "application/octet-stream" }
		}
		return { isText: true }
	} catch {
		// Can't safely inspect file contents; treat as binary so callers
		// don't retry the same failing read via the text path.
		return { isText: false, detectedMime: "application/octet-stream" }
	} finally {
		if (fd !== undefined) fs.closeSync(fd)
	}
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
	// Resolve workspace boundary at registration time for file path security.
	// Only files inside the agent's workspace can be read from disk.
	// Uses SDK's api.runtime.agent.resolveAgentWorkspaceDir() when available.
	let workspaceDir: string | undefined
	try {
		const cfg_ = (api as any).config ?? api.pluginConfig
		const runtime = (api as any).runtime
		const agentId: string | undefined =
			runtime?.agentId ??
			runtime?.agent?.resolveDefaultAgentId?.(cfg_)
		if (cfg_ && agentId) {
			const raw = runtime?.agent?.resolveAgentWorkspaceDir?.(cfg_, agentId)
			workspaceDir = raw ? fs.realpathSync(raw) : undefined
		}
	} catch {
		// runtime may not be available in all registration modes
	}

	function isInsideWorkspace(filePath: string): boolean {
		if (!workspaceDir) {
			log.warn("supermemory_ingest: workspace boundary not resolved — denying file read (fail-closed)")
			return false
		}
		try {
			const resolved = fs.realpathSync(filePath)
			if (resolved === workspaceDir) return true
			const rel = path.relative(workspaceDir, resolved)
			// Must not escape via ".." and must not be an absolute path
			return !rel.startsWith("..") && !path.isAbsolute(rel)
		} catch {
			return false // can't resolve (e.g. broken symlink) = reject
		}
	}

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
							log.warn(`supermemory_ingest: path outside workspace boundary${workspaceDir ? ` (${workspaceDir})` : ""}, skipping file read: ${resolved}`)
							// fall through to treat as plain text
						} else {
							localFilePath = resolved
							const classification = classifyFile(resolved)

							if (!classification.isText) {
								// Binary file → route through uploadFile() (proper SM binary endpoint)
								const detectedMime = classification.detectedMime
								const fileType = deriveFileType(detectedMime)
								const fileSize = fs.statSync(resolved).size

								log.debug(`ingest: uploading binary file ${resolved} (${fileSize} bytes, ${detectedMime}, fileType=${fileType ?? "auto"})`)

								const uploadResult = await client.uploadFile(resolved, {
									...(fileType && { fileType }),
									...(detectedMime && { mimeType: detectedMime }),
									metadata: {
										source: "openclaw_ingest",
										documentDate: new Date().toISOString(),
										sourceFile: resolved,
										// uploadFile API has no customId param; encode in metadata for traceability
										...(params.customId && { customId: params.customId }),
										...params.metadata,
									},
									containerTag: tag,
								})

								const sizeLabel = fileSize > 1024 ? `${(fileSize / 1024).toFixed(0)}KB` : `${fileSize} bytes`

								return {
									content: [
										{
											type: "text" as const,
											text: `Uploaded: 📁 ${path.basename(resolved)} (${sizeLabel}, ${detectedMime})\nDocument ID: ${uploadResult.id}, Status: ${uploadResult.status}`,
										},
									],
									details: {
										id: uploadResult.id,
										status: uploadResult.status,
										localFile: resolved,
										detectedMime,
										fileType,
									},
								}
							}

							// Text file → read as UTF-8
							content = fs.readFileSync(resolved, "utf-8")
							log.debug(`ingest: read text file ${resolved} (${content.length} chars)`)
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
					// Agent-provided base64: use addRawContent() to bypass sanitizeContent
					// which would truncate at 100k chars and corrupt the payload.
					// NOTE: For local binary files we use uploadFile() above instead.
					// Extract contentType from data URI prefix if present (e.g. "data:image/png;base64,...")
					const dataUriMatch = content.match(/^data:([^;,]+)/)
					const detectedContentType = dataUriMatch?.[1] ?? undefined

					result = await client.addRawContent({
						content,
						...(detectedContentType && { contentType: detectedContentType }),
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
					? `📁 ${path.basename(localFilePath)} (text, ${content.length > 1024 ? `${(content.length / 1024).toFixed(0)}KB` : `${content.length} chars`})`
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
