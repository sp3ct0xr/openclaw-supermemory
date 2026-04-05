## PR Review: feat: improve memory prompts

**Overall: ✅ Looks good — minor notes below**

---

### `runtime.ts` — Changes

#### 1. Tool Inventory Block
```ts
`### Available tools\n${[...params.availableTools].map((t) => `- \`${t}\``).join("\n")}`,
```
✅ **Good addition.** Dynamically listing available tools gives the agent accurate, runtime-aware context instead of relying on hardcoded references.

> ⚠️ **Minor note:** `Set` iteration order is insertion-order in JS/TS, which is deterministic — but if tools are added to the Set from different sources, the display order may vary across runs. Consider sorting: `[...params.availableTools].sort().map(...)` for consistent output.

---

#### 2. Search Mode Descriptions
✅ **Improvement.** The old description explained *what* the modes do technically. The new description tells the agent *when* to use each — much more actionable for decision-making.

---

#### 3. Trusting Recalled Memories
✅ **Solid improvement.** The "historical snapshot" framing is cleaner and more universal. The addition of `>30 days old` as an explicit threshold for staleness is a useful heuristic.

> ⚠️ **Minor note:** The `>30 days` threshold is a hardcoded heuristic in a prompt string. If this value ever needs tuning, it'll require a code change rather than a config tweak. Not a blocker, but worth being aware of.

---

#### 4. Proactive Ingestion
✅ **Good one-liner.** Clear, actionable, and well-placed right after the `customId` explanation.

---

### `memory.ts` — Changes

#### 5. Document Extraction Rule
✅ **Useful addition.** Fills a gap — without this rule, documents shared in conversation might not get persisted as searchable entities.

> ⚠️ **Minor note:** This rule is appended to `DEFAULT_ENTITY_CONTEXT`, which is a general-purpose extraction prompt. If `hasIngest` is `false` but `DEFAULT_ENTITY_CONTEXT` is still used, the agent might try to extract document entities even when it has no way to ingest them. Consider whether this rule should be conditionally included only when `hasIngest` is enabled.

---

### Summary

| # | Change | Assessment |
|---|--------|------------|
| 1 | Tool inventory list | ✅ Good — consider `.sort()` for determinism |
| 2 | Search mode decision criteria | ✅ Clear improvement |
| 3 | Memory freshness + snapshot framing | ✅ Better UX, `>30 days` is a soft hardcode |
| 4 | Proactive ingestion line | ✅ Clean and useful |
| 5 | Document entity extraction rule | ✅ Good, but may fire even without `hasIngest` |

All changes are prompt-only as stated. No functional regressions expected.