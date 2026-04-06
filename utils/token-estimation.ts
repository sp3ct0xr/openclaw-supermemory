import type { AgentMessage } from "openclaw/plugin-sdk"

/** Heuristic: ~4 characters per token. Good enough for budget allocation.
 *  Phase 3 replaces this with tiktoken for model-aware counting. */
const CHARS_PER_TOKEN = 4

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Extract text content from an AgentMessage for token estimation. */
function messageTextLength(msg: AgentMessage): number {
	if (typeof msg.content === "string") return msg.content.length
	if (Array.isArray(msg.content)) {
		let len = 0
		for (const block of msg.content) {
			if (block.type === "text" && typeof block.text === "string") {
				len += block.text.length
			}
		}
		return len
	}
	return 0
}

export function estimateMessagesTokens(messages: AgentMessage[]): number {
	let total = 0
	for (const msg of messages) {
		// Role overhead: ~4 tokens per message for role/separator
		total += 4
		total += Math.ceil(messageTextLength(msg) / CHARS_PER_TOKEN)
	}
	return total
}
