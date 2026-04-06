import type { AgentMessage, ContextEngineRuntimeContext } from "openclaw/plugin-sdk"
import { log } from "../logger.ts"
import { estimateMessagesTokens } from "../utils/token-estimation.ts"

/** Type for the ingestBatch function built by buildIngestBatchHandler */
type IngestBatchFn = (params: {
	sessionId: string
	sessionKey?: string
	messages: AgentMessage[]
	isHeartbeat?: boolean
}) => Promise<{ ingestedCount: number }>

/** Shared state written by afterTurn, read by other lifecycle methods. */
export type AfterTurnSharedState = {
	turnCount: { value: number }
	compactionRecommended: { value: boolean }
}

/** Budget threshold for proactive compaction signal (80%). */
const COMPACTION_THRESHOLD = 0.80

/**
 * Build the afterTurn() handler for the context engine.
 *
 * When afterTurn is defined, the runtime does NOT auto-call ingestBatch.
 * We handle ingestion ourselves by extracting new messages and calling
 * the ingestBatch handler.
 *
 * Phase 2 additions:
 * - Turn metrics logging (messages ingested, token usage)
 * - Proactive compaction signal (when session tokens > 80% budget)
 * - Turn counter for shared state
 */
export function buildAfterTurnHandler(
	ingestBatchFn: IngestBatchFn,
	sharedState: AfterTurnSharedState,
) {
	return async (params: {
		sessionId: string
		sessionKey?: string
		sessionFile: string
		messages: AgentMessage[]
		prePromptMessageCount: number
		autoCompactionSummary?: string
		isHeartbeat?: boolean
		tokenBudget?: number
		runtimeContext?: ContextEngineRuntimeContext
	}): Promise<void> => {
		if (params.isHeartbeat) return

		// Increment turn counter
		sharedState.turnCount.value++

		// Extract only the new messages from this turn
		const newMessages = params.messages.slice(params.prePromptMessageCount)
		if (newMessages.length === 0) {
			log.debug("CE afterTurn: no new messages to ingest")
			return
		}

		// Ingest new turn messages
		const result = await ingestBatchFn({
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			messages: newMessages,
			isHeartbeat: params.isHeartbeat,
		})

		// ── Turn metrics ──
		const totalTokens = estimateMessagesTokens(params.messages)
		const budgetLimit = params.tokenBudget ?? 128_000
		const budgetPct = Math.round((totalTokens / budgetLimit) * 100)

		log.debug(
			`CE afterTurn: turn=${sharedState.turnCount.value} ingested=${result.ingestedCount}/${newMessages.length} tokens≈${totalTokens} (${budgetPct}% of ${budgetLimit})`,
		)

		// ── Proactive compaction signal ──
		if (totalTokens > budgetLimit * COMPACTION_THRESHOLD) {
			sharedState.compactionRecommended.value = true
			log.info(`CE afterTurn: session at ${budgetPct}% budget — compaction recommended`)
		} else {
			sharedState.compactionRecommended.value = false
		}
	}
}
