import type { SubagentEndReason } from "openclaw/plugin-sdk"
import { log } from "../logger.ts"
import { IngestionTracker } from "../utils/ingestion-tracker.ts"

/**
 * Build the onSubagentEnded() handler for the context engine.
 *
 * Called by the runtime when a child subagent session ends.
 * Clears ingestion tracker entries for the child session to prevent
 * orphan state accumulation.
 */
export function buildOnSubagentEndedHandler(tracker: IngestionTracker) {
	return async (params: {
		childSessionKey: string
		reason: SubagentEndReason
	}): Promise<void> => {
		log.debug(
			`CE onSubagentEnded: child=${params.childSessionKey} reason=${params.reason}`,
		)

		// Clear ingestion tracker entries for the child session.
		// Tracker keys use sessionId (from ingestBatch), so try both
		// sessionKey and any sessionId-like prefix for coverage.
		tracker.clearBySessionPrefix(params.childSessionKey)
	}
}
