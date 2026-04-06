import type {
	AgentMessage,
	ContextEngineMaintenanceResult,
	ContextEngineRuntimeContext,
	TranscriptRewriteReplacement,
} from "openclaw/plugin-sdk"
import { log } from "../logger.ts"
import { IngestionTracker } from "../utils/ingestion-tracker.ts"

/** Minimum content length (chars) before a tool_result is eligible for compaction. */
const COMPACTION_THRESHOLD_CHARS = 2000

/** Placeholder text for compacted tool results. */
const COMPACTED_PLACEHOLDER = "[compacted: tool output removed to free context]"

/**
 * Build the maintain() handler for the context engine.
 *
 * Called by the runtime after bootstrap, successful turns, or compaction.
 * Uses runtimeContext.rewriteTranscriptEntries() to safely replace verbose
 * tool_result messages with compact placeholders.
 *
 * Safety: only rewrites messages whose turns have been ingested by SM.
 */
export function buildMaintainHandler(tracker: IngestionTracker) {
	return async (params: {
		sessionId: string
		sessionKey?: string
		sessionFile: string
		runtimeContext?: ContextEngineRuntimeContext
	}): Promise<ContextEngineMaintenanceResult> => {
		const rewrite = params.runtimeContext?.rewriteTranscriptEntries
		if (typeof rewrite !== "function") {
			return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: "rewriteTranscriptEntries not available" }
		}

		// Only proceed if ALL tracked messages are ingested (no pending/buffered)
		const counts = tracker.counts()
		if (counts.ingested === 0 || counts.pending > 0 || counts.buffered > 0) {
			return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: counts.ingested === 0 ? "no ingested messages yet" : "messages pending/buffered — unsafe to rewrite" }
		}

		// Access messages from runtimeContext if available
		const messages = (params.runtimeContext?.messages ?? []) as AgentMessage[]
		if (messages.length === 0) {
			return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: "no messages in runtimeContext" }
		}

		// Find tool_result messages with large content
		const replacements: TranscriptRewriteReplacement[] = []

		for (const msg of messages) {
			// Only target tool_result role messages
			if (msg.role !== "tool" && msg.role !== "tool_result") continue

			const entryId = msg.id as string | undefined
			if (!entryId) continue

			const contentLength = typeof msg.content === "string"
				? msg.content.length
				: Array.isArray(msg.content)
					? msg.content.reduce((len, b) => len + (typeof b.text === "string" ? b.text.length : 0), 0)
					: 0

			if (contentLength < COMPACTION_THRESHOLD_CHARS) continue

			// Already compacted?
			if (typeof msg.content === "string" && msg.content.includes("[compacted:")) continue

			replacements.push({
				entryId,
				message: {
					...msg,
					content: COMPACTED_PLACEHOLDER,
				},
			})
		}

		if (replacements.length === 0) {
			return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: "no large tool results to compact" }
		}

		try {
			const result = await rewrite({ replacements })
			log.info(
				`CE maintain: compacted ${result.rewrittenEntries} tool results, freed ~${result.bytesFreed} bytes`,
			)
			return result
		} catch (err) {
			log.warn(`CE maintain: rewrite failed — ${err instanceof Error ? err.message : String(err)}`)
			return { changed: false, bytesFreed: 0, rewrittenEntries: 0, reason: "rewrite failed" }
		}
	}
}
