import type { SupermemoryClient } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { log } from "../logger.ts"
import { buildTurnDocumentId, stripInboundMetadata } from "../memory.ts"

const SKIPPED_PROVIDERS = ["exec-event", "cron-event", "heartbeat"]

function extractTextsFromMessages(
	messages: unknown[],
	captureMode: string,
): string[] {
	const texts: string[] = []
	for (const msg of messages) {
		if (!msg || typeof msg !== "object") continue
		const msgObj = msg as Record<string, unknown>
		const role = msgObj.role
		if (role !== "user" && role !== "assistant") continue

		const content = msgObj.content
		const parts: string[] = []

		if (typeof content === "string") {
			parts.push(content)
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (!block || typeof block !== "object") continue
				const b = block as Record<string, unknown>
				if (b.type === "text" && typeof b.text === "string") {
					parts.push(b.text)
				}
			}
		}

		if (parts.length > 0) {
			const cleaned =
				role === "user"
					? parts.map(stripInboundMetadata).join("\n")
					: parts.join("\n")
			texts.push(`[role: ${role}]\n${cleaned}\n[${role}:end]`)
		}
	}

	if (captureMode === "all") {
		return texts
			.map((t) =>
				t
					.replace(
						/<supermemory-context>[\s\S]*?<\/supermemory-context>\s*/g,
						"",
					)
					.replace(
						/<supermemory-containers>[\s\S]*?<\/supermemory-containers>\s*/g,
						"",
					)
					.trim(),
			)
			.filter((t) => t.length >= 10)
	}

	return texts
}

export type SessionBuffer = {
	addTurn(messages: unknown[]): void
	flush(): Promise<{ success: number; failed: number }>
	pending(): number
}

export function buildSessionBuffer(
	client: SupermemoryClient,
	cfg: SupermemoryConfig,
	getSessionKey: () => string | undefined,
): SessionBuffer {
	const bufferedTurns: string[][] = []

	return {
		addTurn(messages: unknown[]) {
			const texts = extractTextsFromMessages(messages, cfg.captureMode)
			if (texts.length > 0) {
				bufferedTurns.push(texts)
				log.debug(
					`buffer: added turn ${bufferedTurns.length} (${texts.length} messages)`,
				)
			}
		},

		async flush() {
			if (bufferedTurns.length === 0) {
				log.debug("buffer: nothing to flush")
				return { success: 0, failed: 0 }
			}

			const sk = getSessionKey()
			const now = new Date().toISOString()

			// Build one document per buffered turn with unique IDs
			const documents = bufferedTurns.map((texts, idx) => ({
				content: texts.join("\n\n"),
				metadata: {
					source: "openclaw" as const,
					timestamp: now,
					turnIndex: idx,
				},
				customId: sk ? buildTurnDocumentId(sk, idx) : undefined,
				entityContext: cfg.entityContext,
			}))

			const totalChars = documents.reduce(
				(sum, d) => sum + d.content.length,
				0,
			)
			log.info(
				`buffer: flushing ${documents.length} turns (${totalChars} chars) for session ${sk ?? "unknown"}`,
			)

			try {
				const result = await client.batchAddMemories(documents)
				bufferedTurns.length = 0 // clear after successful flush
				log.info(
					`buffer: flushed ${result.success} ok, ${result.failed} failed`,
				)
				return result
			} catch (err) {
				log.error("buffer: flush failed", err)
				return { success: 0, failed: bufferedTurns.length }
			}
		},

		pending() {
			return bufferedTurns.length
		},
	}
}

export function buildCaptureHandler(
	client: SupermemoryClient,
	cfg: SupermemoryConfig,
	getSessionKey: () => string | undefined,
	buffer: SessionBuffer,
) {
	return async (
		event: Record<string, unknown>,
		ctx: Record<string, unknown>,
	) => {
		log.info(
			`agent_end fired: provider="${ctx.messageProvider}" success=${event.success}`,
		)
		const provider = ctx.messageProvider as string
		if (SKIPPED_PROVIDERS.includes(provider)) {
			return
		}

		if (
			!event.success ||
			!Array.isArray(event.messages) ||
			event.messages.length === 0
		)
			return

		// Buffer the full conversation, not just the last turn
		buffer.addTurn(event.messages)
	}
}
