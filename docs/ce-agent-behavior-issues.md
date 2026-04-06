# Context Engine — Agent Behavior Issues & Proposed Fixes

## Problem Summary

The Context Engine (CE) correctly injects profile, memory, and recent context into each turn. However, the agent frequently bypasses this injected context and calls `search_v4` unnecessarily — even when the answer is already present in the auto-injected payload.

## Issues Identified

### 1. Agent skips reading auto-injected context
The CE injects profile/memory/recent correctly, but the agent goes straight to `search_v4` without reading the injected context first. This wastes tokens, adds latency, and defeats the purpose of the CE pipeline.

### 2. Over-searching for simple facts
The agent calls `search_v4` for facts that are already present in the auto-injected profile. For example, asking "what's my name?" triggers a search even though the profile already contains the answer.

### 3. No "read before search" rule
There is no explicit instruction telling the agent to read injected context before reaching for search tools. Without this rule, the agent defaults to tool use as a first resort.

### 4. Old habit: verify by searching
The agent defaults to searching even when the profile already has the answer — as if it needs to "double-check" what the CE already provided. This is redundant and wasteful.

## Proposed Fixes

1. **Add "read auto-injected context first" instruction** — Include an explicit directive in the CE prompt section telling the agent to read all injected context before invoking any search tools.

2. **Add "trust profile for simple facts" guidance** — When the profile contains a direct answer (name, preferences, identity), the agent should use it without verification.

3. **Make injected context more prominent in turn structure** — Consider structural changes (e.g., a clearly labeled `## Injected Context` section) so the agent is less likely to skip over it.

4. **Add instruction: "answer from injected context, search only if not answered"** — A clear decision rule: if the injected context answers the question, respond directly. Only search when the context is insufficient or stale.

## Expected Impact

- Reduced token waste (~800–2000 tokens/turn saved)
- Lower latency per turn (fewer API round-trips)
- Better UX — faster, more direct responses
- CE pipeline operates as designed
