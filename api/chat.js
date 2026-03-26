export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) { res.status(500).json({ error: 'Chat service not configured. Please contact support.' }); return; }

  const { message, context, history } = req.body || {};
  if (!message) { res.status(400).json({ error: 'message required' }); return; }
  if (!context) { res.status(400).json({ error: 'context required (dashboard data)' }); return; }

  // Tab mapping for navigation references
  const TAB_MAP = {
    command: { id: 'command', label: 'Command Center', keywords: ['verdict', 'decision', 'overview', 'summary', 'approval', 'vote', 'confidence'] },
    risk: { id: 'risk', label: 'Risk Matrix', keywords: ['risk', 'blocker', 'threat', 'concern', 'danger', 'kill criteria'] },
    financials: { id: 'financials', label: 'Financial Impact', keywords: ['financial', 'cost', 'budget', 'revenue', 'investment', 'roi', 'spend', 'p&l'] },
    room: { id: 'room', label: 'The Room', keywords: ['role', 'ceo', 'cfo', 'coo', 'cto', 'chro', 'cso', 'legal', 'stance', 'position'] },
    options: { id: 'options', label: 'Options Analysis', keywords: ['option', 'alternative', 'scenario', 'opt-', 'preferred'] },
    handoff: { id: 'handoff', label: 'Handoff & Next Steps', keywords: ['next step', 'action', 'handoff', 'timeline', 'implementation', 'condition'] },
  };

  const systemPrompt = `You are the StratOS Decision Assistant. You answer questions about a specific decision analysis that was run through the StratOS Decision Engine.

IMPORTANT RULES:
- ONLY answer based on the dashboard data provided below. Never make up information.
- If the data doesn't contain the answer, say so clearly.
- Keep answers concise and specific — cite specific roles, rounds, and data points.
- When your answer relates to a specific dashboard section, include a tab reference in this exact format: [TAB:tabId:Label Text] — for example [TAB:risk:View Risk Matrix] or [TAB:room:See Role Details].
- Available tabs: command (Command Center), risk (Risk Matrix), financials (Financial Impact), room (The Room), options (Options Analysis), handoff (Handoff & Next Steps).
- You may include multiple tab references if the answer spans sections.
- Format numbers, percentages, and currencies clearly.
- Use markdown for emphasis and structure when helpful.

DASHBOARD DATA:
${typeof context === 'string' ? context : JSON.stringify(context, null, 1)}`;

  const messages = [];
  if (Array.isArray(history)) {
    for (const h of history.slice(-6)) {
      messages.push({ role: h.role, content: h.content });
    }
  }
  messages.push({ role: 'user', content: message });

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages,
      }),
    });

    if (!apiRes.ok) {
      const err = await apiRes.text();
      console.error('[chat.js] Anthropic API error:', apiRes.status, err);
      res.status(502).json({ error: 'AI service error', status: apiRes.status });
      return;
    }

    const data = await apiRes.json();
    const text = data.content?.[0]?.text || '';

    // Extract tab references from the response
    const tabRefs = [];
    const tabPattern = /\[TAB:(\w+):([^\]]+)\]/g;
    let match;
    while ((match = tabPattern.exec(text)) !== null) {
      if (TAB_MAP[match[1]]) {
        tabRefs.push({ tab: match[1], label: match[2] });
      }
    }

    // Clean tab markers from display text
    const cleanText = text.replace(/\[TAB:\w+:[^\]]+\]/g, '').trim();

    res.status(200).json({
      text: cleanText,
      references: tabRefs,
      usage: data.usage,
    });
  } catch (err) {
    console.error('[chat.js] Error:', err.message);
    res.status(500).json({ error: 'Something went wrong processing your question. Please try again.' });
  }
}
