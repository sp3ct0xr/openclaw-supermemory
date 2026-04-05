import fs from "node:fs"
import path from "node:path"
import Supermemory, { toFile } from "supermemory"
import { isAllowedPath } from "./path-guard.ts"
import { deriveFileType, lookupMime } from "./mime-utils.ts"
import {
	sanitizeContent,
	validateApiKeyFormat,
	validateContainerTag,
} from "./lib/validate.js"
import { log } from "./logger.ts"
import { textSimilarity, DEDUP_SIMILARITY_THRESHOLD } from "./text-similarity.ts"
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

export type DocumentInfo = {
	id: string
	content: string | null
	summary: string | null
	title: string | null
	type: string
	status: string
	metadata: Record<string, unknown> | null
	url?: string | null
	createdAt: string
	updatedAt: string
}

export type ProcessingDocument = {
	id: string
	title: string | null
	type: string
	status: string
	createdAt: string
	updatedAt: string
}

export type DeepSearchResult = {
	id: string
	type: "memory" | "chunk"
	content: string
	score: number
	metadata: Record<string, unknown> | null
	updatedAt: string
	version?: number | null
	context?: { parents?: unknown[]; children?: unknown[] }
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

/**
 * Deduplicate an array of strings, removing exact duplicates and
 * near-duplicates (strings that are substrings of each other or
 * share high Jaro-Winkler similarity).
 */
function deduplicateStrings(items: string[]): string[] {
	if (items.length <= 1) return items

	const seen = new Set<string>()
	const result: string[] = []

	for (const item of items) {
		const normalized = item.trim()
		if (!normalized) continue

		// Exact duplicate check (case-insensitive)
		const key = normalized.toLowerCase()
		if (seen.has(key)) continue

		// Near-duplicate: check if this is a substring of an already-kept item
		// or if an already-kept item is a substring of this one
		let isDuplicate = false
		for (const existing of result) {
			const existingLower = existing.toLowerCase()
			if (existingLower.includes(key) || key.includes(existingLower)) {
				// Keep the longer one
				if (key.length > existingLower.length) {
					const idx = result.indexOf(existing)
					if (idx !== -1) {
						seen.delete(existingLower)
						result[idx] = normalized
						seen.add(key)
					}
				}
				isDuplicate = true
				break
			}

			// Fuzzy similarity check via Jaro-Winkler (handles typos, case, punctuation)
			if (textSimilarity(key, existingLower) >= DEDUP_SIMILARITY_THRESHOLD) {
				isDuplicate = true
				break
			}
		}

		if (!isDuplicate) {
			seen.add(key)
			result.push(normalized)
		}
	}

	return result
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
				forgottenMemories?: boolean
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

	/** Deep search via search.memories() with reranking — re-scores results with cross-encoder for better relevance. */
	async deepSearch(
		query: string,
		opts?: {
			limit?: number
			rerank?: boolean
			rewriteQuery?: boolean
			filters?: Record<string, unknown>
			containerTag?: string
		},
	): Promise<DeepSearchResult[]> {
		const limit = opts?.limit ?? 5
		log.debugRequest("search.memories(deep)", {
			query,
			limit,
			rerank: opts?.rerank,
			rewriteQuery: opts?.rewriteQuery,
			containerTag: opts?.containerTag,
		})

		const response = await this.client.search.memories({
			q: query,
			limit,
			searchMode: "hybrid",
			rerank: opts?.rerank ?? true,
			...(opts?.rewriteQuery !== undefined && { rewriteQuery: opts.rewriteQuery }),
			...(opts?.containerTag && { containerTag: opts.containerTag }),
			...(opts?.filters && { filters: opts.filters as any }),
		})

		const results: DeepSearchResult[] = (response.results ?? []).map((r) => ({
			id: r.id,
			type: r.memory ? "memory" as const : "chunk" as const,
			content: r.memory ?? r.chunk ?? "",
			score: r.similarity,
			metadata: r.metadata ?? null,
			updatedAt: r.updatedAt,
			version: r.version,
			context: r.context ? {
				parents: r.context.parents,
				children: r.context.children,
			} : undefined,
		}))

		log.debugResponse("search.memories(hybrid)", { count: results.length })
		return results
	}

	async getProfile(
		query?: string,
		containerTag?: string,
		opts?: {
			threshold?: number
			filters?: Record<string, unknown>
		},
	): Promise<ProfileResult> {
		const tag = containerTag ?? this.containerTag

		log.debugRequest("profile", {
			containerTag: tag,
			query,
			threshold: opts?.threshold,
		})

		const response = await this.client.profile({
			containerTag: tag,
			...(query && { q: query }),
			...(opts?.threshold !== undefined && { threshold: opts.threshold }),
			...(opts?.filters && { filters: opts.filters as any }),
		})

		log.debugResponse("profile.raw", response)

		const result: ProfileResult = {
			static: deduplicateStrings(response.profile?.static ?? []),
			dynamic: deduplicateStrings(response.profile?.dynamic ?? []),
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

		const results = await this.search(query, 10, containerTag)
		if (results.length === 0) {
			return { success: false, message: "No matching memory found to forget." }
		}

		const HIGH_THRESHOLD = 0.80
		const highConfidence = results.filter(
			(r) => r.similarity !== undefined && r.similarity >= HIGH_THRESHOLD,
		)

		if (highConfidence.length > 0) {
			// Delete all high-confidence matches
			for (const target of highConfidence) {
				await this.deleteMemory(target.id, containerTag)
			}
			const previews = highConfidence
				.map((r) => `"${limitText(r.content || r.memory || "", 60)}"`)
				.join(", ")
			return {
				success: true,
				message: `Forgot ${highConfidence.length} memor${highConfidence.length === 1 ? "y" : "ies"}: ${previews}`,
			}
		}

		// No high-confidence match — check minimum threshold before fallback
		const MIN_THRESHOLD = 0.75
		if (results[0].similarity !== undefined && results[0].similarity < MIN_THRESHOLD) {
			return {
				success: false,
				message: `No confident match found. Top result only scored ${Math.round((results[0].similarity || 0) * 100)}%.`,
			}
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
			// TODO: SDK v4.21.1 documents.list() only supports deprecated containerTags (array).
			// Migrate to containerTag (singular) when SDK adds it to DocumentListParams.
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

	/** Get org-level Supermemory settings. */
	async getSettings(): Promise<{
		filterPrompt: string | null
		shouldLLMFilter: boolean | null
		chunkSize: number | null
	}> {
		log.debugRequest("settings.get", {})
		const response = await this.client.settings.get()
		const trunc = (s: string) =>
			s.length > 50 ? `${s.slice(0, 50)}…` : s
		log.debugResponse("settings.get", {
			filterPrompt: response.filterPrompt ? trunc(response.filterPrompt) : null,
			shouldLLMFilter: response.shouldLLMFilter,
			chunkSize: response.chunkSize,
		})
		return {
			filterPrompt: response.filterPrompt ?? null,
			shouldLLMFilter: response.shouldLLMFilter ?? null,
			chunkSize: response.chunkSize ?? null,
		}
	}

	/** Update org-level Supermemory settings. */
	async updateSettings(params: {
		filterPrompt?: string | null
		shouldLLMFilter?: boolean | null
		chunkSize?: number | null
	}): Promise<{
		filterPrompt?: string | null
		shouldLLMFilter?: boolean | null
		chunkSize?: number | null
	}> {
		const trunc = (s: string) =>
			s.length > 50 ? `${s.slice(0, 50)}…` : s
		log.debugRequest("settings.update", {
			...(params.filterPrompt !== undefined && {
				filterPrompt: params.filterPrompt
					? trunc(params.filterPrompt)
					: params.filterPrompt,
			}),
			...(params.shouldLLMFilter !== undefined && { shouldLLMFilter: params.shouldLLMFilter }),
			...(params.chunkSize !== undefined && { chunkSize: params.chunkSize }),
		})
		const response = await this.client.settings.update({
			...(params.filterPrompt !== undefined && { filterPrompt: params.filterPrompt }),
			...(params.shouldLLMFilter !== undefined && { shouldLLMFilter: params.shouldLLMFilter }),
			...(params.chunkSize !== undefined && { chunkSize: params.chunkSize }),
		})
		log.debugResponse("settings.update", {
			...(response.updated.filterPrompt !== undefined && {
				filterPrompt: response.updated.filterPrompt
					? trunc(response.updated.filterPrompt)
					: response.updated.filterPrompt,
			}),
			...(response.updated.shouldLLMFilter !== undefined && {
				shouldLLMFilter: response.updated.shouldLLMFilter,
			}),
			...(response.updated.chunkSize !== undefined && {
				chunkSize: response.updated.chunkSize,
			}),
		})
		return {
			filterPrompt: response.updated.filterPrompt,
			shouldLLMFilter: response.updated.shouldLLMFilter,
			chunkSize: response.updated.chunkSize,
		}
	}

	/** Add raw content directly to Supermemory, bypassing sanitizeContent.
	 *  Used for base64 payloads that would be corrupted by the 100k char truncation. */
	async addRawContent(params: {
		content: string
		contentType?: string
		containerTag?: string
		customId?: string
		entityContext?: string
		metadata?: Record<string, string | number | boolean>
	}): Promise<{ id: string }> {
		const tag = params.containerTag ?? this.containerTag
		log.debugRequest("add.raw", {
			contentLength: params.content.length,
			contentType: params.contentType,
			containerTag: tag,
			customId: params.customId,
		})
		const result = await this.client.add({
			content: params.content,
			containerTag: tag,
			...(params.contentType && { contentType: params.contentType }),
			...(params.customId && { customId: params.customId }),
			...(params.entityContext && { entityContext: params.entityContext }),
			...(params.metadata && { metadata: params.metadata }),
		})
		log.debugResponse("add.raw", { id: result.id })
		return { id: result.id }
	}

	/** Upload a binary file for processing.
	 *  Auto-detects MIME type and SDK fileType from extension when not provided. */
	async uploadFile(filePath: string, opts?: {
		fileType?: string
		mimeType?: string
		metadata?: Record<string, string | number | boolean>
		containerTag?: string
	}): Promise<{ id: string; status: string }> {
		// Defense in depth: validate path even if caller already checked
		if (!isAllowedPath(filePath)) {
			throw new Error(`uploadFile blocked: ${path.basename(filePath)} is outside allowed directories`)
		}
		const tag = opts?.containerTag ?? this.containerTag

		// Auto-detect MIME and fileType from extension when not explicitly provided
		const detectedMime = lookupMime(filePath)
		const mimeType = opts?.mimeType ?? detectedMime ?? "application/octet-stream"
		const fileType = opts?.fileType ?? (detectedMime ? deriveFileType(detectedMime) : undefined)

		log.debugRequest("documents.uploadFile", { filePath, containerTag: tag, mimeType, fileType, detected: detectedMime })
		const fileName = path.basename(filePath)
		const fileObj = await toFile(fs.createReadStream(filePath), fileName, { type: mimeType })
		const result = await this.client.documents.uploadFile({
			file: fileObj,
			...(tag && { containerTags: tag }),
			...(fileType && { fileType }),
			...(mimeType && { mimeType }),
			...(opts?.metadata && { metadata: JSON.stringify(opts.metadata) }),
		})
		log.debugResponse("documents.uploadFile", result)
		return { id: result.id, status: result.status }
	}

	/** Get a document by ID. */
	async getDocument(id: string): Promise<DocumentInfo> {
		log.debugRequest("documents.get", { id })
		const r = await this.client.documents.get(id)
		log.debugResponse("documents.get", { id: r.id, status: r.status, type: r.type })
		return {
			id: r.id,
			content: r.content,
			summary: r.summary,
			title: r.title,
			type: r.type,
			status: r.status,
			metadata: (r.metadata && typeof r.metadata === "object" && !Array.isArray(r.metadata))
				? r.metadata as Record<string, unknown>
				: null,
			url: r.url,
			createdAt: r.createdAt,
			updatedAt: r.updatedAt,
		}
	}

	/** Update a document's content or metadata. */
	async updateDocument(id: string, params: {
		content?: string
		metadata?: Record<string, string | number | boolean | string[]>
		customId?: string
		containerTag?: string
	}): Promise<{ id: string; status: string }> {
		log.debugRequest("documents.update", {
			id,
			...(params.content !== undefined && {
				contentLength: params.content.length,
			}),
			...(params.metadata && { metadataKeys: Object.keys(params.metadata) }),
			...(params.customId && { customId: params.customId }),
			...(params.containerTag && { containerTag: params.containerTag }),
		})
		const result = await this.client.documents.update(id, {
			...(params.content && { content: params.content }),
			...(params.metadata && { metadata: params.metadata }),
			...(params.customId && { customId: params.customId }),
			...(params.containerTag && { containerTag: params.containerTag }),
		})
		log.debugResponse("documents.update", result)
		return { id: result.id, status: result.status }
	}

	/** Delete a single document by ID. */
	async deleteDocument(id: string): Promise<{ success: boolean; error?: string }> {
		log.debugRequest("documents.delete", { id })
		try {
			await this.client.documents.delete(id)
			log.debug(`documents.delete: deleted ${id}`)
			return { success: true }
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			log.warn(`documents.delete failed for ${id}: ${message}`)
			return { success: false, error: message }
		}
	}

	/** List documents currently being processed. */
	async listProcessingDocuments(): Promise<{
		documents: ProcessingDocument[]
		totalCount: number
	}> {
		log.debugRequest("documents.listProcessing", {})
		const response = await this.client.documents.listProcessing()
		log.debugResponse("documents.listProcessing", { totalCount: response.totalCount })
		return {
			documents: response.documents.map((d) => ({
				id: d.id,
				title: d.title,
				type: d.type,
				status: d.status,
				createdAt: d.createdAt,
				updatedAt: d.updatedAt,
			})),
			totalCount: response.totalCount,
		}
	}

	/** List documents with full SDK params (sort, order, filters, includeContent). */
	async listDocuments(opts?: {
		page?: number
		limit?: number
		sort?: "createdAt" | "updatedAt"
		order?: "asc" | "desc"
		includeContent?: boolean
		containerTag?: string
	}): Promise<{
		documents: Array<Record<string, unknown>>
		pagination: { currentPage: number; totalPages: number; totalItems: number }
	}> {
		const tag = opts?.containerTag ?? this.containerTag
		log.debugRequest("documents.list", { tag, ...opts })
		// TODO: SDK v4.21.1 documents.list() only supports deprecated containerTags (array).
		// Migrate to containerTag (singular) when SDK adds it to DocumentListParams.
		const response = await this.client.documents.list({
			containerTags: [tag],
			...(opts?.page && { page: opts.page }),
			...(opts?.limit && { limit: opts.limit }),
			...(opts?.sort && { sort: opts.sort }),
			...(opts?.order && { order: opts.order }),
			...(opts?.includeContent !== undefined && { includeContent: opts.includeContent }),
		})
		log.debugResponse("documents.list", { count: response.memories?.length ?? 0 })
		return {
			// SDK returns `memories` field from documents.list() — not `documents`.
			// This is the SDK's naming convention, not a bug.
			documents: (response.memories ?? []) as unknown as Array<Record<string, unknown>>,
			pagination: {
				currentPage: response.pagination?.currentPage ?? 1,
				totalPages: response.pagination?.totalPages ?? 1,
				totalItems: response.pagination?.totalItems ?? 0,
			},
		}
	}

	getContainerTag(): string {
		return this.containerTag
	}
}
