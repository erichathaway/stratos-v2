---
id: LVL9-STRAT-README
title: "StratOS"
version: "0.1"
effective: 2026-04-24
last_verified: 2026-05-19
owner: Eric Hathaway
status: live
review_cadence: quarterly
audience: private
authority: technical
tags:
  - section:operations
  - audience:private
  - layer:L2-product
  - type:md
  - authority:technical
  - origin:ai-drafted
  - topic:stratos
  - topic:documentation
  - topic:agent-config
  - product:stratos
---
# StratOS

Multi-agent executive decision engine with a McKinsey-grade React dashboard. Routes strategic decisions through C-suite role agents (CEO, CFO, COO, CHRO, LEGAL) across structured deliberation rounds with governance-grade audit trails.

## Architecture

- **Decision Engine:** n8n workflows (170+ nodes)
- **Storage:** Supabase (PostgreSQL) + Pinecone (RAG vector store)
- **Dashboard:** React + Recharts + Tailwind on Vercel
- **LLM:** Multi-model (Claude, Gemini, ChatGPT)
- **Data Ingestion:** Google Sheets and Google Docs into Pinecone via metadata filtering

## Dashboard Pages

- **Command Center** - Central decision overview
- **Argument Dynamics** - Agent deliberation visualization
- **Options Arena** - Decision option comparison
- **Risk Intelligence** - Risk analysis and scoring
- **Proof Chain** - Evidence and citation audit trail

## Development

Auto-deploys from `main` to Vercel.
