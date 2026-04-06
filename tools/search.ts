import { Type } from "@sinclair/typebox"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import {
	type SearchResult,
	type DeepSearchResult,
	type SupermemoryClient,
	buildTemporalFilters,
} from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { log } from "../logger.ts"

const MS_PER_DAY = 86_400_000

/** Extract a sortable timestamp from a search result (newest = highest). */
function getResultTimestamp(r: { metadata?: Record<string, unknown> | null; updatedAt?: string }): number {
	const raw = (r.metadata?.documentDate as string | undefined)
		?? (r.metadata?.timestamp as string | undefined)
		?? (r.metadata?.updatedAt as string | undefined)
		?? r.updatedAt
	if (!raw) return 0
	const t = new Date(raw).getTime()
	return Number.isNaN(t) ? 0 : t
}

/** Sort by date descending (freshest first), similarity as tiebreaker. */
function compareFreshness(
	a: { similarity?: number; score?: number; metadata?: Record<string, unknown> | null; updatedAt?: string },
	b: { similarity?: number; score?: number; metadata?: Record<string, unknown> | null; updatedAt?: string },
): number {
	const ta = getResultTimestamp(a)
	const tb = getResultTimestamp(b)
	if (ta !== tb) return tb - ta // newest first
	return (b.similarity ?? b.score ?? 0) - (a.similarity ?? a.score ?? 0) // tiebreaker
}

/**
 * Compute a freshness tag from a date string.
 * Returns "" if < 7 days or no date, a mild warning for 7-30 days,
 * and a strong warning for > 30 days.
 */
function formatFreshnessTag(
	dateStr: string | undefined | null,
): string {
	if (!dateStr) return ""
	const stored = new Date(dateStr)
	if (Number.isNaN(stored.getTime())) return ""
	const daysAgo = Math.max(
		0,
		Math.floor((Date.now() - stored.getTime()) / MS_PER_DAY),
	)
	if (daysAgo < 7) return ""
	if (daysAgo <= 30) return ` ⏱ ${daysAgo}d ago`
	return ` ⏱ ${daysAgo}d ago — verify before asserting`
}

function formatMemoryResult(r: SearchResult, i: number): string {
	const score = r.similarity
		? ` (${(r.similarity * 100).toFixed(0)}%)`
		: ""
	const versionTag = r.version != null ? ` [v${r.version}]` : ""
	const freshness = formatFreshnessTag(
		(r.metadata?.documentDate as string | undefined) ?? undefined,
	)
	const contextParts: string[] = []
	if (r.parents?.length) {
		contextParts.push(
			`   ↑ ${r.parents.length} parent(s): ${r.parents.map((p) => `"${p.memory.length > 60 ? `${p.memory.slice(0, 60)}…` : p.memory}" (${p.relation})`).join(", ")}`,
		)
	}
	if (r.children?.length) {
		contextParts.push(
			`   ↓ ${r.children.length} child(ren): ${r.children.map((c) => `"${c.memory.length > 60 ? `${c.memory.slice(0, 60)}…` : c.memory}" (${c.relation})`).join(", ")}`,
		)
	}
	const context =
		contextParts.length > 0 ? `\n${contextParts.join("\n")}` : ""
	return `${i + 1}. ${r.content || r.memory || ""}${score}${versionTag}${freshness}${context}`
}

function formatDeepResult(r: DeepSearchResult, i: number): string {
	const tag = r.type === "memory" ? "mem" : "chunk"
	const score = ` (${(r.score * 100).toFixed(0)}%)`
	const freshness = formatFreshnessTag(
		(r.metadata?.documentDate as string | undefined) ?? r.updatedAt,
	)
	const preview = r.content.slice(0, 300) + (r.content.length > 300 ? "…" : "")
	const version = r.version ? ` v${r.version}` : ""
	return `${i + 1}. [${tag}:${r.id.slice(0, 8)}]${score}${version}${freshness}\n   ${preview}`
}

export function registerSearchTool(
	api: OpenClawPluginApi,
	client: SupermemoryClient,
	cfg: SupermemoryConfig,
): void {
	api.registerTool(
		{
			name: "supermemory_search",
			label: "Memory Search",
			description:
				"Search long-term memories. Use mode='fast' (default) for quick memory lookups, or mode='deep' for detailed chunk-level search with reranking.",
			parameters: Type.Object({
				query: Type.String({ description: "Search query" }),
				mode: Type.Optional(
					Type.Unsafe<string>({
						type: "string",
						enum: ["fast", "deep"],
						description:
							"'fast' (default): memory-level search, low latency. 'deep': chunk-level search with reranking, higher quality but slower.",
					}),
				),
				limit: Type.Optional(
					Type.Number({ description: "Max results (default: 5)" }),
				),
				after: Type.Optional(
					Type.String({
						description:
							"Only return memories created after this ISO date (e.g. '2026-03-01')",
					}),
				),
				before: Type.Optional(
					Type.String({
						description:
							"Only return memories created before this ISO date (e.g. '2026-04-01')",
					}),
				),
				rerank: Type.Optional(
					Type.Boolean({
						description:
							"Re-score results with cross-encoder for better ranking (+~100ms). Default: false for fast, true for deep.",
					}),
				),
				rewriteQuery: Type.Optional(
					Type.Boolean({
						description:
							"Expand query for better recall (e.g., 'auth' → 'authentication login oauth'). Useful for short or ambiguous queries.",
					}),
				),
				containerTag: Type.Optional(
					Type.String({
						description:
							"Optional container tag to search in a specific container",
					}),
				),
			}),
			async execute(
				_toolCallId: string,
				params: {
					query: string
					mode?: string
					limit?: number
					after?: string
					before?: string
					rerank?: boolean
					rewriteQuery?: boolean
					containerTag?: string
				},
			) {
				const mode = params.mode === "deep" ? "deep" : "fast"
				const limit = params.limit ?? 5
				const filters = buildTemporalFilters({
					after: params.after,
					before: params.before,
				})

				log.debug(
					`search tool: mode=${mode} query="${params.query}" limit=${limit} after=${params.after ?? "none"} before=${params.before ?? "none"} rerank=${params.rerank ?? "default"}`,
				)

				// --- Deep mode: search.memories() with reranking ---
				if (mode === "deep") {
					const deepOpts = {
						limit,
						rerank: params.rerank ?? true,
						...(params.rewriteQuery !== undefined && { rewriteQuery: params.rewriteQuery }),
						...(filters && { filters }),
					}

					// Root+topic dual deep search
					const rootTag = client.getContainerTag()
					let deepResults: DeepSearchResult[]
					if (params.containerTag && cfg.enableCustomContainerTags && params.containerTag !== rootTag) {
						log.debug(`search tool: deep dual search — root + ${params.containerTag}`)
						const [rootResults, topicResults] = await Promise.all([
							client.deepSearch(params.query, { ...deepOpts, containerTag: rootTag }),
							client.deepSearch(params.query, { ...deepOpts, containerTag: params.containerTag }),
						])
						const seen = new Set<string>()
						const merged: DeepSearchResult[] = []
						for (const r of [...topicResults, ...rootResults]) {
							if (!seen.has(r.id)) {
								seen.add(r.id)
								merged.push(r)
							}
						}
						deepResults = merged
							.sort(compareFreshness)
							.slice(0, limit)
					} else {
						deepResults = await client.deepSearch(
							params.query,
							{ ...deepOpts, ...(params.containerTag && { containerTag: params.containerTag }) },
						)
					}

					if (deepResults.length === 0) {
						return {
							content: [
								{
									type: "text" as const,
									text: "No relevant documents found (deep search).",
								},
							],
						}
					}

					const text = deepResults
						.map(formatDeepResult)
						.join("\n")

					const memCount = deepResults.filter((r) => r.type === "memory").length
					const chunkCount = deepResults.filter((r) => r.type === "chunk").length

					return {
						content: [
							{
								type: "text" as const,
								text: `Found ${deepResults.length} results (deep search, reranked — ${memCount} memories, ${chunkCount} chunks):\n\n${text}`,
							},
						],
						details: {
							count: deepResults.length,
							mode: "deep",
							memoryCount: memCount,
							chunkCount,
							results: deepResults.map((r) => ({
								id: r.id,
								type: r.type,
								score: r.score,
							})),
						},
					}
				}

				// --- Fast mode: search.memories() (defaults to hybrid, no reranking) ---
				let results: SearchResult[]

				const searchOpts = {
					...(params.rerank !== undefined && { rerank: params.rerank }),
					...(params.rewriteQuery !== undefined && { rewriteQuery: params.rewriteQuery }),
					searchMode: "hybrid" as const,
					...(filters && { filters }),
				}

				// When a topic container is specified, also search root for baseline context
				const rootTag = client.getContainerTag()
				if (params.containerTag && cfg.enableCustomContainerTags && params.containerTag !== rootTag) {
					log.debug(`search tool: dual search — root + ${params.containerTag}`)
					const [rootResults, topicResults] = await Promise.all([
						client.search(params.query, limit, rootTag, searchOpts),
						client.search(params.query, limit, params.containerTag, searchOpts),
					])
					const seen = new Set<string>()
					const merged: SearchResult[] = []
					for (const r of [...topicResults, ...rootResults]) {
						if (!seen.has(r.id)) {
							seen.add(r.id)
							merged.push(r)
						}
					}
					results = merged
						.sort(compareFreshness)
						.slice(0, limit)
				} else {
					results = await client.search(
						params.query,
						limit,
						params.containerTag,
						searchOpts,
					)
				}

				if (results.length === 0) {
					return {
						content: [
							{ type: "text" as const, text: "No relevant memories found." },
						],
					}
				}

				const text = results.map(formatMemoryResult).join("\n")

				return {
					content: [
						{
							type: "text" as const,
							text: `Found ${results.length} memories:\n\n${text}`,
						},
					],
					details: {
						count: results.length,
						mode: "fast",
						memories: results.map((r) => ({
							id: r.id,
							content: r.content,
							similarity: r.similarity,
							...(r.version != null && { version: r.version }),
							...(r.parents?.length && { parents: r.parents }),
							...(r.children?.length && { children: r.children }),
						})),
					},
				}
			},
		},
		{ name: "supermemory_search" },
	)
}
