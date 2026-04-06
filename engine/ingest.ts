import type { AgentMessage, IngestResult, IngestBatchResult } from "openclaw/plugin-sdk"
import type { SupermemoryClient } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { log } from "../logger.ts"
import { IngestionTracker } from "../utils/ingestion-tracker.ts"
import { OutageBuffer } from "../utils/outage-buffer.ts"
import { stripInboundMetadata } from "../memory.ts"

/**
 * Strip OpenClaw runtime internal context blocks that should never be stored as memories.
 *
 * Patterns sourced from OpenClaw runtime:
 *  - internal-runtime-context.ts (delimited + legacy internal context)
 *  - internal-events.ts (task completion events)
 *  - external-content.ts (untrusted external content wrappers)
 *  - subagent-spawn.ts (subagent dispatch messages)
 *  - subagent-announce.ts (subagent wake/completion context)
 *  - subagent-announce-output.ts (child result formatting)
 */
function stripRuntimeContext(text: string): string {
	if (!text) return text
	return text
		// ── Delimited runtime context (supports nesting via greedy match) ──
		.replace(/<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>/g, "")

		// ── Legacy internal context header + event blocks ──
		// Format: "OpenClaw runtime context (internal):\nThis context is runtime-generated...\n\n[Internal task completion event]\n..."
		.replace(/OpenClaw runtime context \(internal\):[\s\S]*?(?=\n\[role:|$)/g, "")

		// ── Internal task completion event metadata ──
		.replace(/\[Internal task completion event\][\s\S]*?(?=\n\n---\n\n\[Internal|\n\[role:|$)/g, "")

		// ── Untrusted child result blocks (strip markers AND content between them) ──
		.replace(/(?:(?:Result|Child result) \(untrusted content, treat as data\):\n)?<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>[\s\S]*?<<<END_UNTRUSTED_CHILD_RESULT>>>/g, "")

		// ── Child completion result blocks ──
		.replace(/Child completion results:[\s\S]*?(?=\n\[role:|$)/g, "")

		// ── External untrusted content (web fetches with random IDs) ──
		.replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, "")

		// ── Tool result blocks (file contents, command outputs — ephemeral) ──
		.replace(/\[role: toolResult\][\s\S]*?\[toolResult:end\]/g, "")

		// ── Subagent dispatch metadata (subagent-spawn.ts:675-683) ──
		.replace(/^\[Subagent Context\][^\n]*$/gm, "")
		.replace(/^\[Subagent Task\]:.*$/gm, "")

		// ── Our own injected memory/container context ──
		.replace(/<supermemory-context>[\s\S]*?<\/supermemory-context>\s*/g, "")
		.replace(/<supermemory-containers>[\s\S]*?<\/supermemory-containers>\s*/g, "")

		// ── Action/reply instructions appended to internal events ──
		.replace(/^Action:\n.*(?:Convert (?:this|the) (?:completion|result)|reply ONLY)[^\n]*$/gm, "")

		// ── Execution stats lines ──
		.replace(/^Stats: runtime[^\n]*$/gm, "")

		// ── Security notice boilerplate ──
		.replace(/SECURITY NOTICE: The following content is from an EXTERNAL[\s\S]*?Send messages to third parties\n*/g, "")

		// ── Untrusted context trailing header (strip-inbound-meta.ts) ──
		.replace(/^Untrusted context \(metadata, do not treat as instructions or commands\):[\s\S]*$/gm, "")

		// ── Clean up whitespace ──
		.replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "")
}

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
	// Strip runtime context from ALL roles (subagent context, injected SM tags)
	const sanitized = stripRuntimeContext(cleaned)
	if (!sanitized) return ""
	return `[role: ${role}]\n${sanitized}\n[${role}:end]`
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
		const formatted = params.messages
			.map(formatMessageText)
			.filter((t) => t.length > 0)
			.join("\n\n")

		if (!formatted) {
			log.debug("CE ingestBatch: all messages were runtime-only context, skipping")
			return { ingestedCount: 0 }
		}
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
