## Canonical Stack (read before you write)

This project participates in the Level9 portfolio's canonical stack. Before hardcoding a color, font, logo, legal line, LLC attribution, API key, or ID, check the canonical source:

- **Brand** (tokens, logos, components, content, voice rules) → `@level9/brand` at `/Users/erichathaway/claude code 1/level9-brand/`
- **Legal + LLC attribution** → `@level9/brand/legal/<llc>/` + `legal/attribution.ts`
- **Policy + procedure** → `level9-brand/policy/` (NORTHSTAR, COMPANY-CHARTER) + `level9-brand/procedure/`
- **Secrets** → Supabase `cmd_secrets` via `get_secret()` RPC
- **Project / agent / workflow IDs** → `cmd_projects` / `cmd_agents` / `cmd_governance_agents` in Supabase, or n8n list

For the full mandate see `~/claude code 1/CLAUDE.md` → "Canonical Stack Mandate" + `~/claude code 1/level9-brand/CLAUDE-TEMPLATE.md`.

---

StratOS (STRATOS ELT) - Agent Context
Project Overview
Multi-agent executive decision engine with a McKinsey-grade React dashboard. Routes strategic decisions through C-suite role agents (CEO, CFO, COO, CHRO, LEGAL) across structured deliberation rounds with governance-grade audit trails.
Architecture

Decision Engine: n8n workflows (170+ nodes) on erichath.app.n8n.cloud
Storage: Supabase (PostgreSQL) + Pinecone (RAG vector store)
Dashboard: React + Recharts + Tailwind on Vercel
LLM: Multi-model (Claude, Gemini, ChatGPT)
Data Ingestion: Google Sheets and Google Docs into Pinecone via metadata filtering

Key n8n Workflows

Conductor (orchestrator): 44IWvxCxUsYO67fr
D (deliberation): wIoB90XZBVufNE3V
EI (external intelligence): ZH7QvVcinoze9uMI
RX (research enrichment): 0mpJvOYCX9wCBzNp
F1/F2 (facilitator synthesis), GOV (governance)

Infrastructure

Repo: erichathaway/stratos-elt on GitHub
Vercel: stratos-elt project under decisioning-v1 team (auto-deploys from main)
Supabase: shared instance
n8n: erichath.app.n8n.cloud (cloud instance)
Pinecone: metadata filtering (not namespace-per-document)

Dashboard Pages

Command Center
Argument Dynamics
Options Arena
Risk Intelligence
Proof Chain

Current State
Dashboard deployed and functional. Landing page added at public/landing.html (dark mode, hero + 3 feature cards + CTA). Known issues: dynamic audio buttons and citation display improvements pending. v12.7 of D workflow fixed performance regression (hard character caps on Pinecone evidence blocks).
Key Architectural Decisions

Pointer + delta pattern for payload reduction (n8n 256KB limit)
Metadata filtering over namespace-per-document in Pinecone (namespaces can't be queried simultaneously)
Standardized 3,200-token modular role prompts with four sections: Role Core, Personality Profile, Context Overlay, Quality Controls
Reduced code duplication from ~1,400 to ~550 lines in optimization sprint

What NOT to Touch

n8n workflow IDs (listed above) without understanding the full chain
Pinecone namespace structure
Supabase tables that don't start with stratos_ or the decision engine schema
Other projects in the parent directory

Cross-Project Impacts

Shares Supabase instance with CommandOS (cmd_ prefixed tables)
Brand site references StratOS positioning and product language
CommandOS will eventually receive strategic direction from StratOS
## Prior Intelligence (read before starting)
- ~/claude code 1/specs/FULL_SYSTEM_AUDIT.md — full system audit
- ~/claude code 1/specs/SUPABASE_AUDIT.md — Supabase schema audit
- ~/claude code 1/specs/N8N_WORKFLOW_AUDIT.md — n8n workflow audit
- ~/claude code 1/specs/FULL_PLAN.md — original build plan
- ~/claude code 1/specs/D_PARALLEL_BUILD_PLAN.md — parallel execution plan
- ~/claude code 1/role-docs-new/ — role prompt archive (A16Z Partner, Chairman, etc.)
- ~/claude code 1/sql/ — database schemas for deliberation rooms
- ~/claude code 1/brandproduct/BRAND_AUDIT.md — StratOS flagged as most brand-divergent
