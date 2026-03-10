// ═══════════════════════════════════════════════════════════
// CROWNFALL — Cloudflare Worker
//
// Environment variables to set in Cloudflare dashboard:
//   ANTHROPIC_KEY         → your sk-ant-... key (Secret)
//   ADMIN_KEY             → any password you choose (Secret)
//   SUPABASE_URL          → https://yourproject.supabase.co (Plain text)
//   SUPABASE_SERVICE_KEY  → service_role key from Supabase Settings → API (Secret)
// ═══════════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    const url = new URL(request.url);
    if (url.pathname === '/admin') return handleAdmin(request, env);
    return handleGame(request, env);
  }
};

// ══════════════════════════════════
// GAME PROXY
// ══════════════════════════════════
async function handleGame(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  return json(data, res.status);
}

// ══════════════════════════════════
// ADMIN
// ══════════════════════════════════
async function handleAdmin(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  if (!body.adminKey || body.adminKey !== env.ADMIN_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const stats = await getRealmStats(env);

  if (body.action === 'stats') {
    return json(stats);
  }

  if (body.action === 'summary') {
    const summary = await generateRealmSummary(stats, env);
    return json({ ...stats, summary });
  }

  return json({ error: 'Unknown action' }, 400);
}

async function getRealmStats(env) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/characters?select=id,name,house_full,house_key,region,location,health,dead,season,created_at,updated_at,events`,
    {
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      }
    }
  );

  const characters = await res.json();
  if (!Array.isArray(characters)) return { error: 'DB error', raw: characters };

  const now = Date.now();
  const alive = characters.filter(c => !c.dead);
  const activeChars = alive.filter(c => {
    const updated = new Date(c.updated_at).getTime();
    return (now - updated) < 30 * 60 * 1000;
  });

  const byLocation = {};
  alive.forEach(c => {
    const loc = c.location || 'unknown';
    if (!byLocation[loc]) byLocation[loc] = [];
    byLocation[loc].push({ name: c.name, house: c.house_full, health: c.health });
  });

  const byHouse = {};
  alive.forEach(c => {
    const h = c.house_full || 'No House';
    byHouse[h] = (byHouse[h] || 0) + 1;
  });

  const allEvents = [];
  characters.forEach(c => {
    if (Array.isArray(c.events)) {
      c.events.slice(0, 3).forEach(e => {
        const txt = typeof e === 'string' ? e : (e?.title || '');
        if (txt && !allEvents.includes(txt)) allEvents.push(txt);
      });
    }
  });

  return {
    totalChars:   characters.length,
    aliveChars:   alive.length,
    deadChars:    characters.filter(c => c.dead).length,
    activeNow:    activeChars.length,
    activeList:   activeChars.map(c => ({ name: c.name, house: c.house_full, location: c.location, health: c.health })),
    byLocation,
    byHouse,
    recentEvents: allEvents.slice(0, 12),
    fetchedAt:    new Date().toISOString(),
  };
}

async function generateRealmSummary(stats, env) {
  const activeDesc = stats.activeList.length
    ? stats.activeList.map(c => `${c.name} of ${c.house} (${c.location}, ${c.health})`).join(', ')
    : 'No known movements in the past half-hour.';

  const prompt = `You are Grand Maester Pycelle writing a private intelligence report for the small council. The year is 250 AC.

Based on this intelligence, write one flowing paragraph (5-7 sentences) on the state of the realm — who is moving, where tensions lie, what the ravens have reported. Be specific. Name names. Be slightly ominous. Sound like a tired old man who has seen kingdoms rise and fall.

INTELLIGENCE:
- ${stats.aliveChars} notable persons active across the realm (${stats.deadChars} deceased)
- Active in last 30 minutes: ${stats.activeNow}
- Known movements: ${activeDesc}
- Characters by location: ${JSON.stringify(stats.byLocation)}
- Recent raven reports: ${stats.recentEvents.join(' | ')}

Write only the paragraph. No title, no sign-off, no "Pycelle" signature.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 350,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  return data.content?.[0]?.text || 'The ravens have gone quiet. Something is wrong.';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
