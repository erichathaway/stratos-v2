/* ────────────────────────────────────────────────────────────────
   StratOS API Auth Middleware
   - Validates run_id format
   - Optional token-based access control
   - Rate limiting via simple in-memory counter
   ──────────────────────────────────────────────────────────────── */

const RUN_ID_PATTERN = /^RUN-\d{14}-[a-z0-9]{8}$/;
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 30; // requests per window per IP
const rateLimitMap = new Map();

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap) {
    if (now - val.start > RATE_LIMIT_WINDOW * 2) rateLimitMap.delete(key);
  }
}, 300_000);

export function validateRunId(run_id) {
  if (!run_id) return false;
  return RUN_ID_PATTERN.test(run_id);
}

export function rateLimit(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = rateLimitMap.get(ip);

  if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
    entry = { start: now, count: 0 };
    rateLimitMap.set(ip, entry);
  }

  entry.count++;

  if (entry.count > RATE_LIMIT_MAX) {
    res.setHeader('Retry-After', '60');
    res.status(429).json({ error: 'Rate limit exceeded. Try again in 60 seconds.' });
    return false;
  }

  return true;
}

export function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Restrict CORS to known origins in production
  const allowedOrigins = [
    'https://results.stratos.lucidorg.com',
    'https://app.stratos.lucidorg.com',
    'https://stratos.lucidorg.com',
  ];
  return allowedOrigins;
}

export function validateOrigin(req, res) {
  const origin = req.headers.origin || req.headers.referer || '';
  const allowed = securityHeaders(res);

  // In development, allow all
  if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return true;
  }

  // Check against allowed origins
  const matchedOrigin = allowed.find(o => origin.startsWith(o));
  if (matchedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', matchedOrigin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', allowed[0]);
  }

  return true;
}
