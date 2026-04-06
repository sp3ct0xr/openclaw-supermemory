import { Type } from "@sinclair/typebox"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { SupermemoryClient } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { log } from "../logger.ts"

export function registerForgetTool(
	api: OpenClawPluginApi,
	client: SupermemoryClient,
	cfg: SupermemoryConfig,
): void {
	api.registerTool(
		{
			name: "supermemory_forget",
			label: "Memory Forget",
			description:
				"Forget/delete a specific memory. Searches for the closest match and removes it.",
			parameters: Type.Object({
				query: Type.Optional(
					Type.String({ description: "Describe the memory to forget" }),
				),
				memoryId: Type.Optional(
					Type.String({ description: "Direct memory ID to delete" }),
				),
				reason: Type.Optional(
					Type.String({
						description:
							"Reason for forgetting this memory (for audit trail)",
					}),
				),
				containerTag: Type.Optional(
					Type.String({
						description:
							"Optional container tag to delete from a specific container",
					}),
				),
			}),
			async execute(
				_toolCallId: string,
				params: {
					query?: string
					memoryId?: string
					reason?: string
					containerTag?: string
				},
			) {
				if (params.memoryId) {
					log.debug(
						`forget tool: direct delete id="${params.memoryId}" reason="${params.reason ?? "none"}" containerTag="${params.containerTag ?? "default"}"`,
					)
					await client.deleteMemory(
						params.memoryId,
						params.containerTag,
						params.reason,
					)
					return {
						content: [{ type: "text" as const, text: "Memory forgotten." }],
					}
				}

				if (params.query) {
					log.debug(
						`forget tool: search-then-delete query="${params.query}" reason="${params.reason ?? "none"}" containerTag="${params.containerTag ?? "default"}"`,
					)
					// When a topic container is specified, also try root
					const rootTag = client.getContainerTag()
					if (params.containerTag && cfg.enableCustomContainerTags && params.containerTag !== rootTag) {
						// Try topic container first, fall back to root
						const topicResult = await client.forgetByQuery(params.query!, params.containerTag)
						if (topicResult.success) {
							return {
								content: [{ type: "text" as const, text: topicResult.message }],
							}
						}
						// Not found in topic container, try root
						const rootResult = await client.forgetByQuery(params.query!, rootTag)
						return {
							content: [{ type: "text" as const, text: rootResult.message }],
						}
					}
					const result = await client.forgetByQuery(
						params.query,
						params.containerTag,
					)
					return {
						content: [{ type: "text" as const, text: result.message }],
					}
				}

				return {
					content: [
						{
							type: "text" as const,
							text: "Provide a query or memoryId to forget.",
						},
					],
				}
			},
		},
		{ name: "supermemory_forget" },
	)
}
