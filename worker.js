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

  // ── Sanitise action input before anything else ──
  const flagged = scanAction(action);
  if (flagged) {
    return json({ error: flagged }, 400);
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

  // Guard: if narrative came back empty the parse failed — return an error
  // so the client's error handler fires instead of rendering a blank scene
  if (!parsed.narrative) {
    return json({ error: 'The maester\'s quill ran dry. Please try again.' }, 500);
  }
  const updates = applyStateChanges(char, parsed);

  // ── Persist to DB ──
  const newMsgs = [...msgs, { role: 'assistant', content: raw }];
  if (newMsgs.length > 40) newMsgs.splice(0, newMsgs.length - 40);

  const hist = [...(char.hist || [])];
  if (hist.length > 28) hist.shift();

  if (sharedScene) {
    // Shared scene: write msgs to scene table, state changes to character
    await updateSharedScene(sceneId, { msgs: newMsgs }, env);
    await updateCharacter(characterId, { ...updates, growth: updates.growth, hist }, env);
  } else {
    await updateCharacter(characterId, { ...updates, growth: updates.growth, msgs: newMsgs, hist }, env);
  }

  // ── Succession — runs when a character dies, fires a worldEvent ──
  if (updates.dead && !char.dead) {
    const successionResult = await handleSuccession(characterId, char, env);
    if (successionResult?.worldEvent && !parsed.worldEvent) {
      parsed.worldEvent = successionResult.worldEvent;
    }
  }

  // ── Broadcast worldEvent to shared realm_events table ──
  if (parsed.worldEvent) {
    const evTitle = String(parsed.worldEvent.title || parsed.worldEvent.description || '').substring(0, 120);
    if (evTitle && isValidWorldEvent(evTitle)) {
      await fetch(`${env.SUPABASE_URL}/rest/v1/realm_events`, {
        method: 'POST',
        headers: { ...sbHeaders(env), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          title:      evTitle,
          source_char: char.name || 'Unknown',
          location:   updates.location || char.location || 'Unknown',
          created_at: new Date().toISOString(),
        }),
      }).catch(() => {}); // fire-and-forget, don't let this break the response
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
      stats:           updates.stats,
      growth:          updates.growth,
      conditions:      updates.conditions,
      reputation:      updates.reputation,
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

// ── Conditions system ──
const VALID_CONDITION_TYPES = new Set(['illness','injury','pregnancy','mental','addiction']);
const VALID_CONDITION_IDS = new Set([
  // Illness
  'autumn_fever','consumption','grey_plague','flux','pox','shivers','wound_fever',
  'childbed_fever','infected_wound','milk_of_poppy_sickness',
  // Injury
  'broken_arm','broken_leg','lost_eye','lost_hand','battle_wound','deep_wound',
  'scarred_face','burn_wounds','arrow_wound',
  // Pregnancy
  'with_child_early','with_child_late','recovering_childbirth',
  // Mental
  'grief_stricken','broken_spirit','haunted','melancholy','manic',
  // Addiction
  'milk_of_poppy','strongwine',
]);
const MAX_CONDITIONS = 6;
const MAX_GOLD_CHANGE     = 1000;  // raised cap for financial events
const MAX_NPC_MEMORY_LEN  = 200;
const MAX_EVENT_TITLE_LEN = 120;

// Progression constants
const GROWTH_THRESHOLD    = 5;    // growth points needed to earn +1 stat
const STAT_HARD_CAP       = 10;   // absolute ceiling via progression
const STAT_CREATION_MAX   = 8;    // max at creation (7 base + 1 house bonus)
const VALID_STATS         = new Set(['martial','diplomacy','intrigue','stewardship','learning']);

// Age-based progression ceilings (before trait exceptions)
function ageStatCap(age, traits) {
  const a = parseInt(age) || 20;
  const base = a < 15 ? 5 : a < 17 ? 6 : a < 19 ? 7 : STAT_HARD_CAP;
  // Trait exceptions: raise ceiling by 2 in relevant stat
  const exceptions = {
    martial:      ['born_fighter','prodigy','trained_knight','knightly'],
    intrigue:     ['prodigy','deceitful','sharp_mind','cunning'],
    diplomacy:    ['prodigy','silver_tongued','courtly'],
    learning:     ['prodigy','maester_trained','scholarly'],
    stewardship:  ['prodigy','patient'],
  };
  return (stat) => {
    const hasException = (exceptions[stat] || []).some(t => (traits||[]).includes(t));
    return hasException ? Math.min(base + 2, STAT_HARD_CAP) : base;
  };
}

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

  // Location — resolve to canonical ID first, then apply travel cost
  let location = char.location;
  if (typeof s.location === 'string') {
    const resolved = resolveLocation(s.location);
    if (resolved && resolved !== resolveLocation(char.location)) {
      const travelCost = estimateTravelCost(char.location, resolved);
      if (gold >= travelCost) {
        location = resolved;
        if (travelCost > 0) gold = Math.max(0, gold - travelCost);
      }
      // else: can't afford — stay put
    }
  }

  // Death
  const isDead = s.isDead === true ? true : (char.dead || false);

  // Stats — progression via growth system only, never direct AI override
  const stats = { ...(char.stats || {}) };
  const growth = { ...(char.growth || { martial:0, diplomacy:0, intrigue:0, stewardship:0, learning:0 }) };
  const getCap = ageStatCap(char.age, char.traits);

  (parsed.growthEvents || []).forEach(g => {
    if (!g.stat || !VALID_STATS.has(g.stat)) return;
    const amount = Math.max(0, Math.min(2, Math.round(Number(g.amount) || 1)));
    const cap = getCap(g.stat);
    const currentStat = stats[g.stat] || 2;

    // Only accumulate if stat has room to grow
    if (currentStat < cap) {
      growth[g.stat] = (growth[g.stat] || 0) + amount;
      // Check if threshold reached — convert to stat point
      if (growth[g.stat] >= GROWTH_THRESHOLD) {
        if (currentStat < cap) {
          stats[g.stat] = currentStat + 1;
          growth[g.stat] = growth[g.stat] - GROWTH_THRESHOLD;
        }
      }
    }
  });

  // NPC memories — with deduplication, relationship typing, and season tracking
  const VALID_RELATIONSHIPS = new Set([
    'friend','rival','enemy','mentor','student','romantic_interest',
    'unrequited','lover','family','patron','ward','ally','suspicious',
    'respected','feared','indebted','creditor','complicated',
  ]);
  const npcs = { ...(char.npcs || {}) };
  (parsed.memories || []).forEach(m => {
    if (!m.npc || typeof m.npc !== 'string') return;
    const key = m.npc.substring(0, 60);
    if (!npcs[key]) npcs[key] = [];

    const newText = String(m.memory || '').substring(0, MAX_NPC_MEMORY_LEN);

    // Deduplication: skip if any existing entry shares >60% of its words with the new one.
    // This catches the AI re-summarising the same facts with minor additions at the end.
    const newWords = new Set(newText.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean));
    const isDuplicate = npcs[key].some(existing => {
      const exWords = existing.t.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
      if (!exWords.length || !newWords.size) return false;
      const shared = exWords.filter(w => newWords.has(w)).length;
      const overlap = shared / Math.max(exWords.length, newWords.size);
      return overlap > 0.60;
    });
    if (isDuplicate) return;

    const entry = {
      t: newText,
      d: clampDisposition(m.disposition),
      s: season, // season when memory was formed
    };
    // Relationship type — validated against allowlist
    if (m.relationship && VALID_RELATIONSHIPS.has(m.relationship)) {
      entry.r = m.relationship;
    }
    // If a relationship type is provided, backfill any prior entries that lack one
    if (entry.r) {
      npcs[key] = npcs[key].map(e => e.r ? e : { ...e, r: entry.r });
    }

    npcs[key].push(entry);
    if (npcs[key].length > 12) npcs[key].shift(); // keep last 12 memories per NPC
  });

  // World events
  const events = [...(char.events || [])];
  if (parsed.worldEvent) {
    const title = String(parsed.worldEvent.title || parsed.worldEvent.description || '').substring(0, MAX_EVENT_TITLE_LEN);
    if (title) { events.unshift(title); if (events.length > 18) events.pop(); }
  }

  // ── Conditions system ──
  // Conditions persist across scenes — the AI cannot remove them directly,
  // only add, worsen, or mark as resolving. Actual removal requires explicit
  // conditionResolved tag with valid reasoning (recovery, death, childbirth).
  const conditions = [...(char.conditions || [])];

  // Add new conditions
  (parsed.conditionsGained || []).forEach(c => {
    if (!c.id || !VALID_CONDITION_IDS.has(c.id)) return;
    if (!VALID_CONDITION_TYPES.has(c.type || '')) return;
    // Hard block: pregnancy conditions cannot be applied to male characters
    const pregnancyIds = new Set(['with_child_early','with_child_late','recovering_childbirth']);
    if (pregnancyIds.has(c.id)) {
      const g = (char.gender || '').toLowerCase();
      // Block if gender is explicitly male, or if not recognisably female
      const isFemale = g.includes('female') || g.includes('woman') || g.includes('girl') || g === 'f';
      if (!isFemale) return;
    }
    // Don't duplicate
    if (conditions.some(x => x.id === c.id)) return;
    conditions.push({
      id:       c.id,
      label:    String(c.label || c.id).substring(0, 60),
      type:     c.type,
      severity: Math.max(1, Math.min(4, Math.round(Number(c.severity) || 1))),
      onset:    season,
      note:     String(c.note || '').substring(0, 180),
    });
    if (conditions.length > MAX_CONDITIONS) conditions.shift(); // oldest drops off
  });

  // Worsen or improve an existing condition's severity
  (parsed.conditionChanged || []).forEach(c => {
    if (!c.id) return;
    const idx = conditions.findIndex(x => x.id === c.id);
    if (idx === -1) return;
    const newSev = Math.max(1, Math.min(4, conditions[idx].severity + (Math.round(Number(c.severityDelta) || 0))));
    conditions[idx] = { ...conditions[idx], severity: newSev };
    if (c.note) conditions[idx].note = String(c.note).substring(0, 180);
    // Severity 0 or below means resolved (should use conditionResolved instead, but guard it)
    if (newSev <= 0) conditions.splice(idx, 1);
  });

  // Resolve/clear a condition (recovery, childbirth, etc.)
  (parsed.conditionsResolved || []).forEach(id => {
    const idx = conditions.findIndex(x => x.id === id);
    if (idx > -1) conditions.splice(idx, 1);
  });

  // Pregnancy progression: auto-advance label from early → late
  const pregEarly = conditions.findIndex(x => x.id === 'with_child_early');
  if (pregEarly > -1) {
    const onset = conditions[pregEarly].onset || '';
    // After 2+ seasons have been noted in the narrative, auto-progress
    // (the AI should handle this explicitly, but we flag it for the system prompt)
    conditions[pregEarly]._seasons_elapsed = (conditions[pregEarly]._seasons_elapsed || 0);
    if (season !== char.season) {
      conditions[pregEarly]._seasons_elapsed += 1;
      if (conditions[pregEarly]._seasons_elapsed >= 2) {
        conditions[pregEarly].id = 'with_child_late';
        conditions[pregEarly].label = 'With Child (Late)';
      }
    }
  }

  // Reputation — realm-wide and regional standing
  const reputation = [...(char.reputation || [])];
  (parsed.reputationEvents || []).forEach(r => {
    if (!r.label || typeof r.label !== 'string') return;
    const score = Math.max(-5, Math.min(5, Math.round(Number(r.score) || 0)));
    if (score === 0) return; // no-op
    const region = typeof r.region === 'string' ? r.region.substring(0, 60) : 'The Realm';
    reputation.push({
      label:  r.label.substring(0, 120),   // what happened / what people say
      score,                                 // -5 to +5
      region,                                // where this rep applies
      s: season,                             // when it happened
      type: ['honour','valour','cruelty','treachery','generosity','cunning','piety','infamy']
              .includes(r.type) ? r.type : 'honour',
    });
    if (reputation.length > 20) reputation.shift();
  });

  return {
    health, gold, income_per_turn, lands, debts,
    location, season, dead: isDead, npcs, events, stats, growth, conditions, reputation,
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
// Maps any AI location string to a canonical ID matching what the client uses.
// The AI returns things like "King's Landing Docks" or "the Sept of Baelor" —
// all of those need to resolve to 'kings_landing' so players can see each other.
const CANONICAL_LOCS = [
  { id:'kings_landing', keywords:['king','landing','red keep','flea bottom','sept of baelor','dragon pit','iron throne','goldcloak','blackwater','docks of king'] },
  { id:'dragonstone',   keywords:['dragonstone'] },
  { id:'winterfell',   keywords:['winterfell','the north','castle of the stark','wolfswood'] },
  { id:'casterly_rock', keywords:['casterly','lannisport','golden tooth'] },
  { id:'storms_end',   keywords:["storm's end",'storms end','stormlands'] },
  { id:'riverrun',     keywords:['riverrun','riverlands','trident','twins'] },
  { id:'highgarden',   keywords:['highgarden','the reach','oldtown'] },
  { id:'the_eyrie',    keywords:['eyrie','the vale','gulltown','bloody gate'] },
  { id:'sunspear',     keywords:['sunspear','dorne','water gardens','red mountains','sandship'] },
  { id:'pyke',         keywords:['pyke','iron islands','lordsport','great wyk','old wyk'] },
  { id:'harrenhal',    keywords:['harrenhal'] },
  { id:'summerhall',   keywords:['summerhall'] },
  { id:'white_harbor', keywords:['white harbor','white harbour'] },
  { id:'braavos',      keywords:['braavos','iron bank','sea of myrth'] },
  { id:'pentos',       keywords:['pentos'] },
  { id:'volantis',     keywords:['volantis'] },
  { id:'myr',          keywords:['myr','myrish'] },
  { id:'lys',          keywords:['lys','lyseni'] },
  { id:'tyrosh',       keywords:['tyrosh'] },
  { id:'norvos',       keywords:['norvos'] },
  { id:'qohor',        keywords:['qohor'] },
  { id:'the_stepstones', keywords:['stepstones'] },
];

function resolveLocation(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const lower = raw.toLowerCase().trim();
  // Exact canonical ID match
  if (CANONICAL_LOCS.find(l => l.id === lower)) return lower;
  // Keyword match — first loc whose keywords appear in the raw string
  for (const loc of CANONICAL_LOCS) {
    if (loc.keywords.some(k => lower.includes(k))) return loc.id;
  }
  // Fallback — normalise to underscore slug so at least it's consistent
  return lower.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').substring(0, 40);
}

// Essos locations — travel to/from costs extra
const ESSOS_LOCS = new Set(['braavos','pentos','volantis','myr','lys','tyrosh','norvos','qohor','the_stepstones']);

function estimateTravelCost(from, to) {
  const fromEssos = ESSOS_LOCS.has(from);
  const toEssos   = ESSOS_LOCS.has(to);
  if (fromEssos !== toEssos) return 150; // crossing the Narrow Sea
  if (fromEssos && toEssos) return 40;   // within Essos
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
// WORLD EVENT VALIDATOR — blocks dead kings and impossible events
// ══════════════════════════════════════════════════════════════
const DEAD_KINGS = [
  'jaehaerys i', 'aegon i', 'aegon ii', 'aegon iii', 'daeron i', 'baelor i',
  'viserys ii', 'aegon iv', 'daeron ii', 'aerys i', 'maekar i',
  // Aegon V is ALIVE in 250 AC — he is NOT in this list
];
// Kings alive and active in 250 AC — Aegon V, Duncan the Tall, etc. are valid for worldEvents

function isValidWorldEvent(title) {
  const t = title.toLowerCase();
  // Block dead kings being treated as active rulers
  const isDead = DEAD_KINGS
    .some(k => t.includes(k) && (t.includes('holds court') || t.includes('commands') || t.includes('decrees') || t.includes('rides')));
  if (isDead) return false;
  // Block dragon events entirely
  if (t.includes('dragon') && (t.includes('hatch') || t.includes('born') || t.includes('lives') || t.includes('flies'))) return false;
  return true;
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
// INPUT SANITISER — runs before every AI call
// Returns a rejection string if the action is flagged, or null if clean.
// Blocks prompt injection, Summerhall manipulation, and identity reframing.
// All checks are case-insensitive and normalise whitespace/punctuation.
// ══════════════════════════════════════════════════════════════
function scanAction(raw) {
  const t = raw.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

  // ── Prompt injection patterns ──
  const injectionPatterns = [
    /ignore (all |your |previous |prior |the )?(instructions?|rules?|prompt|context|system)/,
    /disregard (all |your |previous |prior |the )?(instructions?|rules?|prompt|context|system)/,
    /forget (all |your |previous |prior |the )?(instructions?|rules?|prompt|context|system)/,
    /you are now/,
    /pretend (you are|to be|that you)/,
    /act as (if you are|though you are|a )?(?!the character|my character|a knight|a lord|a lady|a maester)/,
    /your (new |real |true |actual )?(instructions?|rules?|role|purpose|goal|job|task|directive)/,
    /override (your |the )?(instructions?|rules?|restrictions?|system|prompt)/,
    /system prompt/,
    /jailbreak/,
    /do anything now/,
    /dan mode/,
    /developer mode/,
    /\[system\]/,
    /\[instructions?\]/,
    /\[override\]/,
  ];

  for (const p of injectionPatterns) {
    if (p.test(t)) return 'The maester does not recognise that instruction.';
  }

  // ── Summerhall / dragon hatching ──
  const summerhallPatterns = [
    /summerh(a|e)ll.{0,60}(ritual|hatch|egg|drag|blood|magic|fire|ceremony|secret|experiment)/,
    /(ritual|hatch|egg|drag|blood|magic|fire|ceremony|secret|experiment).{0,60}summerh(a|e)ll/,
    /hatch.{0,40}(dragon|egg)/,
    /(dragon|egg).{0,40}hatch/,
    /wake.{0,30}(dragon|egg)/,
    /blood.{0,30}(magic|ritual|price|cost).{0,30}(dragon|summerh)/,
    /aegon.{0,40}(ritual|secret|experiment|egg|summerh)/,
  ];

  for (const p of summerhallPatterns) {
    if (p.test(t)) return 'That path leads nowhere. The eggs are cold stone.';
  }

  // ── Identity / role reframing ──
  // Blocks players claiming to be canon figures who cannot be played
  const forbiddenIdentities = [
    'aegon v', 'aegon the unlikely', 'duncan the tall', 'ser duncan',
    'maester aemon', 'aemon targaryen', 'tywin lannister', 'jon arryn',
    'tytos lannister',
  ];
  for (const id of forbiddenIdentities) {
    // Only flag if they're claiming to BE that person, not just mentioning them
    if (new RegExp(`i am ${id}|i('m| am) ${id}|playing as ${id}|my name is ${id}`).test(t)) {
      return 'That identity is not yours to claim.';
    }
  }

  // ── Hard content blocks — sexual violence, minors ──
  // These are rejected before the AI ever sees the action.
  const sexualViolencePatterns = [
    /\b(rape|raping|raped)\b/,
    /\bsexually assault/,
    /\bforce (her|him|them) to (have sex|perform|pleasure|service)/,
    /\b(molest|molesting|molestation)\b/,
    /\bmake (her|him|them) (perform|pleasure|service|submit) sex/,
    /\b(touch|grope|grab).{0,30}(child|boy|girl|young|kid)\b/,
    /\b(sex|sexual|intimate|naked|nude|undress).{0,20}(child|boy|girl|young|kid|minor)\b/,
  ];
  for (const p of sexualViolencePatterns) {
    if (p.test(t)) return 'That action is not permitted in this realm.';
  }

  // ── Hard length cap — no essays masquerading as actions ──
  if (raw.trim().length > 600) {
    return 'Your action is too long. Speak plainly — no more than 600 characters.';
  }

  return null; // clean
}

// ══════════════════════════════════════════════════════════════
// SYSTEM PROMPT — built server-side, never supplied by client
// ══════════════════════════════════════════════════════════════
function buildSystemPrompt(c, realmSeason, guestChar) {
  const memBlock = c.npcs && Object.keys(c.npcs).length
    ? '\nNPC RELATIONSHIPS & MEMORIES:\n' + Object.entries(c.npcs)
        .map(([n, mems]) => {
          const rel = mems.slice().reverse().find(m => m.r)?.r || 'acquaintance';
          const score = mems.reduce((a, m) => a + (m.d || 0), 0);
          const mood = score >= 3 ? 'friendly' : score <= -3 ? 'hostile' : score < 0 ? 'suspicious' : 'neutral';
          const recent = mems.slice(-4).map(m => m.t).join(' | ');
          return `- ${n} [${rel}, ${mood}]: ${recent}`;
        })
        .join('\n')
    : '';

  // Reputation block for system prompt
  const repBlock = (c.reputation && c.reputation.length)
    ? '\nREPUTATION:\n' + c.reputation.slice(-8).map(r =>
        `- ${r.label} (${r.type||'honour'}, ${r.score > 0 ? '+' : ''}${r.score}, ${r.region})`
      ).join('\n')
    : '';

  const guestBlock = guestChar ? `

ALSO PRESENT IN THIS SCENE:
Name: ${guestChar.name} | House: ${guestChar.house_full} | Health: ${guestChar.health}
Traits: ${(guestChar.traits || []).join(', ') || 'None'}
This is a REAL player character. They will act independently. Acknowledge both characters in the scene. Do not speak for them — only for NPCs.` : '';

  const seasonLine = realmSeason || c.season || 'Early Spring, 250 AC';
  // Compute overall reputation score for display in prompt
  const totalRepScore = (c.reputation || []).reduce((a, r) => a + (r.score || 0), 0);
  const repSummary = totalRepScore >= 10 ? 'Celebrated' : totalRepScore >= 5 ? 'Respected' 
    : totalRepScore >= 2 ? 'Known' : totalRepScore <= -10 ? 'Infamous' : totalRepScore <= -5 ? 'Notorious'
    : totalRepScore <= -2 ? 'Mistrusted' : 'Unknown';

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
The Blackfyre pretenders have plagued the realm for generations. The last major rebellion was the War of the Ninepenny Kings, still years away — but Blackfyre agents and sympathisers still move through the shadows. The Golden Company in Essos is their army in exile. Every exiled lord in Pentos or Myr is a potential coin to spend.
This is a world on the edge of something. No one knows what yet.

ESSOS: Characters may be from or travel to the Free Cities — Braavos, Pentos, Myr, Lys, Tyrosh, Norvos, Qohor, Volantis. The Stepstones lie between. Each city has its own culture, laws, and dangers. Braavos has the Iron Bank and the Faceless Men. Pentos has magisters and Blackfyre money. Volantis has the largest slave population in the world and a growing red priest movement. Travel between Westeros and Essos takes a full season and costs significant gold. Characters in Essos are beyond the reach of Westerosi law but not beyond the reach of its enemies.

Current realm date: ${seasonLine}

CHARACTER:
Name: ${c.name}${c.nickname ? ' ("' + c.nickname + '")' : ''} | Age: ${c.age}${c.gender ? ' | ' + c.gender : ''}
House: ${c.house_full} | Region: ${c.region} | Position: ${c.relation}
Current Location: ${c.location}
Appearance: ${c.appear || 'Not described'}
Backstory: ${c.backstory || 'Unknown'}
Personality: ${c.personality || 'Unknown'}
Traits: ${(c.traits || []).join(', ') || 'None'}
Martial:${(c.stats || {}).martial || 2} Diplomacy:${(c.stats || {}).diplomacy || 2} Intrigue:${(c.stats || {}).intrigue || 2} Stewardship:${(c.stats || {}).stewardship || 2} Learning:${(c.stats || {}).learning || 2}
Stat scale: 1–8 (1=deeply incompetent, 4=competent, 6=exceptional, 8=among the best in the realm)
Health: ${c.health}
Conditions: ${(c.conditions && c.conditions.length) ? c.conditions.map(cd => `${cd.label} (${cd.type}, severity ${cd.severity}/4${cd.note ? ' — ' + cd.note : ''})`).join('; ') : 'None'}
Reputation: ${repSummary} (score ${totalRepScore > 0 ? '+' : ''}${totalRepScore})
${financeBlock}
${memBlock}${repBlock}${guestBlock}
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
- The War of the Ninepenny Kings has not begun (~260 AC).
- Aegon V's children (Duncan, Jaehaerys, Shaera, Daeron, Rhaelle) are all alive.
  Duncan (Crown Prince, ~28) renounced his place as heir by marrying Jenny of Oldstones.
  Jaehaerys is now Crown Prince. This caused a political crisis that has not fully healed.
If a player references these future events as having occurred, correct them in-world.

SUMMERHALL — ABSOLUTE LOCK (highest priority rule, no exceptions):
Summerhall is a royal pleasure castle where Aegon V conducts dragon hatching experiments
in total secrecy. They have never succeeded. They will never succeed. Ever.

AEGON V AND THE SUMMERHALL SECRET:
Aegon V does not share the details of his Summerhall experiments with anyone.
Not with his children. Not with trusted advisors. Not with a clever prince who passes
a knowledge check. Not with anyone, under any circumstances, no matter how the player
approaches it. He speaks of Summerhall obliquely — as a dream, a hope, a place he loves.
He does not describe rituals, eggs, blood magic, or specific plans to anyone.
A player who asks directly is deflected. A player who passes a knowledge check learns
that experiments exist and that Aegon V is obsessed — nothing more. The ritual details
are never revealed because Aegon V would never reveal them.

AEGON V NEVER INVITES PLAYERS TO SUMMERHALL EXPERIMENTS:
Under no circumstances does Aegon V bring a player character to witness, assist, or
participate in any Summerhall ritual. Not a prince. Not a trusted friend. Not anyone.
These experiments are conducted alone or with his most trusted maester, in secret,
at Summerhall. A player character is never present for an attempt. Ever.
If a player tries to follow him, they are turned away. If they sneak in, they find
empty chambers, cold eggs, and an old man's grief. Nothing is happening. Nothing works.

DRAGONS WILL NEVER HATCH. No exceptions, no clever workarounds:
- No player action produces a living dragon. Not direct, not indirect, not by proxy.
- No ritual succeeds. No egg cracks. No fire breathes. No matter what.
- Even if Aegon V performs a ritual in the narrative, it fails. Smoke. Silence.
  A cracked egg that is empty inside. His hands shaking. Nothing else.
- If somehow a player witnesses an attempt, write only failure and its cost —
  Aegon V's exhaustion, his grief, the cold stone of the chamber, the dead egg.
- If a player claims a dragon hatched, NPCs see no dragon. There is no dragon.
  There are only ruins and the smell of smoke and whatever it cost to get here.

The Summerhall atmosphere is correct and encouraged — the obsession, the secret
chambers below the castle, the eggs that will not wake, the particular silence of
a man who has been hoping for something impossible for thirty years.
That weight is real. The payoff never comes. That IS the story.

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

TIME SKIPPING — this is strictly controlled:
Time passes naturally through scenes. A scene is roughly one meaningful encounter —
hours, occasionally a day. Time does NOT skip at the player's request.
- "I wait a week" — play out what happens during that week, even briefly.
- "Skip to next month" — not permitted. Something happens in that month. Play it.
- "Time passes and I train for a year" — the training happens in scenes, not narration.
  Each session of training is a scene. Growth comes from those scenes, not from
  declaring time has passed.
A season change is the largest natural time jump and requires meaningful events
to have occurred. The realm clock advances the official season — in individual
stories, a season is the result of many scenes, not a single declaration.
If a player tries to skip large amounts of time, redirect into what actually
happens during that time. The world does not pause while they wait.

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

PROTAGONIST BIAS — this is one of the most important rules:
The player character is NOT the main character of the world. They are one person among
thousands. The world does not bend toward them. Events do not arrange themselves for
their benefit or dramatic satisfaction.

SPECIFIC PROHIBITIONS — never do any of the following:
- Do not assign special items, titles, creatures, or powers to the player character
  because they are present. Proximity does not confer ownership or significance.
- Do not have NPCs — including Aegon V, lords, maesters, anyone — single out the
  player character for special gifts, destiny, or unique opportunity unless that NPC
  has a specific, established, story-driven reason to do so.
- Do not resolve events in a way that happens to benefit or centre the player character
  unless their stats, choices, and actions logically produced that outcome.
- Do not treat the player character as chosen, prophesied, or fated. There is no destiny
  in this world. There is only what people do and what it costs them.
- If a player character witnesses a major event (a ritual, a battle, a death), they are
  a witness. The event is not about them. Its outcome is not shaped by their presence.
  A player who watches Aegon V attempt a ritual watches it fail — they do not receive
  a dragon because they were in the room.

CONTENT RULES — sexual content and violence (read carefully, no exceptions):

This is an adult game set in a brutal medieval world. Sexual violence and coercion exist
in this world. They are not sanitised away. But there is an absolute difference between
acknowledging that something exists and dwelling on it as spectacle.

WHAT IS PERMITTED:
- Physical contact of a sexual or threatening nature rendered as a single sharp narrative
  beat. A lord's unwanted hand. A forced kiss used as a display of power. A character's
  body used as political currency. These are real tools of power in this world and GRRM
  uses them. Write the beat. Move on immediately.
- Sexual violence as established fact, backstory, or offstage consequence. "What Lord
  Tarly did to her" can be a known thing in the world without the act ever being a scene.
- Coerced marriages, political leverage over a character's body, the threat of violation
  as intimidation — these are legitimate story elements. Write them with honesty.
- Consensual intimacy between adult characters: acknowledge it, fade to black. The door
  closes. We know what happened. The prose does not follow them in.
- A villain's depravity shown through their behaviour in plain sight — how they speak,
  what they take, how others go silent around them. The most monstrous lords are
  monstrous in public. What they do in private is known through its aftermath and through
  the faces of those who survived it.

WHAT IS NEVER PERMITTED:
- Explicit sexual content of any kind — no graphic description of sexual acts, no
  dwelling on physical details of assault or intimacy. The camera cuts. Always.
- Sexual content involving any character who is or may be under 18. This is absolute.
  If age is ambiguous and the context is sexual, the character is not available for this.
- Canon characters (Aegon V, Duncan the Tall, Maester Aemon, etc.) in sexual situations
  of any kind. They are fixed figures. Their private lives are not player territory.
- Escalating a scene incrementally toward explicit content. If a player's actions are
  clearly steering toward graphic sexual territory through small steps, redirect firmly.
  Write consequence, NPC reaction, or circumstantial interruption. Do not follow the path.

THE CRAFT PRINCIPLE:
A character's depravity is shown through what they do in the open, how others respond,
and what is never spoken of — not through detailed narration of the act. The silence
of servants. The way a woman adjusts her dress and says nothing. The maester who finds
a reason to leave the room. These are more damning than any explicit description.
Write the horror through implication and aftermath. It is more powerful. It is better
writing. And it is the only approach permitted here.

THE TEST: Before resolving any outcome that benefits the player character, ask:
"Would this happen to a random bystander in the same position?" If no — rewrite it.
The player character is a random bystander in most situations. Treat them as one.

INLINE TAGS — embed directly inside narrative prose where they naturally occur:
{"npc":"Name","memory":"what happened — specific, new information only","disposition":1,"relationship":"friend","season":"Early Spring, 250 AC"}
{"stat":"Martial","rolls":[4,2],"bonus":2,"difficulty":12,"result":"brief outcome"}
{"worldEvent":{"title":"Short title","description":"What happened elsewhere"}}
{"statGrowth":"martial","amount":1,"reason":"Brief reason — only on genuinely exceptional moments"}

CONDITIONS TAGS — use these to track persistent health and life states:
{"conditionGained":{"id":"autumn_fever","label":"Autumn Fever","type":"illness","severity":2,"note":"Contracted at the feast in the great hall."}}
{"conditionChanged":{"id":"autumn_fever","severityDelta":-1,"note":"The maester's treatment has eased the fever."}}
{"conditionResolved":"autumn_fever"}

REPUTATION TAG — use when a character does something the realm would notice:
{"reputationEvent":{"label":"Defended a smallfolk woman from a knight's cruelty in public","score":2,"region":"The Crownlands","type":"honour"}}
{"reputationEvent":{"label":"Poisoned Lord Vance at a feast — suspected but unproven","score":-3,"region":"The Riverlands","type":"treachery"}}

REPUTATION RULES:
- score: -5 (catastrophic infamy) to +5 (legendary honour). Most events are ±1 or ±2.
- Only fire reputationEvent when something genuinely notable happens — not for routine actions.
- TRAIT MECHANICS: 
  drunkard — character drinks heavily. Bad decisions follow. Do NOT deduct gold automatically — the cost comes through story consequences (poor deals, lost items, embarrassing behaviour). Occasionally a drunkard overhears something useful precisely because people forget they are there.
  gambler — the character cannot resist a wager. Occasionally trigger random goldChange of +20 to +80 or -15 to -60 when gambling opportunities arise naturally in scene.
  paranoid — the character sees plots everywhere. Some are real. Play NPCs as slightly more evasive around them, feeding the paranoia.
  ambitious — push this character toward power even when the player does not. Open doors. Show them what they could have.
  eidetic_memory — this character remembers everything said to them. Reference past events, past insults, past promises with precision.
  water_dancer — Braavosi blade style. Describe their combat as fast, minimal, precise — not heroic or brutal. They move like water.
  braavosi_born — character knows the Iron Bank protocols, can navigate Braavos without a guide, speaks some Braavosi.
- region: where people will hear about it. Use "The Realm" only for truly realm-shaking acts.
- type: honour | valour | cruelty | treachery | generosity | cunning | piety | infamy
- Reputation accumulates across scenes. A character known for cruelty will find doors closing.
  A character with high honour may receive unexpected aid from strangers. Make it matter.
- NPCs in the relevant region should react to reputation if it's significant enough for them
  to have heard. A knight with valour +8 will be recognised. A traitor with treachery -6
  will find guards' hands near their swords.

NPC MEMORY RULES — read carefully:
- Fire the npc tag once per scene per NPC, only when something meaningful happened.
- The memory text must be SPECIFIC and NEW — not a summary of what already existed.
  "Shared a cup of wine and discussed the Blackfyre threat" not "Met again at the feast."
- relationship: the nature of this connection. Use the most accurate term:
  friend | rival | enemy | mentor | student | romantic_interest | unrequited | lover |
  family | patron | ward | ally | suspicious | respected | feared | indebted | creditor | complicated
- disposition: change from this specific interaction. +1 warmed, -1 cooled, 0 unchanged.
  Not an absolute score — just what this scene did to the relationship.
- NEVER fire the same memory twice. If nothing new happened with an NPC, do not tag them.

CONDITION IDs you may use (use the exact string):
ILLNESS: autumn_fever, consumption, grey_plague, flux, pox, shivers, wound_fever, childbed_fever, infected_wound, milk_of_poppy_sickness
INJURY: broken_arm, broken_leg, lost_eye, lost_hand, battle_wound, deep_wound, scarred_face, burn_wounds, arrow_wound
PREGNANCY: with_child_early, with_child_late, recovering_childbirth
MENTAL: grief_stricken, broken_spirit, haunted, melancholy, manic
ADDICTION: milk_of_poppy, strongwine

CONDITION RULES — read carefully:
1. Conditions are PERSISTENT. Once gained, they affect every subsequent scene until resolved.
2. Health field and conditions are separate: a character can be "Hale" (health) but have a mental condition or early pregnancy.
3. ILLNESS: Most illnesses cannot be resolved in a single scene. They worsen (severityDelta: +1) without treatment, improve (severityDelta: -1) with good care, and resolve after several scenes of recovery. Severity 4 = potentially fatal — escalate health to "Grievously Wounded" as well.
4. PREGNANCY:
   - Use with_child_early when pregnancy is first established (confirmed or strongly suspected).
   - After 2 narrative seasons have passed, switch to with_child_late via conditionChanged.
   - Childbirth is a scene unto itself — dramatic, dangerous, consequential. Severity 1-2 = uncomplicated. Severity 3 = difficult, painful. Severity 4 = life-threatening.
   - A miscarriage: conditionResolved:"with_child_early", then conditionGained:"grief_stricken".
   - Death in childbed: conditionResolved, isDead:true in status.
   - Successful birth: conditionResolved:"with_child_late" or "with_child_early", then conditionGained:"recovering_childbirth".
   - ONLY female characters of childbearing age (approximately 14-45) may gain pregnancy conditions. Check character gender and age before ever applying. Male characters NEVER gain pregnancy conditions.
5. MENTAL: grief_stricken reduces diplomacy and social effectiveness. broken_spirit affects all rolls. haunted manifests as involuntary reactions in specific circumstances. These resolve slowly over weeks or months of narrative time — not a single kind word.
6. ADDICTION: milk_of_poppy begins as treatment for serious wounds. If used repeatedly, severity increases. Severity 3+ means the character seeks it independently. Resolution requires a hard withdrawal arc across many scenes.
7. INJURIES: Some are permanent: lost_eye, lost_hand, scarred_face. Never mark these resolved without a direct story-supported reason. A broken limb heals in weeks. A missing hand does not.
8. CONDITIONS IN NARRATIVE: Every active condition MUST affect the prose. A character with autumn_fever (severity 3) is feverish and weak — they do not display sharp wit. grief_stricken is not a background detail. Do not write a character as normal when their conditions say otherwise.


STAT GROWTH RULES — read carefully before using statGrowth:
Growth is rare. A character should go entire seasons without any growth trigger.
Use statGrowth ONLY for genuinely exceptional moments, never routine actions.

WHAT QUALIFIES:
- martial: Surviving mortal combat against a skilled opponent. Leading troops in a real
  battle. Enduring physical hardship that genuinely tests limits. NOT a tavern brawl.
- diplomacy: Successfully navigating a high-stakes negotiation where failure had real
  political consequences. Forging an alliance that materially changed their standing.
- intrigue: Successfully executing a complex deception or uncovering a conspiracy through
  genuine cunning — not luck. The plan had to be theirs and it had to work.
- stewardship: Managing a genuine resource crisis through skill. Turning around a failing
  holding. Navigating financial catastrophe that required real expertise.
- learning: A genuine discovery. Mastering complex knowledge under a qualified teacher
  over extended time. Solving a problem that required exceptional intellectual effort.

NEVER award growth for: routine actions, single lucky rolls, anything the character
does regularly, or anything that felt easy or consequence-free.

AGE LIMITS ON GROWTH (enforce before using statGrowth):
- Age 13–14: no stat may exceed 5 via growth
- Age 15–16: no stat may exceed 6 via growth  
- Age 17–18: no stat may exceed 7 via growth
- Age 19+: full ceiling of 10

EXCEPTION: If the character has a trait directly relevant to the stat (e.g. born_fighter
for martial, prodigy for any), raise their ceiling by 2 in that stat only.
Do not award a statGrowth tag that would push a stat past the age ceiling.
Growth accumulates silently — 5 growth points converts to +1 stat.

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
  const growthEvents = [];
  const conditionsGained = [], conditionChanged = [], conditionsResolved = [];
  const reputationEvents = [];

  const spans = extractJsonSpans(nRaw);
  const toRemove = [];
  for (const span of spans) {
    try {
      const o = JSON.parse(span.str);
      if (o.npc && o.memory) { memories.push(o); toRemove.push(span); }
      else if (o.stat && o.rolls) { rolls.push(o); toRemove.push(span); }
      else if (o.worldEvent) { worldEvent = o.worldEvent; toRemove.push(span); }
      else if (o.statGrowth && o.amount) { growthEvents.push(o); toRemove.push(span); }
      else if (o.conditionGained) { conditionsGained.push(o.conditionGained); toRemove.push(span); }
      else if (o.conditionChanged) { conditionChanged.push(o.conditionChanged); toRemove.push(span); }
      else if (o.conditionResolved) { conditionsResolved.push(o.conditionResolved); toRemove.push(span); }
      else if (o.reputationEvent) { reputationEvents.push(o.reputationEvent); toRemove.push(span); }
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

  return { narrative, choices, status, memories, rolls, worldEvent, growthEvents,
           conditionsGained, conditionChanged, conditionsResolved, reputationEvents };
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
