export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  let { run_id } = req.query;
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SB_URL || !SB_KEY) {
    res.status(500).json({ error: 'Env vars not set' });
    return;
  }

  const h = {
    'apikey': SB_KEY,
    'Authorization': `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json'
  };

  // Fetch with timeout and response validation
  const safeFetch = async (url, label) => {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 8000);
    try {
      const r = await fetch(url, { headers: h, signal: ac.signal });
      clearTimeout(tid);
      if (!r.ok) {
        console.warn(`[data.js] ${label} returned ${r.status}`);
        return null;
      }
      return r;
    } catch (e) {
      clearTimeout(tid);
      console.warn(`[data.js] ${label} failed: ${e.message}`);
      return null;
    }
  };

  // Safely parse JSON from a fetch response, returning fallback on failure
  const safeJson = async (r, fallback = null) => {
    if (!r) return fallback;
    try { return await r.json(); } catch { return fallback; }
  };

  // Unwrap double-encoded JSON from Supabase blobs
  const unwrap = async (r) => {
    const rows = await safeJson(r, []);
    const raw = rows[0]?.content_json ?? null;
    if (!raw) return null;
    try {
      const once = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return typeof once === 'string' ? JSON.parse(once) : once;
    } catch {
      return null;
    }
  };

  // If no run_id provided, fetch the latest run
  if (!run_id) {
    const latestRes = await safeFetch(
      `${SB_URL}/rest/v1/engine_master_state?order=created_at.desc&limit=1`,
      'latest_run'
    );
    const latestRows = await safeJson(latestRes, []);
    run_id = latestRows?.[0]?.run_id;

    if (!run_id) {
      res.status(404).json({ error: 'No runs found' });
      return;
    }
  }

  const enc = encodeURIComponent(run_id);

  try {
    // Fetch all data sources in parallel — allSettled so one failure doesn't kill the rest
    const results = await Promise.allSettled([
      safeFetch(`${SB_URL}/rest/v1/engine_blobs?run_id=eq.${enc}&blob_type=eq.OUTPUT&order=created_at.desc&limit=1`, 'outputBlob'),
      safeFetch(`${SB_URL}/rest/v1/engine_stage_outputs?run_id=eq.${enc}&section=eq.D&order=round.asc,role_key.asc`, 'stageOutputs'),
      safeFetch(`${SB_URL}/rest/v1/engine_blobs?run_id=eq.${enc}&blob_type=eq.D_packet&order=round.desc&limit=1`, 'dPacket'),
      safeFetch(`${SB_URL}/rest/v1/engine_stage_outputs?run_id=eq.${enc}&section=eq.F1&order=round.asc`, 'f1Outputs'),
      safeFetch(`${SB_URL}/rest/v1/engine_master_state?run_id=eq.${enc}&limit=1`, 'master'),
      safeFetch(`${SB_URL}/rest/v1/engine_blobs?run_id=eq.${enc}&blob_type=eq.options&order=created_at.desc&limit=1`, 'optionsBlob'),
      safeFetch(`${SB_URL}/rest/v1/engine_blobs?run_id=eq.${enc}&blob_type=eq.GOV&order=created_at.desc&limit=1`, 'govBlob'),
      safeFetch(`${SB_URL}/rest/v1/engine_blobs?run_id=eq.${enc}&blob_type=eq.rx_auto&order=round.desc&limit=1`, 'rxAutoBlob'),
      safeFetch(`${SB_URL}/rest/v1/engine_stage_checkpoints?run_id=eq.${enc}&order=created_at.asc`, 'checkpoints'),
    ]);

    // Extract settled values (safeFetch already returns null on failure, so all are fulfilled)
    const responses = results.map(r => r.status === 'fulfilled' ? r.value : null);
    const [blobRes, stageRes, dpacketRes, f1Res, masterRes, optionsRes, govRes, rxAutoRes, checkpointsRes] = responses;

    // Parse all responses in parallel
    const [outputBlob, stageOutputs, dPacket, f1Outputs, masterRows, optionsBlob, govBlob, rxAutoBlob, checkpoints] =
      await Promise.all([
        unwrap(blobRes),
        safeJson(stageRes, []),
        unwrap(dpacketRes),
        safeJson(f1Res, []),
        safeJson(masterRes, []),
        unwrap(optionsRes),
        unwrap(govRes),
        unwrap(rxAutoRes),
        safeJson(checkpointsRes, []),
      ]);

    // Track which sources returned data for debugging
    const _sources = {
      outputBlob: !!outputBlob,
      stageOutputs: Array.isArray(stageOutputs) && stageOutputs.length > 0,
      dPacket: !!dPacket,
      f1Outputs: Array.isArray(f1Outputs) && f1Outputs.length > 0,
      master: Array.isArray(masterRows) && masterRows.length > 0,
      optionsBlob: !!optionsBlob,
      govBlob: !!govBlob,
      rxAutoBlob: !!rxAutoBlob,
      checkpoints: Array.isArray(checkpoints) && checkpoints.length > 0,
    };

    res.status(200).json({
      run_id,
      outputBlob,
      stageOutputs: stageOutputs || [],
      dPacket,
      f1Outputs: f1Outputs || [],
      master: masterRows?.[0] ?? null,
      optionsBlob,
      govBlob,
      rxAutoBlob,
      checkpoints: checkpoints || [],
      _sources,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
