import { readNewsChangeState, saveNewsChangeState } from './storage.js';

export const NEWS_CHANGE_STATE_VERSION = 1;
export const NEWS_MATERIALITY = Object.freeze(['none', 'minor', 'meaningful', 'critical']);
export const NEWS_CHANGE_RULES = Object.freeze({
  unavailable_statuses: Object.freeze(['out', 'inactive', 'ir', 'suspended']),
  critical_game_statuses: Object.freeze(['postponed', 'cancelled']),
  practice_transition_materiality: Object.freeze({
    'full>limited': 'minor',
    'full>did_not_practice': 'meaningful',
    'limited>full': 'meaningful',
    'limited>did_not_practice': 'meaningful',
    'did_not_practice>full': 'meaningful',
    'did_not_practice>limited': 'meaningful'
  }),
  close_to_kickoff_hours: 2,
  reanalysis_materiality: Object.freeze(['meaningful', 'critical'])
});

const SOURCES = new Map([
  ['espn nfl injury', 'espn-nfl-injury'], ['espn nfl injury report', 'espn-nfl-injury'], ['espn-nfl-injury', 'espn-nfl-injury'],
  ['espn fantasy', 'espn-fantasy'], ['espn-fantasy', 'espn-fantasy'],
  ['sleeper', 'sleeper'],
  ['espn nfl scoreboard', 'espn-nfl-scoreboard'], ['espn-nfl-scoreboard', 'espn-nfl-scoreboard'],
  ['existing context', 'existing-context'], ['existing-context', 'existing-context']
]);
const MATERIALITY_RANK = Object.freeze({ none: 0, minor: 1, meaningful: 2, critical: 3 });
const AVAILABILITY_CLASS = Object.freeze({ healthy: 0, questionable: 1, doubtful: 2, out: 3, inactive: 3, ir: 3, suspended: 3 });

/** Convert the project's existing normalized ESPN injury row into a minimal observation. */
export function newsObservationFromEspnInjury(injury, {
  season,
  week,
  gameId = null,
  kickoffAt = null,
  playerId = null,
  affectedPlayerIds = []
} = {}) {
  const espnId = textOrNull(injury?.playerId);
  return {
    season,
    week,
    gameId,
    kickoffAt,
    playerId: playerId || (espnId ? `espn:${espnId}` : null),
    teamId: injury?.team?.id || injury?.team?.abbreviation || null,
    displayName: injury?.name || null,
    source: 'espn-nfl-injury',
    sourceAvailable: injury != null && injury.stale !== true,
    availabilityStatus: injury?.status
      || injury?.designation?.description
      || injury?.designation?.abbreviation
      || injury?.injury?.fantasyStatus?.description
      || injury?.injury?.fantasyStatus?.abbreviation,
    practiceStatus: injury?.injury?.practiceStatus,
    observedAt: injury?.updatedAt || injury?.retrievedAt,
    affectedPlayerIds
  };
}

/** Pure state transition. Only the latest normalized state is retained. */
export function updateNewsChangeState(input, observations, { analysis = null } = {}) {
  const currentState = normalizeState(input);
  const records = { ...currentState.records };
  const evaluations = [];
  let changed = false;
  let updatedAt = timestampOrNull(currentState.updated_at);

  for (const raw of Array.isArray(observations) ? observations : []) {
    if (raw?.sourceAvailable === false || raw?.source_available === false) {
      evaluations.push(unavailableEvaluation(raw));
      continue;
    }
    const incoming = normalizeObservation(raw);
    if (!incoming) {
      evaluations.push(invalidEvaluation(raw));
      continue;
    }
    const previous = records[incoming.record_id] || null;
    if (!previous) {
      records[incoming.record_id] = storedObservation(incoming);
      updatedAt = newestTimestamp(updatedAt, incoming.observed_at);
      changed = true;
      evaluations.push(evaluationResult(null, incoming, { status: 'baseline', materiality: 'none', changes: [] }, analysis));
      continue;
    }

    const previousTime = timestampOrNull(previous.last_seen_at);
    const incomingTime = timestampOrNull(incoming.observed_at);
    if (incomingTime < previousTime || (incomingTime === previousTime && !sameNormalizedState(previous, incoming))) {
      evaluations.push(evaluationResult(previous, previous, {
        status: 'ignored', materiality: 'none', changes: [], reason: 'Older or conflicting same-time observation ignored.'
      }, analysis));
      continue;
    }

    const effective = mergeMissingState(previous, incoming);
    const transition = classifyNewsMateriality(previous, effective);
    const next = storedObservation(effective, previous.first_seen_at);
    if (!sameStoredObservation(previous, next)) {
      records[incoming.record_id] = next;
      updatedAt = newestTimestamp(updatedAt, incoming.observed_at);
      changed = true;
    }
    evaluations.push(evaluationResult(previous, effective, transition, analysis));
  }

  if (!changed) return { state: currentState, changed: false, evaluations };
  return {
    state: {
      version: NEWS_CHANGE_STATE_VERSION,
      updated_at: updatedAt ? new Date(updatedAt).toISOString() : null,
      records: Object.fromEntries(Object.entries(records).sort(([left], [right]) => left.localeCompare(right)))
    },
    changed: true,
    evaluations
  };
}

/** Classify normalized state differences with explicit rules, never learned weights. */
export function classifyNewsMateriality(previous, current) {
  const changes = [
    availabilityChange(previous?.availability_status, current?.availability_status),
    practiceChange(previous?.practice_status, current?.practice_status),
    roleChange(previous?.role_status, current?.role_status),
    gameChange(previous?.game_status, current?.game_status)
  ].filter(Boolean);
  let materiality = changes.reduce((highest, change) =>
    MATERIALITY_RANK[change.materiality] > MATERIALITY_RANK[highest] ? change.materiality : highest, 'none');
  const closeEscalation = materiality === 'meaningful'
    && changes.some((change) => change.closeEscalation === true)
    && withinHoursOfKickoff(current?.observed_at, current?.kickoff_at, NEWS_CHANGE_RULES.close_to_kickoff_hours);
  if (closeEscalation) materiality = 'critical';
  return {
    status: materiality === 'none' ? 'unchanged' : 'changed',
    materiality,
    changes,
    ...(closeEscalation ? { reason: 'A meaningful availability downgrade was confirmed within two hours of kickoff.' } : {})
  };
}

/** Queue the complete read-modify-write cycle so concurrent callers cannot lose baselines. */
export function createNewsChangeEvaluatorStore({
  read = readNewsChangeState,
  write = saveNewsChangeState
} = {}) {
  let queue = Promise.resolve();
  return {
    evaluate(observations, options = {}) {
      const job = queue.then(async () => {
        const update = updateNewsChangeState(await read(), observations, options);
        if (update.changed) await write(update.state);
        return { ...update, stored: update.changed };
      });
      queue = job.then(() => undefined, () => undefined);
      return job;
    }
  };
}

export const newsChangeEvaluatorStore = createNewsChangeEvaluatorStore();

/** Safe one-shot entry point. No scheduler, polling, notification, or transaction path exists. */
export async function evaluateNewsChanges(observations, {
  analysis = null,
  sourceAvailable = true,
  store = newsChangeEvaluatorStore,
  warn = console.warn
} = {}) {
  if (sourceAvailable === false) {
    return { stored: false, changed: false, evaluations: [unavailableEvaluation(null)] };
  }
  try {
    return await store.evaluate(observations, { analysis });
  } catch (error) {
    const rawCode = String(error?.code || '').trim().toUpperCase();
    const code = /^[A-Z][A-Z0-9_]{0,31}$/.test(rawCode) ? rawCode : null;
    try { warn(`News-change evaluation failed${code ? ` (${code})` : ''}; previous state was left unchanged.`); } catch {}
    return { stored: false, changed: false, evaluations: [unavailableEvaluation(null)], error: 'news_change_state_unavailable' };
  }
}

function normalizeObservation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const season = positiveIntegerOrNull(raw.season);
  const week = positiveIntegerOrNull(raw.week);
  const source = normalizeSource(raw.source);
  const playerId = normalizePlayerId(raw.playerId ?? raw.player_id, source);
  const teamId = normalizeTeamId(raw.teamId ?? raw.team_id ?? raw.team?.id ?? raw.team?.abbreviation);
  const entityType = playerId ? 'player' : teamId ? 'team' : null;
  const entityId = playerId || teamId;
  const gameId = textOrNull(raw.gameId ?? raw.game_id ?? raw.nfl_game_id);
  const observedAt = isoOrNull(raw.observedAt ?? raw.observed_at ?? raw.updatedAt ?? raw.updated_at ?? raw.retrievedAt);
  const kickoffInput = raw.kickoffAt ?? raw.kickoff_at ?? raw.kickoff;
  const kickoffAt = kickoffInput == null ? null : isoOrNull(kickoffInput);
  const availabilityStatus = normalizeAvailability(raw.availabilityStatus ?? raw.availability_status ?? raw.status
    ?? raw.designation?.description ?? raw.designation?.abbreviation ?? raw.injury?.fantasyStatus?.description ?? raw.injury?.fantasyStatus?.abbreviation);
  const practiceStatus = normalizePractice(raw.practiceStatus ?? raw.practice_status ?? raw.injury?.practiceStatus);
  const roleStatus = normalizeRole(raw.roleStatus ?? raw.role_status);
  const gameStatus = normalizeGameStatus(raw.gameStatus ?? raw.game_status);
  if (!season || !week || !source || !entityType || !entityId || !observedAt
    || (kickoffInput != null && !kickoffAt)
    || ![availabilityStatus, practiceStatus, roleStatus, gameStatus].some(Boolean)) return null;
  const boundary = gameId || `week-${week}`;
  return {
    record_id: [season, week, boundary, entityType, entityId, source].map((value) => encodeURIComponent(String(value))).join('|'),
    season,
    week,
    nfl_game_id: gameId,
    entity_type: entityType,
    entity_id: entityId,
    player_id: playerId,
    team_id: teamId,
    display_name: compactText(raw.displayName ?? raw.display_name ?? raw.playerName ?? raw.name, 120),
    source,
    availability_status: availabilityStatus,
    practice_status: practiceStatus,
    role_status: roleStatus,
    game_status: gameStatus,
    kickoff_at: kickoffAt,
    observed_at: observedAt,
    affected_player_ids: compactPlayerIds(raw.affectedPlayerIds ?? raw.affected_player_ids, source)
  };
}

function storedObservation(value, firstSeenAt = null) {
  return {
    record_id: value.record_id,
    season: value.season,
    week: value.week,
    nfl_game_id: value.nfl_game_id,
    entity_type: value.entity_type,
    entity_id: value.entity_id,
    player_id: value.player_id,
    team_id: value.team_id,
    display_name: value.display_name,
    source: value.source,
    availability_status: value.availability_status,
    practice_status: value.practice_status,
    role_status: value.role_status,
    game_status: value.game_status,
    kickoff_at: value.kickoff_at,
    first_seen_at: firstSeenAt || value.observed_at,
    last_seen_at: value.observed_at
  };
}

function mergeMissingState(previous, incoming) {
  return {
    ...incoming,
    display_name: incoming.display_name || previous.display_name,
    team_id: incoming.team_id || previous.team_id,
    availability_status: incoming.availability_status || previous.availability_status,
    practice_status: incoming.practice_status || previous.practice_status,
    role_status: incoming.role_status || previous.role_status,
    game_status: incoming.game_status || previous.game_status,
    kickoff_at: incoming.kickoff_at || previous.kickoff_at
  };
}

function evaluationResult(previous, current, transition, analysis) {
  const playerIds = new Set([
    ...(current?.entity_type === 'player' && current?.player_id ? [current.player_id] : []),
    ...(current?.affected_player_ids || [])
  ]);
  const recommendationTypes = transition.materiality === 'meaningful' || transition.materiality === 'critical'
    ? affectedRecommendationTypes(analysis, playerIds, transition.changes)
    : [];
  const requiresReanalysis = NEWS_CHANGE_RULES.reanalysis_materiality.includes(transition.materiality) && recommendationTypes.length > 0;
  return {
    status: transition.status,
    entity: current ? {
      type: current.entity_type,
      id: current.entity_id,
      player_id: current.player_id,
      team_id: current.team_id,
      name: current.display_name
    } : null,
    season: current?.season ?? null,
    week: current?.week ?? null,
    nfl_game_id: current?.nfl_game_id ?? null,
    previous_state: previous ? publicState(previous) : null,
    current_state: current ? publicState(current) : null,
    change_types: transition.changes.map((change) => change.type),
    materiality: transition.materiality,
    affected_recommendation_types: recommendationTypes,
    requires_reanalysis: requiresReanalysis,
    reason: reasonFor(previous, current, transition, recommendationTypes, requiresReanalysis)
  };
}

function affectedRecommendationTypes(analysisInput, playerIds, changes) {
  if (!playerIds.size) return [];
  const types = new Set();
  for (const analysis of (Array.isArray(analysisInput) ? analysisInput : [analysisInput]).filter(Boolean)) {
    for (const assignment of [...(analysis?.lineup?.current?.assignments || []), ...(analysis?.lineup?.recommended?.assignments || [])]) {
      if (playerIds.has(String(assignment?.playerId))) types.add('lineup_confidence');
    }
    for (const recommendation of analysis?.lineup?.recommendations || []) {
      const ids = [recommendation?.start?.playerId, recommendation?.sit?.playerId, ...(recommendation?.lineupMoves || []).map((move) => move?.playerId)].filter(Boolean).map(String);
      if (ids.some((id) => playerIds.has(id))) types.add('start_sit');
    }
    for (const recommendation of analysis?.waivers?.recommendations || []) {
      if ([recommendation?.add?.playerId, recommendation?.drop?.playerId].filter(Boolean).map(String).some((id) => playerIds.has(id))) types.add('waiver_priority');
    }
    if ((analysis?.projections || []).some((projection) => playerIds.has(String(projection?.playerId)))
      && changes.some((change) => change.type === 'availability' || change.type === 'practice')) types.add('player_availability');
  }
  return [...types].sort();
}

function reasonFor(previous, current, transition, recommendationTypes, requiresReanalysis) {
  if (transition.reason) return requiresReanalysis
    ? `${transition.reason} Current ${recommendationTypes.join(', ')} recommendation requires reanalysis.`
    : transition.reason;
  if (transition.status === 'baseline') return 'First observation stored as the weekly baseline; no change classified.';
  if (!transition.changes.length || transition.materiality === 'none') return 'No practical status change was detected.';
  const name = current?.display_name || 'The tracked player or team';
  const detail = transition.changes.map((change) => change.reason).join(' ');
  return requiresReanalysis
    ? `${name}: ${detail} Current ${recommendationTypes.join(', ')} recommendation requires reanalysis.`
    : `${name}: ${detail}`;
}

function availabilityChange(previous, current) {
  if (!current || current === previous) return null;
  const previousClass = previous == null ? null : AVAILABILITY_CLASS[previous];
  const currentClass = AVAILABILITY_CLASS[current];
  if (previousClass === currentClass) return null;
  if (currentClass === 3) return change('availability', 'critical', `${label(previous)} → ${label(current)} availability.`);
  if (previous == null) return change('availability', current === 'healthy' ? 'minor' : 'meaningful', `New ${label(current)} availability designation.`);
  const worsening = currentClass > previousClass;
  return change('availability', 'meaningful', `${label(previous)} → ${label(current)} availability.`, worsening && current === 'doubtful');
}

function practiceChange(previous, current) {
  if (!current || current === previous) return null;
  if (previous == null) return change('practice', current === 'full' ? 'minor' : 'meaningful', `New ${label(current)} practice designation.`, current === 'did_not_practice');
  const transition = `${previous}>${current}`;
  const materiality = NEWS_CHANGE_RULES.practice_transition_materiality[transition] || 'meaningful';
  return change('practice', materiality, `${label(previous)} → ${label(current)} practice.`, current === 'did_not_practice');
}

function roleChange(previous, current) {
  if (!current || current === previous) return null;
  if (previous == null) return change('role', 'minor', `New ${label(current)} role designation.`);
  return change('role', 'meaningful', `${label(previous)} → ${label(current)} role.`);
}

function gameChange(previous, current) {
  if (!current || current === previous) return null;
  if (NEWS_CHANGE_RULES.critical_game_statuses.includes(current)) return change('game_status', 'critical', `Game status changed from ${label(previous)} to ${label(current)}.`);
  if ((previous === 'scheduled' && ['in_progress', 'final'].includes(current)) || (previous === 'in_progress' && current === 'final')) return null;
  if (current === 'delayed' || ['delayed', 'postponed'].includes(previous)) return change('game_status', 'meaningful', `Game status changed from ${label(previous)} to ${label(current)}.`);
  return change('game_status', previous == null ? 'minor' : 'meaningful', `Game status changed from ${label(previous)} to ${label(current)}.`);
}

function change(type, materiality, reason, closeEscalation = false) {
  return { type, materiality, reason, closeEscalation };
}

function normalizeAvailability(value) {
  const status = token(value);
  if (['active', 'available', 'healthy', 'full go', 'no injury designation'].includes(status)) return 'healthy';
  if (['q', 'questionable', 'day to day'].includes(status)) return 'questionable';
  if (['d', 'doubtful'].includes(status)) return 'doubtful';
  if (['o', 'out', 'ruled out', 'out for game'].includes(status)) return 'out';
  if (status === 'inactive') return 'inactive';
  if (['ir', 'injured reserve'].includes(status)) return 'ir';
  if (status === 'suspended') return 'suspended';
  return null;
}

function normalizePractice(value) {
  const status = token(value);
  if (['fp', 'full', 'full practice', 'full participation', 'full participant'].includes(status)) return 'full';
  if (['lp', 'limited', 'limited practice', 'limited participation', 'limited participant'].includes(status)) return 'limited';
  if (['dnp', 'did not practice', 'did not participate', 'no participation'].includes(status)) return 'did_not_practice';
  return null;
}

function normalizeRole(value) {
  const status = token(value);
  if (['starter', 'starting', 'promoted to starter'].includes(status)) return 'starter';
  if (['backup', 'reserve', 'demoted to backup'].includes(status)) return 'backup';
  if (['committee', 'rotation'].includes(status)) return 'committee';
  return null;
}

function normalizeGameStatus(value) {
  const status = token(value);
  if (['scheduled', 'pre'].includes(status)) return 'scheduled';
  if (['in progress', 'live', 'halftime'].includes(status)) return 'in_progress';
  if (status === 'delayed') return 'delayed';
  if (status === 'postponed') return 'postponed';
  if (['cancelled', 'canceled'].includes(status)) return 'cancelled';
  if (['final', 'complete', 'completed', 'post'].includes(status)) return 'final';
  return null;
}

function normalizeSource(value) {
  return SOURCES.get(token(value).replaceAll(' ', '-')) || SOURCES.get(token(value)) || null;
}

function normalizePlayerId(value, source) {
  const id = textOrNull(value);
  if (!id) return null;
  if (/^[a-z0-9_-]+:.+$/i.test(id)) return id;
  if (source === 'espn-nfl-injury' || source === 'espn-fantasy') return `espn:${id}`;
  if (source === 'sleeper') return `sleeper:${id}`;
  return null;
}

function normalizeTeamId(value) {
  const id = textOrNull(value);
  if (!id) return null;
  return /^[a-z0-9_-]+:.+$/i.test(id) ? id : `nfl-team:${id.toUpperCase()}`;
}

function compactPlayerIds(values, source) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => normalizePlayerId(value, source)).filter(Boolean))].slice(0, 64);
}

function sameNormalizedState(left, right) {
  return ['availability_status', 'practice_status', 'role_status', 'game_status']
    .every((field) => (left?.[field] || null) === (right?.[field] || null));
}

function sameStoredObservation(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function publicState(value) {
  return {
    source: value.source,
    availability_status: value.availability_status,
    practice_status: value.practice_status,
    role_status: value.role_status,
    game_status: value.game_status,
    observed_at: value.last_seen_at || value.observed_at
  };
}

function unavailableEvaluation(raw) {
  return {
    status: 'source_unavailable',
    entity: safeEntity(raw),
    season: positiveIntegerOrNull(raw?.season),
    week: positiveIntegerOrNull(raw?.week),
    nfl_game_id: textOrNull(raw?.gameId ?? raw?.nfl_game_id),
    previous_state: null,
    current_state: null,
    change_types: [],
    materiality: 'none',
    affected_recommendation_types: [],
    requires_reanalysis: false,
    reason: 'Source unavailable; no change was invented and previous state remains intact.'
  };
}

function invalidEvaluation(raw) {
  return {
    ...unavailableEvaluation(raw),
    status: 'invalid_observation',
    reason: 'Observation lacked safe identity, boundary, timestamp, source, or normalized status fields; previous state remains intact.'
  };
}

function safeEntity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = textOrNull(raw.playerId ?? raw.player_id ?? raw.teamId ?? raw.team_id);
  return id ? { type: raw.playerId || raw.player_id ? 'player' : 'team', id, player_id: textOrNull(raw.playerId ?? raw.player_id), team_id: textOrNull(raw.teamId ?? raw.team_id), name: compactText(raw.displayName ?? raw.name, 120) } : null;
}

function normalizeState(input) {
  if (input == null) return { version: NEWS_CHANGE_STATE_VERSION, updated_at: null, records: {} };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Number(input.version) !== NEWS_CHANGE_STATE_VERSION
    || !input.records || typeof input.records !== 'object' || Array.isArray(input.records)) {
    throw Object.assign(new Error('News-change state has an unsupported shape'), { code: 'INVALID_NEWS_CHANGE_STATE' });
  }
  return input;
}

function withinHoursOfKickoff(observedAt, kickoffAt, hours) {
  const observed = timestampOrNull(observedAt);
  const kickoff = timestampOrNull(kickoffAt);
  if (!observed || !kickoff) return false;
  const difference = kickoff - observed;
  return difference >= 0 && difference <= hours * 60 * 60 * 1000;
}

function newestTimestamp(left, right) {
  return Math.max(left || 0, timestampOrNull(right) || 0) || null;
}

function timestampOrNull(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function isoOrNull(value) {
  const time = timestampOrNull(value);
  return time == null ? null : new Date(time).toISOString();
}

function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : value != null && String(value).trim() ? String(value).trim() : null;
}

function compactText(value, limit) {
  const text = textOrNull(value)?.replace(/\s+/g, ' ') || null;
  return text && text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function token(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function label(value) {
  if (value == null) return 'Unknown';
  return String(value).replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
