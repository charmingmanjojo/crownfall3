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
    if (path === '/saveChar')     return handleSaveChar(await request.json().catch(() => ({})), env);
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

  // ── "While you were away" — inject matured NPC events into the opening turn ──
  // Pending events that have counted down to 0 fire here as context injected before
  // the player's action, forcing the AI to address the consequence in this scene.
  const pendingEvents = char.pending_npc_events || [];
  const maturedNow = pendingEvents.filter(ev => (ev.resolvesAfter || 1) <= 1);
  const stillPending = pendingEvents.filter(ev => (ev.resolvesAfter || 1) > 1)
    .map(ev => ({ ...ev, resolvesAfter: ev.resolvesAfter - 1 }));

  let awayInjection = '';
  if (maturedNow.length > 0 && (char.hist || []).length > 0) {
    // Only fire if character has a history (not brand new)
    const eventDescs = maturedNow.map(ev => {
      const base = `${ev.npc} — ${ev.pendingEvent.replace(/_/g, ' ')}`;
      const extra = ev.data?.note ? `: ${ev.data.note}` : '';
      return base + extra;
    }).join('\n');
    awayInjection = `\n[WORLD UPDATE — things that have happened since your last scene:\n${eventDescs}\nAddress at least one of these naturally in this scene.]`;
    // Clear fired events from pending
    await updateCharacter(characterId, { pending_npc_events: stillPending }, env).catch(() => {});
  }

  // ── Build conversation — shared scene uses scene msgs, solo uses char msgs ──
  const baseMsgs = sharedScene ? (sharedScene.msgs || []) : (char.msgs || []);
  const actionWithInjection = awayInjection
    ? `[${char.name}]: ${action}${awayInjection}`
    : `[${char.name}]: ${action}`;
  const msgs = [...baseMsgs, { role: 'user', content: actionWithInjection }];

  // When hist is populated the system prompt's CURRENT SITUATION + STORY SO FAR blocks
  // already carry the narrative context. Sending the same turns again in the message
  // window is redundant and causes the AI to echo/re-introduce resolved scenes.
  // Use a tighter window (10) when hist has content; fall back to 20 for fresh games.
  const histLen = (char.hist || []).length;
  const msgWindow = histLen >= 3 ? 10 : 20;

  // For older assistant messages (not the most recent), strip the narrative prose and
  // replace with just the summary. This prevents the AI from pattern-matching to its own
  // previous scene descriptions and replaying them.
  const rawWindow = msgs.slice(-msgWindow);
  const windowedMsgs = rawWindow.map((m, i) => {
    // Always keep user messages intact
    if (m.role === 'user') return m;
    // Keep the last 2 assistant messages FULL so the AI has enough scene texture
    // to continue in media res rather than re-establishing setting and characters.
    // Only 1 full message caused the AI to lose track of who was in the room and restart.
    const assistantMsgs = rawWindow.filter(x => x.role === 'assistant');
    const assistantIdx  = assistantMsgs.indexOf(m);
    if (assistantIdx >= assistantMsgs.length - 2) return m; // keep last 2 full
    // For older assistant messages: extract the summary + location for compact context
    const summaryMatch  = m.content && m.content.match(/"summary"\s*:\s*"([^"]{0,200})"/);
    const locationMatch = m.content && m.content.match(/"location"\s*:\s*"([^"]{0,80})"/);
    if (summaryMatch) {
      const loc = locationMatch ? ` [at: ${locationMatch[1]}]` : '';
      return { role: 'assistant', content: `[Scene summary${loc}: ${summaryMatch[1]}]` };
    }
    // Fallback: first 200 chars of narrative
    const narrativeMatch = m.content && m.content.match(/<narrative>([\s\S]{0,200})/);
    return { role: 'assistant', content: narrativeMatch ? `[Scene: ${narrativeMatch[1].trim()}...]` : '[Scene continued]' };
  });

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 850,
      system: buildSystemPrompt(char, realmSeason, guestChar),
      messages: windowedMsgs,
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
  // Cap at 40 for both solo and shared scenes — shared scenes were previously uncapped
  // until written back, allowing a long session to balloon the DB entry unboundedly.
  if (newMsgs.length > 40) newMsgs.splice(0, newMsgs.length - 40);

  // Push this turn into history so the STORY SO FAR block stays current
  // Store the AI's own summary (one sentence) -- far more useful than raw narrative
  const hist = [...(char.hist || [])];
  const turnSummary = String((parsed.status || {}).summary || '').substring(0, 200);
  hist.push({
    choice:  action,
    summary: turnSummary || (parsed.narrative ? parsed.narrative.replace(/\n+/g,' ').substring(0, 160) : ''),
    rolls:   parsed.rolls || [],
  });
  if (hist.length > 30) hist.shift();

  try {
    if (sharedScene) {
      // Extra guard: ensure shared scene msgs are capped before write
      const sharedMsgsCapped = newMsgs.length > 40 ? newMsgs.slice(-40) : newMsgs;
      await updateSharedScene(sceneId, { msgs: sharedMsgsCapped }, env);
      await updateCharacter(characterId, {
        ...updates, growth: updates.growth, hist,
        turn_count: updates.turnCount,
        pending_npc_events: updates.pendingNpcEvents,
      }, env);
    } else {
      await updateCharacter(characterId, {
        ...updates, growth: updates.growth, msgs: newMsgs, hist,
        turn_count: updates.turnCount,
        pending_npc_events: updates.pendingNpcEvents,
      }, env);
    }
  } catch (saveErr) {
    // The AI ran fine but the save failed — return the scene WITH a warning flag
    // The client will show a toast and can retry
    // Include npcs, hist, and msgs in the saveError payload so the client's
    // pendingSave has the FULL state needed to recover — not just charState.
    // Previously, a failed save would lose NPC memories (Known Relationships),
    // turn history, and message context permanently on retry.
    return json({
      ...parsed,
      charState: updates,
      saveError: true,
      saveErrorMsg: saveErr.message || 'Save failed',
      saveFields: {
        // Everything updateCharacter would have written
        ...updates,
        hist:               hist,
        msgs:               sharedScene ? undefined : newMsgs,
        growth:             updates.growth,
        turn_count:         updates.turnCount,
        pending_npc_events: updates.pendingNpcEvents,
      },
    });
  }

  // ── Succession — runs when a character dies, fires a worldEvent ──
  // Guard: only use succession worldEvent if the AI didn't already emit one this turn,
  // preventing the same death from broadcasting two separate realm events.
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
      // Dedup: check if an identical event title was already broadcast in the last 60 seconds
      // This catches the rare case where AI + succession both fire for the same death.
      const recentCheck = await fetch(
        `${env.SUPABASE_URL}/rest/v1/realm_events?title=eq.${encodeURIComponent(evTitle)}&created_at=gte.${new Date(Date.now()-60000).toISOString()}&limit=1`,
        { headers: sbHeaders(env) }
      ).then(r => r.json()).catch(() => []);
      if (!Array.isArray(recentCheck) || recentCheck.length === 0) {
        await fetch(`${env.SUPABASE_URL}/rest/v1/realm_events`, {
          method: 'POST',
          headers: { ...sbHeaders(env), 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            title:      evTitle,
            source_char: char.name || 'Unknown',
            location:   updates.location || char.location || 'Unknown',
            created_at: new Date().toISOString(),
          }),
        }).catch(() => {}); // fire-and-forget
      }
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
      turn_count:      updates.turnCount,
      pending_npc_events: updates.pendingNpcEvents,
    },
    firedEvents: updates.firedEvents || [],
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
const VALID_CONDITION_TYPES = new Set(['illness','injury','pregnancy','mental','addiction','supernatural','social']);
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
  // Supernatural (Targaryen dreams, greensight, etc.)
  'dragon_dreams','greensight','prophetic_dreams','shadow_touched','fire_resistant',
  // Social consequences
  'bastard_born','scandal_known','betrothal_broken','blood_debt_owed','exiled',
  'disinherited','imprisoned','hostage',
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

  // Location — resolve to canonical ID and apply.
  // Travel gold cost is handled narratively by the AI via goldChange — we don't
  // deduct it mechanically here as it blocked valid location updates when gold was low.
  let location = char.location;
  if (typeof s.location === 'string') {
    const resolved = resolveLocation(s.location);
    if (resolved) location = resolved;
  }

  // Death
  const isDead = s.isDead === true ? true : (char.dead || false);

  // Stats — progression via growth system only, never direct AI override
  const stats = { ...(char.stats || {}) };
  const growth = { ...(char.growth || { martial:0, diplomacy:0, intrigue:0, stewardship:0, learning:0 }) };
  const getCap = ageStatCap(char.age, char.traits);

  (parsed.growthEvents || []).forEach(g => {
    // AI emits {"statGrowth":"martial","amount":1} -- the key is statGrowth, not stat
    const statKey = g.statGrowth || g.stat;
    if (!statKey || !VALID_STATS.has(statKey)) return;
    const amount = Math.max(0, Math.min(2, Math.round(Number(g.amount) || 1)));
    const cap = getCap(statKey);
    const currentStat = stats[statKey] || 2;

    // Only accumulate if stat has room to grow
    if (currentStat < cap) {
      growth[statKey] = (growth[statKey] || 0) + amount;
      // Check if threshold reached — convert to stat point
      if (growth[statKey] >= GROWTH_THRESHOLD) {
        if (currentStat < cap) {
          stats[statKey] = currentStat + 1;
          growth[statKey] = growth[statKey] - GROWTH_THRESHOLD;
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

  // ── Pending NPC Events — time-delayed consequences ──
  // The AI can tag an NPC with a pendingEvent that resolves after N turns.
  // e.g. {"npc":"Mira","pendingEvent":"pregnancy_reveal","resolvesAfter":8,"data":{...}}
  // Each turn we decrement the counter; when it hits 0 the event fires on next session load.
  const pendingNpcEvents = [...(char.pending_npc_events || [])];
  const firedEvents = []; // events that matured this turn — returned to client
  const newPending = [];
  const turnCount = (char.turn_count || 0) + 1;

  pendingNpcEvents.forEach(ev => {
    const remaining = (ev.resolvesAfter || 1) - 1;
    if (remaining <= 0) {
      firedEvents.push(ev); // matured — will be injected into next session opening
    } else {
      newPending.push({ ...ev, resolvesAfter: remaining });
    }
  });

  // Check if AI emitted any new pending NPC events this turn
  (parsed.pendingNpcEvents || []).forEach(ev => {
    if (!ev.npc || !ev.pendingEvent || !ev.resolvesAfter) return;
    // Don't duplicate — one pending event per npc+type
    const key = ev.npc + ':' + ev.pendingEvent;
    if (newPending.some(e => e.npc + ':' + e.pendingEvent === key)) return;
    newPending.push({
      npc:           String(ev.npc).substring(0, 60),
      pendingEvent:  String(ev.pendingEvent).substring(0, 60),
      resolvesAfter: Math.max(1, Math.min(30, Math.round(Number(ev.resolvesAfter) || 6))),
      data:          ev.data || {},
      createdTurn:   turnCount,
    });
  });

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
    // Pending NPC event system — time-delayed consequences
    turnCount,
    pendingNpcEvents: newPending,
    firedEvents,
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
  if (!checkRateLimit('inscribe:' + userId)) return json({ error: 'Too many inscriptions.' }, 429);

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
  // Build NPC memory block — flag any NPCs sharing a first name so the AI never conflates them.
  const npcEntries = c.npcs ? Object.entries(c.npcs) : [];
  // Count how many NPCs share each first name
  const firstNameCount = {};
  npcEntries.forEach(([n]) => {
    const first = n.split(' ')[0];
    firstNameCount[first] = (firstNameCount[first] || 0) + 1;
  });
  const memBlock = npcEntries.length
    ? '\nNPC RELATIONSHIPS & MEMORIES:\n' + npcEntries
        .map(([n, mems]) => {
          const rel = mems.slice().reverse().find(m => m.r)?.r || 'acquaintance';
          const score = mems.reduce((a, m) => a + (m.d || 0), 0);
          const mood = score >= 3 ? 'friendly' : score <= -3 ? 'hostile' : score < 0 ? 'suspicious' : 'neutral';
          const recent = mems.slice(-4).map(m => m.t).join(' | ');
          // If another NPC shares this first name, append a disambiguation warning
          const first = n.split(' ')[0];
          const disambig = firstNameCount[first] > 1
            ? ` ⚠ DISTINCT PERSON — do not confuse with other ${first}s`
            : '';
          return `- ${n} [${rel}, ${mood}]${disambig}: ${recent}`;
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

  // -- Current situation + story history block --
  // These appear EARLY in the prompt (right after CHARACTER) so the AI weights them highly.
  // Uses the AI's own turn summaries -- compact, accurate, no noise.
  const recentHist = c.hist ? c.hist.slice(-5) : [];
  const lastEntry  = recentHist.length ? recentHist[recentHist.length - 1] : null;

  const situationLine = lastEntry && lastEntry.summary
    ? '\nCURRENT SITUATION: ' + lastEntry.summary
    : '';

  const histBlock = recentHist.length > 1
    ? '\n\nSTORY SO FAR (most recent first — do NOT re-introduce any of this):\n' +
      recentHist.slice(0, -1).reverse().map((h, i) => {
        const act = h.choice ? h.choice.substring(0, 80) : '';
        const sum = (h.summary || '').substring(0, 160);
        return (i + 1) + '. [' + act + '] ' + sum;
      }).join('\n') +
      '\n\nCONTINUATION RULE: The narrative continues directly from CURRENT SITUATION above. ' +
      'Every NPC, tension, and consequence from the Story So Far persists. ' +
      'Do NOT restart, reset to an earlier scene, or re-introduce already-resolved situations. ' +
      'Do NOT offer choices that mirror or repeat what was just done. ' +
      'The player has already acted — the world now responds. Move forward only.'
    : '';

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

  // Return two-block array for Anthropic prompt caching.
  // Block 1 = all static lore (~7400 tokens), cached at 1/10 price after first request.
  // Block 2 = per-character dynamic data (~370 tokens), never cached (changes every turn).
  return [
    {
      type: 'text',
      text: `text: `You are the Game Master of a text-based RPG set in Westeros, 250 AC, during the reign of Aegon V Targaryen — the Unlikely.

WORLD STATE — 250 AC:
Aegon V is a reformist king who grew up as a hedge knight's squire. He has spent his reign trying to break the power of the great lords and raise the smallfolk. Lords resent him. His Small Council is fractious. His children defy him. The realm is stable on the surface and rotting underneath.
Dragons are extinct — dead for 150 years. Aegon V is secretly attempting to hatch new ones at Summerhall, his royal pleasure castle. Every attempt fails. He never succeeds. He never will. No player action changes this.
Dorne joined the realm only 36 years ago (214 AC). Old resentments persist. The Blackfyre pretenders still scheme from exile — their army, the Golden Company, operates out of Essos.
The Free Cities — Braavos, Pentos, Myr, Lys, Tyrosh, Norvos, Qohor, Volantis — are reachable by sea. Travel between Westeros and Essos takes a full season.

WRITING VOICE:
Write in a grounded medieval voice — direct, specific, unsentimental. Name the stone, the smell, the exact words spoken. No modern idiom. No purple prose. Short sentences carry more weight than long ones. Dialogue in quotes. Actions in plain past tense. 2-4 paragraphs per scene. The narrative picks up exactly where the last scene ended — no re-establishing the room, no re-introducing characters already present.

THE ACTION IS AN INTENT — NOT A FACT:
The player's message is what their character is about to do. You resolve it. You decide if it succeeds, partially succeeds, or fails based on stats, circumstances, and dice. Never treat the action text as something that already happened. "Ask her about the letter" means the character is about to ask — write what happens when they do.

CHARACTERS AND NPCS:
Named canon figures have fixed personalities. Aegon V: warm with smallfolk, cold with lords, obsessed with Summerhall, never shares the details with anyone. Ser Duncan the Tall: enormous, formal, honourable, loyal to Aegon above all. Maester Aemon: at Castle Black, refuses family politics. Tywin Lannister: ~8 years old, silent, watchful. Aerys Targaryen: ~6 years old, charming child, no sign yet of what he will become.
Not yet born: Eddard Stark, Robert Baratheon, Jaime Lannister, Cersei Lannister, Rhaegar Targaryen, Jon Snow, Daenerys Targaryen.
Always use NPCs' FULL NAMES — never first name alone, especially if two NPCs share a first name. Check NPC RELATIONSHIPS before resolving any action involving "her", "him", or a first name to confirm who is actually present.

SOCIAL RULES:
High-status NPCs (lords, maesters, senior knights) correct errors directly. Mid-status NPCs (merchants, lesser knights) deflect, hesitate, change subject. Low-status NPCs (servants, smallfolk) agree, nod, say nothing — but show discomfort in their body. The silence is not agreement.
The player character is not chosen or special. The world does not arrange itself for their benefit. NPCs do not gift them titles or powers without story-driven reason.

STATS AND OUTCOMES:
Martial 1-10, Diplomacy 1-10, Intrigue 1-10, Stewardship 1-10, Learning 1-10. Scale: 2=poor, 4=competent, 6=exceptional, 8=best in the realm.
For uncertain outcomes, roll dice and report result in the status block's rolls field. Success/failure must be consistent with the character's relevant stat.
Traits are mechanical constraints: Wrathful = anger checks required. Brave = cannot easily flee. Craven = -2 combat. Deceitful = intrigue options available.

CONTINUITY:
Once a scene has been played, it is closed. Do not replay it, re-describe it, or return to it. The STORY SO FAR is the authoritative record — treat it as ground truth and continue from the last entry. If the player's action is vague or meta, pick the most plausible interpretation and advance the story. Never stall. Never loop.

CHOICES:
Offer 3-4 choices per scene. Each must be a genuinely different path. Write them in imperative or present-intent form — "Ask her about the letter" not "He asked about the letter." Choices are what the player is about to do, not what has already happened.

CONSEQUENCES:
Death is real. Permanent injuries stay permanent. Burned bridges stay burned. Not every consequence arrives immediately — insult a lord today, face coldness two scenes later. Gold matters: feasts, bribes, gifts all cost money. Use goldChange in status whenever money changes hands.

CONTENT:
Adult themes are part of this world. Violence and sexual coercion exist and are not sanitised — but the camera cuts at the act itself. No graphic sexual description. No sexual content involving anyone under 18. Consensual intimacy between adults: acknowledge it, fade to black. A villain's depravity is shown through behaviour and aftermath, not explicit description.

SUMMERHALL — ABSOLUTE:
Aegon V's experiments always fail. No egg hatches. No dragon lives. No player action, clever argument, or narrative contrivance changes this. A player who witnesses an attempt sees failure — smoke, cold stone, an old man's exhaustion. Nothing else.

STATUS FIELDS — include all that changed this scene, omit unchanged ones (except health, location, season, summary which are always required):
health: Hale | Wounded | Grievously Wounded | Dead
location: canonical location id
isDead: boolean
season: current season string
summary: one sentence — what happened and what it means
goldChange: integer (positive=gain, negative=spend)
incomeChange: integer (permanent income change)
landGained / landLost: string
newDebt: {creditor, amount, reason} or null
debtRepaid: creditor name string
rolls: [{"stat":"Martial","rolls":[4,2],"bonus":2,"difficulty":12,"result":"brief outcome"}]
npcUpdates: [{"npc":"Full Name","memory":"specific new thing that happened","disposition":0,"relationship":"friend"}]
conditionGained: {"id":"autumn_fever","label":"Autumn Fever","type":"illness","severity":2,"note":"..."}
conditionChanged: {"id":"autumn_fever","severityDelta":-1,"note":"..."}
conditionResolved: "condition_id"
reputationEvent: {"label":"what happened","score":2,"region":"The Crownlands","type":"honour"}
statGrowth: {"stat":"martial","amount":1,"reason":"..."}
worldEvent: {"title":"Short title","description":"What happened offstage"}
pendingNpcEvent: {"npc":"Full Name","pendingEvent":"event_type","resolvesAfter":6,"data":{"note":"..."}}

CONDITION IDs:
illness: autumn_fever, consumption, grey_plague, flux, pox, shivers, wound_fever, childbed_fever, infected_wound, milk_of_poppy_sickness
injury: broken_arm, broken_leg, lost_eye, lost_hand, battle_wound, deep_wound, scarred_face, burn_wounds, arrow_wound
pregnancy: with_child_early, with_child_late, recovering_childbirth (female characters of childbearing age only)
mental: grief_stricken, broken_spirit, haunted, melancholy, manic
addiction: milk_of_poppy, strongwine
supernatural: dragon_dreams, greensight, prophetic_dreams, shadow_touched, fire_resistant
social: bastard_born, scandal_known, betrothal_broken, blood_debt_owed, exiled, disinherited, imprisoned, hostage

Conditions are persistent — they affect the narrative every scene until resolved. Severity 4 illnesses are life-threatening. Permanent injuries (lost_eye, lost_hand, scarred_face) are never resolved without explicit story reason. Pregnancy progresses over seasons. Growth is rare — only for genuinely exceptional moments, not routine actions.

RESPONSE FORMAT — exactly three XML blocks, nothing outside them:
<narrative>2-4 paragraphs. Plain prose only. No JSON, no XML tags inside here.</narrative>
<choices>["Imperative choice one","Imperative choice two","Imperative choice three"]</choices>
<status>{"health":"...","location":"...","isDead":false,"season":"...","summary":"...","goldChange":0,"incomeChange":0,"landGained":"","landLost":"","newDebt":null,"debtRepaid":"","rolls":[],"npcUpdates":[]}</status>

Add any optional fields (conditionGained, reputationEvent, etc.) to the status JSON only when they apply. Never put JSON objects in the narrative block.
`      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: `
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
${financeBlock}${situationLine}${histBlock}
${memBlock}${repBlock}${guestBlock}
${ageGuard}

ON CHARACTER DEATH:
<narrative>Death scene. Specific. Consequential. Honest.</narrative>
<choices>[]</choices>
<status>{"health":"Dead","location":"...","isDead":true,"season":"...","summary":"How ${c.name} died and what it meant.","goldChange":0,"incomeChange":0,"landGained":"","landLost":"","newDebt":null,"debtRepaid":""}</status>`,
    },
  ];
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
  // Extract the three XML blocks
  const nRaw = text.match(/<narrative>([\s\S]*?)<\/narrative>/)?.[1]?.trim() || text;
  const cRaw = text.match(/<choices>([\s\S]*?)<\/choices>/)?.[1]?.trim() || '[]';
  const sRaw = text.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim() || '{}';

  // Clean narrative — strip any XML bleed and any stray JSON objects
  // (old prompt put JSON inline; new prompt puts everything in status)
  let narrative = nRaw
    .replace(/<status>[\s\S]*?<\/status>/gi, '')
    .replace(/<choices>[\s\S]*?<\/choices>/gi, '')
    .replace(/<\/?narrative>/gi, '')
    .replace(/<\/?choices>/gi, '')
    .replace(/<\/?status>/gi, '')
    .trim();

  // Also strip any inline JSON objects that leaked from old-style responses
  const spans = extractJsonSpans(narrative);
  const toRemove = [];
  for (const span of spans) {
    try {
      const o = JSON.parse(span.str);
      // Only remove objects that look like our tags — not narrative content
      if (o.npc || o.stat || o.worldEvent || o.statGrowth || o.conditionGained ||
          o.conditionChanged || o.conditionResolved || o.reputationEvent || o.pendingNpcEvent) {
        toRemove.push(span);
      }
    } catch {}
  }
  toRemove.sort((a, b) => b.start - a.start);
  for (const r of toRemove) narrative = narrative.slice(0, r.start) + narrative.slice(r.end);
  narrative = narrative.trim();

  // Parse choices
  let choices = [];
  try { choices = JSON.parse(cRaw); } catch {}
  choices = (Array.isArray(choices) ? choices : [])
    .filter(c => typeof c === 'string')
    .slice(0, 4)
    .map(c => c.substring(0, 120));

  // Parse status — all structured data lives here in the new prompt
  let status = {};
  try { status = JSON.parse(sRaw); } catch {}

  // Pull structured fields from status (new style) with fallback to inline (old style)
  const rolls = Array.isArray(status.rolls) ? status.rolls : [];
  const worldEvent = status.worldEvent || null;

  // npcUpdates — new name for what was "memories" (inline npc tags)
  const memories = Array.isArray(status.npcUpdates)
    ? status.npcUpdates.map(u => ({ npc: u.npc, memory: u.memory, disposition: u.disposition || 0, relationship: u.relationship || 'acquaintance', season: status.season || '' }))
    : [];

  // Growth — single object or array
  const growthEvents = status.statGrowth
    ? (Array.isArray(status.statGrowth) ? status.statGrowth : [status.statGrowth])
    : [];

  // Conditions — single objects in status
  const conditionsGained   = status.conditionGained   ? [status.conditionGained]   : [];
  const conditionChanged   = status.conditionChanged   ? [status.conditionChanged]  : [];
  const conditionsResolved = status.conditionResolved  ? [status.conditionResolved] : [];

  // Reputation
  const reputationEvents = status.reputationEvent
    ? [status.reputationEvent]
    : [];

  // Pending NPC events
  const pendingNpcEvents = status.pendingNpcEvent
    ? [status.pendingNpcEvent]
    : [];

  return { narrative, choices, status, memories, rolls, worldEvent, growthEvents,
           conditionsGained, conditionChanged, conditionsResolved, reputationEvents, pendingNpcEvents };
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

// Columns that exist in the base schema — always safe to write
const BASE_CHAR_COLUMNS = new Set([
  'name','age','gender','nickname','house_key','house_full','region','relation',
  'appear','backstory','personality','stats','traits','health','location','season',
  'dead','death_narrative','death_summary','gold','msgs','hist','npcs','events',
  'income_per_turn','lands','debts','growth','conditions','updated_at',
  // Extended columns — added via migration
  'reputation','turn_count','pending_npc_events',
]);

async function updateCharacter(id, fields, env, retries = 3) {
  // Strip any keys not in the known column list to prevent 400s from unknown columns
  const safeFields = Object.fromEntries(
    Object.entries(fields).filter(([k]) => BASE_CHAR_COLUMNS.has(k))
  );
  const body = JSON.stringify({ ...safeFields, updated_at: new Date().toISOString() });
  const url  = `${env.SUPABASE_URL}/rest/v1/characters?id=eq.${encodeURIComponent(id)}`;
  const hdrs = {
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal',
  };
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { method: 'PATCH', headers: hdrs, body });
      if (res.ok) return res;
      // 4xx = bad request, no point retrying
      if (res.status >= 400 && res.status < 500) {
        const err = await res.text().catch(() => res.status);
        throw new Error(`DB error ${res.status}: ${err}`);
      }
      // 5xx — wait and retry
      if (attempt < retries - 1) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    } catch (e) {
      if (attempt === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw new Error('updateCharacter: all retries exhausted');
}

// ══════════════════════════════════════════════════════════════
// SAVE CHAR — retry endpoint for failed saves
// ══════════════════════════════════════════════════════════════
async function handleSaveChar(body, env) {
  const { characterId, fields, userToken, debugKey } = body;
  if (!characterId || !fields) return json({ error: 'Missing fields' }, 400);

  // Two paths:
  // A) Normal save retry — user token only, restricted to fields /act would write
  // B) Debug write — requires ADMIN_KEY, can write any allowed field including
  //    gold/stats/conditions injected via the stress-test panel
  const isDebugWrite = !!debugKey;
  if (isDebugWrite && debugKey !== env.ADMIN_KEY) {
    return json({ error: 'Unauthorized.' }, 403);
  }

  // Verify user owns this character via their session token
  const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${userToken}` }
  }).catch(() => null);
  if (!userRes?.ok) return json({ error: 'Unauthorized' }, 401);
  const user = await userRes.json();
  const charRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/characters?id=eq.${encodeURIComponent(characterId)}&select=user_id`,
    { headers: { 'apikey': env.SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
  );
  const chars = await charRes.json();
  if (!chars?.[0] || chars[0].user_id !== user.id) return json({ error: 'Forbidden' }, 403);

  // Field whitelists — normal retries get a tighter set than debug writes
  const RETRY_FIELDS = new Set([
    'health','gold','income_per_turn','lands','debts','location','season',
    'dead','npcs','events','stats','growth','conditions','reputation','hist','msgs',
    'turn_count','pending_npc_events',
  ]);
  const DEBUG_FIELDS = new Set([
    'health','gold','income_per_turn','lands','debts','location','season',
    'dead','npcs','events','stats','growth','conditions','reputation','hist','msgs',
    'turn_count','pending_npc_events',
  ]);
  const allowed = isDebugWrite ? DEBUG_FIELDS : RETRY_FIELDS;
  const safeFields = Object.fromEntries(
    Object.entries(fields).filter(([k]) => allowed.has(k))
  );
  if (!Object.keys(safeFields).length) return json({ error: 'No valid fields' }, 400);

  try {
    await updateCharacter(characterId, safeFields, env);
    return json({ ok: true });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
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
  try {
  const activeDesc = stats.activeList.length
    ? stats.activeList.map(c => `${c.name} of ${c.house} (${c.location}, ${c.health})`).join(', ')
    : 'No known movements in the past half-hour.';

  const adminController = new AbortController();
  const adminTimeout = setTimeout(() => adminController.abort(), 15000); // 15s max for admin summary
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    signal: adminController.signal,
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 350,
      messages: [{ role: 'user', content:
        `You are Grand Maester Pycelle writing a private intelligence report for the small council of King Aegon V Targaryen. The year is 250 AC. The king is reformist and his lords are restless.\n\nBased on this intelligence, write one flowing paragraph (5-7 sentences) on the state of the realm. Be specific. Name names. Be slightly ominous.\n\nINTELLIGENCE:\n- ${stats.aliveChars} notable persons active (${stats.deadChars} deceased)\n- Active in last 30 minutes: ${stats.activeNow}\n- Known movements: ${activeDesc}\n- By location: ${JSON.stringify(stats.byLocation)}\n- Recent events: ${stats.recentEvents.join(' | ')}\n\nWrite only the paragraph.`
      }],
    }),
  });
    clearTimeout(adminTimeout);
    const data = await res.json();
    return data.content?.[0]?.text || 'The ravens have gone quiet. Something is wrong.';
  } catch (e) {
    return 'The ravens have gone quiet. Something is wrong.';
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
