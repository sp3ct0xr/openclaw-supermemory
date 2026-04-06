import type { AgentMessage, AssembleResult } from "openclaw/plugin-sdk"
import type { SupermemoryClient } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { log } from "../logger.ts"
import {
	getProfileCache,
	setProfileCache,
	hasProfileOverlap,
	formatContainerMetadata,
} from "../hooks/recall.ts"
import { estimateTokens, estimateMessagesTokens } from "../utils/token-estimation.ts"

/** SM status page for outage warnings */
const SM_STATUS_URL = "https://status.supermemory.ai/"

/** Default budget ratios (Phase 2 makes these adaptive) */
const BUDGET_PROFILE = 0.15
const BUDGET_MEMORY = 0.35
const BUDGET_RECENT = 0.50

/** Probe timeout for recovery detection (ms) */
const PROBE_TIMEOUT_MS = 2000

/**
 * Build the assemble() handler for the context engine.
 *
 * CRITICAL: This function MUST NOT throw — the OpenClaw runtime does NOT
 * wrap assemble() in try/catch. Any uncaught error kills the run.
 * All SM calls are wrapped internally with legacy fallback.
 */
export function buildAssembleHandler(
	client: SupermemoryClient,
	cfg: SupermemoryConfig,
	degradedMode: { value: boolean },
	trimOffset: { value: number },
) {
	return async (params: {
		sessionId: string
		sessionKey?: string
		messages: AgentMessage[]
		tokenBudget?: number
		model?: string
		prompt?: string
	}): Promise<AssembleResult> => {
		try {
			// ── Degraded mode: probe for recovery ──
			if (degradedMode.value) {
				try {
					// Race probe against timeout — AbortController.signal not supported by SM SDK
					await Promise.race([
						client.search("probe", 1),
						new Promise((_, reject) =>
							setTimeout(() => reject(new Error("probe timeout")), PROBE_TIMEOUT_MS),
					),
					])
					degradedMode.value = false
					log.info("CE assemble: SM recovered — resuming normal operation")
				} catch {
					// Still down — return legacy fallback
					log.debug("CE assemble: SM still unreachable, using legacy fallback")
					return buildDegradedFallback(params.messages)
				}
			}

			const budget = params.tokenBudget ?? 128_000
			const profileBudget = Math.floor(budget * BUDGET_PROFILE)
			const memoryBudget = Math.floor(budget * BUDGET_MEMORY)
			const recentBudget = Math.floor(budget * BUDGET_RECENT)

			// ── Zone 1: Profile (systemPromptAddition) ──
			let profileText = ""
			try {
				let profile = getProfileCache()
				if (!profile) {
					profile = await client.getProfile(params.prompt)
					setProfileCache(profile, cfg.profileCacheTtlMs)
				}

				// Over-personalization guard
				const shouldInject = !params.prompt || hasProfileOverlap(params.prompt, profile)

				if (shouldInject) {
					const sections: string[] = []
					if (profile.static.length > 0) {
						sections.push(
							"## User Profile (Persistent)\n" +
								profile.static.map((f) => `- ${f}`).join("\n"),
						)
					}
					if (profile.dynamic.length > 0) {
						sections.push(
							`## Recent Context\n${profile.dynamic.map((f) => `- ${f}`).join("\n")}`,
						)
					}
					if (sections.length > 0) {
						const intro = "The following is background context about the user from long-term memory."
						profileText = `<supermemory-context>\n${intro}\n\n${sections.join("\n\n")}\n</supermemory-context>`

						// Trim to budget
						if (estimateTokens(profileText) > profileBudget) {
							profileText = profileText.slice(0, profileBudget * 4) // rough trim
						}
					}
				}
			} catch (err) {
				log.warn(`CE assemble: profile fetch failed — ${err instanceof Error ? err.message : String(err)}`)
				// Continue without profile — Zone 2 + 3 still available
			}

			// Container guidance
			const containerGuidance = formatContainerMetadata(cfg)
			if (containerGuidance) {
				profileText += `\n\n<supermemory-containers>\n${containerGuidance}\n</supermemory-containers>`
			}

			// ── Zone 2: Retrieved Memories (as messages) ──
			const memoryMessages: AgentMessage[] = []
			try {
				const query = params.prompt ?? extractLastUserQuery(params.messages)
				if (query && query.length >= 3) {
					const results = await client.search(query, 10, undefined, {
						searchMode: "hybrid",
						rerank: true,
						threshold: cfg.assembleThreshold,
					})

					if (results.length > 0) {
						// Format as a single system message with memory context
						const memoryLines = results
							.map((r) => `- ${r.content || r.memory || ""}`)
							.join("\n")

						let memoryText = `[Supermemory: relevant memories for this turn]\n${memoryLines}`

						// Trim to budget
						if (estimateTokens(memoryText) > memoryBudget) {
							memoryText = memoryText.slice(0, memoryBudget * 4)
						}

						memoryMessages.push({
							role: "system",
							content: memoryText,
						})
					}
				}
			} catch (err) {
				log.warn(`CE assemble: SM search failed — ${err instanceof Error ? err.message : String(err)}`)
				// Continue without memories — Zone 1 + 3 still available
			}

			// ── Zone 3: Recent Messages ──
			// Apply trimOffset from compact() — skip already-ingested older messages
			const effectiveMessages = trimOffset.value > 0
				? params.messages.slice(trimOffset.value)
				: params.messages
			if (trimOffset.value > 0) {
				log.debug(`CE assemble: applying trimOffset=${trimOffset.value} from compact`)
				trimOffset.value = 0
			}

			const recentMessages = trimMessagesToBudget(
				effectiveMessages,
				recentBudget,
			)

			// ── Combine ──
			const assembled = [...memoryMessages, ...recentMessages]
			const totalTokens = estimateMessagesTokens(assembled) + estimateTokens(profileText)

			log.debug(
				`CE assemble: ${memoryMessages.length > 0 ? memoryMessages.length : "no"} memory msgs, ${recentMessages.length} recent msgs, ${totalTokens} est. tokens`,
			)

			return {
				messages: assembled,
				estimatedTokens: totalTokens,
				...(profileText && { systemPromptAddition: profileText }),
			}
		} catch (err) {
			// SAFETY NET: assemble must never throw
			log.error("CE assemble: unexpected error, falling back to legacy", err)
			return buildDegradedFallback(params.messages)
		}
	}
}

/** Legacy-equivalent fallback with outage warning. */
function buildDegradedFallback(messages: AgentMessage[]): AssembleResult {
	return {
		messages,
		estimatedTokens: 0, // Let runtime estimate
		systemPromptAddition:
			`⚠️ Long-term memory (Supermemory) is temporarily unavailable. ` +
			`You have full session context but cannot access past memories. ` +
			`If the user asks about past conversations, let them know memory is temporarily offline ` +
			`(status: ${SM_STATUS_URL}). Continue working normally — session context is intact.`,
	}
}

/** Extract last user message text as search query. */
function extractLastUserQuery(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (msg?.role === "user") {
			if (typeof msg.content === "string") return msg.content
			if (Array.isArray(msg.content)) {
				return msg.content
					.filter((b) => b.type === "text" && typeof b.text === "string")
					.map((b) => b.text as string)
					.join(" ")
			}
		}
	}
	return undefined
}

/** Trim messages from the start to fit within a token budget, keeping recent messages. */
function trimMessagesToBudget(
	messages: AgentMessage[],
	budgetTokens: number,
): AgentMessage[] {
	// Start from the end (most recent), accumulate until budget is reached
	const result: AgentMessage[] = []
	let tokens = 0
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]
		if (!msg) continue
		const msgTokens = estimateMessagesTokens([msg])
		if (tokens + msgTokens > budgetTokens && result.length > 0) break
		result.unshift(msg)
		tokens += msgTokens
	}
	return result
}
