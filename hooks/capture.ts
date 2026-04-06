import type { SupermemoryClient } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { log } from "../logger.ts"
import { buildTurnDocumentId, stripInboundMetadata } from "../memory.ts"

const SKIPPED_PROVIDERS = ["exec-event", "cron-event", "heartbeat"]

const MAX_BUFFER_SIZE = 50
const MAX_RETRY_COUNT = 3

function extractTextsFromMessages(
	messages: unknown[],
	captureMode: string,
	startIndex = 0,
): string[] {
	const texts: string[] = []
	for (let i = startIndex; i < messages.length; i++) {
		const msg = messages[i]
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

type BufferedTurn = {
	texts: string[]
	timestamp: string
	retryCount: number
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
	const bufferedTurns: BufferedTurn[] = []
	let lastBufferedIndex = 0
	let flushInProgress = false

	return {
		addTurn(messages: unknown[]) {
			// Defensive reset: if messages array is shorter than our bookmark,
			// a new session or context has started — reset to avoid skipping.
			if (messages.length < lastBufferedIndex) {
				log.debug(
					`buffer: messages.length (${messages.length}) < lastBufferedIndex (${lastBufferedIndex}), resetting bookmark`,
				)
				lastBufferedIndex = 0
			}

			const texts = extractTextsFromMessages(
				messages,
				cfg.captureMode,
				lastBufferedIndex,
			)
			if (texts.length > 0) {
				bufferedTurns.push({
					texts,
					timestamp: new Date().toISOString(),
					retryCount: 0,
				})
				log.debug(
					`buffer: added turn ${bufferedTurns.length} (${texts.length} messages)`,
				)
			}
			// Track the last buffered index to avoid re-processing
			lastBufferedIndex = messages.length

			// If buffer exceeds cap, flush immediately
			if (bufferedTurns.length >= MAX_BUFFER_SIZE) {
				log.warn(
					`buffer: exceeded MAX_BUFFER_SIZE (${MAX_BUFFER_SIZE}), triggering immediate flush`,
				)
				// Fire-and-forget flush to avoid blocking the event handler
				this.flush().catch((err) =>
					log.error("buffer: emergency flush failed", err),
				)
			}
		},

		async flush() {
			if (bufferedTurns.length === 0) {
				log.debug("buffer: nothing to flush")
				return { success: 0, failed: 0 }
			}

			// Concurrency guard: if a flush is already in-flight, skip to
			// avoid double-sending the same turns.
			if (flushInProgress) {
				log.debug("buffer: flush already in progress, skipping")
				return { success: 0, failed: 0 }
			}

			flushInProgress = true

			// Atomically drain the buffer before the async call so concurrent
			// addTurn() calls append to a fresh array instead of the one we're
			// about to send.
			const batch = bufferedTurns.splice(0, bufferedTurns.length)

			const sk = getSessionKey()

			// Build one document per buffered turn with unique IDs
			const documents = batch.map((turn, idx) => ({
				content: turn.texts.join("\n\n"),
				metadata: {
					source: "openclaw" as const,
					documentDate: turn.timestamp,
					timestamp: turn.timestamp,
					turnIndex: idx,
				},
				customId: sk
					? buildTurnDocumentId(sk, idx)
					: `anon_${Date.now()}_${crypto.randomUUID().slice(0, 8)}_t${idx}`,
			}))

			const totalChars = documents.reduce(
				(sum, d) => sum + d.content.length,
				0,
			)
			log.info(
				`buffer: flushing ${documents.length} turns (${totalChars} chars) for session ${sk ?? "unknown"}`,
			)

			try {
				// Use single-add path when entityContext is configured,
				// since batchAdd (SDK v4.21.1) does not support entityContext.
				// This ensures server-side atomic fact extraction uses our
				// enhanced extraction prompt from Phase 3.
				const useEntityContext =
					cfg.entityContext && cfg.entityContext.length > 0

				let result: { success: number; failed: number }

				if (useEntityContext && documents.length <= 10) {
					// Single-add fallback: slower but supports entityContext
					log.debug(
						`buffer: using single-add path for ${documents.length} docs (entityContext enabled)`,
					)
					let success = 0
					let failed = 0
					for (const doc of documents) {
						try {
							await client.addMemory(
								doc.content,
								doc.metadata,
								doc.customId,
								undefined,
								cfg.entityContext,
							)
							success++
						} catch (docErr) {
							log.warn("buffer: single-add failed for turn", docErr)
							failed++
						}
					}
					result = { success, failed }
				} else {
					// Batch path: faster, no entityContext support
					result = await client.batchAddMemories(documents)
				}

				log.info(
					`buffer: flushed ${result.success} ok, ${result.failed} failed`,
				)
				return result
			} catch (err) {
				log.error("buffer: flush failed", err)

				// Increment retry counts, push survivors back into the
				// live buffer so the next flush retries them.
				for (const turn of batch) {
					turn.retryCount++
					if (turn.retryCount >= MAX_RETRY_COUNT) {
						log.warn(
							`buffer: dropping turn after ${MAX_RETRY_COUNT} failed retries (${turn.texts.length} messages, timestamp: ${turn.timestamp})`,
						)
					} else {
						bufferedTurns.push(turn)
					}
				}

				return { success: 0, failed: documents.length }
			} finally {
				flushInProgress = false
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

		// Buffer only new messages since last buffered index
		buffer.addTurn(event.messages)
	}
}
