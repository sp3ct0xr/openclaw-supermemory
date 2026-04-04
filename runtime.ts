import type { SupermemoryClient } from "./client.ts"
import { log } from "./logger.ts"

type MemoryProviderStatus = {
	backend: "builtin" | "qmd"
	provider: string
	model?: string
	files?: number
	chunks?: number
	custom?: Record<string, unknown>
}

type MemoryEmbeddingProbeResult = {
	ok: boolean
	error?: string
}

type MemorySyncProgressUpdate = {
	completed: number
	total: number
	label?: string
}

type RegisteredMemorySearchManager = {
	status(): MemoryProviderStatus
	probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>
	probeVectorAvailability(): Promise<boolean>
	sync?(params?: {
		reason?: string
		force?: boolean
		sessionFiles?: string[]
		progress?: (update: MemorySyncProgressUpdate) => void
	}): Promise<void>
	close?(): Promise<void>
}

type MemoryRuntimeBackendConfig =
	| { backend: "builtin" }
	| { backend: "qmd"; qmd?: { command?: string } }

type MemoryPluginRuntime = {
	getMemorySearchManager(params: {
		cfg: unknown
		agentId: string
		purpose?: "default" | "status"
	}): Promise<{
		manager: RegisteredMemorySearchManager | null
		error?: string
	}>
	resolveMemoryBackendConfig(params: {
		cfg: unknown
		agentId: string
	}): MemoryRuntimeBackendConfig
	closeAllMemorySearchManagers?(): Promise<void>
}

function createSearchManager(
	client: SupermemoryClient,
): RegisteredMemorySearchManager {
	return {
		status() {
			return {
				backend: "builtin" as const,
				provider: "supermemory",
				model: "supermemory-remote",
				files: 0,
				chunks: 0,
				custom: {
					containerTag: client.getContainerTag(),
					transport: "remote",
				},
			}
		},

		async probeEmbeddingAvailability() {
			try {
				await client.search("connection-probe", 1)
				return { ok: true }
			} catch (err) {
				const message =
					err instanceof Error ? err.message : "supermemory unreachable"
				log.warn(`embedding probe failed: ${message}`)
				return { ok: false, error: message }
			}
		},

		async probeVectorAvailability() {
			return true
		},

		async sync() {},

		async close() {},
	}
}

export function buildMemoryRuntime(
	client: SupermemoryClient,
): MemoryPluginRuntime {
	return {
		async getMemorySearchManager() {
			return { manager: createSearchManager(client) }
		},

		resolveMemoryBackendConfig() {
			return { backend: "builtin" as const }
		},
	}
}

export function buildPromptSection(params: {
	availableTools: Set<string>
}): string[] {
	const hasSearch = params.availableTools.has("supermemory_search")
	const hasStore = params.availableTools.has("supermemory_store")
	const hasForget = params.availableTools.has("supermemory_forget")
	const hasProfile = params.availableTools.has("supermemory_profile")
	if (!hasSearch && !hasStore && !hasForget && !hasProfile) return []

	const lines: string[] = [
		"## Memory (Supermemory)",
		"",
		"Memory is managed by Supermemory (cloud). Do not read or write local memory files like MEMORY.md or memory/*.md — they do not exist.",
		"",
		"### What is auto-injected",
		"Your user profile (persistent facts and recent context) is automatically injected at the start of each session. This gives you baseline knowledge about the user without any tool calls.",
		"",
	]

	if (hasSearch) {
		lines.push(
			"### Active memory search",
			"Profile context alone is not enough. When the user's request relates to past conversations, prior decisions, specific preferences, or anything that may have been discussed before:",
			"",
			"1. **Search before you act** — call supermemory_search with a focused query before responding to questions that might involve prior context.",
			"2. **Be specific** — use targeted queries like \"user's preferred database\" rather than broad ones like \"preferences\".",
			"3. **Search on uncertainty** — if you're unsure whether the user has mentioned something before, search. It's cheap and fast.",
			"4. **Don't guess from profile alone** — the profile is a summary. Search for details when the user asks about specifics.",
			"",
			"**Search modes:**",
			"- `mode: 'fast'` (default) — memory-level search, low latency, good for most queries. Uses hybrid search (memories + document chunks).",
			"- `mode: 'deep'` — chunk-level document search with reranking and query rewriting. Use for complex or detailed queries where precision matters.",
			"",
			"**Temporal filters:** Use `after` and `before` (ISO dates) to scope search to a time range (e.g. 'what did the user say last week').",
			"**Reranking:** Use `rerank: true` for better result ordering (+~100ms). Auto-enabled in deep mode.",
			"",
		)
	}
	if (hasStore) {
		lines.push(
			"### Storing memories",
			"Use supermemory_store when the user explicitly asks you to remember something, states a preference, makes a decision, or corrects you. Do not store transient task details.",
			"",
			"**Atomic facts**: Store ONE fact per call. Instead of \"User likes dark mode and uses pnpm\", make two separate calls.",
			"**Categories**: The tool auto-detects category (preference/fact/decision/entity/correction) but you can override. Corrections are HIGH priority — they replace outdated information.",
			"**Deduplication**: The store automatically checks for similar existing memories. If a near-duplicate exists, it updates the existing memory instead of creating a new one.",
			"",
		)
	}
	if (hasForget) {
		lines.push(
			"### Forgetting memories",
			"Use supermemory_forget when the user asks to delete or remove a specific memory, when information is outdated or incorrect and the user wants it gone, or when the user says \"forget that\", \"delete that memory\", or \"remove what you know about X\". Provide a descriptive query or the memory ID to target the closest match.",
			"",
		)
	}
	if (hasProfile) {
		lines.push(
			"### Profile inspection",
			"Use supermemory_profile to see a full summary of what is known about the user if you need an overview beyond what was auto-injected.",
			"",
		)
	}

	return lines
}
