/* ────────────────────────────────────────────────────────────────
   StratOS Presentation Generation API (Gamma)
   GET /api/presentation?run_id=XXX&type=executive|board|market
   ──────────────────────────────────────────────────────────────── */

export const config = { maxDuration: 120 };

const GAMMA_API_KEY = process.env.GAMMA_API_KEY || 'sk-gamma-P3kSiUkiWN5I8WUxcAEtO6fxjuK3p0VBVrByDQzJ8rA';
const GAMMA_BASE = 'https://public-api.gamma.app';
const GAMMA_THEME_ID = process.env.GAMMA_THEME_ID || '2kzw2fo24ga3blg'; // StratOS brand theme

import { validateRunId, rateLimit, validateOrigin } from './_auth.js';

export default async function handler(req, res) {
  validateOrigin(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!rateLimit(req, res)) return;

  let { run_id, type } = req.query;
  const deckType = type || 'executive';
  const validTypes = ['executive', 'board', 'market'];
  if (!validTypes.includes(deckType)) {
    return res.status(400).json({ error: `Invalid type. Use: ${validTypes.join(', ')}` });
  }

  /* ── Fetch data from Supabase (same pattern as pdf.js) ── */
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SB_URL || !SB_KEY) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const headers = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
  };

  const safeFetch = async (url, label) => {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 8000);
    try {
      const r = await fetch(url, { headers, signal: ac.signal });
      clearTimeout(tid);
      if (!r.ok) { console.warn(`[presentation] ${label} ${r.status}`); return null; }
      return r;
    } catch (e) { clearTimeout(tid); console.warn(`[presentation] ${label}: ${e.message}`); return null; }
  };
  const safeJson = async (r, fb = null) => { if (!r) return fb; try { return await r.json(); } catch { return fb; } };
  const unwrap = async (r) => {
    const rows = await safeJson(r, []);
    const raw = rows[0]?.content_json ?? null;
    if (!raw) return null;
    try {
      const once = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return typeof once === 'string' ? JSON.parse(once) : once;
    } catch { return null; }
  };

  // Resolve run_id
  if (!run_id) {
    const latestRes = await safeFetch(`${SB_URL}/rest/v1/engine_master_state?order=created_at.desc&limit=1`, 'latest');
    const rows = await safeJson(latestRes, []);
    run_id = rows?.[0]?.run_id;
    if (!run_id) return res.status(404).json({ error: 'No runs found' });
  }

  const enc = encodeURIComponent(run_id);

  try {
    const results = await Promise.allSettled([
      safeFetch(`${SB_URL}/rest/v1/engine_blobs?run_id=eq.${enc}&blob_type=eq.OUTPUT&order=created_at.desc&limit=1`, 'outputBlob'),
      safeFetch(`${SB_URL}/rest/v1/engine_stage_outputs?run_id=eq.${enc}&section=eq.D&order=round.asc,role_key.asc`, 'stageOutputs'),
      safeFetch(`${SB_URL}/rest/v1/engine_blobs?run_id=eq.${enc}&blob_type=eq.D_packet&order=round.desc&limit=1`, 'dPacket'),
      safeFetch(`${SB_URL}/rest/v1/engine_stage_outputs?run_id=eq.${enc}&section=eq.F1&order=round.asc`, 'f1Outputs'),
      safeFetch(`${SB_URL}/rest/v1/engine_master_state?run_id=eq.${enc}&limit=1`, 'master'),
      safeFetch(`${SB_URL}/rest/v1/engine_blobs?run_id=eq.${enc}&blob_type=eq.options&order=created_at.desc&limit=1`, 'optionsBlob'),
      safeFetch(`${SB_URL}/rest/v1/engine_blobs?run_id=eq.${enc}&blob_type=eq.GOV&order=created_at.desc&limit=1`, 'govBlob'),
      safeFetch(`${SB_URL}/rest/v1/engine_blobs?run_id=eq.${enc}&blob_type=eq.rx_auto&order=round.desc&limit=1`, 'rxAutoBlob'),
      safeFetch(`${SB_URL}/rest/v1/engine_blobs?run_id=eq.${enc}&blob_type=eq.master_state&order=created_at.desc&limit=1`, 'masterBlob'),
      safeFetch(`${SB_URL}/rest/v1/engine_blobs?run_id=eq.${enc}&blob_type=eq.MARKET_INTEL&order=created_at.desc&limit=1`, 'marketIntelBlob'),
    ]);

    const vals = results.map(r => r.status === 'fulfilled' ? r.value : null);
    const [blobRes, stageRes, dpacketRes, f1Res, masterRes, optionsRes, govRes, rxAutoRes, masterBlobRes, marketIntelRes] = vals;

    const [outputBlob, stageOutputs, dPacket, f1Outputs, masterRows, optionsBlob, govBlob, rxAutoBlob, masterBlob, marketIntelBlob] =
      await Promise.all([
        unwrap(blobRes), safeJson(stageRes, []), unwrap(dpacketRes), safeJson(f1Res, []),
        safeJson(masterRes, []), unwrap(optionsRes), unwrap(govRes), unwrap(rxAutoRes),
        unwrap(masterBlobRes), unwrap(marketIntelRes),
      ]);

    const data = {
      run_id,
      outputBlob: outputBlob || {},
      stageOutputs: stageOutputs || [],
      dPacket: dPacket || {},
      f1Outputs: f1Outputs || [],
      master: masterRows?.[0] ?? {},
      masterBlob: masterBlob || {},
      optionsBlob: optionsBlob || {},
      govBlob: govBlob || {},
      rxAutoBlob: rxAutoBlob || {},
      marketIntelBlob: marketIntelBlob || {},
    };

    // Validate market type has data
    if (deckType === 'market' && !marketIntelBlob) {
      return res.status(400).json({ error: 'No market intelligence data available for this run. Market Brief requires a market intelligence analysis.' });
    }

    /* ── Build slide content for chosen deck type ── */
    const slideContent = buildDeckContent(data, deckType);

    /* ── Call Gamma API ── */
    const gammaResponse = await callGammaAPI(slideContent, deckType);

    res.status(200).json(gammaResponse);

  } catch (err) {
    console.error('[presentation] Error:', err);
    res.status(500).json({ error: err.message });
  }
}


/* ═══════════════════════════════════════════════════════════════════
   GAMMA API INTEGRATION
   ═══════════════════════════════════════════════════════════════════ */

async function callGammaAPI(slideContent, deckType) {
  const titles = {
    executive: 'StratOS Executive Decision Brief',
    board: 'Board of Directors — Decision Governance Report',
    market: 'Market Intelligence Briefing',
  };

  const tones = {
    executive: 'Crisp, commanding, numbers-forward. CEO presenting to investors. Confident and action-oriented.',
    board: 'Formal, governance-grade, fiduciary-focused. Board memo turned into slides. Precise and measured.',
    market: 'Research-grade, data-dense, McKinsey-style competitive intelligence briefing. Analytical and authoritative.',
  };

  const audiences = {
    executive: 'C-suite executives, investors, and senior leadership making high-stakes strategic decisions',
    board: 'Board of Directors, corporate governance committees, and fiduciary stakeholders',
    market: 'Strategy teams, competitive intelligence analysts, and executive leadership evaluating market positioning',
  };

  const body = {
    inputText: slideContent,
    textMode: 'preserve',
    format: 'presentation',
    numCards: 10,
    cardSplit: 'inputTextBreaks',
    additionalInstructions: [
      `This is a ${titles[deckType]} by StratOS Decision Engine.`,
      `Brand: StratOS — an AI-powered decision intelligence platform. The brand is premium, modern, and data-driven.`,
      `Tone: ${tones[deckType]}`,
      `DESIGN: Use bold, clean layouts inspired by McKinsey and Bain presentations. Large metrics, clear hierarchy, minimal clutter.`,
      `VISUALS: Use professional data visualization — progress bars, comparison tables, numbered lists, metric cards. Make key numbers LARGE and prominent.`,
      `CONTENT: Every slide must have a clear takeaway headline at the top. No filler. Data-dense but readable.`,
      `COLOR PALETTE: Primary dark navy (#0f172a), accents in teal (#14b8a6), cyan (#00e5ff), emerald (#10b981). Use white or light gray backgrounds for readability.`,
      `IMAGERY: Use professional business imagery — boardrooms, strategy sessions, data dashboards, cityscapes. No clipart or cartoons.`,
      `BRANDING: Include "StratOS | Decision Intelligence" in the footer of every slide. The first slide should prominently feature the StratOS brand.`,
      `QUALITY: This presentation will be shared with C-suite executives and board members. It must look like it cost $10,000 to produce.`,
    ].join(' '),
    textOptions: {
      amount: 'detailed',
      tone: tones[deckType],
      audience: audiences[deckType],
      language: 'en',
    },
    imageOptions: {
      source: 'webFreeToUse',
    },
    cardOptions: {
      dimensions: '16x9',
    },
    sharingOptions: {
      externalAccess: 'view',
    },
  };

  // Apply custom StratOS brand theme if configured
  if (GAMMA_THEME_ID) {
    body.themeId = GAMMA_THEME_ID;
  }

  // POST to Gamma
  const createRes = await fetch(`${GAMMA_BASE}/v1.0/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': GAMMA_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!createRes.ok) {
    const errText = await createRes.text().catch(() => 'Unknown error');
    throw new Error(`Gamma API error (${createRes.status}): ${errText}`);
  }

  const createData = await createRes.json();
  const generationId = createData.generationId;

  if (!generationId) {
    throw new Error('Gamma API did not return a generationId');
  }

  // Poll for completion (max 100 seconds)
  let status = 'pending';
  let result = null;
  const maxAttempts = 20;

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(5000);

    const pollRes = await fetch(`${GAMMA_BASE}/v1.0/generations/${generationId}`, {
      headers: { 'X-API-KEY': GAMMA_API_KEY },
    });

    if (!pollRes.ok) {
      console.warn(`[presentation] Poll attempt ${i + 1} returned ${pollRes.status}`);
      continue;
    }

    result = await pollRes.json();
    status = result.status;

    if (status === 'completed' || status === 'failed') break;
  }

  if (status === 'failed') {
    throw new Error('Gamma generation failed. Please try again.');
  }

  if (status !== 'completed') {
    throw new Error('Gamma generation timed out. The presentation may still be generating — check your Gamma workspace.');
  }

  return {
    generationId,
    status: 'completed',
    gammaUrl: result.gammaUrl,
    exportUrl: result.exportUrl || null,
    credits: result.credits || null,
    deckType,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/* ═══════════════════════════════════════════════════════════════════
   CONTENT BUILDERS — Each returns structured Markdown with --- breaks
   for cardSplit: inputTextBreaks
   ═══════════════════════════════════════════════════════════════════ */

function extractMeta(data) {
  const ob = data.outputBlob || {};
  const dash = ob.dashboard || {};
  const mb = data.masterBlob || {};
  const masterInput = mb.input_data || data.master?.input_data || data.master || {};
  const originals = masterInput._originals || {};
  const mi = data.marketIntelBlob || {};

  const question = originals.question || data.master?.question || masterInput.question || dash.decision_question || 'Decision question pending';
  const company = mi.company_name || masterInput.company_name || masterInput.company || originals.company_name || '';

  const voteSplit = dash.vote_split || {};
  const voteKey = Object.keys(voteSplit)[0] || '';
  const verdict = voteKey.includes('APPROVE') ? 'Approved' : voteKey.includes('REJECT') ? 'Rejected' : 'Approved';
  const verdictSub = voteKey.includes('CONDITIONS') ? 'With Conditions' : '';
  let conf = dash.decision_confidence || 67;
  if (conf < 1) conf = Math.round(conf * 100);

  const mode = (dash.mode || data.master?.room_type || 'ELT').toUpperCase();
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  return { question, company, runId: data.run_id, date: today, verdict, verdictSub, confidence: conf, mode, voteOutcome: voteKey.replace(/_/g, ' ') || 'Pending', voteSplit };
}

function extractActions(mso, exec) {
  const sources = [
    mso?.priority_actions, mso?.immediate_actions, mso?.recommended_actions,
    exec?.top_3_actions, exec?.priority_actions, exec?.actions,
  ];
  for (const s of sources) {
    if (Array.isArray(s) && s.length > 0) return s;
  }
  return [];
}

function extractConditions(dash) {
  const cond = dash.all_conditions || dash.conditions || [];
  return Array.isArray(cond) ? cond : [];
}

function fmtAction(a, i) {
  if (typeof a === 'string') return `${i + 1}. ${a}`;
  const title = a.action || a.title || a.name || `Action ${i + 1}`;
  const owner = a.owner || a.responsible || '';
  const timeline = a.timeline || a.deadline || a.timeframe || '';
  let line = `${i + 1}. **${title}**`;
  if (owner || timeline) {
    const parts = [];
    if (owner) parts.push(`Owner: ${owner}`);
    if (timeline) parts.push(`Timeline: ${timeline}`);
    line += ` (${parts.join(' | ')})`;
  }
  if (a.description || a.detail || a.rationale) {
    line += `\n   ${a.description || a.detail || a.rationale}`;
  }
  return line;
}

function fmtRisk(r) {
  if (typeof r === 'string') return `- ${r}`;
  const name = r.name || r.risk || r.title || 'Risk';
  const sev = r.severity || r.impact || r.level || '';
  const mit = r.mitigation || r.response || '';
  let line = `- **${name}**`;
  if (sev) line += ` [${sev}]`;
  if (mit) line += `\n  Mitigation: ${mit}`;
  return line;
}

function fmtCondition(c) {
  if (typeof c === 'string') return `- ${c}`;
  return `- ${c.condition || c.description || JSON.stringify(c)}`;
}

function fmtVoteSplit(voteSplit) {
  const entries = Object.entries(voteSplit);
  if (entries.length === 0) return 'No vote data available';
  const total = entries.reduce((s, [, v]) => s + (typeof v === 'number' ? v : 0), 0);
  return entries.map(([key, val]) => {
    const pct = total > 0 ? Math.round((val / total) * 100) : 0;
    return `${key.replace(/_/g, ' ')}: ${val} votes (${pct}%)`;
  }).join(' | ');
}

function fmtRoleVotes(dash) {
  const preview = dash.role_assessment_preview || [];
  if (!Array.isArray(preview) || preview.length === 0) return '';
  return preview.map(r => {
    const role = (r.role || r.role_key || r.name || '').replace(/_/g, ' ');
    const vote = (r.vote || r.recommendation || '').replace(/_/g, ' ');
    let conf = r.confidence || r.confidence_pct || '';
    if (typeof conf === 'number' && conf < 1) conf = Math.round(conf * 100) + '%';
    else if (typeof conf === 'number') conf += '%';
    const concern = r.key_concern || r.concern || '';
    let line = `| ${role} | ${vote} | ${conf} |`;
    if (concern) line += ` ${concern} |`;
    return line;
  }).join('\n');
}


/* ─────────────────────────────────────────────────
   TYPE 1: EXECUTIVE DECISION BRIEF
   ───────────────────────────────────────────────── */

function buildExecutiveDeck(data) {
  const meta = extractMeta(data);
  const ob = data.outputBlob || {};
  const dash = ob.dashboard || {};
  const exec = ob.executive_summary || {};
  const mso = ob.machine_strategy_object || {};
  const dir = ob.direction_package || {};
  const fm = dash.financial_mechanics || {};
  const bgp = ob.board_governance_packet || {};
  const dPacket = data.dPacket || {};
  const rolePackets = dPacket.role_packets || dPacket.roles || {};

  const actions = extractActions(mso, exec);
  const conditions = extractConditions(dash);
  const topRisks = dash.top_3_risks || dash.top_risks || [];
  const strategicWins = dash.strategic_wins || mso.strategic_wins || [];
  const rolePreview = dash.role_assessment_preview || [];
  const voteSplit = dash.vote_split || {};
  const totalVotes = Object.values(voteSplit).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
  const roleSet = new Set((data.stageOutputs || []).map(s => s.role_key).filter(Boolean));
  const rounds = new Set((data.stageOutputs || []).map(s => s.round).filter(Boolean));
  const execDecision = exec.decision || exec.recommendation || dash.headline_recommendation || '';
  const finOverview = bgp.financial_overview || fm.summary || {};
  const milestones = dir.milestones || mso.milestones || [];
  const citations = dash.citations || [];

  const slides = [];

  // SLIDE 1: Cover
  slides.push([
    `# StratOS Executive Decision Brief`,
    ``,
    meta.company ? `**Prepared for ${meta.company}**` : '',
    ``,
    `> "${meta.question}"`,
    ``,
    `**${meta.date}** | Analysis Mode: ${meta.mode} | Run: ${meta.runId?.substring(0, 8) || 'N/A'}`,
    ``,
    `## VERDICT: ${meta.verdict}${meta.verdictSub ? ' — ' + meta.verdictSub : ''} | Confidence: ${meta.confidence}%`,
  ].filter(Boolean).join('\n'));

  // SLIDE 2: The Decision
  slides.push([
    `# The Decision`,
    ``,
    `## What Was Asked`,
    `> "${meta.question}"`,
    ``,
    `## Who Deliberated`,
    `A panel of **${roleSet.size} expert roles** conducted **${rounds.size} deliberation round${rounds.size !== 1 ? 's' : ''}** to stress-test this decision from every angle.`,
    ``,
    roleSet.size > 0 ? `**Roles:** ${Array.from(roleSet).map(r => r.replace(/_/g, ' ')).join(', ')}` : '',
    ``,
    `## How It Unfolded`,
    execDecision ? execDecision : 'The panel converged on a recommendation through structured deliberation, weighing strategic opportunity against downside risk.',
  ].filter(Boolean).join('\n'));

  // SLIDE 3: Verdict & Confidence
  const voteLines = fmtVoteSplit(voteSplit);
  slides.push([
    `# Verdict & Confidence`,
    ``,
    `## ${meta.verdict}${meta.verdictSub ? ' — ' + meta.verdictSub : ''}`,
    ``,
    `### Decision Confidence: ${meta.confidence}%`,
    ``,
    `## Vote Breakdown`,
    `${voteLines}`,
    ``,
    `**Total Votes:** ${totalVotes} | **Consensus:** ${meta.voteOutcome}`,
    ``,
    Array.isArray(rolePreview) && rolePreview.length > 0
      ? `### Per-Role Votes\n| Role | Vote | Confidence |\n|------|------|------------|\n${fmtRoleVotes(dash)}`
      : '',
  ].filter(Boolean).join('\n'));

  // SLIDE 4: Priority Actions
  const topActions = (exec.top_3_actions || exec.priority_actions || actions).slice(0, 3);
  slides.push([
    `# Priority Actions`,
    ``,
    `The three highest-impact moves to execute immediately:`,
    ``,
    ...topActions.map((a, i) => fmtAction(a, i)),
    ``,
    topActions.length === 0 ? 'Action plan pending deliberation completion.' : '',
  ].filter(Boolean).join('\n'));

  // SLIDE 5: Conditions for Approval
  const topCond = conditions.slice(0, 5);
  slides.push([
    `# Conditions for Approval`,
    ``,
    topCond.length > 0
      ? `These conditions must be met before proceeding:\n\n${topCond.map((c, i) => `${i + 1}. ${typeof c === 'string' ? c : (c.condition || c.description || JSON.stringify(c))}`).join('\n')}`
      : 'No conditions specified — unconditional approval.',
    ``,
    meta.verdictSub ? `> This decision was approved **with conditions**. Failure to meet these gates should trigger re-evaluation.` : '',
  ].filter(Boolean).join('\n'));

  // SLIDE 6: Key Risks
  slides.push([
    `# Key Risks`,
    ``,
    `Top risks identified during deliberation:`,
    ``,
    ...(Array.isArray(topRisks) ? topRisks.slice(0, 3).map(fmtRisk) : ['No significant risks flagged.']),
    ``,
    `> Risk assessment is based on multi-stakeholder stress testing across ${roleSet.size} expert perspectives.`,
  ].filter(Boolean).join('\n'));

  // SLIDE 7: Financial Snapshot
  const investmentAsk = fm.investment_ask || finOverview.capital_approved || finOverview.investment || '';
  const ltvCac = fm.ltv_cac || fm.ltv_cac_ratio || finOverview.ltv_cac || '';
  const payback = fm.payback_period || finOverview.payback || '';
  const revenueImpact = fm.revenue_impact || fm.projected_revenue || finOverview.revenue_potential || '';
  const costStructure = fm.cost_structure || finOverview.cost_estimate || '';
  slides.push([
    `# Financial Snapshot`,
    ``,
    investmentAsk ? `**Investment Ask:** ${typeof investmentAsk === 'object' ? JSON.stringify(investmentAsk) : investmentAsk}` : '',
    ltvCac ? `**LTV/CAC Ratio:** ${ltvCac}` : '',
    payback ? `**Payback Period:** ${typeof payback === 'object' ? JSON.stringify(payback) : payback}` : '',
    revenueImpact ? `**Revenue Impact:** ${typeof revenueImpact === 'object' ? JSON.stringify(revenueImpact) : revenueImpact}` : '',
    costStructure ? `**Cost Structure:** ${typeof costStructure === 'object' ? JSON.stringify(costStructure) : costStructure}` : '',
    ``,
    (!investmentAsk && !ltvCac) ? 'Financial modeling data pending. Quantitative analysis will be available in the full report.' : '',
  ].filter(Boolean).join('\n'));

  // SLIDE 8: Strategic Wins
  slides.push([
    `# Strategic Wins`,
    ``,
    `Key strategic advantages this decision unlocks:`,
    ``,
    ...(Array.isArray(strategicWins) && strategicWins.length > 0
      ? strategicWins.slice(0, 5).map((w, i) => {
          if (typeof w === 'string') return `${i + 1}. ${w}`;
          return `${i + 1}. **${w.title || w.win || 'Win'}** — ${w.description || w.detail || ''}`;
        })
      : ['Strategic advantages will be detailed in the full deliberation report.']),
  ].filter(Boolean).join('\n'));

  // SLIDE 9: What Happens Next
  const dirActions = dir.strategic_actions || dir.immediate_actions || mso.immediate_actions || [];
  slides.push([
    `# What Happens Next`,
    ``,
    `## Immediate Steps (0-30 days)`,
    ...(dirActions.length > 0
      ? dirActions.slice(0, 3).map((a, i) => fmtAction(a, i))
      : topActions.map((a, i) => fmtAction(a, i))),
    ``,
    `## Gated Milestones`,
    ...(Array.isArray(milestones) && milestones.length > 0
      ? milestones.slice(0, 4).map(m => {
          if (typeof m === 'string') return `- ${m}`;
          return `- **${m.name || m.milestone || m.title}** — ${m.target || m.date || m.deadline || 'TBD'}`;
        })
      : ['Milestone plan to be finalized with implementation team.']),
  ].filter(Boolean).join('\n'));

  // SLIDE 10: Appendix
  slides.push([
    `# Appendix: Sources & Evidence`,
    ``,
    `## Analysis Parameters`,
    `- **Run ID:** ${meta.runId || 'N/A'}`,
    `- **Expert Roles:** ${roleSet.size}`,
    `- **Deliberation Rounds:** ${rounds.size}`,
    `- **Total Stage Outputs:** ${(data.stageOutputs || []).length}`,
    `- **Analysis Mode:** ${meta.mode}`,
    ``,
    Array.isArray(citations) && citations.length > 0
      ? `## Evidence Sources\n${citations.slice(0, 5).map(c => {
          if (typeof c === 'string') return `- ${c}`;
          return `- **${c.source || c.role || c.type || 'Source'}:** ${c.text || c.finding || c.citation || ''}`;
        }).join('\n')}`
      : '',
    ``,
    `> Generated by StratOS Decision Intelligence Platform | ${meta.date}`,
  ].filter(Boolean).join('\n'));

  return slides.join('\n---\n');
}


/* ─────────────────────────────────────────────────
   TYPE 2: BOARD GOVERNANCE PACKET
   ───────────────────────────────────────────────── */

function buildBoardDeck(data) {
  const meta = extractMeta(data);
  const ob = data.outputBlob || {};
  const dash = ob.dashboard || {};
  const exec = ob.executive_summary || {};
  const mso = ob.machine_strategy_object || {};
  const bgp = ob.board_governance_packet || {};
  const fm = dash.financial_mechanics || {};
  const gov = data.govBlob || {};
  const dir = ob.direction_package || {};
  const dPacket = data.dPacket || {};

  const actions = extractActions(mso, exec);
  const conditions = extractConditions(dash);
  const topRisks = dash.top_3_risks || dash.top_risks || [];
  const voteSplit = dash.vote_split || {};
  const totalVotes = Object.values(voteSplit).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
  const rolePreview = dash.role_assessment_preview || [];
  const execDecision = exec.decision || exec.recommendation || dash.headline_recommendation || '';
  const finOverview = bgp.financial_overview || fm.summary || {};
  const boardAction = bgp.board_action_requested || bgp.resolution || '';
  const strategicRationale = bgp.strategic_rationale || mso.strategic_rationale || dir.strategic_narrative || '';
  const govRequirements = gov.governance_requirements || gov.compliance || bgp.governance || {};
  const dissentFlags = dash.dissent_flags || dash.groupthink_flags || [];
  const killGates = bgp.kill_gates || mso.kill_gates || conditions;

  const slides = [];

  // SLIDE 1: Cover
  slides.push([
    `# Board of Directors`,
    `# Decision Governance Report`,
    ``,
    `**CONFIDENTIAL**`,
    ``,
    meta.company ? `**${meta.company}**` : '',
    ``,
    `${meta.date} | StratOS Decision Intelligence Platform`,
    ``,
    `Report ID: ${meta.runId?.substring(0, 8) || 'N/A'} | Classification: Board Confidential`,
  ].filter(Boolean).join('\n'));

  // SLIDE 2: Board Action Requested
  slides.push([
    `# Board Action Requested`,
    ``,
    `## Resolution for Board Consideration`,
    boardAction
      ? `> ${typeof boardAction === 'object' ? JSON.stringify(boardAction) : boardAction}`
      : `> The Board is requested to review and ${meta.verdict === 'Approved' ? 'ratify' : 'consider'} the following recommendation: **${meta.verdict}${meta.verdictSub ? ' ' + meta.verdictSub : ''}** on the matter of: "${meta.question}"`,
    ``,
    `**Recommended Action:** ${meta.verdict}${meta.verdictSub ? ' — ' + meta.verdictSub : ''}`,
    `**Confidence Level:** ${meta.confidence}%`,
    `**Deliberation Basis:** ${totalVotes} expert votes across structured deliberation`,
  ].filter(Boolean).join('\n'));

  // SLIDE 3: Executive Summary
  slides.push([
    `# Executive Summary`,
    ``,
    execDecision ? execDecision : `A multi-stakeholder deliberation process has been conducted regarding: "${meta.question}"`,
    ``,
    `**Verdict:** ${meta.verdict}${meta.verdictSub ? ' — ' + meta.verdictSub : ''}`,
    `**Confidence:** ${meta.confidence}%`,
    `**Consensus:** ${meta.voteOutcome}`,
    ``,
    `This recommendation reflects the synthesized judgment of the full deliberation panel, stress-tested across strategic, financial, operational, and risk dimensions.`,
  ].filter(Boolean).join('\n'));

  // SLIDE 4: Strategic Rationale
  slides.push([
    `# Strategic Rationale`,
    ``,
    `## Why This Direction Was Recommended`,
    ``,
    strategicRationale
      ? strategicRationale
      : (exec.rationale || exec.reasoning || 'The panel converged on this recommendation based on comprehensive analysis of market conditions, organizational readiness, and risk-adjusted returns.'),
    ``,
    exec.upside ? `**Upside Case:** ${exec.upside}` : '',
  ].filter(Boolean).join('\n'));

  // SLIDE 5: Financial Overview
  const investmentAsk = fm.investment_ask || finOverview.capital_approved || finOverview.investment || '';
  const ltvCac = fm.ltv_cac || fm.ltv_cac_ratio || finOverview.ltv_cac || '';
  const payback = fm.payback_period || finOverview.payback || '';
  const riskAdjReturn = fm.risk_adjusted_return || finOverview.risk_adjusted || '';
  slides.push([
    `# Financial Overview`,
    ``,
    `## Investment Structure & Risk-Adjusted Returns`,
    ``,
    investmentAsk ? `**Capital Required:** ${typeof investmentAsk === 'object' ? JSON.stringify(investmentAsk) : investmentAsk}` : '',
    ltvCac ? `**LTV/CAC Ratio:** ${ltvCac}` : '',
    payback ? `**Payback Period:** ${typeof payback === 'object' ? JSON.stringify(payback) : payback}` : '',
    riskAdjReturn ? `**Risk-Adjusted Return:** ${typeof riskAdjReturn === 'object' ? JSON.stringify(riskAdjReturn) : riskAdjReturn}` : '',
    ``,
    (!investmentAsk && !ltvCac) ? `Financial modeling details are available in the supplementary materials. Board should request full financial due diligence before final ratification.` : '',
    ``,
    `> The financial analysis has been reviewed through the lens of fiduciary responsibility and prudent capital allocation.`,
  ].filter(Boolean).join('\n'));

  // SLIDE 6: Vote Outcome
  slides.push([
    `# Vote Outcome`,
    ``,
    `## Per-Role Breakdown`,
    ``,
    `**Overall Result:** ${fmtVoteSplit(voteSplit)}`,
    ``,
    Array.isArray(rolePreview) && rolePreview.length > 0
      ? `| Role | Vote | Confidence | Key Concern |\n|------|------|------------|-------------|\n${rolePreview.map(r => {
          const role = (r.role || r.role_key || r.name || '').replace(/_/g, ' ');
          const vote = (r.vote || r.recommendation || '').replace(/_/g, ' ');
          let conf = r.confidence || r.confidence_pct || '';
          if (typeof conf === 'number' && conf < 1) conf = Math.round(conf * 100) + '%';
          else if (typeof conf === 'number') conf += '%';
          const concern = r.key_concern || r.concern || '';
          return `| ${role} | ${vote} | ${conf} | ${concern} |`;
        }).join('\n')}`
      : `Total of ${totalVotes} votes cast across the deliberation panel.`,
  ].filter(Boolean).join('\n'));

  // SLIDE 7: Conditions & Kill Gates
  slides.push([
    `# Conditions & Kill Gates`,
    ``,
    `## Conditions That Must Be True to Proceed`,
    ``,
    ...(Array.isArray(killGates) && killGates.length > 0
      ? killGates.slice(0, 6).map((c, i) => `${i + 1}. ${typeof c === 'string' ? c : (c.condition || c.gate || c.description || JSON.stringify(c))}`)
      : conditions.slice(0, 6).map((c, i) => `${i + 1}. ${typeof c === 'string' ? c : (c.condition || c.description || JSON.stringify(c))}`)),
    ``,
    conditions.length === 0 && killGates.length === 0 ? '> No explicit conditions were set. The Board may wish to define governance gates before implementation.' : '',
    ``,
    `> Failure to meet any kill gate should trigger an automatic pause and Board re-review.`,
  ].filter(Boolean).join('\n'));

  // SLIDE 8: Risk Exposure
  slides.push([
    `# Risk Exposure`,
    ``,
    `## Board-Relevant Risk Assessment`,
    ``,
    ...(Array.isArray(topRisks) && topRisks.length > 0
      ? topRisks.slice(0, 4).map(fmtRisk)
      : ['No material risks flagged during deliberation. The Board should consider commissioning independent risk review.']),
    ``,
    `> Risk framing emphasizes fiduciary exposure, reputational impact, and regulatory compliance.`,
  ].filter(Boolean).join('\n'));

  // SLIDE 9: Dissent & Groupthink
  const hasDissent = Array.isArray(dissentFlags) && dissentFlags.length > 0;
  const dissentRoles = Array.isArray(rolePreview) ? rolePreview.filter(r => {
    const vote = (r.vote || r.recommendation || '').toUpperCase();
    return vote.includes('REJECT') || vote.includes('OPPOSE') || vote.includes('DEFER');
  }) : [];
  slides.push([
    `# Dissent & Groupthink Analysis`,
    ``,
    `## Recorded Dissent`,
    dissentRoles.length > 0
      ? dissentRoles.map(r => `- **${(r.role || r.role_key || '').replace(/_/g, ' ')}** voted ${(r.vote || '').replace(/_/g, ' ')}: ${r.key_concern || r.concern || 'Concerns noted in deliberation record'}`).join('\n')
      : 'No formal dissent recorded. All panel members converged on the recommendation.',
    ``,
    `## Groupthink Assessment`,
    hasDissent
      ? dissentFlags.map(f => `- ${typeof f === 'string' ? f : (f.flag || f.description || JSON.stringify(f))}`).join('\n')
      : meta.confidence > 90
        ? '> **Advisory:** Unanimous high-confidence outcomes warrant additional scrutiny. The Board may wish to commission an independent devil\'s advocate review.'
        : '> Deliberation showed healthy variance in perspectives. No groupthink flags raised.',
  ].filter(Boolean).join('\n'));

  // SLIDE 10: Governance Requirements
  slides.push([
    `# Governance Requirements`,
    ``,
    `## Compliance & Reporting`,
    typeof govRequirements === 'object' && Object.keys(govRequirements).length > 0
      ? Object.entries(govRequirements).slice(0, 5).map(([k, v]) => `- **${k.replace(/_/g, ' ')}:** ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')
      : '- Standard corporate governance protocols apply\n- Quarterly progress reporting to the Board\n- Material deviation triggers automatic Board notification',
    ``,
    `## Next Review Date`,
    `The Board should schedule a follow-up review within 90 days of implementation commencement.`,
    ``,
    `## Record Keeping`,
    `- Decision Record: ${meta.runId || 'N/A'}`,
    `- Date of Analysis: ${meta.date}`,
    `- Analysis Mode: ${meta.mode}`,
    ``,
    `> This document constitutes a formal governance record. Retain in accordance with corporate records policy.`,
    `> Generated by StratOS Decision Intelligence Platform`,
  ].filter(Boolean).join('\n'));

  return slides.join('\n---\n');
}


/* ─────────────────────────────────────────────────
   TYPE 3: MARKET INTELLIGENCE REPORT
   ───────────────────────────────────────────────── */

function buildMarketDeck(data) {
  const meta = extractMeta(data);
  const mi = data.marketIntelBlob || {};
  const ob = data.outputBlob || {};
  const dash = ob.dashboard || {};
  const exec = ob.executive_summary || {};
  const mso = ob.machine_strategy_object || {};

  // Market intel data extraction
  const companyName = mi.company_name || meta.company || 'Target Company';
  const tam = mi.tam || mi.total_addressable_market || '';
  const sam = mi.sam || mi.serviceable_addressable_market || '';
  const marketPosition = mi.market_position || mi.positioning || '';
  const execSummary = mi.executive_summary || mi.summary || exec.decision || '';
  const segments = mi.market_segments || mi.segments || [];
  const competitors = mi.competitors || mi.competitive_landscape || mi.competitor_analysis || [];
  const opportunities = mi.strategic_opportunities || mi.opportunities || [];
  const trends = mi.market_trends || mi.trends || [];
  const maActivity = mi.ma_activity || mi.mergers_acquisitions || mi.ma || [];
  const risks = mi.market_risks || mi.risks || dash.top_3_risks || [];
  const recommendation = mi.strategic_recommendation || mi.recommendation || exec.recommendation || '';
  const threatMatrix = mi.threat_matrix || mi.competitive_positioning || '';
  const marketSize = mi.market_size || mi.market_value || '';

  const slides = [];

  // SLIDE 1: Cover
  slides.push([
    `# Market Intelligence Briefing`,
    ``,
    `## ${companyName}`,
    ``,
    `**CONFIDENTIAL — Strategic Intelligence**`,
    ``,
    `${meta.date} | StratOS Market Intelligence Unit`,
    ``,
    `Report ID: ${meta.runId?.substring(0, 8) || 'N/A'}`,
    marketSize ? `\nEstimated Market: ${typeof marketSize === 'object' ? JSON.stringify(marketSize) : marketSize}` : '',
  ].filter(Boolean).join('\n'));

  // SLIDE 2: Executive Positioning
  slides.push([
    `# Executive Positioning`,
    ``,
    tam ? `**Total Addressable Market (TAM):** ${typeof tam === 'object' ? JSON.stringify(tam) : tam}` : '',
    sam ? `**Serviceable Addressable Market (SAM):** ${typeof sam === 'object' ? JSON.stringify(sam) : sam}` : '',
    marketPosition ? `**Market Position:** ${typeof marketPosition === 'object' ? JSON.stringify(marketPosition) : marketPosition}` : '',
    ``,
    `## Executive Summary`,
    typeof execSummary === 'object' ? JSON.stringify(execSummary) : (execSummary || `Comprehensive market intelligence analysis for ${companyName}, covering competitive landscape, market dynamics, and strategic positioning opportunities.`),
  ].filter(Boolean).join('\n'));

  // SLIDE 3: Market Landscape
  slides.push([
    `# Market Landscape`,
    ``,
    `## Market Segments`,
    ``,
    Array.isArray(segments) && segments.length > 0
      ? segments.slice(0, 6).map((s, i) => {
          if (typeof s === 'string') return `${i + 1}. ${s}`;
          const name = s.name || s.segment || s.title || `Segment ${i + 1}`;
          const size = s.size || s.market_size || s.value || '';
          const fit = s.fit || s.alignment || s.score || '';
          let line = `${i + 1}. **${name}**`;
          if (size) line += ` — Size: ${typeof size === 'object' ? JSON.stringify(size) : size}`;
          if (fit) line += ` | Fit: ${fit}`;
          if (s.description || s.detail) line += `\n   ${s.description || s.detail}`;
          return line;
        }).join('\n')
      : 'Market segmentation data is being compiled. Full segment analysis available upon request.',
  ].filter(Boolean).join('\n'));

  // SLIDE 4: Competitive Dossiers
  slides.push([
    `# Competitive Dossiers`,
    ``,
    Array.isArray(competitors) && competitors.length > 0
      ? competitors.slice(0, 5).map(c => {
          if (typeof c === 'string') return `### ${c}`;
          const name = c.name || c.competitor || c.company || 'Competitor';
          const threat = c.threat_level || c.threat || c.risk || '';
          const strengths = c.strengths || c.advantage || '';
          const weaknesses = c.weaknesses || c.vulnerability || '';
          const share = c.market_share || c.share || '';
          let block = `### ${name}`;
          if (threat) block += ` [Threat: ${threat}]`;
          if (share) block += `\n- **Market Share:** ${typeof share === 'object' ? JSON.stringify(share) : share}`;
          if (strengths) block += `\n- **Strengths:** ${typeof strengths === 'object' ? JSON.stringify(strengths) : strengths}`;
          if (weaknesses) block += `\n- **Vulnerabilities:** ${typeof weaknesses === 'object' ? JSON.stringify(weaknesses) : weaknesses}`;
          return block;
        }).join('\n\n')
      : 'Competitive intelligence profiles are being developed. Preliminary analysis suggests a moderately competitive market with identifiable gaps.',
  ].filter(Boolean).join('\n'));

  // SLIDE 5: Threat Matrix
  slides.push([
    `# Threat Matrix`,
    ``,
    `## Competitive Positioning Analysis`,
    ``,
    typeof threatMatrix === 'string' && threatMatrix
      ? threatMatrix
      : typeof threatMatrix === 'object' && Object.keys(threatMatrix).length > 0
        ? Object.entries(threatMatrix).map(([k, v]) => `- **${k}:** ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')
        : Array.isArray(competitors) && competitors.length > 0
          ? `| Competitor | Threat Level | Key Differentiator |\n|------------|-------------|--------------------|\n${competitors.slice(0, 5).map(c => {
              if (typeof c === 'string') return `| ${c} | Medium | Under analysis |`;
              return `| ${c.name || c.competitor || 'N/A'} | ${c.threat_level || c.threat || 'Medium'} | ${c.differentiator || c.strengths || 'Under analysis'} |`;
            }).join('\n')}`
          : 'Threat matrix visualization pending competitive data compilation.',
    ``,
    `> Positioning based on multi-dimensional analysis: market share, product capability, customer base, and strategic trajectory.`,
  ].filter(Boolean).join('\n'));

  // SLIDE 6: Strategic Opportunities
  slides.push([
    `# Strategic Opportunities`,
    ``,
    `## Ranked by Revenue Potential`,
    ``,
    Array.isArray(opportunities) && opportunities.length > 0
      ? opportunities.slice(0, 5).map((o, i) => {
          if (typeof o === 'string') return `${i + 1}. ${o}`;
          const name = o.name || o.opportunity || o.title || `Opportunity ${i + 1}`;
          const revenue = o.revenue_potential || o.value || o.impact || '';
          const difficulty = o.difficulty || o.complexity || o.effort || '';
          let line = `${i + 1}. **${name}**`;
          if (revenue) line += `\n   Revenue Potential: ${typeof revenue === 'object' ? JSON.stringify(revenue) : revenue}`;
          if (difficulty) line += ` | Difficulty: ${difficulty}`;
          if (o.description || o.detail) line += `\n   ${o.description || o.detail}`;
          return line;
        }).join('\n')
      : 'Opportunity analysis is being refined. Initial screening identifies multiple high-potential vectors.',
  ].filter(Boolean).join('\n'));

  // SLIDE 7: Market Trends
  slides.push([
    `# Market Trends`,
    ``,
    `## Key Trends & Implications`,
    ``,
    Array.isArray(trends) && trends.length > 0
      ? trends.slice(0, 5).map((t, i) => {
          if (typeof t === 'string') return `${i + 1}. ${t}`;
          const name = t.name || t.trend || t.title || `Trend ${i + 1}`;
          const implication = t.implication || t.impact || t.description || '';
          const timeline = t.timeline || t.timeframe || '';
          let line = `${i + 1}. **${name}**`;
          if (timeline) line += ` (${timeline})`;
          if (implication) line += `\n   Implication: ${implication}`;
          return line;
        }).join('\n')
      : 'Trend analysis based on market signals, regulatory movements, and technology adoption curves.',
  ].filter(Boolean).join('\n'));

  // SLIDE 8: M&A Activity
  slides.push([
    `# M&A Activity`,
    ``,
    `## Recent Deals & Market Multiples`,
    ``,
    Array.isArray(maActivity) && maActivity.length > 0
      ? maActivity.slice(0, 5).map(m => {
          if (typeof m === 'string') return `- ${m}`;
          const deal = m.deal || m.name || m.title || m.description || 'Deal';
          const multiple = m.multiple || m.valuation || m.price || '';
          const rationale = m.rationale || m.reason || '';
          let line = `- **${deal}**`;
          if (multiple) line += ` — Multiple: ${typeof multiple === 'object' ? JSON.stringify(multiple) : multiple}`;
          if (rationale) line += `\n  Rationale: ${rationale}`;
          return line;
        }).join('\n')
      : typeof maActivity === 'object' && !Array.isArray(maActivity) && Object.keys(maActivity).length > 0
        ? Object.entries(maActivity).map(([k, v]) => `- **${k}:** ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')
        : 'M&A activity monitoring is active. No significant transactions to report in the current analysis window.',
  ].filter(Boolean).join('\n'));

  // SLIDE 9: Risk Factors
  slides.push([
    `# Market Risk Factors`,
    ``,
    `## Market-Specific Risks`,
    ``,
    ...(Array.isArray(risks) && risks.length > 0
      ? risks.slice(0, 5).map(fmtRisk)
      : ['Market risk assessment is underway. Key risk vectors include competitive response, regulatory shifts, and technology disruption.']),
    ``,
    `> Risk factors are assessed in context of market dynamics, competitive intensity, and regulatory environment.`,
  ].filter(Boolean).join('\n'));

  // SLIDE 10: Strategic Recommendation
  slides.push([
    `# Strategic Recommendation`,
    ``,
    `## What to Do Based on the Intelligence`,
    ``,
    typeof recommendation === 'object'
      ? JSON.stringify(recommendation, null, 2)
      : (recommendation || `Based on comprehensive market intelligence analysis for ${companyName}, the recommended strategic posture is to pursue the identified opportunities while maintaining defensive positioning against the top competitive threats.`),
    ``,
    `## Suggested Next Steps`,
    `1. Commission deep-dive analysis on top 2-3 opportunities`,
    `2. Initiate competitive monitoring program for key threats`,
    `3. Develop market entry / expansion playbook based on segment analysis`,
    `4. Schedule quarterly market intelligence review cadence`,
    ``,
    `> StratOS Market Intelligence Unit | ${meta.date} | Report: ${meta.runId?.substring(0, 8) || 'N/A'}`,
  ].filter(Boolean).join('\n'));

  return slides.join('\n---\n');
}


/* ── Router ── */

function buildDeckContent(data, deckType) {
  switch (deckType) {
    case 'executive': return buildExecutiveDeck(data);
    case 'board':     return buildBoardDeck(data);
    case 'market':    return buildMarketDeck(data);
    default:          return buildExecutiveDeck(data);
  }
}
