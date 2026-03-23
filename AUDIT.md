# StratOS Decision Engine — Full Audit Reference

**Date:** 2026-03-21
**Scope:** 10 n8n workflows, 304 nodes, 119 Code nodes (~4,800 lines JS)

---

## Pipeline Flow (Actual, from COND.21)

```
Round 0:  Q → D → F1 → F2-F4 → (loop to D, round=1)
Round 1+: D → F1 → RX → EI → F2-F4 → (loop to D, round+1)
Final:    F2-F4 → F3 → GOV → GOV-TEST → COMPLETE
```

**Note:** The documented flow (Q→EI→D→F1→RX→F2-F4→F3→GOV) does NOT match the actual code. EI and RX only run on round >= 1.

---

## Issue Catalog

### CRITICAL (8 issues)

| ID | Workflow | Issue | Impact |
|----|----------|-------|--------|
| C1 | ALL | **72 Supabase/HTTP nodes unprotected** — no `retryOnFail`, no result validation | Any transient Supabase outage kills the entire run |
| C2 | CONDUCTOR | **No webhook authentication** — plain POST to `/conductor` | Anyone can initiate runs, advance state, pull results |
| C3 | CONDUCTOR | **No idempotency guard** — double `section_complete` callbacks double-advance state | Can skip entire pipeline stages |
| C4 | F1/F2-F4 | **Callback deadlock** — sub-workflow POSTs back to conductor webhook while conductor is blocked waiting for sub-workflow return | Race condition, timeout-induced false failure |
| C5 | F3 | **`media_assets` field never created** — GOV-TEST stores audio/doc links in separate GOV blob, not in F3 output_package | Dashboard has no path to discover audio/HTML brief links |
| C6 | F3 | **F3.31 freemium gating is a no-op** — reads `ctx.output_package` which doesn't exist (F3.30 outputs `output_blob_row`) | Tier gating never enforced at runtime |
| C7 | F3 | **Hardcoded financial figures** — `$500K budget`, `$50K-70K per FTE`, `$175K LTV` baked into F3.10 and F3.30 | Every decision shows EU-expansion numbers |
| C8 | D | **EI evidence appears twice in LLM prompt** — D1.03 + D1.03a both inject EI evidence | Token waste, potential model confusion |

### HIGH (12 issues)

| ID | Workflow | Issue |
|----|----------|-------|
| H1 | Q | **2 hardcoded Google Doc IDs** for FACILITATOR_1 and FACILITATOR_2 prompts |
| H2 | F1/F2-F4 | **12 hardcoded Google Doc IDs** for facilitator prompts across 4 selector nodes |
| H3 | CONDUCTOR | Hardcoded personal email (`erichathaway@gmail.com`), placeholder `client_id`, Drive folder IDs |
| H4 | CONDUCTOR | `mode` defaults to `'ELT'` but no downstream node uses it for branching |
| H5 | D | **D1.03a is 589 lines** — largest Code node, prompt template engine in a single function |
| H6 | EI/RX | **`classifySourceTier()` duplicated identically** — TIER1/TIER2 domain lists must be synced manually |
| H7 | Q | **Q1.11 skips validation gate when JSON is repaired** — truncated FAC2 that would fail validation passes silently |
| H8 | GOV-TEST | **Reconstructs data independently from F3** — may show different numbers than dashboard |
| H9 | GOV-TEST | **GOV.02 hardcodes "Three rounds. Seven executives."** regardless of actual config |
| H10 | F3 | **F3.13 hardcoded milestones** — EU-expansion-specific dates (Board Approval Feb 15, Ireland Legal Entity Apr 30, etc.) |
| H11 | D | **D1.05 `validation_rules` computed but never enforced** — schema validation is dead code |
| H12 | CONDUCTOR | **Thin data contract on Advance/Resume** — downstream workflows don't receive `question`, `context`, etc. on rounds > 0 |

### MEDIUM (15 issues)

| ID | Workflow | Issue |
|----|----------|-------|
| M1 | D | `D.SB.06` field name `arr_target_fy25` is FY25-specific |
| M2 | Q | `Budget_FY25` in `financial_master_tabs_expected` will go stale |
| M3 | D | `buildAccumulatedStateBlock()` reads fields never populated — always returns empty string |
| M4 | F2-F4 | `classifyConditionSeverity()` duplicated in F2.07 and W0.30 |
| M5 | F1 | F1.09 at 256 lines mixes parse + normalize + validate + serialize — should be split |
| M6 | F2-F4 | F2.05 at 414 lines is a prompt template engine embedded in Code node |
| M7 | RX | `classifyGap()` defaults unrecognized gaps to INTERNAL — external gaps with novel language misclassified |
| M8 | D | `round` vs `current_round` field naming inconsistency between CONDUCTOR and downstream |
| M9 | CONDUCTOR | No `retry_count` upper bound — infinite resume loops possible |
| M10 | CONDUCTOR | No state transition audit log — overwrites `execution_control` in place |
| M11 | GOV | GOV.04c LLM fallback exposes internal node names in Google Doc |
| M12 | GOV-TEST | Missing data silently defaults to `vote: 'APPROVE_WITH_CONDITIONS'` — inflates approval numbers |
| M13 | F3 | `executive_summary` referenced but never constructed upstream — always undefined |
| M14 | F3 | `evidence_panel` never set by any F3 node — always empty |
| M15 | D | D1.06 uses DJB2 hash but field is named `payload_hash_sha256` — misleading |

### LOW (8 issues)

| ID | Workflow | Issue |
|----|----------|-------|
| L1 | ALL | `fail()`, `isObj()`, `norm()`, `upper()` duplicated across ~43 nodes (n8n limitation) |
| L2 | EI | `f1_err_count` is misnamed — actually counts valid F1 rows |
| L3 | D | `CONFIDENCE_CEILINGS` only defined for CFO/LEGAL/CTO — other roles uncapped |
| L4 | D | Round 3+ falls back to round 0 schema — likely wrong |
| L5 | F2-F4 | `PROHIBITED` confidence scores with anti-clustering nudge is a hacky workaround |
| L6 | GOV-TEST | `ttsNorm()` and `spellNum()` duplicated between GOV.02 and GOV.10 |
| L7 | Q | Duplicate role doc overwrites silently — only `console.warn` |
| L8 | Q | Supabase view reads not filtered by customer_key — relies on RLS |

---

## Hardcoded Google Doc IDs (14 total)

| Node | Round | Doc ID | Prompt |
|------|-------|--------|--------|
| Q: Q1.04 | — | `16cDB_hHLrLFS99AUUYUwrsMeAUWxr5oFtFbl90GdIQo` | FACILITATOR_1 (INIT.1) |
| Q: Q1.08 | — | `1GP510cu5v7QgPA8gD_NUM1NMRFgDv6k0y1iXYQ-h_P8` | FACILITATOR_2 (INIT.2) |
| F1: F1.01 | 0 | `1hmqs4luRhMjmUkI6E9PjiIZl0v-mAmPvWC-bhafHyvY` | R0.1 |
| F1: F1.01 | 1 | `1o80tVgo_TX13lQnn3WF3bz6-OljtTSD3CilkXNIprNs` | R1.1 |
| F1: F1.01 | 2 | `1vbDQT_5OaHNepIuYfm1zuRrLHrab85wrl0V4WADvPd8` | R2.1 |
| F2: F2.02c | 0 | `1uX6JQ7-VZXrCHoftoizmaM0PdnND8BLtmdIlx3C4dv0` | R0.2 |
| F2: F2.02c | 1 | `1Kyt4TJSPCIEun29JGAabPWEB-5hHKGvrS_wjmKljsS8` | R1.2 |
| F2: F2.02c | 2 | `1LrZ9XUNVDsWtxmNGbpf6XQmyIad-Yi0XO00H95ogLzE` | R2.2 |
| F2: F2.19a | 0 | `1CthFsrpDufOH1gVxwx9wb7QyIt8JGCOfEgkvx69Qy-Q` | R0.3 |
| F2: F2.19a | 1 | `1cbacuWxSZxV0Wg1OpUKJ5IEaDAGnAgnGcuyMDTiTKWM` | R1.3 |
| F2: F2.19a | 2 | `1rvAG0GIIHPvd9yWxkqDkSVVKNKU7fmIgdQwnplsMtc0` | R2.3 |
| F2: F2.29a | 0 | `1fvwBzMtLBDpQXNmuYFV7kihBKPmyKF3nvfnirIE44nE` | R0.4 |
| F2: F2.29a | 1 | `1vHJlcrkxXGIQJxX35aX3bcaNwOnbNrBF8Mbigu2YFXI` | R1.4 |
| F2: F2.29a | 2 | `1Yn3dwt46wFWO2MdKSO-yhCs5e5vEerGfMmFzK6exYuA` | R2.4 |

---

## Unprotected Supabase/HTTP Nodes by Workflow

| Workflow | Count | Nodes |
|----------|-------|-------|
| CONDUCTOR | 8 | COND.11, COND.20, COND.22, COND.40, COND.42, COND.50, COND.51, COND.55 |
| Q | 7 | SUB.Q.99b, PERSIST.02, SB.01-SB.05 |
| D | 12 | SUB.D.99, D1.06b, D1.12b, D1.12d, W1.00b, D.SB.01-05, SUB.D.98, D1.12f |
| EI | 5 | EI.01, EI.05, EI.06, EI.08, EI.99 |
| RX | 5 | RX.01, RX.05, RX.06, RX.08, RX.99 |
| F1 | 5 | SUB.F1.01, SUB.F1.98, SUB.F1.99, F1.10b, F1.12c |
| F2-F4 | 11 | W2.01, F2.08b, F2.10c, F2.24b, F2.24d, W0.30b, F2.37c, W2.98b, W2.98d, SUB.F2.99, SUB.F2.TERM |
| F3 | 7 | F3.01, F3.05, F3.40, F3.41, F3.42, F3.99, F3.05b |
| GOV | 6 | GOV.01, GOV.02, GOV.04b, GOV.06, GOV.99, Update row |
| GOV-TEST | 4 | GOV.SB.01, GOV.SB.02, GOV.SB.03, GOV.12 |
| **TOTAL** | **70** | |

---

## Duplicated Code Across Workflows

| Function | Found In | Lines Each |
|----------|----------|-----------|
| `classifySourceTier()` | EI.04, RX.04 | ~25 |
| `classifyConditionSeverity()` | F2.07, W0.30 | ~15 |
| `ttsNorm()` + `spellNum()` | GOV.02, GOV.10 | ~45 |
| `fail()` | 16+ nodes | ~5 |
| `norm()`, `isObj()`, `upper()` | ~43 nodes | ~3 each |
| `stripFences()` | F1.09, F2.05, F2.07, F2.23, F2.34 | ~10 |
| `extractFirstJsonObject()` | F1.09, F2.07, F2.23, F2.34 | ~15 |
| `buildPayloadMeta()` (crypto hash) | D1.11, D1.12c | ~8 |

---

## Team-Switching Abstraction Points

| Component | Current State | What Needs to Change |
|-----------|--------------|---------------------|
| Role prompts | `roles_ELT` folder in Drive (10 docs) | Create `roles_board`, `roles_management` docs |
| `role_docs_folder_id` | Passed in CONDUCTOR trigger, defaulted to ELT folder | Parameterize per team type |
| Facilitator prompts | 14 hardcoded Doc IDs in Code nodes | Move to config table or folder-based lookup |
| `ELT.FAC.` prefix | Hardcoded in prompt text | Parameterize or ignore (doesn't affect logic) |
| `mode` field | `ELT\|BOARD\|MANAGEMENT\|INNOVATION` in Q0.01 | Already supports multiple modes |
| `MAX_ROUNDS` | `{ELT:3, BOARD:4, MANAGEMENT:3}` in F2-F4 | Already per-mode |
| Voting weight | Defined in role prompts (CEO: 1.5x) | Comes with role swap |
| Veto authority | Defined in role prompts | Comes with role swap |

**Key finding:** Team switching is 90% a prompt-selection problem. The workflow logic is already mode-aware via `Q0.01` and `F2-F4 MAX_ROUNDS`. The main code changes needed are:
1. Move 14 facilitator Doc IDs from hardcoded maps to a config table or folder-based lookup
2. Ensure `role_docs_folder_id` is always passed (not defaulted to ELT)
3. Verify Supabase views support customer_key filtering

---

## F3 Output Package Schema (What Dashboard Reads)

```
output_package = {
  executive_summary: { tier_gate:'free', decision, top_3_actions, top_conditions }
  dashboard: {
    tier_gate:'free', decision_question, approved_option_id, approved_option_label,
    decision_confidence, confidence_range, vote_summary, vote_split, stance_split,
    strategic_feasibility, execution_complexity, risk_exposure, dependency_density,
    research_gap_score, key_question, groupthink_flag, top_3_risks, all_conditions,
    role_assessment_preview, financial_mechanics, make_or_break_issues,
    single_source_warning, all_citations, integrity_hash
  }
  direction_package: { tier_gate:'paid', strategic_narrative, strategic_objectives, ... }
  board_governance_packet: { tier_gate:'paid', financial_overview [HARDCODED], ... }
  timeline_visualization: { tier_gate:'paid', phases, milestones [HARDCODED], hard_gates }
  machine_strategy_object: { tier_gate:'paid', ... }
  citation_registry: { [string]: { icon_type, url, label } }
}
```

---

## Recommended Fix Priority (Phase B)

### Pass 1: Governance (safety, no behavior change)
1. Add `retryOnFail: true, maxTries: 3, waitBetweenTries: 2000` to all 70 unprotected nodes
2. Add `continueOnFail` to F1/F2-F4 callback HTTP nodes (C4 deadlock fix)
3. Add result validation after Supabase reads (check rows returned)
4. Remove hardcoded personal email, webhook URLs

### Pass 2: Code Clean (reduce complexity, no behavior change)
1. Extract `classifySourceTier()` to shared constant or first-node injection
2. Remove hardcoded financial figures from F3.10/F3.30 (derive from data)
3. Remove hardcoded milestones from F3.13 (derive from data)
4. Fix F3.31 freemium gating (point to correct field or remove)
5. Fix F3.13 `functional_mandates[role].implementation_commitments` field name
6. Fix D1.06 hash field name (`payload_hash_sha256` → `payload_hash_djb2`)
7. Remove EI evidence double-injection in D

### Pass 3: Data & Output Quality
1. Create `media_assets` field in GOV-TEST output → persist to GOV blob
2. Wire dashboard to read GOV blob for audio/doc links
3. Fix GOV-TEST silent approval defaults (M12)
4. Fix GOV-TEST hardcoded round/role count in narrative
5. Verify `_originals` preservation through full pipeline

### Pass 4: Efficiency & Cost
1. Audit LLM model selection per stage
2. Evaluate EI+RX merge opportunity
3. Cache Pinecone results per run

### Pass 5: Prompts & Team Switching
1. Move 14 facilitator Doc IDs to config
2. Create board + management role prompt sets
3. Design team config schema

### Pass 6: Commercialization
1. Add webhook authentication to CONDUCTOR
2. Add idempotency guard
3. Add state transition audit log
4. Cost model per run
