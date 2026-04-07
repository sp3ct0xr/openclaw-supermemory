import type { AgentMessage, ContextEngineRuntimeContext } from "openclaw/plugin-sdk"
import { clearProfileCache, PROFILE_TRIGGERS } from "../hooks/recall.ts"
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
	lastAssembledMemories?: { value: string[] }
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

		// Extract only the new messages from this turn
		const newMessages = params.messages.slice(params.prePromptMessageCount)
		if (newMessages.length === 0) {
			log.debug("CE afterTurn: no new messages to ingest")
			return
		}

		// Increment turn counter only for real turns with messages
		sharedState.turnCount.value++

		// Ingest new turn messages
		const result = await ingestBatchFn({
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			messages: newMessages,
			isHeartbeat: params.isHeartbeat,
		})

		// ── Profile cache invalidation ──
		// Only clear when the user said something that could change profile facts.
		// SM server-side may extract new facts from the Conversations API, but
		// we only invalidate on likely profile-changing statements to avoid
		// re-fetching profile on every single turn (24h TTL would be useless).
		// Explicit mutations (store/update/forget tools) are covered separately
		// by onMutation() → clearProfileCache().
		if (result.ingestedCount > 0) {
			const userTexts = newMessages
				.filter(m => m.role === 'user')
				.map(m => {
					if (typeof m.content === 'string') return m.content
					if (Array.isArray(m.content)) {
						return m.content
							.filter((b: Record<string, unknown>) => b.type === 'text')
							.map((b: Record<string, unknown>) => (b.text as string) ?? '')
							.join(' ')
					}
					return ''
				})
				.join(' ')
			if (PROFILE_TRIGGERS.test(userTexts)) {
				clearProfileCache()
				log.debug('CE afterTurn: profile cache invalidated — user statement matched profile triggers')
			}
		}

		// ── Turn metrics ──
		const totalTokens = estimateMessagesTokens(params.messages)
		const budgetLimit = params.tokenBudget ?? 128_000
		const budgetPct = Math.round((totalTokens / budgetLimit) * 100)

		log.debug(
			`CE afterTurn: turn=${sharedState.turnCount.value} ingested=${result.ingestedCount}/${newMessages.length} tokens≈${totalTokens} (${budgetPct}% of ${budgetLimit})`,
		)

		// ── Retrieval quality metrics ──
		const memories = sharedState.lastAssembledMemories?.value ?? []
		if (memories.length > 0) {
			// Find the last assistant message in this turn
			const assistantMsgs = newMessages.filter((m) => m.role === "assistant")
			const lastAssistant = assistantMsgs[assistantMsgs.length - 1]
			if (lastAssistant) {
				const responseText = typeof lastAssistant.content === "string"
					? lastAssistant.content.toLowerCase()
					: Array.isArray(lastAssistant.content)
						? lastAssistant.content.filter((b) => b.type === "text").map((b) => (b.text as string) ?? "").join(" ").toLowerCase()
						: ""
				if (responseText) {
					const matched = memories.filter((mem) =>
						responseText.includes(mem.slice(0, 50).toLowerCase()),
					).length
					const pct = Math.round((matched / memories.length) * 100)
					log.debug(
						`CE afterTurn: retrieval precision=${matched}/${memories.length} (${pct}%)`,
					)
				}
			}
			// Clear after measuring
			if (sharedState.lastAssembledMemories) {
				sharedState.lastAssembledMemories.value = []
			}
		}

		// ── Proactive compaction signal ──
		if (totalTokens > budgetLimit * COMPACTION_THRESHOLD) {
			sharedState.compactionRecommended.value = true
			log.info(`CE afterTurn: session at ${budgetPct}% budget — compaction recommended`)
		} else {
			sharedState.compactionRecommended.value = false
		}
	}
}
