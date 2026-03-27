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
  const tlViz = ob.timeline_visualization || {};
  const dPacket = data.dPacket || {};
  const rolePackets = dPacket.role_packets || dPacket.roles || {};

  let body = '';

  // Cover page (all types)
  body += buildCoverPage(meta);

  if (reportType === 'executive-brief') {
    body += buildExecSummary(meta, dash, exec, mso, bgp, fm, data);
    body += buildKeyMetrics(meta, dash, data, exec, bgp);
  } else if (reportType === 'full-report') {
    body += buildExecSummary(meta, dash, exec, mso, bgp, fm, data);
    body += buildTOC();
    body += buildBriefingSection(meta, dash, exec, dir, mso);
    body += buildCommandCenter(mso, dir, dash, tlViz);
    body += buildRiskIntel(dash, data, mso);
    body += buildFinancials(fm, dash, bgp);
    body += buildTheRoom(dash, data, rolePackets, dPacket);
    body += buildManagementHandoff(mso, dir, rolePackets);
    body += buildBoardReport(bgp, meta, dash, gov, mso);
  } else if (reportType === 'board-packet') {
    body += buildBoardCoverSummary(meta, dash, exec, bgp, fm);
    body += buildBoardReport(bgp, meta, dash, gov, mso);
    body += buildRiskOverview(dash, data, mso);
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

/* ── Page breaks & orphan protection ── */
.page-break { page-break-before: always; break-before: page; }
h2, h3, h4 { page-break-after: avoid; break-after: avoid; }
.callout, .metric-card, table, .action-list li, .role-card { page-break-inside: avoid; break-inside: avoid; }
.section { page-break-inside: auto; }

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

/* ── Role cards ── */
.role-card {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 14px 16px;
  margin-bottom: 12px;
  page-break-inside: avoid;
}
.role-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.role-card-name {
  font-family: 'Sora', sans-serif;
  font-size: 12px;
  font-weight: 600;
  color: #0f172a;
}
.role-card-vote {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 4px;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.role-card-vote-approve { background: #dcfce7; color: #16a34a; }
.role-card-vote-conditional { background: #fef3c7; color: #d97706; }
.role-card-vote-reject { background: #fee2e2; color: #dc2626; }
.role-card-body { font-size: 10.5px; color: #475569; line-height: 1.6; }
.role-card-confidence {
  display: flex; align-items: center; gap: 8px;
  margin-top: 6px; font-size: 10px; color: #64748b;
}
.role-card-conf-bar {
  flex: 1; height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden;
}
.role-card-conf-fill {
  height: 100%; border-radius: 3px;
  background: linear-gradient(90deg, #1a365d, #3b82f6);
}

/* ── Three column layout ── */
.three-col {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 16px;
  margin-bottom: 16px;
}

/* ── Dense narrative ── */
.narrative-dense {
  font-size: 11px;
  line-height: 1.65;
  color: #334155;
  margin-bottom: 12px;
}

/* ── Highlight box ── */
.highlight-box {
  background: #f1f5f9;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
}
.highlight-box h4 { margin-bottom: 8px; color: #1a365d; }

/* ── KPI row ── */
.kpi-row {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.kpi-item {
  flex: 1;
  min-width: 120px;
  text-align: center;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 12px 8px;
}
.kpi-value {
  font-family: 'Sora', sans-serif;
  font-size: 22px;
  font-weight: 700;
  color: #0f172a;
  line-height: 1.1;
}
.kpi-label {
  font-size: 9px;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-top: 4px;
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


function buildExecSummary(meta, dash, exec, mso, bgp = {}, fm = {}, data = {}) {
  const actions = extractActions(mso, exec);
  const conditions = extractConditions(dash);
  const topRisks = dash.top_3_risks || dash.top_risks || [];
  const voteSplit = dash.vote_split || {};
  const totalVotes = Object.values(voteSplit).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
  const execDecision = exec.decision || exec.recommendation || dash.headline_recommendation || '';
  const topActions = exec.top_3_actions || exec.priority_actions || actions;
  const topConditions = exec.top_conditions || conditions;
  const finOverview = bgp.financial_overview || fm.summary || {};
  const approvedLabel = dash.approved_option_label || meta.verdict;
  const rolePreview = dash.role_assessment_preview || [];

  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">01</div><h2>Executive Summary</h2></div>`;

  // Verdict + confidence bar side by side
  html += `<div class="two-col">`;
  html += `<div>`;
  html += `<div class="callout" style="border-left-color:${verdictColor(meta.verdict)};background:${verdictBg(meta.verdict)};">`;
  html += `<div style="font-family:'Sora',sans-serif;font-size:18px;font-weight:700;color:${verdictColor(meta.verdict)};margin-bottom:4px;">${esc(approvedLabel)}</div>`;
  if (meta.verdictSub) html += `<div style="font-size:11px;color:#64748b;">${esc(meta.verdictSub)}</div>`;
  if (execDecision) html += `<div class="narrative-dense" style="margin-top:8px;">${esc(execDecision)}</div>`;
  html += `</div>`;
  html += `</div>`;
  html += `<div>`;
  html += `<div class="conf-bar-wrap"><div style="font-size:10px;color:#64748b;margin-bottom:4px;">Decision Confidence</div><div class="conf-bar-bg"><div class="conf-bar-fill" style="width:${meta.confidence}%"></div></div><div class="conf-label" style="font-size:18px;font-family:'Sora',sans-serif;font-weight:700;color:#0f172a;">${meta.confidence}%</div></div>`;
  // Vote bar inline
  if (totalVotes > 0) {
    html += `<div style="margin-top:8px;">`;
    html += buildVoteBar(voteSplit, totalVotes);
    html += `</div>`;
  }
  html += `</div>`;
  html += `</div>`;

  // Top 3 actions with detail
  const displayActions = Array.isArray(topActions) ? topActions : actions;
  if (displayActions.length > 0) {
    html += `<h3>Top Priority Actions</h3><ul class="action-list">`;
    displayActions.slice(0, 3).forEach((a, i) => {
      const title = typeof a === 'string' ? a : (a.action || a.title || a.name || `Action ${i + 1}`);
      const detail = typeof a === 'string' ? '' : (a.description || a.detail || a.rationale || '');
      const owner = typeof a === 'string' ? '' : (a.owner || a.responsible || '');
      html += `<li><strong>${i + 1}. ${esc(title)}</strong>`;
      if (detail) html += `<br>${esc(detail)}`;
      if (owner) html += `<br><span style="font-size:9px;color:#64748b;">Owner: ${esc(owner)}</span>`;
      html += `</li>`;
    });
    html += `</ul>`;
  }

  // Key conditions
  const displayConditions = Array.isArray(topConditions) && topConditions.length > 0 ? topConditions : conditions;
  if (displayConditions.length > 0) {
    html += `<h3>Conditions for Approval</h3><ul class="action-list">`;
    displayConditions.slice(0, 5).forEach(c => {
      const text = typeof c === 'string' ? c : (c.condition || c.description || JSON.stringify(c));
      html += `<li>${esc(text)}</li>`;
    });
    html += `</ul>`;
  }

  // Role assessment preview (vote by role with confidence)
  if (Array.isArray(rolePreview) && rolePreview.length > 0) {
    html += `<h3>Vote Breakdown by Role</h3>`;
    html += `<table><tr><th>Role</th><th>Vote</th><th>Confidence</th><th>Key Concern</th></tr>`;
    rolePreview.slice(0, 10).forEach(r => {
      const role = r.role || r.role_key || r.name || '';
      const vote = r.vote || r.recommendation || '';
      let conf = r.confidence || r.confidence_pct || '';
      if (typeof conf === 'number' && conf < 1) conf = Math.round(conf * 100) + '%';
      else if (typeof conf === 'number') conf = conf + '%';
      const concern = r.key_concern || r.concern || r.rationale || '';
      html += `<tr><td><strong>${esc(role.replace(/_/g, ' '))}</strong></td><td>${esc(String(vote).replace(/_/g, ' '))}</td><td>${esc(String(conf))}</td><td style="font-size:10px;">${esc(concern)}</td></tr>`;
    });
    html += `</table>`;
  }

  // Top 3 risks
  if (Array.isArray(topRisks) && topRisks.length > 0) {
    html += `<h3>Key Risk Summary</h3>`;
    html += `<div class="three-col">`;
    topRisks.slice(0, 3).forEach(r => {
      const name = typeof r === 'string' ? r : (r.name || r.risk || r.title || 'Risk');
      const sev = typeof r === 'string' ? '' : (r.severity || r.impact || r.level || '');
      const mit = typeof r === 'string' ? '' : (r.mitigation || r.response || '');
      const chipClass = sev.toString().toUpperCase() === 'HIGH' ? 'risk-high' : sev.toString().toUpperCase() === 'LOW' ? 'risk-low' : 'risk-medium';
      html += `<div class="highlight-box">`;
      html += `<h4>${esc(typeof r === 'string' ? r : name)}</h4>`;
      if (sev) html += `<span class="risk-chip ${chipClass}" style="margin-bottom:6px;display:inline-block;">${esc(sev)}</span><br>`;
      if (mit) html += `<div class="narrative-dense">${esc(mit)}</div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }

  // Financial headline
  const finSummary = finOverview.summary || finOverview.headline || finOverview.capital_approved || fm.investment_ask || '';
  const ltvcac = fm.ltv_cac || fm.ltv_cac_ratio || finOverview.ltv_cac || '';
  if (finSummary || ltvcac) {
    html += `<h3>Financial Headline</h3><div class="callout">`;
    if (finSummary) html += `<div class="narrative-dense"><strong>Capital:</strong> ${esc(typeof finSummary === 'object' ? JSON.stringify(finSummary) : String(finSummary))}</div>`;
    if (ltvcac) html += `<div class="narrative-dense"><strong>LTV/CAC:</strong> ${esc(String(ltvcac))}</div>`;
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}


function buildKeyMetrics(meta, dash, data, exec = {}, bgp = {}) {
  const stageCount = (data.stageOutputs || []).length;
  const roleSet = new Set((data.stageOutputs || []).map(s => s.role_key).filter(Boolean));
  const rounds = new Set((data.stageOutputs || []).map(s => s.round).filter(Boolean));
  const voteSplit = dash.vote_split || {};
  const totalVotes = Object.values(voteSplit).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
  const allConditions = dash.all_conditions || [];
  const citations = dash.citations || [];
  const strategicWins = dash.strategic_wins || [];

  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">02</div><h2>Analysis Details</h2></div>`;
  html += `<div class="metrics-grid">`;
  html += metricCard(meta.confidence + '%', 'Decision Confidence');
  html += metricCard(totalVotes || roleSet.size, 'Panel Votes');
  html += metricCard(roleSet.size, 'Expert Roles');
  html += metricCard(rounds.size, 'Deliberation Rounds');
  html += `</div>`;

  // Strategic wins
  if (Array.isArray(strategicWins) && strategicWins.length > 0) {
    html += `<h3>Strategic Wins</h3><ul class="action-list">`;
    strategicWins.slice(0, 4).forEach(w => {
      const text = typeof w === 'string' ? w : (w.title || w.win || w.description || JSON.stringify(w));
      html += `<li>${esc(text)}</li>`;
    });
    html += `</ul>`;
  }

  // All conditions
  if (Array.isArray(allConditions) && allConditions.length > 0) {
    html += `<h3>All Conditions (${allConditions.length})</h3><ul class="action-list">`;
    allConditions.slice(0, 6).forEach(c => {
      const text = typeof c === 'string' ? c : (c.condition || c.description || JSON.stringify(c));
      html += `<li>${esc(text)}</li>`;
    });
    html += `</ul>`;
  }

  // Citations / evidence
  if (Array.isArray(citations) && citations.length > 0) {
    html += `<h3>Supporting Evidence</h3>`;
    html += `<table><tr><th>Source</th><th>Finding</th></tr>`;
    citations.slice(0, 5).forEach(c => {
      const src = typeof c === 'string' ? '' : (c.source || c.role || c.type || '');
      const finding = typeof c === 'string' ? c : (c.text || c.finding || c.citation || JSON.stringify(c));
      html += `<tr><td>${esc(src)}</td><td style="font-size:10px;">${esc(finding)}</td></tr>`;
    });
    html += `</table>`;
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


function buildBriefingSection(meta, dash, exec, dir, mso = {}) {
  const decision = exec.decision || exec.recommendation || dash.headline_recommendation || '';
  const upside = exec.upside || exec.opportunity || '';
  const why = exec.rationale || exec.reasoning || '';
  const strategicNarrative = dir.strategic_narrative || dir.narrative || mso.strategic_rationale || '';
  const milestones = dir.milestones || mso.milestones || [];
  const evidencePanel = dir.evidence_panel || dir.evidence || [];
  const strategicWins = dash.strategic_wins || mso.strategic_wins || [];

  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">02</div><h2>Executive Briefing</h2></div>`;

  if (decision) {
    html += `<h3>Decision Narrative</h3><div class="callout callout-green"><div class="narrative">${esc(decision)}</div></div>`;
  }

  // Why it matters + upside in two columns
  if (strategicNarrative || upside || why) {
    html += `<div class="two-col">`;
    html += `<div>`;
    if (strategicNarrative) {
      html += `<h3>Strategic Narrative</h3><div class="narrative-dense">${esc(strategicNarrative)}</div>`;
    } else if (why) {
      html += `<h3>Why This Matters</h3><div class="narrative-dense">${esc(why)}</div>`;
    }
    html += `</div>`;
    html += `<div>`;
    if (upside) {
      html += `<h3>Upside Case</h3><div class="narrative-dense">${esc(upside)}</div>`;
    }
    html += `</div>`;
    html += `</div>`;
  }

  // Strategic wins
  if (Array.isArray(strategicWins) && strategicWins.length > 0) {
    html += `<h3>Strategic Wins</h3><div class="three-col">`;
    strategicWins.slice(0, 3).forEach(w => {
      const text = typeof w === 'string' ? w : (w.title || w.win || w.description || JSON.stringify(w));
      const detail = typeof w === 'string' ? '' : (w.detail || w.description || '');
      html += `<div class="highlight-box"><h4>${esc(typeof w === 'string' ? w : (w.title || w.win || 'Win'))}</h4>`;
      if (detail && detail !== text) html += `<div class="narrative-dense">${esc(detail)}</div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }

  // Direction package actions
  const dirActions = dir.strategic_actions || dir.immediate_actions || [];
  if (Array.isArray(dirActions) && dirActions.length > 0) {
    html += `<h3>Strategic Direction</h3><ul class="action-list">`;
    dirActions.slice(0, 5).forEach((a, i) => {
      const text = typeof a === 'string' ? a : a.action || a.description || JSON.stringify(a);
      const owner = typeof a === 'string' ? '' : (a.owner || a.responsible || '');
      html += `<li><strong>${i + 1}.</strong> ${esc(text)}`;
      if (owner) html += ` <span style="font-size:9px;color:#64748b;">(${esc(owner)})</span>`;
      html += `</li>`;
    });
    html += `</ul>`;
  }

  // Evidence panel
  if (Array.isArray(evidencePanel) && evidencePanel.length > 0) {
    html += `<h3>Evidence Panel</h3>`;
    html += `<table><tr><th>Source</th><th>Finding</th><th>Impact</th></tr>`;
    evidencePanel.slice(0, 5).forEach(e => {
      const src = typeof e === 'string' ? '' : (e.source || e.type || e.role || '');
      const finding = typeof e === 'string' ? e : (e.finding || e.text || e.description || JSON.stringify(e));
      const impact = typeof e === 'string' ? '' : (e.impact || e.implication || '');
      html += `<tr><td>${esc(src)}</td><td style="font-size:10px;">${esc(finding)}</td><td style="font-size:10px;">${esc(impact)}</td></tr>`;
    });
    html += `</table>`;
  }

  // Milestones
  if (Array.isArray(milestones) && milestones.length > 0) {
    html += `<h3>Key Milestones</h3>`;
    html += `<table><tr><th>Milestone</th><th>Target</th><th>Owner</th></tr>`;
    milestones.slice(0, 6).forEach(m => {
      const name = typeof m === 'string' ? m : (m.name || m.milestone || m.title || '');
      const target = typeof m === 'string' ? '' : (m.target || m.date || m.deadline || m.timeframe || '');
      const owner = typeof m === 'string' ? '' : (m.owner || m.responsible || '');
      html += `<tr><td>${esc(name)}</td><td>${esc(target)}</td><td>${esc(owner)}</td></tr>`;
    });
    html += `</table>`;
  }

  html += `</div>`;
  return html;
}


function buildCommandCenter(mso, dir, dash = {}, tlViz = {}) {
  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">03</div><h2>Command Center</h2></div>`;

  // Decision record
  const decisionRecord = mso.decision_record || {};
  if (typeof decisionRecord === 'object' && Object.keys(decisionRecord).length > 0) {
    html += `<h3>Decision Record</h3>`;
    html += `<table><tr><th>Element</th><th>Detail</th></tr>`;
    flattenToRows(decisionRecord).slice(0, 8).forEach(([k, v]) => {
      html += `<tr><td><strong>${esc(k)}</strong></td><td>${esc(v)}</td></tr>`;
    });
    html += `</table>`;
  }

  // Strategic wins from dashboard
  const wins = dash.strategic_wins || mso.strategic_wins || mso.key_wins || [];
  if (Array.isArray(wins) && wins.length > 0) {
    html += `<h3>Strategic Wins</h3><div class="three-col">`;
    wins.slice(0, 3).forEach(w => {
      const text = typeof w === 'string' ? w : (w.title || w.win || w.description || JSON.stringify(w));
      const detail = typeof w === 'string' ? '' : (w.detail || w.impact || w.description || '');
      html += `<div class="highlight-box"><h4>${esc(typeof w === 'string' ? w : (w.title || w.win || 'Win'))}</h4>`;
      if (detail && detail !== text) html += `<div class="narrative-dense">${esc(detail)}</div>`;
      html += `</div>`;
    });
    html += `</div>`;
    if (wins.length > 3) {
      html += `<ul class="action-list">`;
      wins.slice(3, 6).forEach(w => {
        const text = typeof w === 'string' ? w : (w.title || w.win || w.description || JSON.stringify(w));
        html += `<li>${esc(text)}</li>`;
      });
      html += `</ul>`;
    }
  }

  // Timeline phases from timeline_visualization or mso
  const tlPhases = tlViz.phases || mso.timeline_phases || dir.timeline || mso.timeline || [];
  if (Array.isArray(tlPhases) && tlPhases.length > 0) {
    html += `<h3>Implementation Timeline</h3>`;
    html += `<table><tr><th>Phase</th><th>Description</th><th>Timeframe</th><th>Key Deliverables</th></tr>`;
    tlPhases.slice(0, 8).forEach((t, i) => {
      const phase = t.phase || t.name || t.title || `Phase ${i + 1}`;
      const desc = t.description || t.detail || t.action || t.objective || '';
      const time = t.timeframe || t.duration || t.deadline || t.dates || '';
      const deliverables = t.deliverables || t.outputs || t.milestones || [];
      const delText = Array.isArray(deliverables) ? deliverables.map(d => typeof d === 'string' ? d : (d.name || d.title || '')).join(', ') : String(deliverables || '');
      html += `<tr><td><strong>${esc(phase)}</strong></td><td style="font-size:10px;">${esc(desc)}</td><td>${esc(time)}</td><td style="font-size:10px;">${esc(delText)}</td></tr>`;
    });
    html += `</table>`;
  }

  // Hard gates from timeline_visualization or mso
  const hardGates = tlViz.hard_gates || mso.hard_gates || [];
  if (Array.isArray(hardGates) && hardGates.length > 0) {
    html += `<h3>Hard Gates</h3>`;
    html += `<table><tr><th>Gate</th><th>Trigger</th><th>Action</th></tr>`;
    hardGates.slice(0, 5).forEach(g => {
      const name = typeof g === 'string' ? g : (g.gate || g.name || g.title || '');
      const trigger = typeof g === 'string' ? '' : (g.trigger || g.threshold || g.condition || '');
      const action = typeof g === 'string' ? '' : (g.action || g.response || '');
      html += `<tr><td><strong>${esc(name)}</strong></td><td>${esc(trigger)}</td><td>${esc(action)}</td></tr>`;
    });
    html += `</table>`;
  }

  // Dependencies
  const deps = mso.dependencies || [];
  if (Array.isArray(deps) && deps.length > 0) {
    html += `<h3>Key Dependencies</h3><ul class="action-list">`;
    deps.slice(0, 5).forEach(d => {
      const text = typeof d === 'string' ? d : (d.dependency || d.name || d.description || JSON.stringify(d));
      html += `<li>${esc(text)}</li>`;
    });
    html += `</ul>`;
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


function buildRiskIntel(dash, data, mso = {}) {
  const riskMatrix = dash.risk_matrix || {};
  const risks = riskMatrix.risks || riskMatrix.items || [];
  const topRisks = dash.top_3_risks || dash.top_risks || [];

  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">04</div><h2>Risk &amp; Intelligence</h2></div>`;

  if (riskMatrix.summary || riskMatrix.description) {
    html += `<div class="narrative">${esc(riskMatrix.summary || riskMatrix.description)}</div>`;
  }

  // Top 3 risks as highlight cards
  if (Array.isArray(topRisks) && topRisks.length > 0) {
    html += `<h3>Top Risks</h3><div class="three-col">`;
    topRisks.slice(0, 3).forEach((r, i) => {
      const name = typeof r === 'string' ? r : (r.name || r.risk || r.title || `Risk ${i + 1}`);
      const sev = typeof r === 'string' ? 'MEDIUM' : (r.severity || r.impact || r.level || 'MEDIUM');
      const mit = typeof r === 'string' ? '' : (r.mitigation || r.response || '');
      const desc = typeof r === 'string' ? '' : (r.description || '');
      const chipClass = sev.toString().toUpperCase() === 'HIGH' ? 'risk-high' : sev.toString().toUpperCase() === 'LOW' ? 'risk-low' : 'risk-medium';
      html += `<div class="highlight-box" style="border-left:3px solid ${sev.toString().toUpperCase() === 'HIGH' ? '#dc2626' : sev.toString().toUpperCase() === 'LOW' ? '#16a34a' : '#d97706'};">`;
      html += `<h4>${esc(typeof r === 'string' ? r : name)}</h4>`;
      html += `<span class="risk-chip ${chipClass}">${esc(sev)}</span>`;
      if (desc) html += `<div class="narrative-dense" style="margin-top:6px;">${esc(desc)}</div>`;
      if (mit) html += `<div class="narrative-dense" style="margin-top:4px;"><strong>Mitigation:</strong> ${esc(mit)}</div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }

  // Full risk register
  if (Array.isArray(risks) && risks.length > 0) {
    html += `<h3>Risk Register (${risks.length} Identified)</h3>`;
    html += `<table><tr><th>Risk</th><th>Severity</th><th>Likelihood</th><th>Mitigation</th></tr>`;
    risks.slice(0, 10).forEach(r => {
      const sev = r.severity || r.impact || r.level || 'MEDIUM';
      const chipClass = sev.toUpperCase() === 'HIGH' ? 'risk-high' : sev.toUpperCase() === 'LOW' ? 'risk-low' : 'risk-medium';
      html += `<tr>
        <td><strong>${esc(r.name || r.risk || r.title || 'Risk')}</strong>${r.description ? '<br>' + esc(r.description) : ''}</td>
        <td><span class="risk-chip ${chipClass}">${esc(sev)}</span></td>
        <td>${esc(r.likelihood || r.probability || '')}</td>
        <td style="font-size:10px;">${esc(r.mitigation || r.response || '')}</td>
      </tr>`;
    });
    html += `</table>`;
  }

  // Risk matrix summary counts
  const highCount = risks.filter(r => (r.severity || r.impact || r.level || '').toString().toUpperCase() === 'HIGH').length;
  const medCount = risks.filter(r => (r.severity || r.impact || r.level || '').toString().toUpperCase() === 'MEDIUM').length;
  const lowCount = risks.filter(r => (r.severity || r.impact || r.level || '').toString().toUpperCase() === 'LOW').length;
  if (risks.length > 0) {
    html += `<div class="kpi-row">`;
    html += `<div class="kpi-item" style="border-left:3px solid #dc2626;"><div class="kpi-value" style="color:#dc2626;">${highCount}</div><div class="kpi-label">High Severity</div></div>`;
    html += `<div class="kpi-item" style="border-left:3px solid #d97706;"><div class="kpi-value" style="color:#d97706;">${medCount}</div><div class="kpi-label">Medium Severity</div></div>`;
    html += `<div class="kpi-item" style="border-left:3px solid #16a34a;"><div class="kpi-value" style="color:#16a34a;">${lowCount}</div><div class="kpi-label">Low Severity</div></div>`;
    html += `</div>`;
  }

  // Evidence summary
  const evidence = dash.evidence_summary || dash.evidence || [];
  if (Array.isArray(evidence) && evidence.length > 0) {
    html += `<h3>Evidence Base</h3><ul class="action-list">`;
    evidence.slice(0, 6).forEach(e => {
      const text = typeof e === 'string' ? e : e.finding || e.description || JSON.stringify(e);
      html += `<li>${esc(text)}</li>`;
    });
    html += `</ul>`;
  }

  html += `</div>`;
  return html;
}


function buildFinancials(fm, dash, bgp = {}) {
  const finOverview = bgp.financial_overview || {};
  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">05</div><h2>Financial Analysis</h2></div>`;

  // Financial overview narrative from board governance
  const finNarrative = finOverview.summary || finOverview.headline || finOverview.overview || '';
  if (finNarrative) {
    html += `<div class="callout"><div class="narrative">${esc(typeof finNarrative === 'object' ? JSON.stringify(finNarrative) : String(finNarrative))}</div></div>`;
  }

  // Investment structure / ask
  const investAsk = fm.investment_ask || fm.total_investment || finOverview.investment_ask || finOverview.capital_required || '';
  const ltvcac = fm.ltv_cac || fm.ltv_cac_ratio || finOverview.ltv_cac || '';
  const roi = fm.roi || fm.expected_roi || finOverview.roi || '';
  const payback = fm.payback_period || finOverview.payback || '';
  if (investAsk || ltvcac || roi || payback) {
    html += `<h3>Investment Summary</h3><div class="kpi-row">`;
    if (investAsk) html += `<div class="kpi-item"><div class="kpi-value">${esc(String(investAsk))}</div><div class="kpi-label">Capital Required</div></div>`;
    if (roi) html += `<div class="kpi-item"><div class="kpi-value">${esc(String(roi))}</div><div class="kpi-label">Expected ROI</div></div>`;
    if (ltvcac) html += `<div class="kpi-item"><div class="kpi-value">${esc(String(ltvcac))}</div><div class="kpi-label">LTV/CAC</div></div>`;
    if (payback) html += `<div class="kpi-item"><div class="kpi-value">${esc(String(payback))}</div><div class="kpi-label">Payback Period</div></div>`;
    html += `</div>`;
  }

  // KPIs
  const kpis = fm.kpis || fm.key_metrics || [];
  if (Array.isArray(kpis) && kpis.length > 0) {
    html += `<h3>Key Financial Metrics</h3><div class="metrics-grid">`;
    kpis.slice(0, 8).forEach(k => {
      const label = typeof k === 'string' ? k : k.label || k.name || 'KPI';
      const val = typeof k === 'string' ? '' : k.value || k.amount || '';
      html += metricCard(val, label);
    });
    html += `</div>`;
  }

  // Capital structure
  const capStruct = fm.capital_structure || fm.funding || finOverview.capital_structure || {};
  if (typeof capStruct === 'object' && Object.keys(capStruct).length > 0) {
    html += `<h3>Capital Structure</h3>`;
    html += `<table><tr><th>Component</th><th>Value</th></tr>`;
    flattenToRows(capStruct).forEach(([k, v]) => {
      html += `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`;
    });
    html += `</table>`;
  }

  // Scenarios
  const scenarios = fm.scenarios || fm.scenario_analysis || finOverview.scenarios || [];
  if (Array.isArray(scenarios) && scenarios.length > 0) {
    html += `<h3>Scenario Analysis</h3>`;
    html += `<table><tr><th>Scenario</th><th>Outcome</th><th>Probability</th><th>Financial Impact</th></tr>`;
    scenarios.slice(0, 5).forEach(s => {
      const impact = typeof s === 'string' ? '' : (s.financial_impact || s.impact || s.revenue_impact || '');
      html += `<tr><td><strong>${esc(s.name || s.scenario || s.label || 'Scenario')}</strong></td><td style="font-size:10px;">${esc(s.outcome || s.description || '')}</td><td>${esc(s.probability || s.likelihood || '')}</td><td>${esc(String(impact))}</td></tr>`;
    });
    html += `</table>`;
  }

  // Financial overview table from bgp if it has more fields
  if (typeof finOverview === 'object' && Object.keys(finOverview).length > 2) {
    const shown = new Set(['summary', 'headline', 'overview', 'investment_ask', 'capital_required', 'ltv_cac', 'roi', 'payback', 'capital_structure', 'scenarios']);
    const remaining = Object.entries(finOverview).filter(([k]) => !shown.has(k));
    if (remaining.length > 0) {
      html += `<h3>Additional Financial Detail</h3>`;
      html += `<table><tr><th>Metric</th><th>Value</th></tr>`;
      remaining.slice(0, 10).forEach(([k, v]) => {
        const val = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
        html += `<tr><td>${esc(k.replace(/_/g, ' '))}</td><td>${esc(val)}</td></tr>`;
      });
      html += `</table>`;
    }
  }

  html += `</div>`;
  return html;
}


function buildTheRoom(dash, data, rolePackets = {}, dPacket = {}) {
  const stageOutputs = data.stageOutputs || [];
  const voteSplit = dash.vote_split || {};
  const totalVotes = Object.values(voteSplit).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
  const rolePreview = dash.role_assessment_preview || [];

  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">06</div><h2>The Room</h2></div>`;

  // Vote bar
  if (totalVotes > 0) {
    html += buildVoteBar(voteSplit, totalVotes);
  }

  // Per-role cards from role_packets (richest source)
  const rpEntries = Object.entries(rolePackets);
  if (rpEntries.length > 0) {
    html += `<h3>Individual Role Assessments</h3>`;
    rpEntries.forEach(([roleKey, rp]) => {
      if (!rp || typeof rp !== 'object') return;
      const vote = rp.vote || rp.recommendation || rp.decision || '';
      let conf = rp.confidence || rp.confidence_pct || 0;
      if (typeof conf === 'number' && conf < 1) conf = Math.round(conf * 100);
      const rationale = rp.rationale || rp.reasoning || rp.summary || rp.analysis || '';
      const concern = rp.key_concern || rp.concern || rp.primary_risk || '';
      const conditions = rp.conditions || rp.approval_conditions || [];

      const voteStr = String(vote).toUpperCase();
      const voteClass = voteStr.includes('APPROVE') && !voteStr.includes('CONDITION') ? 'role-card-vote-approve' :
                         voteStr.includes('REJECT') ? 'role-card-vote-reject' : 'role-card-vote-conditional';

      html += `<div class="role-card">`;
      html += `<div class="role-card-header">`;
      html += `<div class="role-card-name">${esc(roleKey.replace(/_/g, ' '))}</div>`;
      if (vote) html += `<span class="role-card-vote ${voteClass}">${esc(String(vote).replace(/_/g, ' '))}</span>`;
      html += `</div>`;
      html += `<div class="role-card-confidence"><span>${conf}%</span><div class="role-card-conf-bar"><div class="role-card-conf-fill" style="width:${conf}%"></div></div></div>`;
      if (rationale) html += `<div class="role-card-body" style="margin-top:6px;">${esc(rationale)}</div>`;
      if (concern) html += `<div class="role-card-body" style="margin-top:4px;"><strong>Key Concern:</strong> ${esc(concern)}</div>`;
      if (Array.isArray(conditions) && conditions.length > 0) {
        html += `<div class="role-card-body" style="margin-top:4px;"><strong>Conditions:</strong> ${esc(conditions.map(c => typeof c === 'string' ? c : c.condition || c.description || '').join('; '))}</div>`;
      }
      html += `</div>`;
    });
  } else if (Array.isArray(rolePreview) && rolePreview.length > 0) {
    // Fallback to role_assessment_preview from dashboard
    html += `<h3>Role Assessments</h3>`;
    rolePreview.forEach(r => {
      const roleKey = r.role || r.role_key || r.name || '';
      const vote = r.vote || r.recommendation || '';
      let conf = r.confidence || r.confidence_pct || 0;
      if (typeof conf === 'number' && conf < 1) conf = Math.round(conf * 100);
      const rationale = r.rationale || r.reasoning || '';
      const concern = r.key_concern || r.concern || '';
      const voteStr = String(vote).toUpperCase();
      const voteClass = voteStr.includes('APPROVE') && !voteStr.includes('CONDITION') ? 'role-card-vote-approve' :
                         voteStr.includes('REJECT') ? 'role-card-vote-reject' : 'role-card-vote-conditional';

      html += `<div class="role-card">`;
      html += `<div class="role-card-header">`;
      html += `<div class="role-card-name">${esc(roleKey.replace(/_/g, ' '))}</div>`;
      if (vote) html += `<span class="role-card-vote ${voteClass}">${esc(String(vote).replace(/_/g, ' '))}</span>`;
      html += `</div>`;
      html += `<div class="role-card-confidence"><span>${conf}%</span><div class="role-card-conf-bar"><div class="role-card-conf-fill" style="width:${conf}%"></div></div></div>`;
      if (rationale) html += `<div class="role-card-body" style="margin-top:6px;">${esc(rationale)}</div>`;
      if (concern) html += `<div class="role-card-body" style="margin-top:4px;"><strong>Key Concern:</strong> ${esc(concern)}</div>`;
      html += `</div>`;
    });
  } else {
    // Fallback to stageOutputs table
    const roleSet = new Set(stageOutputs.map(s => s.role_key).filter(Boolean));
    if (roleSet.size > 0) {
      html += `<h3>Panel Composition (${roleSet.size} Roles)</h3>`;
      html += `<table><tr><th>Role</th><th>Rounds Active</th></tr>`;
      const roleRounds = {};
      stageOutputs.forEach(s => {
        if (s.role_key) roleRounds[s.role_key] = (roleRounds[s.role_key] || 0) + 1;
      });
      Object.entries(roleRounds).forEach(([role, count]) => {
        html += `<tr><td>${esc(role.replace(/_/g, ' '))}</td><td>${count}</td></tr>`;
      });
      html += `</table>`;
    }
  }

  // Convergence narrative
  const convergence = dPacket.convergence_narrative || dPacket.convergence || dash.convergence_narrative || '';
  if (convergence) {
    html += `<h3>Convergence Narrative</h3><div class="narrative">${esc(typeof convergence === 'object' ? JSON.stringify(convergence) : String(convergence))}</div>`;
  }

  // Groupthink flag
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


function buildManagementHandoff(mso, dir, rolePackets = {}) {
  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">07</div><h2>Management Handoff</h2></div>`;

  // Functional mandates per role from direction_package
  const funcMandates = dir.functional_mandates || dir.role_mandates || {};
  if (typeof funcMandates === 'object' && !Array.isArray(funcMandates) && Object.keys(funcMandates).length > 0) {
    html += `<h3>Functional Mandates by Role</h3>`;
    Object.entries(funcMandates).forEach(([roleKey, mandateData]) => {
      html += `<div class="role-card">`;
      html += `<div class="role-card-name" style="margin-bottom:6px;">${esc(roleKey.replace(/_/g, ' '))}</div>`;
      if (typeof mandateData === 'string') {
        html += `<div class="role-card-body">${esc(mandateData)}</div>`;
      } else if (Array.isArray(mandateData)) {
        mandateData.forEach(m => {
          const text = typeof m === 'string' ? m : (m.mandate || m.action || m.description || JSON.stringify(m));
          html += `<div class="role-card-body" style="margin-bottom:2px;">&bull; ${esc(text)}</div>`;
        });
      } else if (typeof mandateData === 'object') {
        const mandate = mandateData.mandate || mandateData.description || mandateData.summary || '';
        const actions = mandateData.actions || mandateData.tasks || [];
        if (mandate) html += `<div class="role-card-body">${esc(mandate)}</div>`;
        if (Array.isArray(actions)) {
          actions.forEach(a => {
            const text = typeof a === 'string' ? a : (a.action || a.task || a.description || '');
            html += `<div class="role-card-body" style="margin-bottom:2px;">&bull; ${esc(text)}</div>`;
          });
        }
      }
      html += `</div>`;
    });
  } else if (Array.isArray(funcMandates) && funcMandates.length > 0) {
    html += `<h3>Functional Mandates</h3><ul class="action-list">`;
    funcMandates.forEach((m, i) => {
      const text = typeof m === 'string' ? m : (m.mandate || m.description || JSON.stringify(m));
      const owner = typeof m === 'string' ? '' : (m.role || m.owner || '');
      html += `<li><strong>${i + 1}.</strong> ${esc(text)}`;
      if (owner) html += ` <span style="font-size:9px;color:#64748b;">(${esc(owner)})</span>`;
      html += `</li>`;
    });
    html += `</ul>`;
  }

  // General execution mandates
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
  const escalation = mso.escalation_triggers || dir.escalation || dir.escalation_triggers || [];
  if (Array.isArray(escalation) && escalation.length > 0) {
    html += `<h3>Escalation Triggers</h3>`;
    html += `<table><tr><th>Trigger</th><th>Threshold</th><th>Action Required</th></tr>`;
    escalation.forEach(e => {
      const trigger = typeof e === 'string' ? e : (e.trigger || e.condition || e.name || '');
      const threshold = typeof e === 'string' ? '' : (e.threshold || e.value || '');
      const action = typeof e === 'string' ? '' : (e.action || e.response || e.escalation || '');
      html += `<tr><td><strong>${esc(trigger)}</strong></td><td>${esc(threshold)}</td><td>${esc(action)}</td></tr>`;
    });
    html += `</table>`;
  }

  // Key dates and timeline
  const timeline = dir.timeline || mso.timeline || [];
  const keyDates = mso.key_dates || dir.key_dates || [];
  if (Array.isArray(keyDates) && keyDates.length > 0) {
    html += `<h3>Key Dates</h3>`;
    html += `<table><tr><th>Date</th><th>Event</th><th>Owner</th></tr>`;
    keyDates.forEach(d => {
      const date = typeof d === 'string' ? '' : (d.date || d.deadline || d.target || '');
      const event = typeof d === 'string' ? d : (d.event || d.milestone || d.name || '');
      const owner = typeof d === 'string' ? '' : (d.owner || d.responsible || '');
      html += `<tr><td>${esc(date)}</td><td>${esc(event)}</td><td>${esc(owner)}</td></tr>`;
    });
    html += `</table>`;
  } else if (Array.isArray(timeline) && timeline.length > 0) {
    html += `<h3>Implementation Timeline</h3>`;
    html += `<table><tr><th>Milestone</th><th>Timeframe</th><th>Owner</th></tr>`;
    timeline.slice(0, 8).forEach(t => {
      const name = t.phase || t.name || t.milestone || '';
      const deadline = t.timeframe || t.deadline || t.duration || '';
      const owner = t.owner || t.responsible || '';
      html += `<tr><td>${esc(name)}</td><td>${esc(deadline)}</td><td>${esc(owner)}</td></tr>`;
    });
    html += `</table>`;
  }

  html += `</div>`;
  return html;
}


function buildBoardReport(bgp, meta, dash, gov, mso = {}) {
  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">08</div><h2>Board Report</h2></div>`;

  // Board action requested (most important for board members)
  const boardAction = bgp.board_action_requested || bgp.action_requested || '';
  if (boardAction) {
    html += `<div class="callout" style="border-left-color:#1a365d;background:#f1f5f9;">`;
    html += `<h4 style="margin-bottom:6px;">Board Action Requested</h4>`;
    html += `<div class="narrative">${esc(typeof boardAction === 'object' ? JSON.stringify(boardAction) : String(boardAction))}</div>`;
    html += `</div>`;
  }

  // Vote outcome from bgp
  const voteOutcome = bgp.vote_outcome || {};
  if (typeof voteOutcome === 'object' && Object.keys(voteOutcome).length > 0) {
    html += `<h3>Vote Outcome</h3>`;
    html += `<table><tr><th>Metric</th><th>Value</th></tr>`;
    flattenToRows(voteOutcome).slice(0, 8).forEach(([k, v]) => {
      html += `<tr><td><strong>${esc(k)}</strong></td><td>${esc(v)}</td></tr>`;
    });
    html += `</table>`;
  } else {
    // Fallback vote summary
    const voteSplit = dash.vote_split || {};
    const totalVotes = Object.values(voteSplit).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);
    if (totalVotes > 0) {
      html += `<h3>Vote Summary</h3>`;
      html += buildVoteBar(voteSplit, totalVotes);
    }
  }

  // Strategic rationale
  const stratRationale = bgp.strategic_rationale || bgp.rationale || '';
  if (stratRationale) {
    html += `<h3>Strategic Rationale</h3><div class="narrative">${esc(typeof stratRationale === 'object' ? JSON.stringify(stratRationale) : String(stratRationale))}</div>`;
  }

  // Financial overview from bgp
  const finOverview = bgp.financial_overview || {};
  if (typeof finOverview === 'object' && Object.keys(finOverview).length > 0) {
    html += `<h3>Financial Overview</h3>`;
    html += `<table><tr><th>Item</th><th>Detail</th></tr>`;
    flattenToRows(finOverview).slice(0, 10).forEach(([k, v]) => {
      html += `<tr><td><strong>${esc(k)}</strong></td><td>${esc(v)}</td></tr>`;
    });
    html += `</table>`;
  }

  // Risk overview from bgp
  const riskOverview = bgp.risk_overview || bgp.risk_summary || {};
  if (typeof riskOverview === 'object' && Object.keys(riskOverview).length > 0) {
    html += `<h3>Risk Overview</h3>`;
    if (typeof riskOverview === 'string') {
      html += `<div class="narrative">${esc(riskOverview)}</div>`;
    } else {
      html += `<table><tr><th>Risk Area</th><th>Assessment</th></tr>`;
      flattenToRows(riskOverview).slice(0, 8).forEach(([k, v]) => {
        html += `<tr><td><strong>${esc(k)}</strong></td><td>${esc(v)}</td></tr>`;
      });
      html += `</table>`;
    }
  }

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
function buildBoardCoverSummary(meta, dash, exec, bgp = {}, fm = {}) {
  const decision = exec.decision || exec.recommendation || dash.headline_recommendation || '';
  const boardAction = bgp.board_action_requested || bgp.action_requested || '';
  const stratRationale = bgp.strategic_rationale || '';
  const finOverview = bgp.financial_overview || {};
  const voteSplit = dash.vote_split || {};
  const totalVotes = Object.values(voteSplit).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);

  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">01</div><h2>Board Memorandum</h2></div>`;

  // Board memo header
  html += `<table style="margin-bottom:20px;"><tr><th style="width:120px;">To:</th><td>Board of Directors</td></tr>`;
  html += `<tr><th>From:</th><td>StratOS Decision Intelligence</td></tr>`;
  html += `<tr><th>Date:</th><td>${meta.date}</td></tr>`;
  html += `<tr><th>Subject:</th><td><strong>${esc(meta.question)}</strong></td></tr>`;
  html += `<tr><th>Recommendation:</th><td><strong style="color:${verdictColor(meta.verdict)}">${esc(meta.verdict)}${meta.verdictSub ? ' \u2014 ' + esc(meta.verdictSub) : ''}</strong> at ${meta.confidence}% confidence</td></tr>`;
  html += `</table>`;

  // Board action requested
  if (boardAction) {
    html += `<div class="callout" style="border-left-color:#1a365d;background:#f1f5f9;">`;
    html += `<h4 style="margin-bottom:6px;">Action Requested</h4>`;
    html += `<div class="narrative">${esc(typeof boardAction === 'object' ? JSON.stringify(boardAction) : String(boardAction))}</div>`;
    html += `</div>`;
  }

  // Decision summary
  if (decision) {
    html += `<h3>Decision Summary</h3><div class="callout callout-green"><div class="narrative">${esc(decision)}</div></div>`;
  }

  // Strategic rationale
  if (stratRationale) {
    html += `<h3>Strategic Rationale</h3><div class="narrative">${esc(typeof stratRationale === 'object' ? JSON.stringify(stratRationale) : String(stratRationale))}</div>`;
  }

  // Vote outcome
  if (totalVotes > 0) {
    html += `<h3>Panel Vote Outcome</h3>`;
    html += buildVoteBar(voteSplit, totalVotes);
  }

  // Financial ask summary
  const finSummary = finOverview.summary || finOverview.headline || fm.investment_ask || '';
  if (finSummary) {
    html += `<h3>Financial Summary</h3><div class="callout"><div class="narrative">${esc(typeof finSummary === 'object' ? JSON.stringify(finSummary) : String(finSummary))}</div></div>`;
  }

  html += `</div>`;
  return html;
}


function buildRiskOverview(dash, data, mso = {}) {
  const riskMatrix = dash.risk_matrix || {};
  const risks = riskMatrix.risks || riskMatrix.items || [];
  const topRisks = dash.top_3_risks || dash.top_risks || [];

  let html = `<div class="page-break"></div><div class="section">`;
  html += `<div class="section-header"><div class="section-num">03</div><h2>Risk Exposure</h2></div>`;

  if (riskMatrix.summary || riskMatrix.description) {
    html += `<div class="narrative">${esc(riskMatrix.summary || riskMatrix.description)}</div>`;
  }

  // Top risks as highlight cards for board
  if (Array.isArray(topRisks) && topRisks.length > 0) {
    html += `<h3>Top Risk Exposures</h3><div class="three-col">`;
    topRisks.slice(0, 3).forEach((r, i) => {
      const name = typeof r === 'string' ? r : (r.name || r.risk || r.title || `Risk ${i + 1}`);
      const sev = typeof r === 'string' ? 'MEDIUM' : (r.severity || r.impact || r.level || 'MEDIUM');
      const mit = typeof r === 'string' ? '' : (r.mitigation || r.response || '');
      const borderColor = sev.toString().toUpperCase() === 'HIGH' ? '#dc2626' : sev.toString().toUpperCase() === 'LOW' ? '#16a34a' : '#d97706';
      const chipClass = sev.toString().toUpperCase() === 'HIGH' ? 'risk-high' : sev.toString().toUpperCase() === 'LOW' ? 'risk-low' : 'risk-medium';
      html += `<div class="highlight-box" style="border-left:3px solid ${borderColor};">`;
      html += `<h4>${esc(typeof r === 'string' ? r : name)}</h4>`;
      html += `<span class="risk-chip ${chipClass}">${esc(sev)}</span>`;
      if (mit) html += `<div class="narrative-dense" style="margin-top:6px;"><strong>Mitigation:</strong> ${esc(mit)}</div>`;
      html += `</div>`;
    });
    html += `</div>`;
  }

  // Full risk table
  if (Array.isArray(risks) && risks.length > 0) {
    html += `<h3>Complete Risk Register</h3>`;
    html += `<table><tr><th>Risk</th><th>Severity</th><th>Mitigation</th></tr>`;
    risks.slice(0, 8).forEach(r => {
      const sev = r.severity || r.impact || r.level || 'MEDIUM';
      const chipClass = sev.toUpperCase() === 'HIGH' ? 'risk-high' : sev.toUpperCase() === 'LOW' ? 'risk-low' : 'risk-medium';
      html += `<tr>
        <td><strong>${esc(r.name || r.risk || r.title || 'Risk')}</strong>${r.description ? '<br><span style="font-size:10px;">' + esc(r.description) + '</span>' : ''}</td>
        <td><span class="risk-chip ${chipClass}">${esc(sev)}</span></td>
        <td style="font-size:10px;">${esc(r.mitigation || r.response || '')}</td>
      </tr>`;
    });
    html += `</table>`;
  } else if (topRisks.length === 0) {
    html += `<div class="narrative"><p>Detailed risk data not available for this analysis run.</p></div>`;
  }

  // Severity distribution
  const highCount = risks.filter(r => (r.severity || r.impact || r.level || '').toString().toUpperCase() === 'HIGH').length;
  const medCount = risks.filter(r => (r.severity || r.impact || r.level || '').toString().toUpperCase() === 'MEDIUM').length;
  const lowCount = risks.filter(r => (r.severity || r.impact || r.level || '').toString().toUpperCase() === 'LOW').length;
  if (risks.length > 0) {
    html += `<div class="kpi-row">`;
    html += `<div class="kpi-item" style="border-left:3px solid #dc2626;"><div class="kpi-value" style="color:#dc2626;">${highCount}</div><div class="kpi-label">High</div></div>`;
    html += `<div class="kpi-item" style="border-left:3px solid #d97706;"><div class="kpi-value" style="color:#d97706;">${medCount}</div><div class="kpi-label">Medium</div></div>`;
    html += `<div class="kpi-item" style="border-left:3px solid #16a34a;"><div class="kpi-value" style="color:#16a34a;">${lowCount}</div><div class="kpi-label">Low</div></div>`;
    html += `</div>`;
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
    exec.top_3_actions, exec.priority_actions,
    mso.immediate_actions, mso.strategic_actions, mso.actions,
    exec.actions, exec.immediate_actions,
  ];
  for (const src of sources) {
    if (Array.isArray(src) && src.length > 0) {
      return src.map(a => {
        if (typeof a === 'string') return { title: a, detail: '' };
        return {
          title: a.action || a.title || a.name || '',
          detail: a.description || a.detail || a.rationale || '',
          owner: a.owner || a.responsible || '',
        };
      });
    }
  }
  return [];
}

function extractConditions(dash) {
  const bgp = dash.board_governance || {};
  const sources = [dash.all_conditions, bgp.conditions, bgp.approval_conditions, dash.conditions, dash.top_conditions];
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
