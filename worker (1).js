
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

  // Build the system prompt server-side from the character data the client sends.
  // The client must include a `character` object in the payload.
  // We always overwrite whatever `system` the client sent — it cannot be spoofed.
  const system = buildSystemPrompt(body.character);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: body.max_tokens || 1000,
      system,                        // always our prompt, never the client's
      messages: body.messages || [],
    }),
  });

  const data = await res.json();
  return json(data, res.status);
}

// ══════════════════════════════════
// SYSTEM PROMPT (server-side)
// ══════════════════════════════════
function buildSystemPrompt(c) {
  if (!c) return 'You are a Game of Thrones RPG Game Master set in 250 AC.';

  const memBlock = c.npcs && Object.keys(c.npcs).length
    ? '\nNPC MEMORIES:\n' + Object.entries(c.npcs)
        .map(([n, mems]) => `- ${n}: ${mems.slice(-3).map(m => m.t).join(' | ')}`)
        .join('\n')
    : '';

  return `You are the Game Master of a Game of Thrones RPG set in 250 AC during the reign of Jaehaerys I Targaryen, the Conciliator.

CHARACTER:
Name: ${c.name}${c.nickname ? ' ("' + c.nickname + '")' : ''} | Age: ${c.age}${c.gender ? ' | ' + c.gender : ''}
House: ${c.house_full} | Region: ${c.region} | Position: ${c.relation}
Current Location: ${c.location}
Appearance: ${c.appear || 'Not described'}
Backstory: ${c.backstory || 'Unknown'}
Personality: ${c.personality || 'Unknown'}
Traits: ${(c.traits || []).join(', ') || 'None'}
Martial:${(c.stats || {}).martial || 3} Diplomacy:${(c.stats || {}).diplomacy || 3} Intrigue:${(c.stats || {}).intrigue || 3} Stewardship:${(c.stats || {}).stewardship || 3} Learning:${(c.stats || {}).learning || 3}
Health: ${c.health} | Gold: ${c.gold || 100} dragons
${memBlock}

RULES:
1. Write GRRM style — third-person past tense, maester's voice. Specific, spare, sensory. Name the smell, the stone, the exact words spoken.
2. Characters CAN and WILL die. Do not protect them. Write deaths honestly and with consequence.
3. All consequences are permanent. The dead stay dead. Burned bridges stay burned.
4. Named NPCs remember what the character has done and act on it accordingly.
5. Traits are mechanical: Wrathful = anger checks required, Brave = cannot easily flee, Deceitful = intrigue paths open, Craven = -2 combat.
6. Stats shape outcomes. Roll dice for uncertain moments using the inline tag format.
7. Offer 3-4 choices per scene. At least one that looks safe isn't. The correct choice is never obvious.
8. The world moves without the character. Events happen offstage. Time passes.
9. Custom player actions get resolved honestly — even if the result is fatal.
10. Political intrigue matters more than combat. Enemies at court are more dangerous than enemies on a battlefield.

INLINE TAGS — embed directly inside narrative prose where they naturally occur:
{"npc":"Name","memory":"what they remember about this interaction","disposition":1}
{"stat":"Martial","rolls":[4,2],"bonus":2,"difficulty":12,"result":"brief outcome text"}
{"worldEvent":{"title":"Short title","description":"What happened in the wider world"}}

RESPONSE FORMAT — use this exactly, nothing else:
<narrative>2-4 paragraphs of prose. Inline tags embedded naturally.</narrative>
<choices>["Choice one","Choice two","Choice three","Choice four"]</choices>
<status>{"health":"Hale","location":"King's Landing","isDead":false,"season":"Early Spring, 250 AC","summary":"One sentence of current situation.","goldChange":0}</status>

ON CHARACTER DEATH:
<narrative>Death scene. Specific. Consequential. Honest.</narrative>
<choices>[]</choices>
<status>{"health":"Dead","location":"...","isDead":true,"season":"...","summary":"How ${c.name} died and what it meant.","goldChange":0}</status>`;
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
      model: 'claude-sonnet-4-6',
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
