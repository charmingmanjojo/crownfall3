

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Simple in-memory rate limiter (resets on worker cold-start)
// For stricter production limits, swap to Cloudflare KV or Durable Objects.
const rateLimiter = new Map(); // userId -> { count, windowStart }
const RATE_LIMIT  = 30;        // max requests
const RATE_WINDOW = 60_000;    // per 60 seconds

function checkRateLimit(key) {
  const now = Date.now();
  const rec = rateLimiter.get(key) || { count: 0, windowStart: now };
  if (now - rec.windowStart > RATE_WINDOW) { rec.count = 0; rec.windowStart = now; }
  rec.count++;
  rateLimiter.set(key, rec);
  return rec.count <= RATE_LIMIT;
}

// ══════════════════════════════════════════════════════════════
// ROUTER
// ══════════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST')   return new Response('Method not allowed', { status: 405, headers: CORS });

    const path = new URL(request.url).pathname;
    if (path === '/act')          return handleAct(request, env);
    if (path === '/raven')        return handleRaven(request, env);
    if (path === '/inscribe')     return handleInscribe(request, env);
    if (path === '/scene/leave')  return handleSceneLeave(request, env);
    if (path === '/admin')        return handleAdmin(request, env);
    if (path === '/admin/clock')  return handleAdminClock(request, env);
    return json({ error: 'Not found' }, 404);
  }
};

// ══════════════════════════════════════════════════════════════
// /act — the main game loop (fully server-authoritative)
//
// Client sends: { userId, characterId, action }
// Worker:  reads char from DB
//       -> calls Claude with server-built system prompt
//       -> parses AI response
//       -> validates + clamps every state change
//       -> writes state back to DB (client never writes game state)
//       -> returns parsed scene + validated charState for display
// ══════════════════════════════════════════════════════════════
async function handleAct(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { userId, characterId, action } = body;
  if (!userId || !characterId || !action?.trim()) {
    return json({ error: 'Missing userId, characterId, or action' }, 400);
  }
  if (!checkRateLimit(userId)) {
    return json({ error: 'Too many requests — slow down, my lord.' }, 429);
  }

  // ── Load character from DB (never trust client-supplied stats) ──
  const char = await getCharacter(characterId, env);
  if (!char)                    return json({ error: 'Character not found' }, 404);
  if (char.user_id !== userId)  return json({ error: 'Forbidden' }, 403);
  if (char.dead)                return json({ error: 'The dead do not act.' }, 403);

  // ── Load realm clock ──
  const realmSeason = await getRealmClock(env);

  // ── Load shared scene if active ──
  const sceneId = body.sceneId || null;
  let sharedScene = null;
  let guestChar = null;
  if (sceneId) {
    sharedScene = await getSharedScene(sceneId, env);
    if (sharedScene && sharedScene.status === 'active') {
      const guestId = sharedScene.initiator_id === characterId
        ? sharedScene.guest_id : sharedScene.initiator_id;
      guestChar = guestId ? await getCharacter(guestId, env) : null;
    } else {
      sharedScene = null;
    }
  }

  // ── Build conversation — shared scene uses scene msgs, solo uses char msgs ──
  const baseMsgs = sharedScene ? (sharedScene.msgs || []) : (char.msgs || []);
  const msgs = [...baseMsgs, { role: 'user', content: `[${char.name}]: ${action}` }];

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: buildSystemPrompt(char, realmSeason, guestChar),
      messages: msgs.slice(-20),
    }),
  });

  if (!aiRes.ok) {
    const err = await aiRes.json().catch(() => ({}));
    return json({ error: err?.error?.message || 'AI error ' + aiRes.status }, aiRes.status);
  }

  const raw = (await aiRes.json()).content?.[0]?.text;
  if (!raw) return json({ error: 'Empty AI response' }, 500);

  // ── Parse and validate ──
  const parsed  = parseResponse(raw);
  const updates = applyStateChanges(char, parsed);

  // ── Persist to DB ──
  const newMsgs = [...msgs, { role: 'assistant', content: raw }];
  if (newMsgs.length > 40) newMsgs.splice(0, newMsgs.length - 40);

  const hist = [...(char.hist || [])];
  if (hist.length > 28) hist.shift();

  if (sharedScene) {
    // Shared scene: write msgs to scene table, state changes to character
    await updateSharedScene(sceneId, { msgs: newMsgs }, env);
    await updateCharacter(characterId, { ...updates, hist }, env);
  } else {
    await updateCharacter(characterId, { ...updates, msgs: newMsgs, hist }, env);
  }

  // ── Return scene + validated state to client ──
  return json({
    narrative:  parsed.narrative,
    choices:    parsed.choices,
    status:     parsed.status,
    rolls:      parsed.rolls,
    memories:   parsed.memories,
    worldEvent: parsed.worldEvent,
    charState: {
      health:   updates.health,
      gold:     updates.gold,
      location: updates.location,
      season:   updates.season,
      dead:     updates.dead || false,
      npcs:     updates.npcs,
      events:   updates.events,
    },
  });
}

// ══════════════════════════════════════════════════════════════
// STATE VALIDATOR
// Every game-state change goes through here before hitting the DB.
// The AI cannot grant impossible gold, resurrect characters, or
// inflate stats — all of that is enforced here.
// ══════════════════════════════════════════════════════════════
const VALID_HEALTH        = new Set(['Hale', 'Wounded', 'Grievously Wounded', 'Dead']);
const MAX_GOLD_CHANGE     = 500;   // max gold swing per turn
const MAX_NPC_MEMORY_LEN  = 200;
const MAX_EVENT_TITLE_LEN = 120;

function applyStateChanges(char, parsed) {
  const s = parsed.status || {};

  // Health — only accept known values; dead is permanent
  const rawHealth = s.health;
  let health = VALID_HEALTH.has(rawHealth) ? rawHealth : char.health;
  if (char.health === 'Dead') health = 'Dead';

  // Gold — clamp change, floor at 0
  let gold = char.gold ?? 100;
  if (typeof s.goldChange === 'number' && Number.isFinite(s.goldChange)) {
    const clamped = Math.max(-MAX_GOLD_CHANGE, Math.min(MAX_GOLD_CHANGE, Math.round(s.goldChange)));
    gold = Math.max(0, gold + clamped);
  }

  // Location — accept AI string for display; client resolves to map tile id
  const location = typeof s.location === 'string' ? s.location.substring(0, 80) : char.location;

  // Season — flavour text, sanitise length
  const season = typeof s.season === 'string' ? s.season.substring(0, 80) : char.season;

  // Death — one-way gate
  const isDead = s.isDead === true ? true : (char.dead || false);

  // Stats — NEVER change base stats from AI output; set at creation only
  const stats = char.stats;

  // NPC memories — merge and cap
  const npcs = { ...(char.npcs || {}) };
  (parsed.memories || []).forEach(m => {
    if (!m.npc || typeof m.npc !== 'string') return;
    const key = m.npc.substring(0, 60);
    if (!npcs[key]) npcs[key] = [];
    npcs[key].push({
      t: String(m.memory || '').substring(0, MAX_NPC_MEMORY_LEN),
      d: clampDisposition(m.disposition),
    });
    if (npcs[key].length > 7) npcs[key].shift();
  });

  // World events — prepend and cap
  const events = [...(char.events || [])];
  if (parsed.worldEvent) {
    const title = String(parsed.worldEvent.title || parsed.worldEvent.description || '')
      .substring(0, MAX_EVENT_TITLE_LEN);
    if (title) {
      events.unshift(title);
      if (events.length > 18) events.pop();
    }
  }

  return {
    health, gold, location, season, dead: isDead, npcs, events, stats,
    death_narrative: isDead ? parsed.narrative : (char.death_narrative || null),
    death_summary:   isDead ? String(s.summary || '').substring(0, 300) : (char.death_summary || null),
  };
}

function clampDisposition(d) {
  if (typeof d !== 'number' || !Number.isFinite(d)) return 0;
  return Math.max(-3, Math.min(3, Math.round(d)));
}

// ══════════════════════════════════════════════════════════════
// /raven — send a raven
// Client sends: { userId, fromCharId, toCharId, subject, ravenBody }
// Server verifies sender owns fromChar; fills in name/house from DB.
// ══════════════════════════════════════════════════════════════
async function handleRaven(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { userId, fromCharId, toCharId, subject, ravenBody } = body;
  if (!userId || !fromCharId || !toCharId || !ravenBody?.trim()) {
    return json({ error: 'Missing required fields' }, 400);
  }
  if (!checkRateLimit('raven:' + userId)) return json({ error: 'Too many ravens.' }, 429);

  const [fromChar, toChar] = await Promise.all([
    getCharacter(fromCharId, env),
    getCharacter(toCharId, env),
  ]);

  if (!fromChar || fromChar.user_id !== userId) return json({ error: 'Forbidden' }, 403);
  if (fromChar.dead)  return json({ error: 'The dead send no ravens.' }, 403);
  if (!toChar || toChar.dead) return json({ error: 'Recipient not found or is dead.' }, 404);

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/ravens`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      from_char_id:   fromCharId,
      from_char_name: fromChar.name,        // server-sourced
      from_house:     fromChar.house_full || 'No House',
      to_char_id:     toCharId,
      to_char_name:   toChar.name,
      subject:        String(subject || '(no subject)').substring(0, 120),
      body:           ravenBody.substring(0, 2000),
    }),
  });

  return res.ok ? json({ ok: true }) : json({ error: 'Failed to send raven.' }, 500);
}

// ══════════════════════════════════════════════════════════════
// /inscribe — write a deed to the chronicle
// Client sends: { userId, characterId, narrativeExcerpt }
// Server verifies ownership; fills char name/house/season from DB.
// ══════════════════════════════════════════════════════════════
async function handleInscribe(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { userId, characterId, narrativeExcerpt } = body;
  if (!userId || !characterId || !narrativeExcerpt?.trim()) {
    return json({ error: 'Missing required fields' }, 400);
  }

  const char = await getCharacter(characterId, env);
  if (!char || char.user_id !== userId) return json({ error: 'Forbidden' }, 403);

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/chronicles`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      char_id:    characterId,
      char_name:  char.name,              // server-sourced
      house_full: char.house_full,
      house_key:  char.house_key,
      deed_text:  narrativeExcerpt.substring(0, 600),
      season:     char.season,            // from DB
      location:   char.location,
    }),
  });

  return res.ok ? json({ ok: true }) : json({ error: 'Failed to inscribe.' }, 500);
}

// ══════════════════════════════════════════════════════════════
// /scene/leave
// Client sends: { userId, characterId, sceneId }
// Marks scene as ended so both players get notified.
// ══════════════════════════════════════════════════════════════
async function handleSceneLeave(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const { userId, characterId, sceneId } = body;
  if (!userId || !characterId || !sceneId) return json({ error: 'Missing fields' }, 400);

  const char = await getCharacter(characterId, env);
  if (!char || char.user_id !== userId) return json({ error: 'Forbidden' }, 403);

  await updateSharedScene(sceneId, { status: 'ended' }, env);
  return json({ ok: true });
}

// ══════════════════════════════════════════════════════════════
// /admin/clock — advance the realm clock (admin only)
// Body: { adminKey, season }
// ══════════════════════════════════════════════════════════════
async function handleAdminClock(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  if (!body.adminKey || body.adminKey !== env.ADMIN_KEY) return json({ error: 'Unauthorized' }, 401);
  if (!body.season) return json({ error: 'Missing season' }, 400);

  await fetch(`${env.SUPABASE_URL}/rest/v1/realm_clock?id=eq.1`, {
    method: 'PATCH',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ season: body.season.substring(0, 80), updated_at: new Date().toISOString() }),
  });

  return json({ ok: true, season: body.season });
}

// ══════════════════════════════════════════════════════════════
// /admin
// ══════════════════════════════════════════════════════════════
async function handleAdmin(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  if (!body.adminKey || body.adminKey !== env.ADMIN_KEY) return json({ error: 'Unauthorized' }, 401);

  const stats = await getRealmStats(env);
  if (body.action === 'stats')   return json(stats);
  if (body.action === 'summary') return json({ ...stats, summary: await generateRealmSummary(stats, env) });
  return json({ error: 'Unknown action' }, 400);
}

// ══════════════════════════════════════════════════════════════
// SYSTEM PROMPT — built server-side, never supplied by client
// ══════════════════════════════════════════════════════════════
function buildSystemPrompt(c, realmSeason, guestChar) {
  const memBlock = c.npcs && Object.keys(c.npcs).length
    ? '\nNPC MEMORIES:\n' + Object.entries(c.npcs)
        .map(([n, mems]) => `- ${n}: ${mems.slice(-3).map(m => m.t).join(' | ')}`)
        .join('\n')
    : '';

  const guestBlock = guestChar ? `

ALSO PRESENT IN THIS SCENE:
Name: ${guestChar.name} | House: ${guestChar.house_full} | Health: ${guestChar.health}
Traits: ${(guestChar.traits || []).join(', ') || 'None'}
This is a REAL player character. They will act independently. Acknowledge both characters in the scene. Do not speak for them — only for NPCs.` : '';

  const seasonLine = realmSeason || c.season || 'Early Spring, 250 AC';

  return `You are the Game Master of a Game of Thrones RPG set in 250 AC during the reign of Jaehaerys I Targaryen, the Conciliator.
Current realm date: ${seasonLine}

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
${memBlock}${guestBlock}

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

// ══════════════════════════════════════════════════════════════
// RESPONSE PARSER
// ══════════════════════════════════════════════════════════════
function parseResponse(text) {
  const nRaw = text.match(/<narrative>([\s\S]*?)<\/narrative>/)?.[1]?.trim() || text;
  const cRaw = text.match(/<choices>([\s\S]*?)<\/choices>/)?.[1]?.trim() || '[]';
  const sRaw = text.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim() || '{}';
  const memories = [], rolls = [];
  let worldEvent = null;

  const narrative = nRaw.replace(/\{[^{}]+\}/g, match => {
    try {
      const o = JSON.parse(match);
      if (o.npc && o.memory) { memories.push(o); return ''; }
      if (o.stat && o.rolls) { rolls.push(o);    return ''; }
      if (o.worldEvent)      { worldEvent = o.worldEvent; return ''; }
    } catch {}
    return match;
  }).trim();

  let choices = [], status = {};
  try { choices = JSON.parse(cRaw); } catch {}
  try { status  = JSON.parse(sRaw); } catch {}

  choices = (Array.isArray(choices) ? choices : [])
    .filter(c => typeof c === 'string')
    .slice(0, 4)
    .map(c => c.substring(0, 120));

  return { narrative, choices, status, memories, rolls, worldEvent };
}

// ══════════════════════════════════════════════════════════════
// SUPABASE HELPERS
// ══════════════════════════════════════════════════════════════
async function getCharacter(id, env) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/characters?id=eq.${encodeURIComponent(id)}&limit=1`,
    { headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
  );
  const rows = await res.json();
  return rows?.[0] || null;
}

async function getRealmClock(env) {
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/realm_clock?id=eq.1&limit=1`,
      { headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
    );
    const rows = await res.json();
    return rows?.[0]?.season || null;
  } catch { return null; }
}

async function getSharedScene(id, env) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/shared_scenes?id=eq.${encodeURIComponent(id)}&limit=1`,
    { headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
  );
  const rows = await res.json();
  return rows?.[0] || null;
}

async function updateSharedScene(id, fields, env) {
  return fetch(
    `${env.SUPABASE_URL}/rest/v1/shared_scenes?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
    }
  );
}

async function updateCharacter(id, fields, env) {
  return fetch(
    `${env.SUPABASE_URL}/rest/v1/characters?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
    }
  );
}

// ══════════════════════════════════════════════════════════════
// ADMIN HELPERS
// ══════════════════════════════════════════════════════════════
async function getRealmStats(env) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/characters?select=id,name,house_full,house_key,region,location,health,dead,season,created_at,updated_at,events`,
    { headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
  );
  const characters = await res.json();
  if (!Array.isArray(characters)) return { error: 'DB error', raw: characters };

  const now   = Date.now();
  const alive = characters.filter(c => !c.dead);
  const active = alive.filter(c => (now - new Date(c.updated_at).getTime()) < 30 * 60 * 1000);

  const byLocation = {}, byHouse = {};
  alive.forEach(c => {
    const loc = c.location || 'unknown';
    if (!byLocation[loc]) byLocation[loc] = [];
    byLocation[loc].push({ name: c.name, house: c.house_full, health: c.health });
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
    totalChars: characters.length, aliveChars: alive.length,
    deadChars: characters.filter(c => c.dead).length, activeNow: active.length,
    activeList: active.map(c => ({ name: c.name, house: c.house_full, location: c.location, health: c.health })),
    byLocation, byHouse, recentEvents: allEvents.slice(0, 12), fetchedAt: new Date().toISOString(),
  };
}

async function generateRealmSummary(stats, env) {
  const activeDesc = stats.activeList.length
    ? stats.activeList.map(c => `${c.name} of ${c.house} (${c.location}, ${c.health})`).join(', ')
    : 'No known movements in the past half-hour.';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 350,
      messages: [{ role: 'user', content:
        `You are Grand Maester Pycelle writing a private intelligence report for the small council. The year is 250 AC.\n\nBased on this intelligence, write one flowing paragraph (5-7 sentences) on the state of the realm. Be specific. Name names. Be slightly ominous.\n\nINTELLIGENCE:\n- ${stats.aliveChars} notable persons active (${stats.deadChars} deceased)\n- Active in last 30 minutes: ${stats.activeNow}\n- Known movements: ${activeDesc}\n- By location: ${JSON.stringify(stats.byLocation)}\n- Recent events: ${stats.recentEvents.join(' | ')}\n\nWrite only the paragraph.`
      }],
    }),
  });
  const data = await res.json();
  return data.content?.[0]?.text || 'The ravens have gone quiet. Something is wrong.';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
