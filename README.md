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
