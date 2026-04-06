import mime from "mime-types"

/** Known text application MIME types that should be read as UTF-8, not binary. */
const TEXT_APPLICATION_MIMES = new Set([
	"application/json",
	"application/xml",
	"application/yaml",
	"application/x-yaml",
	"application/toml",
	"application/x-sh",
	"application/javascript",
	"application/typescript",
	"application/sql",
	"application/graphql",
	"application/ld+json",
	"application/xhtml+xml",
	"application/x-httpd-php",
])

/** Derive Supermemory SDK fileType from a MIME string (e.g. "image/png" → "image"). */
export function deriveFileType(mimeStr: string): string | undefined {
	if (mimeStr === "application/pdf") return "pdf"
	const category = mimeStr.split("/")[0]
	return ["image", "video", "audio"].includes(category) ? category : undefined
}

/** Check if a MIME type represents text content (safe to read as UTF-8). */
export function isTextMime(mimeStr: string): boolean {
	if (mimeStr.startsWith("text/")) return true
	return TEXT_APPLICATION_MIMES.has(mimeStr)
}

/** Lookup MIME type from file path. Returns the MIME string or undefined. */
export function lookupMime(filePath: string): string | undefined {
	return mime.lookup(filePath) || undefined
}
