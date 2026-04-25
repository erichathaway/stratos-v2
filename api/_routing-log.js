// Minimal cmd_routing_log writer for stratos-v2 API routes. The full
// caching+logging helper (commandos-v2/src/lib/llm/anthropic.ts) requires
// either pure-static system prompts or a message-shape change to enable
// caching. stratos chat.js mixes static instructions with dashboard data
// in the system prompt, so caching wouldn't engage anyway. This stripped-
// down helper just closes the visibility gap (cmd_routing_log writes) so
// stratos chat spend appears in the dashboard alongside everything else.
//
// Fire-and-forget. Errors are swallowed so a Supabase blip never breaks
// the user-facing chat response.

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  'https://xwmjrphmdjhlhveyyfey.supabase.co';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY;

// Per-million-token base prices, USD. Mirrors the table in commandos-v2's
// anthropic.ts helper. Update together when pricing changes.
const PRICING = {
  'claude-haiku-4-5':  { in: 0.80, out:  4.00 },
  'claude-sonnet-4-6': { in: 3.00, out: 15.00 },
  'claude-sonnet-4-7': { in: 3.00, out: 15.00 },
  'claude-opus-4-6':   { in: 15.00, out: 75.00 },
  'claude-opus-4-7':   { in: 15.00, out: 75.00 },
};

function priceFor(model) {
  if (PRICING[model]) return PRICING[model];
  const m = (model || '').toLowerCase();
  if (m.includes('haiku')) return PRICING['claude-haiku-4-5'];
  if (m.includes('sonnet')) return PRICING['claude-sonnet-4-6'];
  if (m.includes('opus')) return PRICING['claude-opus-4-7'];
  return { in: 3.0, out: 15.0 };
}

/**
 * Log one Anthropic API call to cmd_routing_log.
 *
 * @param {object} args
 * @param {string} args.taskType - e.g. "STRATOS_CHAT"
 * @param {string} args.model - model id, e.g. "claude-sonnet-4-20250514"
 * @param {object} args.usage - { input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens? }
 * @param {number} args.durationMs - wall time of the API call
 * @param {string} args.outcome - "success" | "error" | "rate_limited"
 */
export async function logRouting(args) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  const u = args.usage || {};
  const inputTokens =
    (u.input_tokens || 0) +
    (u.cache_creation_input_tokens || 0) +
    (u.cache_read_input_tokens || 0);
  const outputTokens = u.output_tokens || 0;

  const p = priceFor(args.model);
  const newInputCost = (u.input_tokens || 0) * p.in / 1_000_000;
  const cacheWriteCost = (u.cache_creation_input_tokens || 0) * p.in * 1.25 / 1_000_000;
  const cacheReadCost = (u.cache_read_input_tokens || 0) * p.in * 0.10 / 1_000_000;
  const outputCost = outputTokens * p.out / 1_000_000;
  const cost = newInputCost + cacheWriteCost + cacheReadCost + outputCost;

  // Production cmd_routing_log has no total_tokens column even though
  // schema-v2.sql still lists one. Do NOT add it back.
  const payload = {
    task_type: args.taskType,
    model_provider: 'anthropic',
    model_name: args.model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    duration_ms: args.durationMs || 0,
    outcome: args.outcome || 'success',
    cost_estimate_usd: cost,
  };

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/cmd_routing_log`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Silently swallow. Visibility is best-effort; never fail the user
    // request because Supabase is slow.
  }
}
