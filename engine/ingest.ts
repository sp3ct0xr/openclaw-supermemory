import type { AgentMessage, IngestResult, IngestBatchResult } from "openclaw/plugin-sdk"
import type { SupermemoryClient } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { log } from "../logger.ts"
import { IngestionTracker } from "../utils/ingestion-tracker.ts"
import { OutageBuffer } from "../utils/outage-buffer.ts"
import { stripInboundMetadata } from "../memory.ts"

/** Extract text content from AgentMessage for SM ingestion. */
function formatMessageText(msg: AgentMessage): string {
	const role = msg.role ?? "unknown"
	let text: string
	if (typeof msg.content === "string") {
		text = msg.content
	} else if (Array.isArray(msg.content)) {
		text = msg.content
			.filter((b) => b.type === "text" && typeof b.text === "string")
			.map((b) => b.text as string)
			.join("\n")
	} else {
		text = ""
	}
	// Strip injected metadata from user messages (same as capture hook)
	const cleaned = role === "user" ? stripInboundMetadata(text) : text
	return `[role: ${role}]\n${cleaned}\n[${role}:end]`
}

/**
 * Build the ingest() handler.
 * Per-message ingest is a no-op — all tracking and SM ingestion happens
 * in ingestBatch() via afterTurn(). This avoids orphan tracker IDs.
 */
export function buildIngestHandler(_tracker: IngestionTracker) {
	return async (params: {
		sessionId: string
		sessionKey?: string
		message: AgentMessage
		isHeartbeat?: boolean
	}): Promise<IngestResult> => {
		// No-op: afterTurn() calls ingestBatch() with all new turn messages.
		// Tracking individual messages here would create orphan IDs that
		// never transition to "ingested" (Copilot review #2).
		return { ingested: false }
	}
}

/**
 * Build the ingestBatch() handler — batch SM ingestion with outage recovery.
 * Called by afterTurn() with new turn messages.
 */
export function buildIngestBatchHandler(
	client: SupermemoryClient,
	cfg: SupermemoryConfig,
	tracker: IngestionTracker,
	outageBuffer: OutageBuffer,
	degradedMode: { value: boolean },
) {
	return async (params: {
		sessionId: string
		sessionKey?: string
		messages: AgentMessage[]
		isHeartbeat?: boolean
	}): Promise<IngestBatchResult> => {
		if (params.isHeartbeat || params.messages.length === 0) {
			return { ingestedCount: 0 }
		}

		// Format messages as session text for SM ingestion
		const formatted = params.messages.map(formatMessageText).join("\n\n")
		const customId = `session_${params.sessionId}_turn_${Date.now()}`
		const msgIds = params.messages.map(
			(_, i) => `${params.sessionId}_batch_${Date.now()}_${i}`,
		)

		try {
			await client.addMemory(
				formatted,
				{
					source: "openclaw_ce",
					documentDate: new Date().toISOString(),
					sessionId: params.sessionId,
				},
				customId,
				undefined, // use default containerTag
				cfg.entityContext,
			)

			// Mark all messages as ingested
			tracker.markAllIngested(msgIds)
			log.debug(`CE ingestBatch: ingested ${params.messages.length} messages`)

			// Recovery: if outage buffer has pending entries, flush them
			if (!outageBuffer.isEmpty()) {
				log.info(`CE ingestBatch: SM recovered — flushing ${outageBuffer.pending()} buffered turns`)
				degradedMode.value = false
				const buffered = outageBuffer.flush()
				let flushed = 0
				for (let i = 0; i < buffered.length; i++) {
					const entry = buffered[i]!
					try {
						const entryText = entry.messages.map(formatMessageText).join("\n\n")
						await client.addMemory(
							entryText,
							{
								source: "openclaw_ce_recovery",
								documentDate: entry.timestamp,
								sessionId: entry.sessionId,
							},
							`recovery_${entry.sessionId}_${entry.timestamp}`,
							undefined,
							cfg.entityContext,
						)
						flushed++
					} catch {
						// Re-buffer failed entry + all remaining unprocessed entries
						for (let j = i; j < buffered.length; j++) {
							outageBuffer.push(buffered[j]!)
						}
						break
					}
				}
				if (flushed > 0) {
					log.info(`CE ingestBatch: recovery flushed ${flushed} buffered turns`)
				}
			}

			return { ingestedCount: params.messages.length }
		} catch (err) {
			// SM unreachable — buffer for later
			log.warn(`CE ingestBatch: SM failed, buffering ${params.messages.length} messages — ${err instanceof Error ? err.message : String(err)}`)
			outageBuffer.push({
				messages: params.messages,
				sessionId: params.sessionId,
				timestamp: new Date().toISOString(),
			})
			tracker.markAllBuffered(msgIds)
			degradedMode.value = true

			return { ingestedCount: 0 }
		}
	}
}
