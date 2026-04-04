import { Type } from "@sinclair/typebox"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { SearchResult, SupermemoryClient } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { log } from "../logger.ts"

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
				"Search through long-term memories for relevant information.",
			parameters: Type.Object({
				query: Type.String({ description: "Search query" }),
				limit: Type.Optional(
					Type.Number({ description: "Max results (default: 5)" }),
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
				params: { query: string; limit?: number; containerTag?: string },
			) {
				const limit = params.limit ?? 5
				log.debug(
					`search tool: query="${params.query}" limit=${limit} containerTag="${params.containerTag ?? "default"}"`,
				)

				let results: SearchResult[]

				if (cfg.categoryRouting && !params.containerTag) {
					// When category routing is enabled, search across all
					// category containers and merge results by similarity.
					const tags = client.getCategoryContainerTags()
					log.debug(
						`search tool: cross-container search across ${tags.length} containers`,
					)
					const allResults = await Promise.all(
						tags.map((tag) => client.search(params.query, limit, tag)),
					)
					// Merge, deduplicate by id, sort by similarity desc, take top N
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
					)
				}

				if (results.length === 0) {
					return {
						content: [
							{ type: "text" as const, text: "No relevant memories found." },
						],
					}
				}

				const text = results
					.map((r, i) => {
						const score = r.similarity
							? ` (${(r.similarity * 100).toFixed(0)}%)`
							: ""
						return `${i + 1}. ${r.content || r.memory || ""}${score}`
					})
					.join("\n")

				return {
					content: [
						{
							type: "text" as const,
							text: `Found ${results.length} memories:\n\n${text}`,
						},
					],
					details: {
						count: results.length,
						memories: results.map((r) => ({
							id: r.id,
							content: r.content,
							similarity: r.similarity,
						})),
					},
				}
			},
		},
		{ name: "supermemory_search" },
	)
}
