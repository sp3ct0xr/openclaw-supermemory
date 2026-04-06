import { Type } from "@sinclair/typebox"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import { type SupermemoryClient, buildTemporalFilters } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { log } from "../logger.ts"

function formatDate(iso: string | undefined | null): string {
	if (!iso) return "unknown date"
	try {
		const d = new Date(iso)
		if (Number.isNaN(d.getTime())) return "unknown date"
		return d.toISOString().slice(0, 10) // YYYY-MM-DD
	} catch {
		return "unknown date"
	}
}

export function registerTimelineTool(
	api: OpenClawPluginApi,
	client: SupermemoryClient,
	_cfg: SupermemoryConfig,
): void {
	api.registerTool(
		{
			name: "supermemory_timeline",
			label: "Memory Timeline",
			description:
				"Get a chronological timeline of memories related to a topic. Results are sorted by date, showing how knowledge evolved over time.",
			parameters: Type.Object({
				topic: Type.String({
					description: "Topic to build timeline for (e.g., 'project X', 'user preferences')",
				}),
				after: Type.Optional(
					Type.String({
						description: "Only include memories after this ISO date (e.g., '2026-01-01')",
					}),
				),
				before: Type.Optional(
					Type.String({
						description: "Only include memories before this ISO date (e.g., '2026-04-01')",
					}),
				),
				limit: Type.Optional(
					Type.Number({
						description: "Max timeline entries (default: 10, max: 30)",
					}),
				),
				containerTag: Type.Optional(
					Type.String({
						description: "Optional container tag to search in a specific container",
					}),
				),
			}),
			async execute(
				_toolCallId: string,
				params: {
					topic: string
					after?: string
					before?: string
					limit?: number
					containerTag?: string
				},
			) {
				const limit = Math.min(params.limit ?? 10, 30)
				// Fetch more than needed to ensure good coverage after sorting
				const fetchLimit = Math.min(limit * 2, 30)

				const filters = buildTemporalFilters({
					after: params.after,
					before: params.before,
				})

				log.debug(
					`timeline tool: topic="${params.topic}" limit=${limit} after=${params.after ?? "none"} before=${params.before ?? "none"}`,
				)

				const results = await client.search(
					params.topic,
					fetchLimit,
					params.containerTag,
					{
						searchMode: "hybrid",
						rerank: true,
						...(filters && { filters }),
					},
				)

				if (results.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No memories found for topic "${params.topic}"${params.after ? ` after ${params.after}` : ""}${params.before ? ` before ${params.before}` : ""}.`,
							},
						],
					}
				}

				// Sort by documentDate ascending (chronological)
				const sorted = results
					.map((r) => ({
						...r,
						date: (r.metadata?.documentDate as string) ?? r.metadata?.updatedAt as string ?? "",
					}))
					.sort((a, b) => {
						if (!a.date && !b.date) return 0
						if (!a.date) return 1
						if (!b.date) return -1
						return a.date.localeCompare(b.date)
					})
					.slice(0, limit)

				// Group by date for cleaner display
				const groups = new Map<string, string[]>()
				for (const r of sorted) {
					const dateKey = formatDate(r.date)
					const existing = groups.get(dateKey) ?? []
					const versionTag = r.version != null ? ` [v${r.version}]` : ""
					existing.push(`  - ${r.content || r.memory || ""}${versionTag}`)
					groups.set(dateKey, existing)
				}

				const timeline = [...groups.entries()]
					.map(([date, entries]) => `**${date}**\n${entries.join("\n")}`)
					.join("\n\n")

				const dateRange = params.after || params.before
					? ` (${params.after ? `from ${params.after}` : ""}${params.after && params.before ? " " : ""}${params.before ? `to ${params.before}` : ""})`
					: ""

				return {
					content: [
						{
							type: "text" as const,
							text: `Timeline for "${params.topic}"${dateRange} — ${sorted.length} entries:\n\n${timeline}`,
						},
					],
					details: {
						count: sorted.length,
						dateRange: {
							earliest: sorted[0]?.date,
							latest: sorted[sorted.length - 1]?.date,
						},
					},
				}
			},
		},
		{ name: "supermemory_timeline" },
	)
}
