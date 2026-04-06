import type { AgentMessage, ContextEngineRuntimeContext } from "openclaw/plugin-sdk"
import { log } from "../logger.ts"

/** Type for the ingestBatch function built by buildIngestBatchHandler */
type IngestBatchFn = (params: {
	sessionId: string
	sessionKey?: string
	messages: AgentMessage[]
	isHeartbeat?: boolean
}) => Promise<{ ingestedCount: number }>

/**
 * Build the afterTurn() handler for the context engine.
 *
 * When afterTurn is defined, the runtime does NOT auto-call ingestBatch.
 * We handle ingestion ourselves by extracting new messages and calling
 * the ingestBatch handler.
 */
export function buildAfterTurnHandler(ingestBatchFn: IngestBatchFn) {
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

		// Extract only the new messages from this turn
		const newMessages = params.messages.slice(params.prePromptMessageCount)
		if (newMessages.length === 0) {
			log.debug("CE afterTurn: no new messages to ingest")
			return
		}

		log.debug(`CE afterTurn: ingesting ${newMessages.length} new messages`)

		const result = await ingestBatchFn({
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			messages: newMessages,
			isHeartbeat: params.isHeartbeat,
		})

		log.debug(`CE afterTurn: ingested ${result.ingestedCount}/${newMessages.length}`)
	}
}
