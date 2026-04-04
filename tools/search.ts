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

function formatMemoryResult(r: SearchResult, i: number): string {
	const score = r.similarity
		? ` (${(r.similarity * 100).toFixed(0)}%)`
		: ""
	const versionTag = r.version != null ? ` [v${r.version}]` : ""
	const contextParts: string[] = []
	if (r.parents?.length) {
		contextParts.push(
			`   ↑ ${r.parents.length} parent(s): ${r.parents.map((p) => `"${p.memory.slice(0, 60)}" (${p.relation})`).join(", ")}`,
		)
	}
	if (r.children?.length) {
		contextParts.push(
			`   ↓ ${r.children.length} child(ren): ${r.children.map((c) => `"${c.memory.slice(0, 60)}" (${c.relation})`).join(", ")}`,
		)
	}
	const context =
		contextParts.length > 0 ? `\n${contextParts.join("\n")}` : ""
	return `${i + 1}. ${r.content || r.memory || ""}${score}${versionTag}${context}`
}

function formatDeepResult(r: DeepSearchResult, i: number): string {
	const title = r.title ? ` — ${r.title}` : ""
	const score = ` (${(r.score * 100).toFixed(0)}%)`
	const summary = r.summary ? `\n   Summary: ${r.summary}` : ""
	const relevantChunks = r.chunks.filter((c) => c.isRelevant)
	const chunkText =
		relevantChunks.length > 0
			? `\n${relevantChunks.map((c, j) => `   [chunk ${j + 1}] ${c.content.slice(0, 200)}${c.content.length > 200 ? "…" : ""}`).join("\n")}`
			: ""
	return `${i + 1}. [doc:${r.documentId.slice(0, 8)}]${title}${score}${summary}${chunkText}`
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
							"'fast' (default): memory-level search, low latency. 'deep': chunk-level search with reranking and query rewriting, higher quality but slower.",
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

				// --- Deep mode: search.documents() with chunks ---
				if (mode === "deep") {
					const deepResults = await client.deepSearch(
						params.query,
						limit,
						{
							rerank: params.rerank ?? true,
							rewriteQuery: true,
							includeSummary: true,
							...(filters && { filters }),
						},
					)

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

					return {
						content: [
							{
								type: "text" as const,
								text: `Found ${deepResults.length} documents (deep search, reranked):\n\n${text}`,
							},
						],
						details: {
							count: deepResults.length,
							mode: "deep",
							documents: deepResults.map((r) => ({
								documentId: r.documentId,
								title: r.title,
								score: r.score,
								chunkCount: r.chunks.length,
								summary: r.summary,
							})),
						},
					}
				}

				// --- Fast mode: search.memories() with optional enhancements ---
				let results: SearchResult[]

				const searchOpts = {
					...(params.rerank !== undefined && { rerank: params.rerank }),
					searchMode: "hybrid" as const,
					...(filters && { filters }),
				}

				if (cfg.categoryRouting && !params.containerTag) {
					const tags = client.getCategoryContainerTags()
					log.debug(
						`search tool: cross-container search across ${tags.length} containers`,
					)
					const allResults = await Promise.all(
						tags.map((tag) =>
							client.search(params.query, limit, tag, searchOpts),
						),
					)
					const seen = new Set<string>()
					const merged: SearchResult[] = []
					for (const batch of allResults) {
						for (const r of batch) {
							if (!seen.has(r.id)) {
								seen.add(r.id)
								merged.push(r)
							}
						}
					}
					results = merged
						.sort(
							(a, b) => (b.similarity ?? 0) - (a.similarity ?? 0),
						)
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
