import type { AgentMessage, CompactResult, ContextEngineRuntimeContext } from "openclaw/plugin-sdk"
import { delegateCompactionToRuntime } from "openclaw/plugin-sdk"
import type { SupermemoryConfig } from "../config.ts"
import { log } from "../logger.ts"
import { IngestionTracker } from "../utils/ingestion-tracker.ts"
import { estimateMessagesTokens } from "../utils/token-estimation.ts"

/**
 * Build the compact() handler for the context engine.
 *
 * ownsCompaction: true — we control /compact, overflow recovery, and
 * proactive compaction. SM has all facts via ingestBatch, so we can
 * trim older messages safely.
 *
 * Only messages confirmed "ingested" by SM are safe to trim.
 * Messages "buffered" or "pending" are kept.
 *
 * On failure: delegates to runtime's legacy compaction (lossy but safe).
 */
export function buildCompactHandler(
	cfg: SupermemoryConfig,
	tracker: IngestionTracker,
	trimOffset: { value: number },
) {
	return async (params: {
		sessionId: string
		sessionKey?: string
		sessionFile: string
		tokenBudget?: number
		force?: boolean
		currentTokenCount?: number
		compactionTarget?: "budget" | "threshold"
		customInstructions?: string
		runtimeContext?: ContextEngineRuntimeContext
	}): Promise<CompactResult> => {
		try {
			// Access messages from runtimeContext if available
			// The runtime passes messages in runtimeContext for plugin compaction
			const messages = ((params.runtimeContext as Record<string, unknown>)?.messages ?? []) as AgentMessage[]

			if (messages.length === 0) {
				// No messages available — delegate to runtime
				log.debug("CE compact: no messages in runtimeContext, delegating to runtime")
				return await delegateCompactionToRuntime(params)
			}

			const tokensBefore = params.currentTokenCount ?? estimateMessagesTokens(messages)
			const keepLast = cfg.compactKeepLast

			// Don't compact if we're under budget and not forced
			if (!params.force && tokensBefore < (params.tokenBudget ?? 128_000) * 0.9) {
				return { ok: true, compacted: false, reason: "under budget" }
			}

			// Find how many messages we can safely trim
			// Start from the oldest, trim only ingested messages
			let trimCount = 0
			const maxTrim = Math.max(0, messages.length - keepLast)

			// Check ingestion safety once (not per-message)
			const counts = tracker.counts()
			if (counts.buffered > 0 || counts.pending > counts.ingested) {
				log.debug(`CE compact: unsafe to trim — ${counts.buffered} buffered, ${counts.pending} pending`)
				return {
					ok: true,
					compacted: false,
					reason: "messages pending ingestion",
				}
			}

			// Safe to trim: all tracked messages are ingested
			trimCount = maxTrim

			if (trimCount === 0) {
				return {
					ok: true,
					compacted: false,
					reason: "no messages safe to trim",
				}
			}

			// Store trim offset — assemble() will consume this on next call
			trimOffset.value = trimCount
			const tokensAfter = estimateMessagesTokens(messages.slice(trimCount))

			log.info(`CE compact: trimmed ${trimCount} messages (${tokensBefore} → ${tokensAfter} tokens)`)

			return {
				ok: true,
				compacted: true,
				result: {
					tokensBefore,
					tokensAfter,
					summary: `Trimmed ${trimCount} older messages. SM has all facts indexed.`,
				},
			}
		} catch (err) {
			// Fallback to legacy compaction — lossy but prevents overflow
			log.error("CE compact: failed, delegating to runtime", err)
			try {
				return await delegateCompactionToRuntime(params)
			} catch (delegateErr) {
				log.error("CE compact: runtime delegation also failed", delegateErr)
				return {
					ok: false,
					compacted: false,
					reason: `both CE and runtime compaction failed: ${err instanceof Error ? err.message : String(err)}`,
				}
			}
		}
	}
}
