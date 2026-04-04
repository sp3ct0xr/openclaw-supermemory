import { Type } from "@sinclair/typebox"
import type { OpenClawPluginApi } from "openclaw/plugin-sdk"
import type { SupermemoryClient } from "../client.ts"
import type { SupermemoryConfig } from "../config.ts"
import { log } from "../logger.ts"

export function registerDocumentsTool(
	api: OpenClawPluginApi,
	client: SupermemoryClient,
	_cfg: SupermemoryConfig,
): void {
	api.registerTool(
		{
			name: "supermemory_documents",
			label: "Document Management",
			description:
				"Manage ingested documents. Use action='get' to inspect a document, 'list' to browse/filter documents, 'processing' to see pipeline status, 'delete' to remove a document.",
			parameters: Type.Object({
				action: Type.Unsafe<string>({
					type: "string",
					enum: ["get", "list", "processing", "delete"],
					description:
						"'get': inspect document by ID. 'list': browse documents with filters. 'processing': show documents in pipeline. 'delete': remove document by ID.",
				}),
				documentId: Type.Optional(
					Type.String({
						description:
							"Document ID — required for 'get' and 'delete' actions.",
					}),
				),
				page: Type.Optional(
					Type.Number({
						description: "Page number for 'list' action (default: 1)",
					}),
				),
				limit: Type.Optional(
					Type.Number({
						description:
							"Results per page for 'list' action (default: 20, max: 100)",
					}),
				),
				sort: Type.Optional(
					Type.Unsafe<string>({
						type: "string",
						enum: ["createdAt", "updatedAt"],
						description: "Sort field for 'list' action",
					}),
				),
				order: Type.Optional(
					Type.Unsafe<string>({
						type: "string",
						enum: ["asc", "desc"],
						description: "Sort order for 'list' action",
					}),
				),
			}),
			async execute(
				_toolCallId: string,
				params: {
					action: string
					documentId?: string
					page?: number
					limit?: number
					sort?: string
					order?: string
				},
			) {
				// --- GET ---
				if (params.action === "get") {
					if (!params.documentId) {
						return {
							content: [
								{
									type: "text" as const,
									text: "documentId is required for 'get' action.",
								},
							],
						}
					}

					log.debug(
						`documents tool: get id=${params.documentId}`,
					)
					const doc = await client.getDocument(params.documentId)

					const lines: string[] = [
						`## Document: ${doc.title ?? doc.id}`,
						"",
						`**ID:** ${doc.id}`,
						`**Type:** ${doc.type}`,
						`**Status:** ${doc.status}`,
						`**Created:** ${doc.createdAt}`,
						`**Updated:** ${doc.updatedAt}`,
						...(doc.url ? [`**URL:** ${doc.url}`] : []),
						...(doc.summary
							? ["", `**Summary:** ${doc.summary}`]
							: []),
						...(doc.content
							? [
									"",
									`**Content preview:** ${doc.content.length > 500 ? `${doc.content.slice(0, 500)}…` : doc.content}`,
								]
							: []),
					]

					return {
						content: [
							{ type: "text" as const, text: lines.join("\n") },
						],
						details: doc,
					}
				}

				// --- LIST ---
				if (params.action === "list") {
					const page = params.page ?? 1
					const limit = Math.min(params.limit ?? 20, 100)

					log.debug(
						`documents tool: list page=${page} limit=${limit} sort=${params.sort ?? "default"} order=${params.order ?? "default"}`,
					)

					// Use the raw client for full list params
					const response = await (client as any).client.documents.list({
						containerTags: [client.getContainerTag()],
						page,
						limit,
						...(params.sort && { sort: params.sort }),
						...(params.order && { order: params.order }),
					})

					const docs = response.memories ?? []
					const pagination = response.pagination

					if (docs.length === 0) {
						return {
							content: [
								{
									type: "text" as const,
									text: "No documents found.",
								},
							],
						}
					}

					const lines = docs.map(
						(d: any, i: number) =>
							`${i + 1}. [${d.type ?? "?"}] ${d.title ?? d.id} — ${d.status} (${d.createdAt?.slice(0, 10)})`,
					)

					return {
						content: [
							{
								type: "text" as const,
								text: `Found ${pagination?.totalItems ?? docs.length} documents (page ${pagination?.currentPage ?? page}/${pagination?.totalPages ?? "?"}):\n\n${lines.join("\n")}`,
							},
						],
						details: {
							count: docs.length,
							pagination,
							documents: docs.map((d: any) => ({
								id: d.id,
								title: d.title,
								type: d.type,
								status: d.status,
								createdAt: d.createdAt,
							})),
						},
					}
				}

				// --- PROCESSING ---
				if (params.action === "processing") {
					log.debug("documents tool: listing processing documents")
					const result = await client.listProcessingDocuments()

					if (result.totalCount === 0) {
						return {
							content: [
								{
									type: "text" as const,
									text: "No documents currently processing.",
								},
							],
						}
					}

					const lines = result.documents.map(
						(d, i) =>
							`${i + 1}. [${d.type}] ${d.title ?? d.id} — **${d.status}** (${d.updatedAt.slice(0, 19)})`,
					)

					return {
						content: [
							{
								type: "text" as const,
								text: `${result.totalCount} document(s) processing:\n\n${lines.join("\n")}\n\nPipeline: queued → extracting → chunking → embedding → indexing → done`,
							},
						],
						details: result,
					}
				}

				// --- DELETE ---
				if (params.action === "delete") {
					if (!params.documentId) {
						return {
							content: [
								{
									type: "text" as const,
									text: "documentId is required for 'delete' action.",
								},
							],
						}
					}

					log.debug(
						`documents tool: delete id=${params.documentId}`,
					)
					await client.deleteDocument(params.documentId)

					return {
						content: [
							{
								type: "text" as const,
								text: `Deleted document: ${params.documentId}`,
							},
						],
					}
				}

				return {
					content: [
						{
							type: "text" as const,
							text: "Invalid action. Use 'get', 'list', 'processing', or 'delete'.",
						},
					],
				}
			},
		},
		{ name: "supermemory_documents" },
	)
}
