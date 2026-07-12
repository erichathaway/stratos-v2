import { rateLimit, validateOrigin, requireAccessToken } from './_auth.js';

// Serves the "My Decisions" portal panel in public/index.html. Replaces a
// prior client-side direct-to-Supabase-REST fetch (anon key, RLS-locked
// tables — silently returned []). Reads execution_control + engine_master_state
// server-side via the service role, gated by the same access token as
// /api/data. No writes; no columns beyond what the widget already rendered.
export default async function handler(req, res) {
  validateOrigin(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Access-Token');
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (!rateLimit(req, res)) return;
  if (!requireAccessToken(req, res)) return;

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE;
  if (!SB_URL || !SB_KEY) {
    res.status(500).json({ error: 'Server configuration error. Please contact support.' });
    return;
  }

  const h = {
    'apikey': SB_KEY,
    'Authorization': `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json'
  };

  const safeFetch = async (url, label) => {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 8000);
    try {
      const r = await fetch(url, { headers: h, signal: ac.signal });
      clearTimeout(tid);
      if (!r.ok) {
        console.warn(`[portal.js] ${label} returned ${r.status}`);
        return null;
      }
      return r;
    } catch (e) {
      clearTimeout(tid);
      console.warn(`[portal.js] ${label} failed: ${e.message}`);
      return null;
    }
  };

  const safeJson = async (r, fallback = []) => {
    if (!r) return fallback;
    try { return await r.json(); } catch { return fallback; }
  };

  // customer_key mirrors the widget's getUserFilter(): a resolved identifier
  // (customer_key or email — the client already collapses email into this
  // param before calling us), matched with eq. No arbitrary filter passthrough.
  const customerKey = typeof req.query?.customer_key === 'string' ? req.query.customer_key : '';

  try {
    let ecUrl = `${SB_URL}/rest/v1/execution_control?select=run_id,current_section,section_status,started_at,customer_key&order=started_at.desc&limit=20`;
    if (customerKey) ecUrl += `&customer_key=eq.${encodeURIComponent(customerKey)}`;

    const ecRes = await safeFetch(ecUrl, 'execution_control');
    const decisions = await safeJson(ecRes, []);

    if (!Array.isArray(decisions) || decisions.length === 0) {
      res.status(200).json({ decisions: [], master: [] });
      return;
    }

    const runIds = decisions.map(r => r.run_id).filter(Boolean);
    const masterUrl = `${SB_URL}/rest/v1/engine_master_state?select=run_id,question,decision_id,confidence_score&run_id=in.(${runIds.map(encodeURIComponent).join(',')})`;
    const masterRes = await safeFetch(masterUrl, 'engine_master_state');
    const master = await safeJson(masterRes, []);

    res.status(200).json({ decisions, master: Array.isArray(master) ? master : [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
