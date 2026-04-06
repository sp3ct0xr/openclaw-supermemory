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
	contextEngineActive?: boolean
}): string[] {
	const hasSearch = params.availableTools.has("supermemory_search")
	const hasStore = params.availableTools.has("supermemory_store")
	const hasUpdate = params.availableTools.has("supermemory_update")
	const hasForget = params.availableTools.has("supermemory_forget")
	const hasProfile = params.availableTools.has("supermemory_profile")
	const hasIngest = params.availableTools.has("supermemory_ingest")
	const hasSettings = params.availableTools.has("supermemory_settings")
	if (
		!hasSearch &&
		!hasStore &&
		!hasUpdate &&
		!hasForget &&
		!hasProfile &&
		!hasIngest &&
		!hasSettings
	)
		return []

	const lines: string[] = [
		"## Memory (Supermemory)",
		"",
		"Memory is managed by Supermemory (cloud). Do not read or write local memory files like MEMORY.md or memory/*.md — they do not exist.",
		"",
	...(params.contextEngineActive
			? [
				"### Context Engine (active)",
				"A context engine manages your memory automatically every turn. It assembles three zones of context:",
				"1. **Profile** — persistent facts and recent context about the user (system prompt)",
				"2. **Retrieved memories** — relevant past memories found via semantic search (injected as messages)",
				"3. **Recent messages** — your most recent conversation turns (kept verbatim)",
				"",
				"Conversation turns are automatically ingested into long-term memory after each turn. You usually do not need to manually recall or capture — it happens automatically.",
				"If older messages are trimmed from context, their content is typically preserved in Supermemory. Search to retrieve early-session details if needed.",
			]
			: [
				"### What is auto-injected",
				"Your user profile (persistent facts and recent context) is automatically injected at the start of each session. This gives you baseline knowledge about the user without any tool calls.",
			]),
		"",
		`### Available tools\n${[...params.availableTools].map((t) => `- \`${t}\``).join("\n")}`,
		"",
	]

	if (hasSearch) {
		if (params.contextEngineActive) {
			lines.push(
				"### Memory search",
				"Relevant memories and your user profile are automatically injected into context each turn by the context engine.",
				"",
				"**IMPORTANT — Read injected context first:**",
"Before calling any search tool, read the auto-injected profile and memory context above. If the answer is already there, respond directly — do not search to verify what the context engine already provided.",
				"",
				"**Trust the profile for simple facts:**",
				"The user profile (name, preferences, identity, tools, projects) is authoritative. If the profile answers the question, use it directly without searching. Only search when you need details, history, or context beyond what the profile provides.",
				"",
				"**Decision rule:** Injected context answers the question → respond directly. Injected context is insufficient or stale → then search.",
				"",
				"**When to search explicitly:**",
				"- The auto-injected context doesn't cover what you need",
				"- You need results from a specific time range (use `after`/`before`)",
				"- You want to search a specific container (use `containerTag`)",
				"- You need deep chunk-level search (use `mode: 'deep'`)",
				"- The question is about something not in the profile or recent context",
				"",
			)
		} else {
			lines.push(
				"### Active memory search",
				"Profile context alone is not enough. When the user's request relates to past conversations, prior decisions, specific preferences, or anything that may have been discussed before:",
				"",
				"1. **Search before you act** — call supermemory_search with a focused query before responding to questions that might involve prior context.",
				"2. **Be specific** — use targeted queries like \"user's preferred database\" rather than broad ones like \"preferences\".",
				"3. **Search on uncertainty** — if you're unsure whether the user has mentioned something before, search. It's cheap and fast.",
				"4. **Don't guess from profile alone** — the profile is a summary. Search for details when the user asks about specifics.",
			"",
			"**Search modes — when to use each:**",
			"- `mode: 'fast'` (default) — quick recall of single facts, preferences, or recent context. Use when one keyword or phrase identifies what you need.",
			"- `mode: 'deep'` — complex queries, vague questions, or 'find everything about X'. Re-ranks results with a cross-encoder for better relevance (+~100ms). Use when fast mode returns too few or irrelevant results.",
			"",
			"**Temporal filters:** Use `after` and `before` (ISO dates) to scope search to a time range (e.g. 'what did the user say last week').",
			"**Reranking:** Use `rerank: true` for better result ordering (+~100ms). Default: false for fast, true for deep.",
			"**Query expansion:** Use `rewriteQuery: true` to expand short or ambiguous queries (e.g. 'auth' → 'authentication login oauth'). Adds ~50ms. Useful when fast mode returns too few results.",
			"",
			"### Trusting recalled memories",
			"Memories reflect what was true *when stored*. Treat each result as a historical snapshot, not live state.",
			"Before acting on a memory that references files, configs, or external state — verify it still exists (read the file, check the repo, etc.).",
			"If a search result shows ⏱ (stale) or is >30 days old, treat it as a lead to investigate, not a fact to assert.",
			"",
		)
		}
	}
	if (hasStore) {
		lines.push(
			"### Storing memories",
			...(params.contextEngineActive
				? [
					"Conversation turns are usually auto-ingested by the context engine — you do not need to store routine conversational facts manually.",
					"Use supermemory_store for **explicit** user statements: preferences, corrections, decisions, or when the user says 'remember this'. These are high-signal facts that deserve their own memory entry.",
				]
				: [
					"Use supermemory_store when the user explicitly asks you to remember something, states a preference, makes a decision, or corrects you. Do not store transient task details.",
				]),
			"",
			"**Atomic facts**: Store ONE fact per call. Instead of \"User likes dark mode and uses pnpm\", make two separate calls.",
			"**Categories**: The tool auto-detects category (preference/fact/decision/entity/correction/confirmation) but you can override. Corrections are HIGH priority — they replace outdated information. Confirmations reinforce validated approaches.",
			"**Direct mode**: Use `direct: true` for explicit facts the user states directly — bypasses the document pipeline for instant searchability. Auto-detected for short preference/fact/entity text when omitted. Falls back to pipeline if v4 fails.",
			"**Deduplication**: The store automatically checks for similar existing memories. If a near-duplicate exists, it updates the existing memory instead of creating a new one.",
			"",
		)
	}
	if (hasUpdate) {
		lines.push(
			"### Updating memories",
			"Use supermemory_update when a known fact needs to change (e.g. user moved cities, changed preferences, corrected a prior statement). This creates a version chain — the old memory is preserved as history, the new version becomes current.",
			"",
			"**Params:** Pass `memoryId` (direct) or `query` (search-then-update) + `newContent`. Optional: `eventDate`, `forgetAfter` (TTL), `forgetReason`.",
			"**Update vs Store:** Store is for NEW information. Update is for CHANGING existing information. Store auto-deduplicates; Update creates explicit version history.",
			"**Update vs Correction:** When the user says 'no, actually X' — use supermemory_store with category 'correction' (force-creates distinct entry). When you need to revise a specific known memory by ID — use supermemory_update.",
			"",
		)
	}
	if (hasForget) {
		lines.push(
			"### Forgetting memories",
			"Use supermemory_forget when the user asks to delete or remove a specific memory, when information is outdated or incorrect and the user wants it gone, or when the user says \"forget that\", \"delete that memory\", or \"remove what you know about X\".",
			"",
			"**Params:** `memoryId` (direct delete) or `query` (search-then-delete). Optional: `reason` (audit trail), `containerTag`.",
			"**Thresholds:** Query-based forget uses similarity thresholds: ≥0.80 = batch delete all matches, 0.75–0.79 = delete best match only, <0.75 = refuse (too uncertain).",
			"",
		)
	}
	if (hasIngest) {
		lines.push(
			"### Ingesting content",
			...(params.contextEngineActive
				? [
					"Conversation content is normally auto-ingested by the context engine. Use supermemory_ingest for **external content**: URLs, files, documents, or raw text the user wants indexed for future recall.",
				]
				: [
					"Use supermemory_ingest as the **primary tool** for adding any content to memory. Pass a URL, raw text, or local file path — the plugin auto-detects the format and routes to the correct Supermemory endpoint. Prefer this over supermemory_documents upload.",
				]),
			"",
			"**Params:** `content` (URL, text, or file path), `customId` (your ID for dedup), `containerTag`, `metadata` (key-value pairs for filtering).",
			"**Supported content:**",
			"- URLs: web pages, hosted PDFs, YouTube videos (auto-transcribed) — just pass the URL",
			"- Local text files: pass a file path (e.g. `/workspace/docs/README.md`) — read as UTF-8. Supports .md, .txt, .json, .csv, .html, .xml, .yaml, .ts, .js, .py, .sh, .env, .cfg, etc. Restricted to agent workspace.",
			"- Local binary files: pass a file path — auto-uploaded via Supermemory's file API with MIME detection. Supports PDF, DOC, DOCX, XLSX, PPTX, images (PNG, JPG, GIF, WebP, SVG), audio (MP3, WAV, M4A, FLAC), video (MP4, WebM, MOV).",
			"- Raw text: plaintext, markdown, HTML, JSON, CSV, code",
			"- Raw base64: agent-provided base64-encoded content (data URIs or raw blobs) — sent directly to Supermemory",
			"",
			"**Limits:** Text: ~100k chars (plugin sanitize). URLs: up to 10MB (server-side fetch). Local files: up to 50MB (binary upload). Raw base64: up to 50MB.",
			"**customId:** Same customId = same document. Re-ingesting with same customId updates instead of duplicating. Use URL slug or your doc ID.",
			"**Proactive ingestion:** When the user shares a URL, doc, or large text block for discussion, ingest it so future sessions can recall it.",
			"",
		)
	}
	if (hasProfile) {
		lines.push(
			"### Profile inspection",
			"Use supermemory_profile to see a full summary of what is known about the user if you need an overview beyond what was auto-injected.",
			"",
			"**Params:** Optional `query` to scope profile search results. Optional `containerTag`.",
			"",
		)
	}
	if (params.availableTools.has("supermemory_documents")) {
		lines.push(
			"### Document management",
			"Use supermemory_documents to **manage** already-ingested documents (inspect, browse, update, delete). For adding new content, prefer supermemory_ingest instead.",
			"",
			"**Actions:** `action: 'get'` + `documentId` to inspect. `action: 'list'` to browse with `sort`/`order`/`page`/`limit`/`containerTag`. `action: 'processing'` to see pipeline status. `action: 'update'` + `documentId` + `content` to update. `action: 'upload'` + `filePath` to upload a local file directly (use only when you need explicit fileType/mimeType override — otherwise use supermemory_ingest). `action: 'delete'` + `documentId` to remove.",
			"",
		)
	}
	if (params.availableTools.has("supermemory_timeline")) {
		lines.push(
			"### Memory timeline",
			"Use supermemory_timeline to see how knowledge about a topic evolved over time. Results are sorted chronologically and grouped by date.",
			"",
			"**When to use:** When the user asks 'what happened with X over time', 'history of Y', or wants to trace how a decision or preference changed.",
			"**Params:** `topic` (required), optional `after`/`before` (ISO dates), `limit` (default: 10, max: 30), `containerTag`.",
			"",
		)
	}
	if (hasSettings) {
		lines.push(
			"### Platform settings",
			"Use supermemory_settings to view or update org-level settings.",
			"",
			"**Params:** `action: 'get'` to view current settings. `action: 'update'` with `filterPrompt` (org-wide extraction prompt), `shouldLLMFilter` (toggle LLM filtering), `chunkSize` (memory granularity, -1 for default or 64-8192).",
			"",
		)
	}

	return lines
}
