import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

/* ────────────────────────────────────────────────────────────────
   StratOS PDF Generation API
   GET /api/pdf?run_id=XXX&type=executive-brief|full-report|board-packet
   ──────────────────────────────────────────────────────────────── */

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let { run_id, type } = req.query;
  const reportType = type || 'executive-brief';
  const validTypes = ['executive-brief', 'full-report', 'board-packet'];
  if (!validTypes.includes(reportType)) {
    return res.status(400).json({ error: `Invalid type. Use: ${validTypes.join(', ')}` });
  }

  /* ── Fetch data from Supabase ── */
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
      if (!r.ok) { console.warn(`[pdf] ${label} ${r.status}`); return null; }
      return r;
    } catch (e) { clearTimeout(tid); console.warn(`[pdf] ${label}: ${e.message}`); return null; }
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

    /* ── Build HTML ── */
    const html = buildReportHTML(data, reportType);

    /* ── Launch Puppeteer ── */
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1122, height: 794 }, // A4 landscape at 96dpi
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      landscape: true,
      printBackground: true,
      margin: { top: '20mm', bottom: '20mm', left: '25mm', right: '25mm' },
      displayHeaderFooter: true,
      headerTemplate: `
        <div style="width:100%;font-size:8px;font-family:Inter,sans-serif;color:#94a3b8;padding:0 25mm;display:flex;justify-content:space-between;">
          <span>StratOS | Decision Intelligence Report</span>
          <span>${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
        </div>`,
      footerTemplate: `
        <div style="width:100%;font-size:8px;font-family:Inter,sans-serif;color:#94a3b8;padding:0 25mm;display:flex;justify-content:space-between;">
          <span>Confidential</span>
          <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
        </div>`,
    });

    await browser.close();

    const filename = `StratOS-${reportType}-${run_id.substring(0, 8)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(Buffer.from(pdfBuffer));

  } catch (err) {
    console.error('[pdf] Error:', err);
    res.status(500).json({ error: err.message });
  }
}


/* ═══════════════════════════════════════════════════════════════════
   HTML TEMPLATE BUILDER
   ═══════════════════════════════════════════════════════════════════ */

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

function verdictColor(verdict) {
  if (verdict === 'Approved') return '#16a34a';
  if (verdict === 'Rejected') return '#dc2626';
  return '#d97706';
}

function verdictBg(verdict) {
  if (verdict === 'Approved') return '#f0fdf4';
  if (verdict === 'Rejected') return '#fef2f2';
  return '#fffbeb';
}

function buildReportHTML(data, reportType) {
  const meta = extractMeta(data);
  const ob = data.outputBlob || {};
  const dash = ob.dashboard || {};
  const exec = ob.executive_summary || {};
  const bgp = ob.board_governance_packet || {};
  const mso = ob.machine_strategy_object || {};
  const dir = ob.direction_package || {};
  const fm = dash.financial_mechanics || {};
  const gov = data.govBlob || {};

  let body = '';

  // Cover page (all types)
  body += buildCoverPage(meta);

  if (reportType === 'executive-brief') {
    body += buildExecSummary(meta, dash, exec, mso);
    body += buildKeyMetrics(meta, dash, data);
  } else if (reportType === 'full-report') {
    body += buildExecSummary(meta, dash, exec, mso);
    body += buildTOC();
    body += buildBriefingSection(meta, dash, exec, dir);
    body += buildCommandCenter(mso, dir);
    body += buildRiskIntel(dash, data);
    body += buildFinancials(fm, dash);
    body += buildTheRoom(dash, data);
    body += buildManagementHandoff(mso, dir);
    body += buildBoardReport(bgp, meta, dash, gov);
  } else if (reportType === 'board-packet') {
    body += buildBoardCoverSummary(meta, dash, exec);
    body += buildBoardReport(bgp, meta, dash, gov);
    body += buildRiskOverview(dash, data);
    body += buildConditionsKillGates(bgp, mso);
  }

  return wrapHTML(body, meta);
}


/* ── Page wrapper with full CSS ── */
function wrapHTML(body, meta) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Sora:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
/* ── Reset ── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'Inter', 'Helvetica Neue', sans-serif;
  font-size: 11px;
  line-height: 1.6;
  color: #475569;
  background: #ffffff;
  -webkit-print-color-adjust: exact !important;
  print-color-adjust: exact !important;
}

/* ── Typography ── */
h1, h2, h3, h4 {
  font-family: 'Sora', 'Helvetica Neue', sans-serif;
  color: #0f172a;
  letter-spacing: -0.01em;
  line-height: 1.25;
}
h1 { font-size: 28px; font-weight: 800; }
h2 { font-size: 18px; font-weight: 700; margin-bottom: 12px; }
h3 { font-size: 14px; font-weight: 600; margin-bottom: 8px; color: #1a365d; }
h4 { font-size: 12px; font-weight: 600; margin-bottom: 6px; color: #334155; }
p { margin-bottom: 8px; }
strong { font-weight: 600; color: #1e293b; }

/* ── Page breaks ── */
.page-break { page-break-before: always; break-before: page; }

/* ── Cover page ── */
.cover {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  text-align: center;
  padding: 60px 40px;
}
.cover-logo {
  width: 64px; height: 64px;
  margin-bottom: 16px;
}
.cover-brand {
  font-family: 'Sora', sans-serif;
  font-size: 36px;
  font-weight: 800;
  color: #0f172a;
  letter-spacing: -0.02em;
  margin-bottom: 4px;
}
.cover-tagline {
  font-size: 13px;
  color: #64748b;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: 48px;
}
.cover-question {
  font-family: 'Sora', sans-serif;
  font-size: 20px;
  font-weight: 600;
  color: #1a365d;
  max-width: 600px;
  margin-bottom: 32px;
  line-height: 1.4;
}
.cover-meta {
  display: flex;
  gap: 32px;
  margin-bottom: 40px;
  font-size: 11px;
  color: #64748b;
}
.cover-meta dt { font-weight: 600; color: #94a3b8; text-transform: uppercase; font-size: 9px; letter-spacing: 0.08em; margin-bottom: 2px; }
.cover-meta dd { color: #1e293b; font-weight: 500; font-size: 12px; }
.verdict-badge {
  display: inline-block;
  padding: 10px 32px;
  border-radius: 6px;
  font-family: 'Sora', sans-serif;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.verdict-sub {
  font-size: 11px;
  color: #64748b;
  margin-top: 4px;
}

/* ── Section layout ── */
.section {
  padding: 24px 0;
}
.section-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
  padding-bottom: 10px;
  border-bottom: 2px solid #e2e8f0;
}
.section-num {
  font-family: 'Sora', sans-serif;
  font-size: 28px;
  font-weight: 800;
  color: #cbd5e1;
  line-height: 1;
}

/* ── Metric cards ── */
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 24px;
}
.metric-card {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 16px;
  text-align: center;
}
.metric-value {
  font-family: 'Sora', sans-serif;
  font-size: 28px;
  font-weight: 700;
  color: #0f172a;
  line-height: 1.1;
}
.metric-label {
  font-size: 10px;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-top: 4px;
}

/* ── Tables ── */
table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 16px;
  font-size: 10.5px;
}
th {
  background: #1a365d;
  color: #ffffff;
  font-weight: 600;
  text-align: left;
  padding: 8px 12px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
td {
  padding: 8px 12px;
  border-bottom: 1px solid #e2e8f0;
  vertical-align: top;
}
tr:nth-child(even) td { background: #f8fafc; }
tr:nth-child(odd) td { background: #ffffff; }

/* ── Callout boxes ── */
.callout {
  background: #f8fafc;
  border-left: 4px solid #1a365d;
  padding: 14px 18px;
  margin-bottom: 16px;
  border-radius: 0 6px 6px 0;
}
.callout-green { border-left-color: #16a34a; background: #f0fdf4; }
.callout-amber { border-left-color: #d97706; background: #fffbeb; }
.callout-red   { border-left-color: #dc2626; background: #fef2f2; }

/* ── Narrative blocks ── */
.narrative {
  font-size: 11.5px;
  line-height: 1.7;
  color: #334155;
  margin-bottom: 16px;
}

/* ── Lists ── */
.action-list {
  list-style: none;
  padding: 0;
  margin-bottom: 16px;
}
.action-list li {
  padding: 8px 12px;
  margin-bottom: 6px;
  background: #f8fafc;
  border-radius: 6px;
  border-left: 3px solid #1a365d;
  font-size: 11px;
}
.action-list li strong {
  display: block;
  font-size: 11.5px;
  margin-bottom: 2px;
}

/* ── Risk chips ── */
.risk-chip {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.risk-high   { background: #fef2f2; color: #dc2626; }
.risk-medium { background: #fffbeb; color: #d97706; }
.risk-low    { background: #f0fdf4; color: #16a34a; }

/* ── Vote bar ── */
.vote-bar-container { margin-bottom: 16px; }
.vote-bar {
  display: flex;
  height: 24px;
  border-radius: 6px;
  overflow: hidden;
  margin-bottom: 6px;
}
.vote-segment {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 600;
  color: #ffffff;
}
.vote-legend {
  display: flex;
  gap: 16px;
  font-size: 10px;
}
.vote-legend-dot {
  display: inline-block;
  width: 8px; height: 8px;
  border-radius: 50%;
  margin-right: 4px;
}

/* ── Two-column layout ── */
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  margin-bottom: 16px;
}

/* ── Confidence bar ── */
.conf-bar-wrap { margin-bottom: 16px; }
.conf-bar-bg {
  width: 100%;
  height: 12px;
  background: #e2e8f0;
  border-radius: 6px;
  overflow: hidden;
  margin-bottom: 4px;
}
.conf-bar-fill {
  height: 100%;
  border-radius: 6px;
  background: linear-gradient(90deg, #1a365d, #3b82f6);
}
.conf-label {
  font-size: 10px;
  color: #64748b;
}

/* ── TOC ── */
.toc-item {
  display: flex;
  align-items: baseline;
  padding: 6px 0;
  border-bottom: 1px dotted #cbd5e1;
}
.toc-num {
  font-family: 'Sora', sans-serif;
  font-weight: 700;
  color: #1a365d;
  width: 30px;
  font-size: 12px;
}
.toc-name {
  flex: 1;
  font-size: 12px;
  color: #334155;
}

/* ── Divider ── */
.divider {
  border: none;
  border-top: 1px solid #e2e8f0;
  margin: 20px 0;
}

/* ── Watermark / Confidential stripe ── */
.conf-stripe {
  text-align: center;
  font-size: 9px;
  color: #94a3b8;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 8px;
  border-top: 1px solid #e2e8f0;
  margin-top: 24px;
}
</style>
</head>
<body>
${body}
</body>
</html>`;
}


/* ═══════════════════════════════════════════════════════════════════
   SECTION BUILDERS
   ═══════════════════════════════════════════════════════════════════ */

function buildCoverPage(meta) {
  const vc = verdictColor(meta.verdict);
  const vbg = verdictBg(meta.verdict);
  return `
  <div class="cover">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none" class="cover-logo" width="64" height="64">
      <circle cx="256" cy="256" r="248" fill="#ffffff" stroke="#e2e8f0" stroke-width="2"/>
      <circle cx="256" cy="256" r="220" stroke="#0f172a" stroke-width="1.5" fill="none"/>
      <circle cx="256" cy="256" r="180" stroke="#cbd5e1" stroke-width="1" fill="none"/>
      <polygon points="256,60 246,210 266,210" fill="#0f172a"/>
      <polygon points="256,452 246,302 266,302" fill="#cbd5e1"/>
      <polygon points="60,256 210,246 210,266" fill="#cbd5e1"/>
      <polygon points="452,256 302,246 302,266" fill="#cbd5e1"/>
      <circle cx="256" cy="256" r="12" fill="#0f172a"/>
      <circle cx="256" cy="256" r="6" fill="#ffffff"/>
      <text x="256" y="48" text-anchor="middle" font-family="Inter,system-ui,sans-serif" font-size="20" font-weight="700" fill="#0f172a">N</text>
    </svg>
    <div class="cover-brand">StratOS</div>
    <div class="cover-tagline">Decision Intelligence Report</div>
    <div class="cover-question">${esc(meta.question)}</div>
    <div class="cover-meta">
      ${meta.company ? `<div><dt>Organization</dt><dd>${esc(meta.company)}</dd></div>` : ''}
      <div><dt>Report ID</dt><dd>${esc(meta.runId)}</dd></div>
      <div><dt>Date</dt><dd>${meta.date}</dd></div>
      <div><dt>Analysis Mode</dt><dd>${meta.mode}</dd></div>
    </div>
    <div class="verdict-badge" style="background:${vbg};color:${vc};border:2px solid ${vc};">
      ${esc(meta.verdict)}${meta.verdictSub ? ` &mdash; ${esc(meta.verdictSub)}` : ''}
    </div>
    <div style="font-size:10px;color:#94a3b8;margin-top:6px;">Confidence: ${meta.confidence}% &bull; Consensus: ${esc(meta.voteOutcome)}</div>
  </div>`;
}


function buildExecSummary(meta, dash, exec, mso) {
  const actions = extractActions(mso, exec);
  const conditions = extractConditions(dash);

  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">01</div><h2>Executive Summary</h2></div>`;
  html += `<div class="narrative"><p>This report presents the findings of a StratOS decision intelligence analysis conducted on ${meta.date}. The central question under review:</p>`;
  html += `<div class="callout"><strong>${esc(meta.question)}</strong></div>`;
  html += `<p>The analysis panel reached a <strong>${esc(meta.verdict)}</strong> recommendation with an overall confidence level of <strong>${meta.confidence}%</strong>. `;
  if (meta.voteOutcome) html += `The deliberation resulted in a <strong>${esc(meta.voteOutcome)}</strong> consensus among panel members.`;
  html += `</p></div>`;

  // Confidence bar
  html += `<div class="conf-bar-wrap"><div class="conf-bar-bg"><div class="conf-bar-fill" style="width:${meta.confidence}%"></div></div><div class="conf-label">${meta.confidence}% Overall Confidence</div></div>`;

  // Top actions
  if (actions.length > 0) {
    html += `<h3>Priority Actions</h3><ul class="action-list">`;
    actions.slice(0, 5).forEach((a, i) => {
      html += `<li><strong>${i + 1}. ${esc(a.title || a.action || `Action ${i + 1}`)}</strong>${a.detail ? esc(a.detail) : ''}</li>`;
    });
    html += `</ul>`;
  }

  // Conditions
  if (conditions.length > 0) {
    html += `<h3>Key Conditions</h3><ul class="action-list">`;
    conditions.slice(0, 4).forEach(c => {
      html += `<li>${esc(c)}</li>`;
    });
    html += `</ul>`;
  }

  html += `</div>`;
  return html;
}


function buildKeyMetrics(meta, dash, data) {
  const stageCount = (data.stageOutputs || []).length;
  const roleSet = new Set((data.stageOutputs || []).map(s => s.role_key).filter(Boolean));
  const rounds = new Set((data.stageOutputs || []).map(s => s.round).filter(Boolean));
  const voteSplit = dash.vote_split || {};
  const totalVotes = Object.values(voteSplit).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);

  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">02</div><h2>Key Metrics</h2></div>`;
  html += `<div class="metrics-grid">`;
  html += metricCard(meta.confidence + '%', 'Decision Confidence');
  html += metricCard(totalVotes || roleSet.size, 'Panel Votes');
  html += metricCard(roleSet.size, 'Expert Roles');
  html += metricCard(rounds.size, 'Deliberation Rounds');
  html += `</div>`;

  // Vote breakdown
  if (totalVotes > 0) {
    html += buildVoteBar(voteSplit, totalVotes);
  }

  html += `<div class="conf-stripe">End of Executive Brief &mdash; Generated by StratOS Decision Intelligence</div>`;
  html += `</div>`;
  return html;
}


function buildTOC() {
  const sections = [
    'Executive Briefing', 'Command Center', 'Risk & Intelligence',
    'Financial Analysis', 'The Room', 'Management Handoff', 'Board Report'
  ];
  let html = `<div class="page-break"></div><div class="section">`;
  html += `<h2 style="margin-bottom:20px;">Contents</h2>`;
  sections.forEach((s, i) => {
    html += `<div class="toc-item"><span class="toc-num">${String(i + 2).padStart(2, '0')}</span><span class="toc-name">${s}</span></div>`;
  });
  html += `</div>`;
  return html;
}


function buildBriefingSection(meta, dash, exec, dir) {
  const decision = exec.decision || exec.recommendation || dash.headline_recommendation || '';
  const upside = exec.upside || exec.opportunity || '';
  const why = exec.rationale || exec.reasoning || '';

  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">02</div><h2>Executive Briefing</h2></div>`;

  if (decision) {
    html += `<h3>Decision</h3><div class="callout callout-green"><div class="narrative">${esc(decision)}</div></div>`;
  }
  if (upside) {
    html += `<h3>Upside &amp; Opportunity</h3><div class="narrative">${esc(upside)}</div>`;
  }
  if (why) {
    html += `<h3>Supporting Rationale</h3><div class="narrative">${esc(why)}</div>`;
  }

  // Direction package highlights
  const dirActions = dir.strategic_actions || dir.immediate_actions || [];
  if (Array.isArray(dirActions) && dirActions.length > 0) {
    html += `<h3>Strategic Direction</h3><ul class="action-list">`;
    dirActions.slice(0, 5).forEach((a, i) => {
      const text = typeof a === 'string' ? a : a.action || a.description || JSON.stringify(a);
      html += `<li><strong>${i + 1}.</strong> ${esc(text)}</li>`;
    });
    html += `</ul>`;
  }

  html += `</div>`;
  return html;
}


function buildCommandCenter(mso, dir) {
  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">03</div><h2>Command Center</h2></div>`;

  // Strategic wins
  const wins = mso.strategic_wins || mso.key_wins || [];
  if (Array.isArray(wins) && wins.length > 0) {
    html += `<h3>Strategic Wins</h3><ul class="action-list">`;
    wins.slice(0, 5).forEach(w => {
      const text = typeof w === 'string' ? w : w.title || w.description || JSON.stringify(w);
      html += `<li>${esc(text)}</li>`;
    });
    html += `</ul>`;
  }

  // Timeline
  const timeline = dir.timeline || mso.timeline || [];
  if (Array.isArray(timeline) && timeline.length > 0) {
    html += `<h3>Implementation Timeline</h3>`;
    html += `<table><tr><th>Phase</th><th>Description</th><th>Timeframe</th></tr>`;
    timeline.slice(0, 8).forEach((t, i) => {
      const phase = t.phase || t.name || `Phase ${i + 1}`;
      const desc = t.description || t.detail || t.action || '';
      const time = t.timeframe || t.duration || t.deadline || '';
      html += `<tr><td><strong>${esc(phase)}</strong></td><td>${esc(desc)}</td><td>${esc(time)}</td></tr>`;
    });
    html += `</table>`;
  }

  // Mandates
  const mandates = mso.mandates || mso.execution_mandates || dir.mandates || [];
  if (Array.isArray(mandates) && mandates.length > 0) {
    html += `<h3>Execution Mandates</h3><ul class="action-list">`;
    mandates.slice(0, 6).forEach(m => {
      const text = typeof m === 'string' ? m : m.mandate || m.description || JSON.stringify(m);
      html += `<li>${esc(text)}</li>`;
    });
    html += `</ul>`;
  }

  html += `</div>`;
  return html;
}


function buildRiskIntel(dash, data) {
  const riskMatrix = dash.risk_matrix || {};
  const risks = riskMatrix.risks || riskMatrix.items || [];

  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">04</div><h2>Risk &amp; Intelligence</h2></div>`;

  if (riskMatrix.summary || riskMatrix.description) {
    html += `<div class="narrative">${esc(riskMatrix.summary || riskMatrix.description)}</div>`;
  }

  if (Array.isArray(risks) && risks.length > 0) {
    html += `<h3>Risk Register</h3>`;
    html += `<table><tr><th>Risk</th><th>Severity</th><th>Likelihood</th><th>Mitigation</th></tr>`;
    risks.slice(0, 10).forEach(r => {
      const sev = r.severity || r.impact || r.level || 'MEDIUM';
      const chipClass = sev.toUpperCase() === 'HIGH' ? 'risk-high' : sev.toUpperCase() === 'LOW' ? 'risk-low' : 'risk-medium';
      html += `<tr>
        <td><strong>${esc(r.name || r.risk || r.title || 'Risk')}</strong><br>${esc(r.description || '')}</td>
        <td><span class="risk-chip ${chipClass}">${esc(sev)}</span></td>
        <td>${esc(r.likelihood || r.probability || '')}</td>
        <td>${esc(r.mitigation || r.response || '')}</td>
      </tr>`;
    });
    html += `</table>`;
  }

  // Evidence summary
  const evidence = dash.evidence_summary || dash.evidence || [];
  if (Array.isArray(evidence) && evidence.length > 0) {
    html += `<h3>Evidence Base</h3><ul class="action-list">`;
    evidence.slice(0, 5).forEach(e => {
      const text = typeof e === 'string' ? e : e.finding || e.description || JSON.stringify(e);
      html += `<li>${esc(text)}</li>`;
    });
    html += `</ul>`;
  }

  html += `</div>`;
  return html;
}


function buildFinancials(fm, dash) {
  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">05</div><h2>Financial Analysis</h2></div>`;

  // KPIs
  const kpis = fm.kpis || fm.key_metrics || [];
  if (Array.isArray(kpis) && kpis.length > 0) {
    html += `<div class="metrics-grid">`;
    kpis.slice(0, 8).forEach(k => {
      const label = typeof k === 'string' ? k : k.label || k.name || 'KPI';
      const val = typeof k === 'string' ? '' : k.value || k.amount || '';
      html += metricCard(val, label);
    });
    html += `</div>`;
  }

  // Capital structure
  const capStruct = fm.capital_structure || fm.funding || {};
  if (typeof capStruct === 'object' && Object.keys(capStruct).length > 0) {
    html += `<h3>Capital Structure</h3>`;
    html += `<table><tr><th>Component</th><th>Value</th></tr>`;
    Object.entries(capStruct).forEach(([k, v]) => {
      html += `<tr><td>${esc(k)}</td><td>${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</td></tr>`;
    });
    html += `</table>`;
  }

  // Scenarios
  const scenarios = fm.scenarios || fm.scenario_analysis || [];
  if (Array.isArray(scenarios) && scenarios.length > 0) {
    html += `<h3>Scenario Analysis</h3>`;
    html += `<table><tr><th>Scenario</th><th>Outcome</th><th>Probability</th></tr>`;
    scenarios.slice(0, 5).forEach(s => {
      html += `<tr><td><strong>${esc(s.name || s.scenario || s.label || 'Scenario')}</strong></td><td>${esc(s.outcome || s.description || '')}</td><td>${esc(s.probability || s.likelihood || '')}</td></tr>`;
    });
    html += `</table>`;
  }

  html += `</div>`;
  return html;
}


function buildTheRoom(dash, data) {
  const stageOutputs = data.stageOutputs || [];
  const voteSplit = dash.vote_split || {};
  const totalVotes = Object.values(voteSplit).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);

  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">06</div><h2>The Room</h2></div>`;

  // Vote bar
  if (totalVotes > 0) {
    html += buildVoteBar(voteSplit, totalVotes);
  }

  // Roles
  const roleSet = new Set(stageOutputs.map(s => s.role_key).filter(Boolean));
  if (roleSet.size > 0) {
    html += `<h3>Panel Composition (${roleSet.size} Roles)</h3>`;
    html += `<table><tr><th>Role</th><th>Rounds Active</th></tr>`;
    const roleRounds = {};
    stageOutputs.forEach(s => {
      if (s.role_key) {
        roleRounds[s.role_key] = (roleRounds[s.role_key] || 0) + 1;
      }
    });
    Object.entries(roleRounds).forEach(([role, count]) => {
      html += `<tr><td>${esc(role.replace(/_/g, ' '))}</td><td>${count}</td></tr>`;
    });
    html += `</table>`;
  }

  // Convergence / Groupthink flag
  const gt = dash.groupthink_flag || {};
  if (gt.detected !== undefined || gt.score !== undefined) {
    const detected = gt.detected || gt.flagged || false;
    html += `<h3>Convergence Analysis</h3>`;
    html += `<div class="callout ${detected ? 'callout-amber' : 'callout-green'}">`;
    html += `<strong>Groupthink ${detected ? 'Warning' : 'Not Detected'}</strong>`;
    if (gt.score !== undefined) html += `<br>Convergence Score: ${gt.score}`;
    if (gt.explanation) html += `<br>${esc(gt.explanation)}`;
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}


function buildManagementHandoff(mso, dir) {
  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">07</div><h2>Management Handoff</h2></div>`;

  const mandates = mso.mandates || mso.execution_mandates || dir.mandates || [];
  if (Array.isArray(mandates) && mandates.length > 0) {
    html += `<h3>Execution Mandates</h3><ul class="action-list">`;
    mandates.forEach((m, i) => {
      const text = typeof m === 'string' ? m : m.mandate || m.description || JSON.stringify(m);
      html += `<li><strong>${i + 1}.</strong> ${esc(text)}</li>`;
    });
    html += `</ul>`;
  }

  // Escalation triggers
  const escalation = mso.escalation_triggers || dir.escalation || [];
  if (Array.isArray(escalation) && escalation.length > 0) {
    html += `<h3>Escalation Triggers</h3>`;
    html += `<table><tr><th>Trigger</th><th>Action</th></tr>`;
    escalation.forEach(e => {
      const trigger = typeof e === 'string' ? e : e.trigger || e.condition || '';
      const action = typeof e === 'string' ? '' : e.action || e.response || '';
      html += `<tr><td>${esc(trigger)}</td><td>${esc(action)}</td></tr>`;
    });
    html += `</table>`;
  }

  // Timeline
  const timeline = dir.timeline || mso.timeline || [];
  if (Array.isArray(timeline) && timeline.length > 0) {
    html += `<h3>Implementation Timeline</h3>`;
    html += `<table><tr><th>Milestone</th><th>Deadline</th></tr>`;
    timeline.slice(0, 8).forEach(t => {
      const name = t.phase || t.name || t.milestone || '';
      const deadline = t.timeframe || t.deadline || t.duration || '';
      html += `<tr><td>${esc(name)}</td><td>${esc(deadline)}</td></tr>`;
    });
    html += `</table>`;
  }

  html += `</div>`;
  return html;
}


function buildBoardReport(bgp, meta, dash, gov) {
  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">08</div><h2>Board Report</h2></div>`;

  // Governance framework
  const governance = bgp.governance_framework || bgp.governance || gov.governance || {};
  if (typeof governance === 'object' && Object.keys(governance).length > 0) {
    html += `<h3>Governance Framework</h3>`;
    html += `<table><tr><th>Element</th><th>Detail</th></tr>`;
    flattenToRows(governance).forEach(([k, v]) => {
      html += `<tr><td><strong>${esc(k)}</strong></td><td>${esc(v)}</td></tr>`;
    });
    html += `</table>`;
  }

  // Vote summary
  const voteSplit = dash.vote_split || {};
  const totalVotes = Object.values(voteSplit).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
  if (totalVotes > 0) {
    html += `<h3>Vote Summary</h3>`;
    html += buildVoteBar(voteSplit, totalVotes);
  }

  // Board recommendations
  const boardRecs = bgp.recommendations || bgp.board_recommendations || [];
  if (Array.isArray(boardRecs) && boardRecs.length > 0) {
    html += `<h3>Board Recommendations</h3><ul class="action-list">`;
    boardRecs.forEach(r => {
      const text = typeof r === 'string' ? r : r.recommendation || r.description || JSON.stringify(r);
      html += `<li>${esc(text)}</li>`;
    });
    html += `</ul>`;
  }

  // Conditions
  const conditions = bgp.conditions || bgp.approval_conditions || [];
  if (Array.isArray(conditions) && conditions.length > 0) {
    html += `<h3>Approval Conditions</h3><ul class="action-list">`;
    conditions.forEach(c => {
      const text = typeof c === 'string' ? c : c.condition || c.description || JSON.stringify(c);
      html += `<li>${esc(text)}</li>`;
    });
    html += `</ul>`;
  }

  html += `<div class="conf-stripe">Confidential &mdash; Board of Directors &mdash; ${esc(meta.company || 'StratOS')}</div>`;
  html += `</div>`;
  return html;
}


/* ── Board-packet specific sections ── */
function buildBoardCoverSummary(meta, dash, exec) {
  const decision = exec.decision || exec.recommendation || dash.headline_recommendation || '';
  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">01</div><h2>Executive Summary</h2></div>`;
  html += `<div class="narrative"><p>Board packet prepared ${meta.date} for the decision: <strong>${esc(meta.question)}</strong></p>`;
  html += `<p>Recommendation: <strong>${esc(meta.verdict)}</strong> at ${meta.confidence}% confidence. ${meta.verdictSub ? `(${esc(meta.verdictSub)})` : ''}</p></div>`;
  if (decision) {
    html += `<div class="callout callout-green"><div class="narrative">${esc(decision)}</div></div>`;
  }
  html += `</div>`;
  return html;
}


function buildRiskOverview(dash, data) {
  const riskMatrix = dash.risk_matrix || {};
  const risks = riskMatrix.risks || riskMatrix.items || [];

  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">03</div><h2>Risk Overview</h2></div>`;

  if (Array.isArray(risks) && risks.length > 0) {
    html += `<table><tr><th>Risk</th><th>Severity</th><th>Mitigation</th></tr>`;
    risks.slice(0, 8).forEach(r => {
      const sev = r.severity || r.impact || r.level || 'MEDIUM';
      const chipClass = sev.toUpperCase() === 'HIGH' ? 'risk-high' : sev.toUpperCase() === 'LOW' ? 'risk-low' : 'risk-medium';
      html += `<tr>
        <td><strong>${esc(r.name || r.risk || r.title || 'Risk')}</strong></td>
        <td><span class="risk-chip ${chipClass}">${esc(sev)}</span></td>
        <td>${esc(r.mitigation || r.response || '')}</td>
      </tr>`;
    });
    html += `</table>`;
  } else {
    html += `<div class="narrative"><p>Risk data will be populated from engine output.</p></div>`;
  }

  html += `</div>`;
  return html;
}


function buildConditionsKillGates(bgp, mso) {
  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">04</div><h2>Conditions &amp; Kill Gates</h2></div>`;

  const conditions = bgp.conditions || bgp.approval_conditions || [];
  if (Array.isArray(conditions) && conditions.length > 0) {
    html += `<h3>Approval Conditions</h3><ul class="action-list">`;
    conditions.forEach(c => {
      const text = typeof c === 'string' ? c : c.condition || c.description || JSON.stringify(c);
      html += `<li>${esc(text)}</li>`;
    });
    html += `</ul>`;
  }

  const killGates = bgp.kill_gates || bgp.killGates || mso.kill_gates || [];
  if (Array.isArray(killGates) && killGates.length > 0) {
    html += `<h3>Kill Gates</h3>`;
    html += `<table><tr><th>Gate</th><th>Threshold</th><th>Action</th></tr>`;
    killGates.forEach(k => {
      const gate = typeof k === 'string' ? k : k.gate || k.name || k.trigger || '';
      const threshold = typeof k === 'string' ? '' : k.threshold || k.value || '';
      const action = typeof k === 'string' ? '' : k.action || k.response || '';
      html += `<tr><td>${esc(gate)}</td><td>${esc(threshold)}</td><td>${esc(action)}</td></tr>`;
    });
    html += `</table>`;
  }

  html += `<div class="conf-stripe">End of Board Packet &mdash; Generated by StratOS Decision Intelligence</div>`;
  html += `</div>`;
  return html;
}


/* ═══════════════════════════════════════════════════════════════════
   HELPER FUNCTIONS
   ═══════════════════════════════════════════════════════════════════ */

function metricCard(value, label) {
  return `<div class="metric-card"><div class="metric-value">${esc(String(value || '—'))}</div><div class="metric-label">${esc(label)}</div></div>`;
}

function buildVoteBar(voteSplit, totalVotes) {
  const colors = {
    'APPROVE': '#16a34a',
    'APPROVE_WITH_CONDITIONS': '#d97706',
    'CONDITIONAL': '#d97706',
    'REJECT': '#dc2626',
    'ABSTAIN': '#94a3b8',
  };
  let html = `<div class="vote-bar-container"><div class="vote-bar">`;
  Object.entries(voteSplit).forEach(([key, count]) => {
    if (typeof count !== 'number' || count <= 0) return;
    const pct = ((count / totalVotes) * 100).toFixed(1);
    const matchKey = Object.keys(colors).find(c => key.toUpperCase().includes(c)) || 'ABSTAIN';
    const color = colors[matchKey] || '#94a3b8';
    html += `<div class="vote-segment" style="width:${pct}%;background:${color}">${count}</div>`;
  });
  html += `</div><div class="vote-legend">`;
  Object.entries(voteSplit).forEach(([key, count]) => {
    if (typeof count !== 'number' || count <= 0) return;
    const matchKey = Object.keys(colors).find(c => key.toUpperCase().includes(c)) || 'ABSTAIN';
    const color = colors[matchKey] || '#94a3b8';
    html += `<span><span class="vote-legend-dot" style="background:${color}"></span>${key.replace(/_/g, ' ')} (${count})</span>`;
  });
  html += `</div></div>`;
  return html;
}

function extractActions(mso, exec) {
  const sources = [
    mso.immediate_actions, mso.strategic_actions, mso.actions,
    exec.actions, exec.immediate_actions, exec.priority_actions,
  ];
  for (const src of sources) {
    if (Array.isArray(src) && src.length > 0) {
      return src.map(a => {
        if (typeof a === 'string') return { title: a, detail: '' };
        return { title: a.action || a.title || a.name || '', detail: a.description || a.detail || '' };
      });
    }
  }
  return [];
}

function extractConditions(dash) {
  const bgp = dash.board_governance || {};
  const sources = [bgp.conditions, bgp.approval_conditions, dash.conditions];
  for (const src of sources) {
    if (Array.isArray(src) && src.length > 0) {
      return src.map(c => typeof c === 'string' ? c : c.condition || c.description || JSON.stringify(c));
    }
  }
  return [];
}

function flattenToRows(obj, prefix = '') {
  const rows = [];
  for (const [k, v] of Object.entries(obj)) {
    const label = prefix ? `${prefix} > ${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      rows.push(...flattenToRows(v, label));
    } else if (Array.isArray(v)) {
      rows.push([label.replace(/_/g, ' '), v.map(i => typeof i === 'string' ? i : JSON.stringify(i)).join('; ')]);
    } else {
      rows.push([label.replace(/_/g, ' '), String(v ?? '')]);
    }
  }
  return rows.slice(0, 20); // Limit rows
}
