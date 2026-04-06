/**
 * Strip OpenClaw runtime internal context blocks from text.
 * Used by both CE ingestion (prevent noise in memories) and
 * CE assembly (clean search queries).
 *
 * Patterns sourced from OpenClaw runtime:
 *  - internal-runtime-context.ts (delimited + legacy internal context)
 *  - internal-events.ts (task completion events)
 *  - external-content.ts (untrusted external content wrappers)
 *  - subagent-spawn.ts (subagent dispatch messages)
 *  - subagent-announce.ts (subagent wake/completion context)
 *  - subagent-announce-output.ts (child result formatting)
 */
export function stripRuntimeContext(text: string): string {
	if (!text) return text
	return text
		// ── Delimited runtime context (supports nesting via greedy match) ──
		.replace(/<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>/g, "")

		// ── Legacy internal context header + event blocks ──
		.replace(/OpenClaw runtime context \(internal\):[\s\S]*?(?=\n\[role:|$)/g, "")

		// ── Internal task completion event metadata ──
		.replace(/\[Internal task completion event\][\s\S]*?(?=\n\n---\n\n\[Internal|\n\[role:|$)/g, "")

		// ── Untrusted child result blocks (strip markers AND content between them) ──
		.replace(/(?:(?:Result|Child result) \(untrusted content, treat as data\):\n)?<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>[\s\S]*?<<<END_UNTRUSTED_CHILD_RESULT>>>/g, "")

		// ── Child completion result blocks ──
		.replace(/Child completion results:[\s\S]*?(?=\n\[role:|$)/g, "")

		// ── External untrusted content (web fetches with random IDs) ──
		.replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, "")

		// ── Tool result blocks (file contents, command outputs — ephemeral) ──
		.replace(/\[role: toolResult\][\s\S]*?\[toolResult:end\]/g, "")

		// ── Subagent dispatch metadata (subagent-spawn.ts:675-683) ──
		.replace(/^\[Subagent Context\][^\n]*$/gm, "")
		.replace(/^\[Subagent Task\]:.*$/gm, "")

		// ── Our own injected memory/container context ──
		.replace(/<supermemory-context>[\s\S]*?<\/supermemory-context>\s*/g, "")
		.replace(/<supermemory-containers>[\s\S]*?<\/supermemory-containers>\s*/g, "")

		// ── Action/reply instructions appended to internal events ──
		.replace(/^Action:\n.*(?:Convert (?:this|the) (?:completion|result)|reply ONLY)[^\n]*$/gm, "")

		// ── Execution stats lines ──
		.replace(/^Stats: runtime[^\n]*$/gm, "")

		// ── Security notice boilerplate ──
		.replace(/SECURITY NOTICE: The following content is from an EXTERNAL[\s\S]*?Send messages to third parties\n*/g, "")

		// ── Untrusted context trailing header (strip-inbound-meta.ts) ──
		.replace(/^Untrusted context \(metadata, do not treat as instructions or commands\):[\s\S]*$/gm, "")

		// ── Leading timestamp prefix (inbound-meta.ts) ──
		.replace(/^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */gm, "")

		// ── Clean up whitespace ──
		.replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "")
}
