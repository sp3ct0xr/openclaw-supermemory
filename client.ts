import Supermemory from "supermemory"
import {
	sanitizeContent,
	validateApiKeyFormat,
	validateContainerTag,
} from "./lib/validate.js"
import { log } from "./logger.ts"
import {
	CATEGORY_CONTAINER_SUFFIX,
	type MemoryCategory,
	clampEntityContext,
} from "./memory.ts"

export type VersionChainContext = {
	memory: string
	relation: "updates" | "extends" | "derives"
	updatedAt: string
	metadata?: Record<string, unknown> | null
	version?: number | null
}

export type SearchResult = {
	id: string
	content: string
	memory?: string
	similarity?: number
	metadata?: Record<string, unknown>
	/** Version number of this memory entry (from version chain) */
	version?: number | null
	/** Parent memories in the version chain */
	parents?: VersionChainContext[]
	/** Child memories in the version chain */
	children?: VersionChainContext[]
}

export type DeepSearchResult = {
	documentId: string
	title: string | null
	score: number
	chunks: { content: string; score: number; isRelevant: boolean }[]
	summary?: string | null
	content?: string | null
	metadata?: Record<string, unknown> | null
	createdAt: string
	updatedAt: string
}

export type ProfileSearchResult = {
	memory?: string
	updatedAt?: string
	similarity?: number
	[key: string]: unknown
}

/** Build an AND filter expression for temporal date range filtering. */
export function buildTemporalFilters(params: {
	after?: string
	before?: string
	dateField?: string
}): { AND: Array<{ key: string; value: string; filterType: "metadata"; numericOperator: ">" | "<" }> } | undefined {
	const field = params.dateField ?? "documentDate"
	const conditions: Array<{ key: string; value: string; filterType: "metadata"; numericOperator: ">" | "<" }> = []
	if (params.after) {
		conditions.push({
			key: field,
			value: params.after,
			filterType: "metadata",
			numericOperator: ">",
		})
	}
	if (params.before) {
		conditions.push({
			key: field,
			value: params.before,
			filterType: "metadata",
			numericOperator: "<",
		})
	}
	return conditions.length > 0 ? { AND: conditions } : undefined
}

export type ProfileResult = {
	static: string[]
	dynamic: string[]
	searchResults: ProfileSearchResult[]
}

function limitText(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text
}

export class SupermemoryClient {
	private client: Supermemory
	private containerTag: string

	constructor(apiKey: string, containerTag: string) {
		const keyCheck = validateApiKeyFormat(apiKey)
		if (!keyCheck.valid) {
			throw new Error(`invalid API key: ${keyCheck.reason}`)
		}

		const tagCheck = validateContainerTag(containerTag)
		if (!tagCheck.valid) {
			log.warn(`container tag warning: ${tagCheck.reason}`)
		}

		this.client = new Supermemory({ apiKey })
		this.containerTag = containerTag
		log.info(`initialized (container: ${containerTag})`)
	}

	/**
	 * Resolve a container tag based on memory category.
	 * When `routingEnabled` is true and a category has a suffix,
	 * returns `{base}_{suffix}`. Otherwise returns the base tag.
	 */
	resolveContainerTag(
		category?: MemoryCategory,
		explicitTag?: string,
		routingEnabled = false,
	): string {
		if (explicitTag) return explicitTag
		if (!routingEnabled || !category) return this.containerTag
		const suffix = CATEGORY_CONTAINER_SUFFIX[category]
		return suffix ? `${this.containerTag}_${suffix}` : this.containerTag
	}

	/**
	 * Return all category container tags (for cross-container search).
	 * Only meaningful when category routing is enabled.
	 */
	getCategoryContainerTags(): string[] {
		const tags = new Set<string>([this.containerTag])
		for (const suffix of Object.values(CATEGORY_CONTAINER_SUFFIX)) {
			if (suffix) tags.add(`${this.containerTag}_${suffix}`)
		}
		return [...tags]
	}

	async addMemory(
		content: string,
		metadata?: Record<string, string | number | boolean>,
		customId?: string,
		containerTag?: string,
		entityContext?: string,
	): Promise<{ id: string }> {
		const cleaned = sanitizeContent(content)
		const tag = containerTag ?? this.containerTag

		log.debugRequest("add", {
			contentLength: cleaned.length,
			customId,
			metadata,
			containerTag: tag,
		})

		const clampedCtx = entityContext
			? clampEntityContext(entityContext)
			: undefined

		const result = await this.client.add({
			content: cleaned,
			containerTag: tag,
			...(metadata && { metadata }),
			...(customId && { customId }),
			...(clampedCtx && { entityContext: clampedCtx }),
		})

		log.debugResponse("add", { id: result.id })
		return { id: result.id }
	}

	async search(
		query: string,
		limit = 5,
		containerTag?: string,
		opts?: {
			rerank?: boolean
			rewriteQuery?: boolean
			searchMode?: "memories" | "hybrid" | "documents"
			threshold?: number
			filters?: Record<string, unknown>
			include?: {
				documents?: boolean
				summaries?: boolean
				relatedMemories?: boolean
			}
		},
	): Promise<SearchResult[]> {
		const tag = containerTag ?? this.containerTag

		log.debugRequest("search.memories", {
			query,
			limit,
			containerTag: tag,
			...(opts && {
				rerank: opts.rerank,
				rewriteQuery: opts.rewriteQuery,
				searchMode: opts.searchMode,
				threshold: opts.threshold,
			}),
		})

		const response = await this.client.search.memories({
			q: query,
			containerTag: tag,
			limit,
			...(opts?.rerank !== undefined && { rerank: opts.rerank }),
			...(opts?.rewriteQuery !== undefined && { rewriteQuery: opts.rewriteQuery }),
			...(opts?.searchMode && { searchMode: opts.searchMode }),
			...(opts?.threshold !== undefined && { threshold: opts.threshold }),
			...(opts?.filters && { filters: opts.filters as any }),
			...(opts?.include && { include: opts.include }),
		})

		const results: SearchResult[] = (response.results ?? []).map((r) => ({
			id: r.id,
			content: r.memory ?? r.chunk ?? "",
			memory: r.memory,
			similarity: r.similarity,
			metadata: r.metadata ?? undefined,
			version: r.version ?? undefined,
			parents: r.context?.parents ?? undefined,
			children: r.context?.children ?? undefined,
		}))

		log.debugResponse("search.memories", { count: results.length })
		return results
	}

	/** Deep search via search.documents() — returns chunk-level results with reranking. */
	async deepSearch(
		query: string,
		opts?: {
			limit?: number
			rerank?: boolean
			rewriteQuery?: boolean
			filters?: Record<string, unknown>
			includeFullDocs?: boolean
			includeSummary?: boolean
			chunkThreshold?: number
			containerTags?: string[]
		},
	): Promise<DeepSearchResult[]> {
		const limit = opts?.limit ?? 5
		log.debugRequest("search.documents", {
			query,
			limit,
			rerank: opts?.rerank,
			rewriteQuery: opts?.rewriteQuery,
			containerTags: opts?.containerTags,
		})

		const response = await this.client.search.documents({
			q: query,
			limit,
			rerank: opts?.rerank ?? true,
			rewriteQuery: opts?.rewriteQuery ?? true,
			...(opts?.containerTags && { containerTags: opts.containerTags }),
			...(opts?.filters && { filters: opts.filters as any }),
			...(opts?.includeFullDocs !== undefined && { includeFullDocs: opts.includeFullDocs }),
			...(opts?.includeSummary !== undefined && { includeSummary: opts.includeSummary }),
			...(opts?.chunkThreshold !== undefined && { chunkThreshold: opts.chunkThreshold }),
		})

		const results: DeepSearchResult[] = (response.results ?? []).map((r) => ({
			documentId: r.documentId,
			title: r.title,
			score: r.score,
			chunks: r.chunks.map((c) => ({
				content: c.content,
				score: c.score,
				isRelevant: c.isRelevant,
			})),
			summary: r.summary,
			content: r.content,
			metadata: r.metadata,
			createdAt: r.createdAt,
			updatedAt: r.updatedAt,
		}))

		log.debugResponse("search.documents", { count: results.length })
		return results
	}

	async getProfile(
		query?: string,
		containerTag?: string,
	): Promise<ProfileResult> {
		const tag = containerTag ?? this.containerTag

		log.debugRequest("profile", { containerTag: tag, query })

		const response = await this.client.profile({
			containerTag: tag,
			...(query && { q: query }),
		})

		log.debugResponse("profile.raw", response)

		const result: ProfileResult = {
			static: response.profile?.static ?? [],
			dynamic: response.profile?.dynamic ?? [],
			searchResults: (response.searchResults?.results ??
				[]) as ProfileSearchResult[],
		}

		log.debugResponse("profile", {
			staticCount: result.static.length,
			dynamicCount: result.dynamic.length,
			searchCount: result.searchResults.length,
		})
		return result
	}

	async updateMemory(params: {
		newContent: string
		containerTag?: string
		id?: string
		content?: string
		temporalContext?: {
			documentDate?: string | null
			eventDate?: string[] | null
		}
		forgetAfter?: string | null
		forgetReason?: string | null
		metadata?: Record<string, string | number | boolean | string[]>
	}): Promise<{
		id: string
		memory: string
		version: number
		rootMemoryId: string | null
		parentMemoryId: string | null
	}> {
		const tag = params.containerTag ?? this.containerTag

		log.debugRequest("memories.updateMemory", {
			id: params.id,
			contentMatch: params.content ? `${params.content.slice(0, 50)}…` : undefined,
			newContentLength: params.newContent.length,
			containerTag: tag,
			temporalContext: params.temporalContext,
			forgetAfter: params.forgetAfter,
		})

		const result = await this.client.memories.updateMemory({
			containerTag: tag,
			newContent: sanitizeContent(params.newContent),
			...(params.id && { id: params.id }),
			...(params.content && { content: params.content }),
			...(params.temporalContext && { temporalContext: params.temporalContext }),
			...(params.forgetAfter !== undefined && { forgetAfter: params.forgetAfter }),
			...(params.forgetReason !== undefined && { forgetReason: params.forgetReason }),
			...(params.metadata && { metadata: params.metadata }),
		})

		log.debugResponse("memories.updateMemory", {
			id: result.id,
			version: result.version,
			rootMemoryId: result.rootMemoryId,
			parentMemoryId: result.parentMemoryId,
		})

		return {
			id: result.id,
			memory: result.memory,
			version: result.version,
			rootMemoryId: result.rootMemoryId,
			parentMemoryId: result.parentMemoryId,
		}
	}

	async deleteMemory(
		id: string,
		containerTag?: string,
		reason?: string,
	): Promise<{ id: string; forgotten: boolean }> {
		const tag = containerTag ?? this.containerTag

		log.debugRequest("memories.delete", {
			id,
			containerTag: tag,
			reason,
		})
		const result = await this.client.memories.forget({
			containerTag: tag,
			id,
			...(reason && { reason }),
		})
		log.debugResponse("memories.delete", result)
		return result
	}

	async forgetByQuery(
		query: string,
		containerTag?: string,
	): Promise<{ success: boolean; message: string }> {
		log.debugRequest("forgetByQuery", { query, containerTag })

		const results = await this.search(query, 5, containerTag)
		if (results.length === 0) {
			return { success: false, message: "No matching memory found to forget." }
		}

		const target = results[0]
		await this.deleteMemory(target.id, containerTag)

		const preview = limitText(target.content || target.memory || "", 100)
		return { success: true, message: `Forgot: "${preview}"` }
	}

	async wipeAllMemories(): Promise<{ deletedCount: number }> {
		log.debugRequest("wipe", { containerTag: this.containerTag })

		const allIds: string[] = []
		let page = 1

		while (true) {
			const response = await this.client.documents.list({
				containerTags: [this.containerTag],
				limit: 100,
				page,
			})

			if (!response.memories || response.memories.length === 0) break

			for (const doc of response.memories) {
				if (doc.id) allIds.push(doc.id)
			}

			if (
				!response.pagination?.totalPages ||
				page >= response.pagination.totalPages
			)
				break
			page++
		}

		if (allIds.length === 0) {
			log.debug("wipe: no documents found")
			return { deletedCount: 0 }
		}

		log.debug(`wipe: found ${allIds.length} documents, deleting in batches`)

		let deletedCount = 0
		for (let i = 0; i < allIds.length; i += 100) {
			const batch = allIds.slice(i, i + 100)
			await this.client.documents.deleteBulk({ ids: batch })
			deletedCount += batch.length
		}

		log.debugResponse("wipe", { deletedCount })
		return { deletedCount }
	}

	async batchAddMemories(
		documents: {
			content: string
			metadata?: Record<string, string | number | boolean>
			customId?: string
		}[],
		containerTag?: string,
	): Promise<{ success: number; failed: number }> {
		if (documents.length === 0) {
			return { success: 0, failed: 0 }
		}

		const tag = containerTag ?? this.containerTag

		log.debugRequest("documents.batchAdd", {
			count: documents.length,
			containerTag: tag,
		})

		// entityContext is NOT available in DocumentBatchAddParams (SDK v4.21.1).
		// It only exists on DocumentAddParams (single-add). The batch endpoint
		// does not accept it at any level (neither per-document nor top-level).
		// Entity context must be configured separately via single add or
		// container-level settings in the SuperMemory dashboard.
		const prepared = documents.map((doc) => {
			const cleaned = sanitizeContent(doc.content)
			return {
				content: cleaned,
				containerTag: tag,
				...(doc.metadata && { metadata: doc.metadata }),
				...(doc.customId && { customId: doc.customId }),
			}
		})

		const result = await this.client.documents.batchAdd({
			documents: prepared,
		})

		log.debugResponse("documents.batchAdd", {
			success: result.success,
			failed: result.failed,
		})

		if (result.failed > 0) {
			const errors = result.results
				.filter((r) => r.status === "error")
				.map((r) => r.error ?? r.details ?? "unknown")
			log.warn(
				`batchAdd: ${result.failed} failures: ${errors.join("; ")}`,
			)
		}

		return { success: result.success, failed: result.failed }
	}

	/** Dedup-aware add: search for similar memory first, update if found. */
	async addOrUpdateMemory(params: {
		content: string
		category?: MemoryCategory
		metadata?: Record<string, string | number | boolean>
		customId?: string
		containerTag?: string
		entityContext?: string
		similarityThreshold?: number
	}): Promise<{ id: string; action: "created" | "updated"; version?: number }> {
		const tag = params.containerTag ?? this.containerTag
		const threshold = params.similarityThreshold ?? 0.90

		// Corrections should NEVER be deduped — force-create as a distinct memory
		const skipDedup = params.category === "correction"

		if (!skipDedup) {
			// Search for existing similar memories
			try {
				const existing = await this.search(params.content, 3, tag)
				const match = existing.find(
					(r) => r.similarity !== undefined && r.similarity >= threshold,
				)

				if (match) {
					log.info(
						`dedup: found similar memory (id=${match.id}, similarity=${match.similarity?.toFixed(3)}), updating instead of creating`,
					)
					const result = await this.updateMemory({
						id: match.id,
						newContent: params.content,
						containerTag: tag,
						metadata: params.metadata,
						temporalContext: {
							documentDate: new Date().toISOString(),
						},
					})
					return {
						id: result.id,
						action: "updated",
						version: result.version,
					}
				}
			} catch (err) {
				log.debug("dedup: search failed, falling through to create", err)
			}
		} else {
			log.info(`dedup: skipped for category="correction" — force-creating new memory`)
		}

		// No match — create new memory
		const result = await this.addMemory(
			params.content,
			params.metadata,
			params.customId,
			tag,
			params.entityContext,
		)
		return { id: result.id, action: "created" }
	}

	getContainerTag(): string {
		return this.containerTag
	}
}
