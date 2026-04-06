import { Type } from "@sinclair/typebox"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { SupermemoryClient } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { log } from "../logger.ts"

/** Extract a sortable timestamp from a search result. */
function getResultTimestamp(r: { metadata?: Record<string, unknown> }): number {
	const raw = (r.metadata?.documentDate as string | undefined)
		?? (r.metadata?.timestamp as string | undefined)
		?? (r.metadata?.updatedAt as string | undefined)
	if (!raw) return 0
	const t = new Date(raw).getTime()
	return Number.isNaN(t) ? 0 : t
}

export function registerUpdateTool(
	api: OpenClawPluginApi,
	client: SupermemoryClient,
	cfg: SupermemoryConfig,
): void {
	api.registerTool(
		{
			name: "supermemory_update",
			label: "Memory Update",
			description:
				"Update an existing memory with new content. The old version is preserved in a version chain. Use this when a user corrects a preference, updates a fact, or adds detail to something already stored.",
			parameters: Type.Object({
				query: Type.Optional(
					Type.String({
						description:
							"Describe the existing memory to update. The closest match will be found and updated.",
					}),
				),
				memoryId: Type.Optional(
					Type.String({
						description: "Direct memory ID to update (from a previous search result)",
					}),
				),
				newContent: Type.String({
					description: "The updated content that replaces the old memory",
				}),
				eventDate: Type.Optional(
					Type.String({
						description:
							"ISO 8601 date of when the event being updated occurred (e.g. '2026-04-01')",
					}),
				),
				forgetAfter: Type.Optional(
					Type.String({
						description:
							"ISO 8601 datetime after which this memory should auto-expire (e.g. '2026-04-15T00:00:00Z')",
					}),
				),
				forgetReason: Type.Optional(
					Type.String({
						description:
							"Reason for scheduled expiry (e.g. 'temporary project deadline')",
					}),
				),
				containerTag: Type.Optional(
					Type.String({
						description:
							"Optional container tag to scope the update",
					}),
				),
			}),
			async execute(
				_toolCallId: string,
				params: {
					query?: string
					memoryId?: string
					newContent: string
					eventDate?: string
					forgetAfter?: string
					forgetReason?: string
					containerTag?: string
				},
			) {
				const now = new Date().toISOString()

				// Resolve the memory to update
				let targetId: string | undefined = params.memoryId
				let targetContent: string | undefined

				if (!targetId && params.query) {
					log.debug(
						`update tool: searching for memory matching query="${params.query}"`,
					)
					// When a topic container is specified, also search root
					const rootTag = client.getContainerTag()
					let results: Awaited<ReturnType<typeof client.search>>
					if (params.containerTag && cfg.enableCustomContainerTags && params.containerTag !== rootTag) {
						const [rootResults, topicResults] = await Promise.all([
							client.search(params.query!, 1, rootTag),
							client.search(params.query!, 1, params.containerTag),
						])
						results = [...topicResults, ...rootResults]
							.sort((a, b) => {
								const ta = getResultTimestamp(a)
								const tb = getResultTimestamp(b)
								if (ta !== tb) return tb - ta
								return (b.similarity ?? 0) - (a.similarity ?? 0)
							})
							.slice(0, 1)
					} else {
						results = await client.search(
							params.query,
							1,
							params.containerTag,
						)
					}
					const topMatch = results[0]
					if (results.length === 0 || !topMatch) {
						return {
							content: [
								{
									type: "text" as const,
									text: `No existing memory found matching "${params.query}". Use supermemory_store to create a new memory instead.`,
								},
							],
						}
					}
					targetId = topMatch.id
					targetContent = topMatch.content || topMatch.memory
					log.debug(
						`update tool: found memory id="${targetId}" content="${(targetContent ?? "").slice(0, 50)}"`,
					)
				}

				if (!targetId && !targetContent) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Provide a query or memoryId to identify the memory to update.",
							},
						],
					}
				}

				const temporalContext: {
					documentDate?: string
					eventDate?: string[]
				} = { documentDate: now }
				if (params.eventDate) {
					temporalContext.eventDate = [params.eventDate]
				}

				const result = await client.updateMemory({
					newContent: params.newContent,
					containerTag: params.containerTag,
					...(targetId && { id: targetId }),
					...(targetContent && !targetId && { content: targetContent }),
					temporalContext,
					...(params.forgetAfter !== undefined && {
						forgetAfter: params.forgetAfter,
					}),
					...(params.forgetReason !== undefined && {
						forgetReason: params.forgetReason,
					}),
				})

				const preview =
					params.newContent.length > 80
						? `${params.newContent.slice(0, 80)}…`
						: params.newContent

				const versionInfo = result.version > 1
					? ` (v${result.version}, chain: ${result.rootMemoryId ?? result.id})`
					: ""

				return {
					content: [
						{
							type: "text" as const,
							text: `Updated: "${preview}"${versionInfo}`,
						},
					],
					details: {
						id: result.id,
						version: result.version,
						rootMemoryId: result.rootMemoryId,
						parentMemoryId: result.parentMemoryId,
					},
				}
			},
		},
		{ name: "supermemory_update" },
	)
}
