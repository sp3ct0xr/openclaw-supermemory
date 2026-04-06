import type { AgentMessage } from "openclaw/plugin-sdk"
import { encodingForModel, type TiktokenModel } from "js-tiktoken"

/** Fallback heuristic when tiktoken is unavailable. */
const CHARS_PER_TOKEN = 4

/** Cached encoder instance (lazy-loaded). */
let cachedEncoder: ReturnType<typeof encodingForModel> | null = null
let cachedModelFamily: string | null = null

/** Map model ID to tiktoken model name. */
function resolveModelFamily(model?: string): TiktokenModel {
	if (!model) return "gpt-4o"
	const lower = model.toLowerCase()
	if (lower.includes("claude")) return "gpt-4o" // cl100k_base compatible
	if (lower.includes("gpt-4")) return "gpt-4o"
	if (lower.includes("gpt-3.5")) return "gpt-3.5-turbo"
	if (lower.includes("gpt-5")) return "gpt-4o"
	return "gpt-4o" // cl100k_base as default
}

/** Get or create a tiktoken encoder for the model family. */
function getEncoder(model?: string): ReturnType<typeof encodingForModel> | null {
	const family = resolveModelFamily(model)
	if (cachedEncoder && cachedModelFamily === family) return cachedEncoder
	try {
		// Free previous encoder to avoid WASM memory leak on model family switch
		if (cachedEncoder) {
			// biome-ignore lint/suspicious/noExplicitAny: js-tiktoken free() not in types but exists at runtime
			try { (cachedEncoder as any).free?.() } catch { /* best-effort */ }
		}
		cachedEncoder = encodingForModel(family)
		cachedModelFamily = family
		return cachedEncoder
	} catch {
		// tiktoken failed to load — fall back to heuristic
		cachedEncoder = null
		cachedModelFamily = null
		return null
	}
}

/** Role overhead tokens per message (model-family aware). */
function roleOverhead(model?: string): number {
	if (model?.toLowerCase().includes("claude")) return 3 // Anthropic
	return 4 // OpenAI default
}

export function estimateTokens(text: string, model?: string): number {
	const encoder = getEncoder(model)
	if (encoder) {
		try {
			return encoder.encode(text).length
		} catch {
			// Encoding failed — fall back
		}
	}
	return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Extract text content from an AgentMessage. */
function messageText(msg: AgentMessage): string {
	if (typeof msg.content === "string") return msg.content
	if (Array.isArray(msg.content)) {
		const parts: string[] = []
		for (const block of msg.content) {
			if (block.type === "text" && typeof block.text === "string") {
				parts.push(block.text)
			}
		}
		return parts.join("\n")
	}
	return ""
}

export function estimateMessagesTokens(messages: AgentMessage[], model?: string): number {
	const overhead = roleOverhead(model)
	let total = 0
	for (const msg of messages) {
		total += overhead
		total += estimateTokens(messageText(msg), model)
	}
	return total
}
