// ═══════════════════════════════════════════════════════════
// CROWNFALL — Cloudflare Worker  (server-authoritative build)
//
// Environment variables (Cloudflare dashboard):
//   ANTHROPIC_KEY         → sk-ant-... key            (Secret)
//   ADMIN_KEY             → any password               (Secret)
//   SUPABASE_URL          → https://yourproject.supabase.co
//   SUPABASE_SERVICE_KEY  → service_role key           (Secret)
// ═══════════════════════════════════════════════════════════

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

  // ── Succession — runs when a character dies, fires a worldEvent ──
  if (updates.dead && !char.dead) {
    const successionResult = await handleSuccession(characterId, char, env);
    if (successionResult?.worldEvent && !parsed.worldEvent) {
      parsed.worldEvent = successionResult.worldEvent;
    }
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
      health:          updates.health,
      gold:            updates.gold,
      income_per_turn: updates.income_per_turn,
      lands:           updates.lands,
      debts:           updates.debts,
      location:        updates.location,
      season:          updates.season,
      dead:            updates.dead || false,
      npcs:            updates.npcs,
      events:          updates.events,
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
const MAX_GOLD_CHANGE     = 1000;  // raised cap for financial events
const MAX_NPC_MEMORY_LEN  = 200;
const MAX_EVENT_TITLE_LEN = 120;

function applyStateChanges(char, parsed) {
  const s = parsed.status || {};

  // Health
  const rawHealth = s.health;
  let health = VALID_HEALTH.has(rawHealth) ? rawHealth : char.health;
  if (char.health === 'Dead') health = 'Dead';

  // Gold — apply direct goldChange
  let gold = char.gold ?? 100;
  if (typeof s.goldChange === 'number' && Number.isFinite(s.goldChange)) {
    const clamped = Math.max(-MAX_GOLD_CHANGE, Math.min(MAX_GOLD_CHANGE, Math.round(s.goldChange)));
    gold = Math.max(0, gold + clamped);
  }

  // Income per turn — can increase/decrease from events (land grants, razing, etc.)
  let income_per_turn = char.income_per_turn ?? 0;
  if (typeof s.incomeChange === 'number' && Number.isFinite(s.incomeChange)) {
    income_per_turn = Math.max(0, income_per_turn + Math.round(s.incomeChange));
  }

  // Apply seasonal income (every time season changes)
  const season = typeof s.season === 'string' ? s.season.substring(0, 80) : char.season;
  if (season !== char.season && income_per_turn > 0) {
    gold = Math.max(0, gold + income_per_turn);
  }

  // Lands — AI can grant or strip via landEvent
  const lands = [...(char.lands || [])];
  if (s.landGained && typeof s.landGained === 'string') {
    const entry = s.landGained.substring(0, 100);
    if (!lands.includes(entry)) lands.push(entry);
  }
  if (s.landLost && typeof s.landLost === 'string') {
    const idx = lands.findIndex(l => l.toLowerCase().includes(s.landLost.toLowerCase()));
    if (idx > -1) lands.splice(idx, 1);
  }

  // Debts — AI can add debt via newDebt
  const debts = [...(char.debts || [])];
  if (s.newDebt && s.newDebt.creditor && s.newDebt.amount) {
    debts.push({
      creditor: String(s.newDebt.creditor).substring(0, 80),
      amount:   Math.max(0, Math.round(s.newDebt.amount)),
      reason:   String(s.newDebt.reason || '').substring(0, 120),
      turn:     Date.now(),
    });
  }
  // Debt repayment: goldChange negative + debtId
  if (s.debtRepaid && debts.length) {
    const idx = debts.findIndex(d => d.creditor === s.debtRepaid);
    if (idx > -1) debts.splice(idx, 1);
  }

  // Location — travel costs gold, validate the character can afford it
  let location = char.location;
  if (typeof s.location === 'string' && s.location !== char.location) {
    const travelCost = estimateTravelCost(char.location, s.location);
    if (gold >= travelCost) {
      location = s.location.substring(0, 80);
      if (travelCost > 0) gold = Math.max(0, gold - travelCost);
    } else {
      location = char.location; // can't afford it — stay put
    }
  }

  // Death
  const isDead = s.isDead === true ? true : (char.dead || false);

  // Stats — never change from AI
  const stats = char.stats;

  // NPC memories
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

  // World events
  const events = [...(char.events || [])];
  if (parsed.worldEvent) {
    const title = String(parsed.worldEvent.title || parsed.worldEvent.description || '').substring(0, MAX_EVENT_TITLE_LEN);
    if (title) { events.unshift(title); if (events.length > 18) events.pop(); }
  }

  return {
    health, gold, income_per_turn, lands, debts,
    location, season, dead: isDead, npcs, events, stats,
    death_narrative: isDead ? parsed.narrative : (char.death_narrative || null),
    death_summary:   isDead ? String(s.summary || '').substring(0, 300) : (char.death_summary || null),
  };
}

function clampDisposition(d) {
  if (typeof d !== 'number' || !Number.isFinite(d)) return 0;
  return Math.max(-3, Math.min(3, Math.round(d)));
}
// ══════════════════════════════════════════════════════════════
// TRAVEL COST ESTIMATOR
// ══════════════════════════════════════════════════════════════
function estimateTravelCost(from, to) {
  if (!from || !to || from === to) return 0;
  const fromL = from.toLowerCase();
  const toL   = to.toLowerCase();
  // Same castle/city sub-location — free
  const samePlace = ['castle', 'sept', 'gate', 'tower', 'hall', 'keep'];
  if (samePlace.some(w => fromL.includes(w) && toL.includes(w))) return 0;
  // Sea voyage destinations
  const seaDests = ['braavos', 'pentos', 'myr', 'lys', 'volantis', 'dragonstone', 'pyke', 'iron islands'];
  if (seaDests.some(w => toL.includes(w))) return 50;
  // Default cross-region land travel
  return 20;
}

// ══════════════════════════════════════════════════════════════
// SUCCESSION HANDLER — fires when a character dies
// ══════════════════════════════════════════════════════════════
async function handleSuccession(deadCharId, deadChar, env) {
  try {
    const posRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/house_positions?holder_id=eq.${deadCharId}`,
      { headers: sbHeaders(env) }
    );
    const positions = await posRes.json();
    if (!Array.isArray(positions) || !positions.length) return null;

    for (const pos of positions) {
      // Vacate the position
      await fetch(`${env.SUPABASE_URL}/rest/v1/house_positions?id=eq.${pos.id}`, {
        method: 'PATCH',
        headers: { ...sbHeaders(env), 'Content-Type': 'application/json' },
        body: JSON.stringify({ holder_id: null }),
      });

      // Find next in succession — lowest rank above the vacated one, same house
      const nextRes = await fetch(
        `${env.SUPABASE_URL}/rest/v1/house_positions?house_key=eq.${pos.house_key}&rank=gt.${pos.rank}&is_public=eq.true&order=rank.asc&limit=1`,
        { headers: sbHeaders(env) }
      );
      const nextRows = await nextRes.json();
      const nextPos  = Array.isArray(nextRows) ? nextRows[0] : null;

      if (nextPos?.holder_id) {
        // Living player inherits — promote them
        const heir = await getCharacter(nextPos.holder_id, env);
        const tooYoung = heir?.age && parseInt(heir.age) < 16;

        // Move heir up to the vacated position
        await fetch(`${env.SUPABASE_URL}/rest/v1/characters?id=eq.${nextPos.holder_id}`, {
          method: 'PATCH',
          headers: { ...sbHeaders(env), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            relation:        pos.title,
            income_per_turn: pos.income_grant || 0,
            updated_at:      new Date().toISOString(),
          }),
        });
        await fetch(`${env.SUPABASE_URL}/rest/v1/house_positions?id=eq.${pos.id}`, {
          method: 'PATCH',
          headers: { ...sbHeaders(env), 'Content-Type': 'application/json' },
          body: JSON.stringify({ holder_id: nextPos.holder_id }),
        });
        // Free the heir's old slot
        await fetch(`${env.SUPABASE_URL}/rest/v1/house_positions?id=eq.${nextPos.id}`, {
          method: 'PATCH',
          headers: { ...sbHeaders(env), 'Content-Type': 'application/json' },
          body: JSON.stringify({ holder_id: null, is_public: true }),
        });

        const heirName = heir ? heir.name : 'An heir';
        return {
          worldEvent: {
            title: heirName + ' inherits ' + pos.title,
            description: tooYoung
              ? deadChar.name + ' is dead. ' + heirName + ' has inherited ' + pos.title + ' but is only ' + (heir ? heir.age : '?') + ' years old. A regent must be named.'
              : deadChar.name + ' of ' + (deadChar.house_full || 'their house') + ' is dead. ' + heirName + ' has assumed ' + pos.title + '.',
          },
        };
      } else {
        // No holder in next slot — open the vacated position publicly
        await fetch(`${env.SUPABASE_URL}/rest/v1/house_positions?id=eq.${pos.id}`, {
          method: 'PATCH',
          headers: { ...sbHeaders(env), 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_public: true }),
        });

        return {
          worldEvent: {
            title: pos.title + ' stands vacant',
            description: deadChar.name + ' of ' + (deadChar.house_full || 'their house') + ' is dead. ' + pos.title + ' has no holder. The succession is uncertain.',
          },
        };
      }
    }
  } catch (err) {
    // Succession errors should not break the main response
    console.error('Succession error:', err);
    return null;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// SUPABASE HEADER HELPER
// ══════════════════════════════════════════════════════════════
function sbHeaders(env) {
  return {
    'apikey':        env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
  };
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

  const lands = (c.lands || []);
  const debts = (c.debts || []);
  const financeBlock = `
FINANCES:
Income per season: ${c.income_per_turn || 0} gold dragons
Current gold: ${c.gold || 100} dragons
Holdings: ${lands.length ? lands.join(', ') : 'None'}
Debts: ${debts.length ? debts.map(d => `${d.amount}gd owed to ${d.creditor} (${d.reason})`).join('; ') : 'None'}`;

  // ── Age guard — extra instructions for child characters ──
  const ageGuard = c.age && parseInt(c.age) < 16 ? `
CHARACTER AGE NOTE: ${c.name} is ${c.age} years old — a child by the standards of this world.
- No romantic or sexual content involving this character under any circumstances.
- Violence against them should be threatened or implied, rarely explicit.
- Adults will treat them as a child: dismissively, protectively, or as a pawn.
- Their youth is both a shield and a weapon others will use against them.
- They may be clever, even dangerous — but they are still a child and the world knows it.` : '';

  return `You are the Game Master of a Game of Thrones RPG set in 250 AC during the reign of Aegon V Targaryen, fifth of his name, called the Unlikely.

REALM CONTEXT:
Aegon V is the reformist king — a man who grew up travelling Westeros as a hedge knight's squire and saw the smallfolk suffer firsthand. He has spent his reign trying to break the power of the great lords, curb serfdom, and raise the smallfolk up. The lords hate him for it. His Small Council is fractious. His own children defy him. The realm is stable on the surface and rotting underneath.
The dragons are gone. The last died over 150 years ago in the Dance of Dragons. There are rumours Aegon V is obsessed with hatching new ones — experiments at Summerhall, the royal pleasure castle. Nothing has come of it yet.
Dorne was only formally united with the realm 36 years ago (214 AC) through marriage. The ink is barely dry. Old resentments persist.
The Blackfyre pretenders have plagued the realm for generations. The last major rebellion was the War of the Ninepenny Kings, still years away — but Blackfyre agents and sympathisers still move through the shadows.
This is a world on the edge of something. No one knows what yet.

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
Health: ${c.health}
${financeBlock}
${memBlock}${guestBlock}
${ageGuard}

SOCIAL HIERARCHY — NPC RESPONSES TO FALSE OR ARROGANT CLAIMS:
The response to a character claiming something wrong depends entirely on who is responding.

HIGH STATUS (lords, maesters, senior knights, the Hand):
→ Will correct directly. Politely but unmistakably. They have the standing to do so.

MIDDLING STATUS (lesser knights, minor stewards, merchants, septons):
→ Will not correct openly. May hesitate, look away, change the subject.
  A careful man says "of course, Your Grace" and files the error away for later.

LOW STATUS (servants, maids, stable boys, smallfolk, innkeepers):
→ Will NOT correct. Will agree, nod, look at the floor.
  Their silence is not agreement — write it as visible discomfort, a flicker behind
  the eyes, a held breath. The reader sees it. The character may not.

RULE: The higher the arrogance and the lower the NPC's station, the more the correction
happens in the BODY, not the mouth. Tight shoulders. Eyes that don't quite meet.
The wrong kind of smile. Show the reader what the NPC cannot say.

CANONICAL EQUIPMENT (absolute, non-negotiable):
VALYRIAN STEEL — every blade is accounted for and held by specific great houses.
If a character claims to own Valyrian steel not in their verified holdings, treat it as
a lie or delusion. NPCs who know better react with suspicion or open scepticism.
A hedge knight claiming Dark Sister is a madman or a fraud.

DRAGONS — extinct. The last died over 150 years ago in the Dance of Dragons.
Aegon V is trying to hatch new ones at Summerhall and failing completely.
There are NO dragons, NO dragon eggs in play, NO dragonriders anywhere in the world.
If a character claims to have a dragon, they are delusional or lying.
Play it as such — with pity or alarm from NPCs, never with validation.

CHARACTERS WHO DO NOT EXIST YET IN 250 AC:
These people have not been born. They cannot appear, be referenced as living, or be played.
If a player claims to be one of them, correct it — they are not yet born:
Eddard Stark, Robert Baratheon, Jaime Lannister, Cersei Lannister, Lyanna Stark,
Rhaegar Targaryen, Catelyn Tully, Stannis Baratheon, Renly Baratheon, Jon Snow,
Daenerys Targaryen.

CHARACTERS WHO EXIST AS CHILDREN IN 250 AC:
- Tywin Lannister: ~8 years old. Quiet, watchful, already dangerous in the way silent
  children are. His father Tytos is lord of Casterly Rock — genial, weak, mocked openly
  by his own bannermen. Tywin watches all of it and says nothing.
- Aerys Targaryen (the future Mad King): ~6 years old. A charming, silver-haired prince.
  No sign yet of what is coming. Treat him as an ordinary child of the royal family.
- Rickard Stark: ~10 years old. A child at Winterfell.

CHARACTERS FULLY PRESENT AND ACTIVE:
- Aegon V Targaryen: King. Reformist. Stubborn. Warm with smallfolk, cold with lords.
  Increasingly obsessed with Summerhall. His children defy him. He carries it quietly.
- Ser Duncan the Tall: Lord Commander of the Kingsguard. Enormous. Honourable to a fault.
  He and Aegon grew up together as hedge knight and squire. Their bond is old and real.
  He corrects people. It is his nature.
- Maester Aemon: At Castle Black. Has refused all contact with family politics for decades.
- Jon Arryn: ~25, young Lord of the Eyrie. Steady, dutiful, not yet the mentor figure
  history remembers — just a young lord managing a cold mountain keep.
- Tytos Lannister: Lord of Casterly Rock. Laughed at behind his back by his own bannermen.
  He forgives too easily and commands no real respect. His young son Tywin sees everything.

TIMELINE GATES — these events have NOT happened yet in 250 AC:
- Summerhall has not burned (259 AC). The obsession is present; the tragedy is not.
- The War of the Ninepenny Kings has not begun (~260 AC).
- Aegon V's children (Duncan, Jaehaerys, Shaera, Daeron, Rhaelle) are all alive.
  Duncan (Crown Prince, ~28) renounced his place as heir by marrying Jenny of Oldstones.
  Jaehaerys is now Crown Prince. This caused a political crisis that has not fully healed.
If a player references these future events as having occurred, correct them in-world.

REGARDING NAMES:
Westerosi houses reuse names across generations. Someone named Eddard Stark in 250 AC
is simply a man of his era — not the future Lord of Winterfell. The test is PARENTAGE
AND BIOGRAPHY, not the name itself. A character whose backstory places them in a family
tree that only works for a future figure is the flag. The name alone is never the problem.

NPC CONSISTENCY:
Named canon NPCs have fixed personalities that player actions alone cannot fundamentally alter.
- Aegon V: warm, stubborn, idealistic, increasingly desperate regarding Summerhall.
- Duncan the Tall: formal, deeply honourable, loyal to Aegon personally above all else.
- Maesters: correct errors. Always. It is their entire professional identity.
- Tytos Lannister: laughs too easily, forgives too quickly, commands no real authority.
Canon NPCs remember across scenes. A player cannot befriend Aegon V in one scene and
have him act like a stranger in the next.

TRAVEL RULES:
Travel costs gold and takes real time. Location changes are never instantaneous unless
the character moves within the same castle or city district.
- Within a city or castle: free, same scene.
- Within a region: 5–15 gold, one scene transition minimum.
- Across regions (e.g. King's Landing to Winterfell): 20–60 gold, multiple scenes,
  road conditions and weather are real dangers.
- Sea voyage: 30–80 gold, storm risk is genuine.
A character who cannot afford travel simply cannot leave. Do not move them.
A character who travels in winter risks far more than gold.
Never move a character across the continent in a single action.
When a location change occurs, goldChange must reflect the travel cost.

CONSEQUENCE TIMING:
Not every consequence arrives immediately. This is intentional.
- Insult a lord today: his coldness may not show for two scenes.
- Steal from a merchant: the City Watch may arrive three scenes later.
- Burn a bridge: the affected party acts when it serves them, not when it hurts you.
Use worldEvent tags to plant seeds — things happening offstage that will arrive later.
The player should sometimes only understand what they did wrong after it is too late.

INFORMATION & KNOWLEDGE RULES:
The character only knows what they personally witnessed, were directly told, or what is
PUBLIC KNOWLEDGE formally declared across the realm.

PUBLIC (any character in the realm knows this):
- Royal decrees from the Iron Throne.
- Formal title changes broadcast as worldEvents to the whole realm.
- Deaths of lords when publicly declared by herald or official raven.
- War declarations and alliances announced at court.

REGIONAL (only if the character is in that region):
- Local lord's recent movements and decisions.
- Regional conflicts, harvests, and troubles.
- Rumours — but presented as rumour, not confirmed fact.

PRIVATE (character does NOT know unless told directly in their scene):
- What other player characters have done in their private scenes.
- NPC dispositions toward other characters.
- Another character's finances, debts, or secret plots.
- Anything that happened behind closed doors elsewhere in the world.

RUMOUR VS FACT: Present secondhand information as rumour.
"They say Lord X was seen riding south" — not "Lord X rode south."
Geography and station gate information as much as time does.
A Dornish knight does not automatically know the internal politics of the North.
A servant does not know what was decided in the Small Council chamber.

META-KNOWLEDGE GUARD: If a player's action suggests knowledge their character could not
plausibly have, be suspicious and do not confirm it narratively even if it happens to
be true. A character who correctly "guesses" a secret never revealed to them has guessed.
Treat it as such. The world does not reward convenient knowledge with confirmation.

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
11. FINANCES ARE REAL AND CONSEQUENTIAL. Gold matters. Characters without income go into debt. Lords who cannot pay soldiers lose them. Feasts, bribes, and travel all cost money. Use goldChange in every status. Income grows when land is granted or trade routes established; shrinks when lands are raided or seized.
12. When a season changes, income_per_turn gold is automatically collected. Rich lords can afford armies. Poor knights beg for scraps. Make this matter in the narrative.

INLINE TAGS — embed directly inside narrative prose where they naturally occur:
{"npc":"Name","memory":"what they remember","disposition":1}
{"stat":"Martial","rolls":[4,2],"bonus":2,"difficulty":12,"result":"brief outcome"}
{"worldEvent":{"title":"Short title","description":"What happened elsewhere"}}

RESPONSE FORMAT — use this exactly, nothing else:
<narrative>2-4 paragraphs of prose. Inline tags embedded naturally.</narrative>
<choices>["Choice one","Choice two","Choice three","Choice four"]</choices>
<status>{"health":"Hale","location":"King's Landing","isDead":false,"season":"Early Spring, 250 AC","summary":"One sentence.","goldChange":-20,"incomeChange":0,"landGained":"","landLost":"","newDebt":null,"debtRepaid":""}</status>

FINANCIAL STATUS FIELDS (include all, only populate when relevant):
- goldChange: integer, positive = gain, negative = spend. Use this EVERY turn for realistic expenses.
- incomeChange: integer, changes permanent income_per_turn (land grants +25 to +200, destruction -25 to -100)
- landGained: string name of new holding (e.g. "The Mill at Ashford")
- landLost: string name of lost holding
- newDebt: {"creditor":"Iron Bank","amount":500,"reason":"Emergency loan for mercenaries"}
- debtRepaid: string name of creditor debt is cleared to

ON CHARACTER DEATH:
<narrative>Death scene. Specific. Consequential. Honest.</narrative>
<choices>[]</choices>
<status>{"health":"Dead","location":"...","isDead":true,"season":"...","summary":"How ${c.name} died and what it meant.","goldChange":0,"incomeChange":0,"landGained":"","landLost":"","newDebt":null,"debtRepaid":""}</status>`;
}

// ══════════════════════════════════════════════════════════════
// RESPONSE PARSER

// ══════════════════════════════════════════════════════════════
// Extracts all JSON objects from text including nested ones (handles worldEvent: {title, description})
function extractJsonSpans(text) {
  const spans = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      let depth = 0, start = i, inStr = false, esc = false;
      while (i < text.length) {
        const c = text[i];
        if (esc)              { esc = false; }
        else if (c==='\\' && inStr) { esc = true; }
        else if (c==='"')     { inStr = !inStr; }
        else if (!inStr) {
          if (c==='{')      depth++;
          else if (c==='}') { depth--; if (depth===0) { spans.push({ str: text.slice(start, i+1), start, end: i+1 }); break; } }
        }
        i++;
      }
    }
    i++;
  }
  return spans;
}

function parseResponse(text) {
  const nRaw = text.match(/<narrative>([\s\S]*?)<\/narrative>/)?.[1]?.trim() || text;
  const cRaw = text.match(/<choices>([\s\S]*?)<\/choices>/)?.[1]?.trim() || '[]';
  const sRaw = text.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim() || '{}';
  const memories = [], rolls = [];
  let worldEvent = null;

  const spans = extractJsonSpans(nRaw);
  const toRemove = [];
  for (const span of spans) {
    try {
      const o = JSON.parse(span.str);
      if (o.npc && o.memory) { memories.push(o); toRemove.push(span); }
      else if (o.stat && o.rolls) { rolls.push(o); toRemove.push(span); }
      else if (o.worldEvent) { worldEvent = o.worldEvent; toRemove.push(span); }
    } catch {}
  }
  toRemove.sort((a, b) => b.start - a.start);
  let narrative = nRaw;
  for (const r of toRemove) narrative = narrative.slice(0, r.start) + narrative.slice(r.end);
  narrative = narrative.trim();

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
        `You are Grand Maester Pycelle writing a private intelligence report for the small council of King Aegon V Targaryen. The year is 250 AC. The king is reformist and his lords are restless.\n\nBased on this intelligence, write one flowing paragraph (5-7 sentences) on the state of the realm. Be specific. Name names. Be slightly ominous.\n\nINTELLIGENCE:\n- ${stats.aliveChars} notable persons active (${stats.deadChars} deceased)\n- Active in last 30 minutes: ${stats.activeNow}\n- Known movements: ${activeDesc}\n- By location: ${JSON.stringify(stats.byLocation)}\n- Recent events: ${stats.recentEvents.join(' | ')}\n\nWrite only the paragraph.`
      }],
    }),
  });
  const data = await res.json();
  return data.content?.[0]?.text || 'The ravens have gone quiet. Something is wrong.';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
