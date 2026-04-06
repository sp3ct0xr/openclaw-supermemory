import { Type } from "@sinclair/typebox"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { SupermemoryClient } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { log } from "../logger.ts"
import {
	buildDocumentId,
	detectCategory,
	MEMORY_CATEGORIES,
	type MemoryCategory,
} from "../memory.ts"

export function registerStoreTool(
	api: OpenClawPluginApi,
	client: SupermemoryClient,
	cfg: SupermemoryConfig,
	getSessionKey: () => string | undefined,
): void {
	api.registerTool(
		{
			name: "supermemory_store",
			label: "Memory Store",
			description:
				"Save important information to long-term memory. Automatically deduplicates: if a very similar memory already exists, it will be updated instead of duplicated.",
			parameters: Type.Object({
				text: Type.String({ description: "Information to remember" }),
				category: Type.Optional(
					Type.Unsafe<string>({ type: "string", enum: [...MEMORY_CATEGORIES] }),
				),
				permanent: Type.Optional(
					Type.Boolean({
						description:
							"Mark as permanent identity trait (name, hometown, core preferences). Permanent memories are never auto-forgotten by Supermemory. Default: false.",
					}),
				),
				eventDate: Type.Optional(
					Type.String({
						description:
							"ISO 8601 date of when the event being remembered occurred (e.g. '2026-04-01'). Auto-detected if omitted.",
					}),
				),
				containerTag: Type.Optional(
					Type.String({
						description:
							"Optional container tag to store the memory in a specific container",
					}),
				),
			}),
			async execute(
				_toolCallId: string,
				params: {
					text: string
					category?: string
					permanent?: boolean
					eventDate?: string
					containerTag?: string
				},
			) {
				const category = (params.category ??
					detectCategory(params.text)) as MemoryCategory
				const sk = getSessionKey()
				const customId = sk ? buildDocumentId(sk) : undefined
				const now = new Date().toISOString()

				// Resolve container based on category routing
				const routedTag = client.resolveContainerTag(
					category,
					params.containerTag,
					cfg.categoryRouting,
				)

				log.debug(
					`store tool: category="${category}" customId="${customId}" containerTag="${routedTag}" eventDate="${params.eventDate ?? "none"}"`,
				)

				// Dedup-aware: search for similar memory, update if found
				const result = await client.addOrUpdateMemory({
					content: params.text,
					category,
					isStatic: params.permanent ?? false,
					metadata: {
						type: category,
						source: "openclaw_tool",
						documentDate: now,
						...(params.eventDate && { eventDate: params.eventDate }),
					},
					customId,
					containerTag: routedTag,
					entityContext: cfg.entityContext,
				})

				const preview =
					params.text.length > 80
						? `${params.text.slice(0, 80)}…`
						: params.text
				const actionLabel =
					result.action === "updated"
						? `Updated (v${result.version})`
						: "Stored"

				return {
					content: [
						{
							type: "text" as const,
							text: `${actionLabel}: "${preview}" [${category}]`,
						},
					],
				}
			},
		},
		{ name: "supermemory_store" },
	)
}
