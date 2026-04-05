import type { ProfileSearchResult, SupermemoryClient } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { log } from "../logger.ts"
import { stripInboundMetadata } from "../memory.ts"
import { textSimilarity, RECALL_DEDUP_SIMILARITY_THRESHOLD } from "../text-similarity.ts"

function formatRelativeTime(isoTimestamp: string): string {
	try {
		const dt = new Date(isoTimestamp)
		const now = new Date()
		const seconds = (now.getTime() - dt.getTime()) / 1000
		const minutes = seconds / 60
		const hours = seconds / 3600
		const days = seconds / 86400

		if (minutes < 30) return "just now"
		if (minutes < 60) return `${Math.floor(minutes)}mins ago`
		if (hours < 24) return `${Math.floor(hours)} hrs ago`
		if (days < 7) return `${Math.floor(days)}d ago`

		const month = dt.toLocaleString("en", { month: "short" })
		if (dt.getFullYear() === now.getFullYear()) {
			return `${dt.getDate()} ${month}`
		}
		return `${dt.getDate()} ${month}, ${dt.getFullYear()}`
	} catch {
		return ""
	}
}

function deduplicateMemories(
	staticFacts: string[],
	dynamicFacts: string[],
	searchResults: ProfileSearchResult[],
): {
	static: string[]
	dynamic: string[]
	searchResults: ProfileSearchResult[]
} {
	// Pass 1: exact-match dedup via Set (case-insensitive)
	const seen = new Set<string>()
	const normalizeKey = (s: string) => s.trim().toLowerCase()

	const uniqueStatic = staticFacts.filter((m) => {
		const key = normalizeKey(m)
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})

	const uniqueDynamic = dynamicFacts.filter((m) => {
		const key = normalizeKey(m)
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})

	const uniqueSearch = searchResults.filter((r) => {
		const memory = r.memory ?? ""
		const key = normalizeKey(memory)
		if (!memory || seen.has(key)) return false
		seen.add(key)
		return true
	})

	// Pass 2: fuzzy dedup via Jaro-Winkler — catches near-dupes like
	// "User prefers vim" vs "User prefers Vim" that exact match misses.
	// Only applied to static facts (most likely to have near-dupes from
	// SM profile extraction). Stricter threshold to avoid dropping distinct memories.
	const fuzzyDeduped: string[] = []
	for (const fact of uniqueStatic) {
		const dupeIdx = fuzzyDeduped.findIndex(
			(existing) => textSimilarity(fact, existing) >= RECALL_DEDUP_SIMILARITY_THRESHOLD,
		)
		if (dupeIdx === -1) {
			fuzzyDeduped.push(fact)
		} else if (fact.length > fuzzyDeduped[dupeIdx].length) {
			// Keep the longer/more informative variant
			fuzzyDeduped[dupeIdx] = fact
		}
	}

	return {
		static: fuzzyDeduped,
		dynamic: uniqueDynamic,
		searchResults: uniqueSearch,
	}
}

function formatContext(
	staticFacts: string[],
	dynamicFacts: string[],
	searchResults: ProfileSearchResult[],
	maxResults: number,
): string | null {
	const deduped = deduplicateMemories(staticFacts, dynamicFacts, searchResults)
	const statics = deduped.static.slice(0, maxResults)
	const dynamics = deduped.dynamic.slice(0, maxResults)
	const search = deduped.searchResults.slice(0, maxResults)

	if (statics.length === 0 && dynamics.length === 0 && search.length === 0)
		return null

	const sections: string[] = []

	if (statics.length > 0) {
		sections.push(
			"## User Profile (Persistent)\n" +
				statics.map((f) => `- ${f}`).join("\n"),
		)
	}

	if (dynamics.length > 0) {
		sections.push(
			`## Recent Context\n${dynamics.map((f) => `- ${f}`).join("\n")}`,
		)
	}

	if (search.length > 0) {
		const lines = search.map((r) => {
			const memory = r.memory ?? ""
			const timeStr = r.updatedAt ? formatRelativeTime(r.updatedAt) : ""
			const pct =
				r.similarity != null ? `[${Math.round(r.similarity * 100)}%]` : ""
			const prefix = timeStr ? `[${timeStr}]` : ""
			return `- ${prefix}${memory} ${pct}`.trim()
		})
		sections.push(
			`## Relevant Memories (with relevance %)\n${lines.join("\n")}`,
		)
	}

	const intro =
		"The following is background context about the user from long-term memory. Use this context silently to inform your understanding — only reference it when the user's message is directly related to something in these memories."
	const disclaimer =
		"Do not proactively bring up memories. Only use them when the conversation naturally calls for it."

	return `<supermemory-context>\n${intro}\n\n${sections.join("\n\n")}\n\n${disclaimer}\n</supermemory-context>`
}

function countUserTurns(messages: unknown[]): number {
	let count = 0
	for (const msg of messages) {
		if (
			msg &&
			typeof msg === "object" &&
			(msg as Record<string, unknown>).role === "user"
		) {
			count++
		}
	}
	return count
}

function formatContainerMetadata(
	cfg: SupermemoryConfig,
	messageProvider?: string,
): string | null {
	if (!cfg.enableCustomContainerTags || cfg.customContainers.length === 0)
		return null

	const lines: string[] = []

	lines.push(`Root container: \`${cfg.containerTag}\``)
	lines.push("")
	lines.push("Custom memory containers:")
	for (const c of cfg.customContainers) {
		lines.push(`- \`${c.tag}\`: ${c.description}`)
	}

	if (messageProvider) {
		lines.push("")
		lines.push(`Current channel: ${messageProvider}`)
	}

	if (cfg.customContainerInstructions) {
		lines.push("")
		lines.push(cfg.customContainerInstructions)
	}

	lines.push("")
	lines.push(
		"Use containerTag parameter to store in a specific container, otherwise stores to root.",
	)

	return lines.join("\n")
}

export function buildRecallHandler(
	client: SupermemoryClient,
	cfg: SupermemoryConfig,
) {
	return async (
		event: Record<string, unknown>,
		ctx?: Record<string, unknown>,
	) => {
		const rawPrompt = event.prompt as string | undefined
		if (!rawPrompt || rawPrompt.length < 5) return

		const messages = Array.isArray(event.messages) ? event.messages : []
		const turn = countUserTurns(messages)
		const isNewSession = turn === 0
		const includeProfile = isNewSession || turn % cfg.profileFrequency === 0
		const messageProvider = ctx?.messageProvider as string | undefined
		const query = isNewSession ? undefined : stripInboundMetadata(rawPrompt)

		log.debug(
			`recalling for turn ${turn} (profile: ${includeProfile}, newSession: ${isNewSession})`,
		)

		try {
			const profile = await client.getProfile(
				isNewSession ? undefined : query,
			)

			const memoryContext = formatContext(
				includeProfile ? profile.static : [],
				includeProfile ? profile.dynamic : [],
				[], // search results no longer auto-injected — agents use supermemory_search actively
				cfg.maxRecallResults,
			)

			const containerContext = formatContainerMetadata(cfg, messageProvider)

			const contextParts: string[] = []
			if (memoryContext) contextParts.push(memoryContext)
			if (containerContext) {
				contextParts.push(
					`<supermemory-containers>\n${containerContext}\n</supermemory-containers>`,
				)
			}

			if (contextParts.length === 0) {
				log.debug("no profile data to inject")
				return
			}

			const finalContext = contextParts.join("\n\n")
			log.debug(
				`injecting context (${finalContext.length} chars, turn ${turn})`,
			)
			return { prependContext: finalContext }
		} catch (err) {
			log.error("recall failed", err)
			return
		}
	}
}
