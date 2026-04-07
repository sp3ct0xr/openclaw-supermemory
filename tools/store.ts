import { Type } from "@sinclair/typebox"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { SupermemoryClient } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { clearProfileCache, PROFILE_TRIGGERS, PROFILE_RELEVANT_CATEGORIES } from "../hooks/recall.ts"
import { log } from "../logger.ts"
import {
	buildDocumentId,
	detectCategory,
	MEMORY_CATEGORIES,
	type MemoryCategory,
} from "../memory.ts"
import { stripRuntimeContext } from "../utils/strip-runtime-context.ts"
import { textSimilarity, CORRECTION_SIMILARITY_THRESHOLD } from "../utils/text-similarity.ts"

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
				direct: Type.Optional(
					Type.Boolean({
						description:
							"Use direct v4 memory creation for immediate searchability (bypasses document pipeline). Best for explicit facts the user states directly. Auto-detected when omitted.",
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
					direct?: boolean
					eventDate?: string
					containerTag?: string
				},
			) {
				// Security: strip runtime context (session keys, internal metadata) from stored content
				params.text = stripRuntimeContext(params.text).trim()
				if (!params.text) {
					return {
						content: [{ type: "text" as const, text: "Nothing to store after removing runtime metadata." }],
					}
				}

				const category = (params.category ??
					detectCategory(params.text)) as MemoryCategory
				const sk = getSessionKey()
				const customId = sk ? buildDocumentId(sk) : undefined
				const now = new Date().toISOString()

				const routedTag = params.containerTag ?? undefined

				// Smart correction: search for contradicted memory and update instead of creating parallel
				if (category === "correction") {
					try {
						const searchResults = await client.search(params.text, 5, routedTag)
						let bestMatch: { id: string; content: string; similarity: number } | null = null

						for (const result of searchResults) {
							const sim = textSimilarity(params.text, result.content)
							if (sim >= CORRECTION_SIMILARITY_THRESHOLD && (!bestMatch || sim > bestMatch.similarity)) {
								bestMatch = { id: result.id, content: result.content, similarity: sim }
							}
						}

						if (bestMatch) {
							log.debug(
								`store: correction match found (id=${bestMatch.id}, similarity=${bestMatch.similarity.toFixed(3)}), updating instead of creating`,
							)
							const updated = await client.updateMemory({
								id: bestMatch.id,
								newContent: params.text,
								containerTag: routedTag,
								metadata: {
									type: category,
									source: "openclaw_tool",
									documentDate: new Date().toISOString(),
								},
							})

							if (PROFILE_RELEVANT_CATEGORIES.has(category) || PROFILE_TRIGGERS.test(params.text)) {
								clearProfileCache()
								log.debug("store: profile cache invalidated — correction updated existing memory")
							}

							return {
								content: [
									{
										type: "text" as const,
										text: `Corrected (v${updated.version}): "${preview}" [${category}] — replaced memory ${bestMatch.id.slice(0, 8)}… (similarity: ${bestMatch.similarity.toFixed(2)})`,
									},
								],
							}
						}

						log.debug("store: correction — no similar memory found above threshold, falling through to normal store")
					} catch (err) {
						log.warn("store: correction search/update failed, falling through to normal store", err)
					}
				}

				// Auto-detect direct mode: short explicit facts (preference/fact/entity) use v4 direct
				const useDirect = params.direct ?? (
					["preference", "fact", "entity"].includes(category) &&
					params.text.length < 500
				)

				log.debug(
					`store tool: category="${category}" direct=${useDirect} customId="${customId}" containerTag="${routedTag}" eventDate="${params.eventDate ?? "none"}"`,
				)

				const preview =
					params.text.length > 80
						? `${params.text.slice(0, 80)}…`
						: params.text

				// v4 Direct path: immediate searchability, bypasses document pipeline
				if (useDirect) {
					try {
						const directResult = await client.createMemoryDirect({
							content: params.text,
							containerTag: routedTag,
							isStatic: params.permanent ?? false,
							metadata: {
								type: category,
								source: "openclaw_tool",
								documentDate: now,
							},
							temporalContext: {
								documentDate: now,
								...(params.eventDate && { eventDate: [params.eventDate] }),
							},
						})
						// Invalidate profile cache for profile-relevant categories or content
						if (PROFILE_RELEVANT_CATEGORIES.has(category) || PROFILE_TRIGGERS.test(params.text)) {
							clearProfileCache()
							log.debug('store: profile cache invalidated (direct path) — profile-relevant category or content stored')
						}

						const staticLabel = directResult.isStatic ? " ⊛" : ""
						return {
							content: [
								{
									type: "text" as const,
									text: `Stored (instant): "${preview}" [${category}]${staticLabel}`,
								},
							],
						}
					} catch (err) {
						// Fallback to pipeline path if v4 direct fails
						log.warn("store: v4 direct creation failed, falling back to pipeline", err)
					}
				}

				// Pipeline path: dedup-aware, goes through SM extraction pipeline
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

				// Invalidate profile cache for profile-relevant categories or content
				if (PROFILE_RELEVANT_CATEGORIES.has(category) || PROFILE_TRIGGERS.test(params.text)) {
					clearProfileCache()
					log.debug('store: profile cache invalidated — profile-relevant category or content stored')
				}

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
