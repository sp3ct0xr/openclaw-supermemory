import type { AgentMessage, AssembleResult } from "openclaw/plugin-sdk"
import type { SearchResult, SupermemoryClient } from "../client.ts"
import { buildTemporalFilters } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { log } from "../logger.ts"
import {
	getProfileCache,
	setProfileCache,
	hasProfileOverlap,
	formatContainerMetadata,
} from "../hooks/recall.ts"
import { estimateTokens, estimateMessagesTokens } from "../utils/token-estimation.ts"
import { classifyQuery, type QueryClassification } from "../utils/query-classifier.ts"
import { stripRuntimeContext } from "../utils/strip-runtime-context.ts"
import { stripInboundMetadata } from "../memory.ts"

/** SM status page for outage warnings */
const SM_STATUS_URL = "https://status.supermemory.ai/"

/** Adaptive budget ratios by query complexity. */
const BUDGET_RATIOS = {
	simple:    { profile: 0.05, memory: 0.10, recent: 0.85 },
	knowledge: { profile: 0.20, memory: 0.50, recent: 0.30 },
	multihop:  { profile: 0.15, memory: 0.45, recent: 0.40 },
} as const

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
	lastAssembledMemories?: { value: string[] },
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

			// ── Classify query for adaptive budget + temporal/container hints ──
			// Strip runtime context from prompt to avoid searching with internal metadata
			const rawQuery = params.prompt ?? extractLastUserQuery(params.messages)
			const queryText = rawQuery ? stripRuntimeContext(stripInboundMetadata(rawQuery)).trim() || undefined : undefined
			const classification: QueryClassification = classifyQuery(
				queryText,
				cfg.enableCustomContainerTags ? cfg.customContainers : undefined,
			)
			const ratios = BUDGET_RATIOS[classification.complexity]

			const budget = params.tokenBudget ?? 128_000
			const profileBudget = Math.floor(budget * ratios.profile)
			const memoryBudget = Math.floor(budget * ratios.memory)
			const recentBudget = Math.floor(budget * ratios.recent)

			log.debug(
				`CE assemble: classified="${classification.complexity}" budget=${Math.round(ratios.profile * 100)}/${Math.round(ratios.memory * 100)}/${Math.round(ratios.recent * 100)}` +
				(classification.temporal ? ` temporal=${JSON.stringify(classification.temporal)}` : "") +
				(classification.containerHint ? ` container=${classification.containerHint}` : ""),
			)

			// ── Zone 1: Profile (systemPromptAddition) ──
			let profileText = ""
			try {
				let profile = getProfileCache()
				if (!profile) {
					profile = await client.getProfile(queryText)
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
					if (estimateTokens(profileText, params.model) > profileBudget) {
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
			// Skip Zone 2 for simple queries — saves ~200ms latency + avoids irrelevant results
			if (classification.complexity !== "simple") {
				try {
					if (queryText && queryText.length >= 3) {
						// Build temporal filters from classifier
						const temporalFilters = classification.temporal
							? buildTemporalFilters(classification.temporal)
							: undefined

						const searchOpts = {
							searchMode: "hybrid" as const,
							rerank: true,
							threshold: cfg.assembleThreshold,
							...(temporalFilters && { filters: temporalFilters }),
						}

						// Container-aware dual search when classifier detects a topic
						let results: SearchResult[]
						const rootTag = client.getContainerTag()
						if (
							classification.containerHint &&
							cfg.enableCustomContainerTags &&
							classification.containerHint !== rootTag
						) {
							log.debug(`CE assemble: dual search — root + ${classification.containerHint}`)
							const [rootResults, topicResults] = await Promise.all([
								client.search(queryText, 10, rootTag, searchOpts),
								client.search(queryText, 10, classification.containerHint, searchOpts),
							])
							// Merge: topic results first (more specific), then root, dedupe by ID
							const seen = new Set<string>()
							const merged: SearchResult[] = []
							for (const r of [...topicResults, ...rootResults]) {
								if (!seen.has(r.id)) {
									seen.add(r.id)
									merged.push(r)
								}
							}
							// Sort by relevance (rerank=true)
							results = merged
								.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
								.slice(0, 10)
						} else {
							results = await client.search(queryText, 10, undefined, searchOpts)
						}

					if (results.length > 0) {
						const memoryLines = results
							.map((r) => r.content || r.memory || "")

						// Store for retrieval quality metrics in afterTurn
						if (lastAssembledMemories) {
							lastAssembledMemories.value = memoryLines.filter(Boolean)
						}

						const formattedLines = memoryLines
							.map((line) => `- ${line}`)
							.join("\n")

						let memoryText = `[Supermemory: relevant memories for this turn]\n${formattedLines}`

							if (estimateTokens(memoryText, params.model) > memoryBudget) {
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
				}
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
			const totalTokens = estimateMessagesTokens(assembled, params.model) + estimateTokens(profileText, params.model)

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
