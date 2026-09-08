export const CURRENT_PLAYER_STATUS_NOT_VERIFIED = 'Current NFL status not verified';

export const CURRENT_PLAYER_ELIGIBILITY_STATES = Object.freeze([
  'active',
  'inactive',
  'practice_squad',
  'IR',
  'PUP',
  'suspended',
  'UFA',
  'cut',
  'retired',
  'unknown'
]);

export const CURRENT_PLAYER_SOURCE_PRIORITY = Object.freeze({
  official: 3,
  espn: 2,
  sleeper: 1,
  explicit: 0
});

const ACTIVE_TEAM_REQUIRED = new Set(['espn', 'sleeper', 'explicit']);

/**
 * Resolve one player from already-fetched, structured status evidence. Missing
 * evidence is not interpreted as a roster transaction or retirement.
 */
export function resolveCurrentPlayerEligibility(player, evidence = {}) {
  const observations = [
    ...normalizeEvidence(evidence),
    ...directEligibilityObservations(player)
  ];
  return resolveObservations(observations, { legacyWhenEmpty: true });
}

/**
 * Create one ID-indexed resolver for reuse across players and fantasy leagues.
 * It performs no I/O. Callers may feed a shared provider response once, then
 * resolve every league locally without name matching or repeated lookups.
 */
export function createCurrentPlayerEligibilityResolver(evidence = {}) {
  const observations = normalizeEvidence(evidence);
  const index = buildObservationIndex(observations);
  const cache = new Map();

  const resolve = (player) => {
    const ids = durablePlayerIds(player);
    const direct = directEligibilityObservations(player);

    if (!direct.length) {
      for (const id of ids) {
        const saved = cache.get(id);
        if (saved) return saved;
      }
    }

    const matches = uniqueObservations([
      ...direct,
      ...ids.flatMap((id) => index.get(id) || [])
    ]);
    const result = resolveObservations(matches, { legacyWhenEmpty: true });
    const aliases = new Set([
      ...ids,
      ...matches.flatMap((observation) => observation.playerIds)
    ]);
    for (const id of aliases) cache.set(id, result);
    return result;
  };

  return Object.freeze({
    resolve,
    resolveAll(players = []) {
      return (Array.isArray(players) ? players : []).map((player) => ({
        player,
        eligibility: resolve(player)
      }));
    },
    clearCache() { cache.clear(); },
    get cacheSize() { return cache.size; },
    get indexSize() { return index.size; }
  });
}

/**
 * Compatibility gate for analytics consumers. Old fixtures without any
 * eligibility metadata continue through unchanged; once metadata is explicit,
 * only a verified `active` result is recommendation-eligible.
 */
export function isCurrentPlayerRecommendationEligible(value, evidence) {
  if (isResolvedEligibility(value)) return value.recommendationEligible === true;
  return resolveCurrentPlayerEligibility(value, evidence).recommendationEligible;
}

export const isRecommendationEligible = isCurrentPlayerRecommendationEligible;

/** Return every durable provider ID carried by a normalized player/evidence row. */
export function durablePlayerIds(value, sourceHint = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const ids = new Set();
  addId(ids, value.playerId ?? value.player_id, sourceHint);
  addId(ids, value.id, sourceHint);
  addId(ids, value.platformPlayerId ?? value.platform_player_id, value.platform ?? sourceHint);
  addId(ids, value.espnPlayerId ?? value.espn_player_id ?? value.espnId, 'espn');
  addId(ids, value.sleeperPlayerId ?? value.sleeper_player_id ?? value.sleeperId, 'sleeper');
  addId(ids, value.gsisId ?? value.gsis_id ?? value.nflId ?? value.nfl_id, 'gsis');
  for (const [provider, id] of Object.entries(value.externalIds ?? value.external_ids ?? {})) addId(ids, id, provider);
  return [...ids].sort();
}

function normalizeEvidence(input) {
  if (Array.isArray(input)) return input.flatMap((value) => normalizeObservation(value));
  if (!input || typeof input !== 'object') return [];
  const grouped = [
    ['official', input.official],
    ['espn', input.espn],
    ['sleeper', input.sleeper],
    [null, input.observations ?? input.records ?? input.evidence]
  ];
  const values = grouped.flatMap(([source, group]) => evidenceValues(group)
    .flatMap((value) => normalizeObservation(value, source)));
  if (values.length) return values;
  return normalizeObservation(input);
}

function evidenceValues(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  if (looksLikeObservation(value)) return [value];
  return Object.entries(value).map(([id, item]) => item && typeof item === 'object'
    ? { ...item, playerId: item.playerId ?? item.player_id ?? id }
    : { playerId: id, state: item });
}

function directEligibilityObservations(player) {
  if (!player || typeof player !== 'object' || Array.isArray(player)) return [];
  const raw = player.currentPlayerEligibility
    ?? player.current_player_eligibility
    ?? player.nflEligibility
    ?? player.nfl_eligibility
    ?? player.eligibility;
  if (raw == null) {
    const explicitState = player.currentNflStatus ?? player.current_nfl_status
      ?? player.nflRosterStatus ?? player.nfl_roster_status
      ?? player.eligibilityState ?? player.eligibility_state;
    if (explicitState == null) return [];
    return normalizeObservation({ ...player, state: explicitState }, sourceClass(player) || 'explicit');
  }
  const observation = typeof raw === 'string' ? { state: raw } : raw;
  if (!observation || typeof observation !== 'object') return [];
  return normalizeObservation({
    ...observation,
    playerId: observation.playerId ?? observation.player_id ?? player.playerId ?? player.player_id ?? player.id,
    platform: observation.platform ?? player.platform,
    platformPlayerId: observation.platformPlayerId ?? observation.platform_player_id ?? player.platformPlayerId ?? player.platform_player_id,
    externalIds: observation.externalIds ?? observation.external_ids ?? player.externalIds ?? player.external_ids,
    team: observation.team ?? player.team,
    nflTeam: observation.nflTeam ?? observation.nfl_team ?? player.nflTeam ?? player.nfl_team,
    nflTeamId: observation.nflTeamId ?? observation.nfl_team_id ?? player.nflTeamId ?? player.nfl_team_id
  }, sourceClass(observation) || sourceClass(player) || 'explicit');
}

function normalizeObservation(raw, defaultSource = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const explicit = explicitStateValue(raw);
  const state = normalizeState(explicit.value, raw.active, explicit.present);
  if (state == null) return [];
  const source = sourceClass(raw, defaultSource) || 'explicit';
  const playerIds = durablePlayerIds(raw, source === 'espn' || source === 'sleeper' ? source : null);
  if (!playerIds.length) return [];
  return [{
    state,
    source,
    priority: CURRENT_PLAYER_SOURCE_PRIORITY[source] ?? CURRENT_PLAYER_SOURCE_PRIORITY.explicit,
    observedAt: timestamp(raw),
    stale: raw.stale === true,
    team: teamIdentity(raw),
    playerIds,
    rawState: explicit.value == null && typeof raw.active === 'boolean' ? String(raw.active) : String(explicit.value ?? '')
  }];
}

function resolveObservations(observations, { legacyWhenEmpty }) {
  const candidates = uniqueObservations(observations);
  if (!candidates.length) return legacyWhenEmpty ? legacyResult() : unknownResult(null, 'no_evidence');

  const highestPriority = Math.max(...candidates.map((item) => item.priority));
  let selected = candidates.filter((item) => item.priority === highestPriority);
  const dated = selected.filter((item) => item.observedAt).sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  if (dated.length) selected = selected.filter((item) => item.observedAt === dated[0].observedAt);
  const states = new Set(selected.map((item) => item.state));
  if (states.size !== 1) return unknownResult(selected[0], 'conflicting_equal_authority');

  const winner = selected[0];
  if (winner.state === 'active') {
    if (winner.stale) return unknownResult(winner, 'stale_active_evidence');
    if (ACTIVE_TEAM_REQUIRED.has(winner.source) && !winner.team) {
      return unknownResult(winner, 'active_team_not_verified');
    }
  }
  if (winner.state === 'unknown') return unknownResult(winner, 'explicit_unknown');
  return resultFor(winner);
}

function resultFor(observation) {
  const eligible = observation.state === 'active';
  return Object.freeze({
    state: observation.state,
    recommendationEligible: eligible,
    message: eligible ? null : statusMessage(observation.state),
    source: observation.source,
    observedAt: observation.observedAt,
    stale: observation.stale,
    team: observation.team,
    reasonCode: eligible ? 'verified_active' : `current_status_${observation.state.toLowerCase()}`,
    legacyCompatibility: false,
    playerIds: Object.freeze([...observation.playerIds])
  });
}

function unknownResult(observation, reasonCode) {
  return Object.freeze({
    state: 'unknown',
    recommendationEligible: false,
    message: CURRENT_PLAYER_STATUS_NOT_VERIFIED,
    source: observation?.source ?? null,
    observedAt: observation?.observedAt ?? null,
    stale: observation?.stale === true,
    team: observation?.team ?? null,
    reasonCode,
    legacyCompatibility: false,
    playerIds: Object.freeze([...(observation?.playerIds || [])])
  });
}

function legacyResult() {
  return Object.freeze({
    state: null,
    recommendationEligible: true,
    message: null,
    source: null,
    observedAt: null,
    stale: false,
    team: null,
    reasonCode: 'legacy_metadata_absent',
    legacyCompatibility: true,
    playerIds: Object.freeze([])
  });
}

function buildObservationIndex(observations) {
  const index = new Map();
  for (const observation of observations) {
    for (const id of observation.playerIds) {
      if (!index.has(id)) index.set(id, []);
      index.get(id).push(observation);
    }
  }
  return index;
}

function uniqueObservations(values) {
  const unique = new Map();
  for (const observation of values) {
    if (!observation) continue;
    const key = [observation.source, observation.state, observation.observedAt, observation.stale,
      observation.team, observation.playerIds.join('|')].join('::');
    unique.set(key, observation);
  }
  return [...unique.values()];
}

function explicitStateValue(raw) {
  for (const key of ['state', 'eligibilityState', 'eligibility_state', 'currentNflStatus', 'current_nfl_status',
    'nflRosterStatus', 'nfl_roster_status', 'rosterStatus', 'roster_status', 'status']) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) return { present: true, value: raw[key] };
  }
  return { present: false, value: null };
}

function normalizeState(value, active, stateWasPresent) {
  if (!stateWasPresent && typeof active === 'boolean') return active ? 'active' : 'unknown';
  if (!stateWasPresent) return null;
  const token = normalizeToken(value);
  if (!token) return 'unknown';
  if (['ACTIVE', 'ACTIVE_ROSTER', 'ROSTERED', 'SIGNED'].includes(token)) return 'active';
  if (['INACTIVE', 'INA'].includes(token)) return 'inactive';
  if (['PRACTICE_SQUAD', 'PRACTICE_SQUAD_INJURED', 'PS'].includes(token)) return 'practice_squad';
  if (['IR', 'INJURED_RESERVE', 'RESERVE_INJURED', 'INJURY_RESERVE'].includes(token)) return 'IR';
  if (['PUP', 'RESERVE_PUP', 'PHYSICALLY_UNABLE_TO_PERFORM'].includes(token)) return 'PUP';
  if (['SUSPENDED', 'SUSP', 'RESERVE_SUSPENDED'].includes(token)) return 'suspended';
  if (['UFA', 'UNRESTRICTED_FREE_AGENT', 'FREE_AGENT', 'UNSIGNED'].includes(token)) return 'UFA';
  if (['CUT', 'RELEASED', 'WAIVED', 'TERMINATED'].includes(token)) return 'cut';
  if (['RETIRED', 'RET'].includes(token)) return 'retired';
  return 'unknown';
}

function sourceClass(value, fallback = null) {
  const trust = normalizeToken(value?.trust ?? value?.trustLevel ?? value?.trust_level);
  const raw = normalizeToken(value?.authority ?? value?.provider ?? value?.source ?? value?.sourceType ?? value?.source_type ?? fallback);
  if (trust.startsWith('OFFICIAL_') || raw.includes('OFFICIAL') || raw === 'NFL' || raw.startsWith('TEAM_')) return 'official';
  if (raw.includes('ESPN')) return 'espn';
  if (raw.includes('SLEEPER')) return 'sleeper';
  if (raw === 'EXPLICIT') return 'explicit';
  return null;
}

function timestamp(value) {
  for (const raw of [value.observedAt, value.observed_at, value.statusUpdatedAt, value.status_updated_at,
    value.updatedAt, value.updated_at, value.retrievedAt, value.retrieved_at]) {
    const time = Date.parse(raw);
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  return null;
}

function teamIdentity(value) {
  const team = value.team && typeof value.team === 'object' ? value.team : null;
  const raw = value.nflTeamId ?? value.nfl_team_id ?? team?.id
    ?? value.nflTeam ?? value.nfl_team ?? team?.abbreviation ?? team?.name;
  if (raw == null || String(raw).trim() === '' || String(raw).trim() === '0') return null;
  return String(raw).trim().toUpperCase();
}

function addId(target, value, providerHint) {
  if (value == null || String(value).trim() === '') return;
  const raw = String(value).trim();
  const matched = /^([a-z][a-z0-9_-]{1,31}):([^\s].*)$/i.exec(raw);
  if (matched) {
    target.add(`${matched[1].toLowerCase()}:${matched[2]}`);
    return;
  }
  const provider = String(providerHint || '').trim().toLowerCase();
  if (provider && /^[a-z][a-z0-9_-]{1,31}$/.test(provider)) target.add(`${provider}:${raw}`);
}

function statusMessage(state) {
  return ({
    inactive: 'Inactive — not recommendation eligible',
    practice_squad: 'Practice squad — not recommendation eligible',
    IR: 'Injured reserve — not recommendation eligible',
    PUP: 'PUP — not recommendation eligible',
    suspended: 'Suspended — not recommendation eligible',
    UFA: 'Unsigned free agent — not recommendation eligible',
    cut: 'Released — not recommendation eligible',
    retired: 'Retired — not recommendation eligible'
  })[state] || CURRENT_PLAYER_STATUS_NOT_VERIFIED;
}

function looksLikeObservation(value) {
  return ['state', 'status', 'active', 'eligibilityState', 'eligibility_state', 'currentNflStatus',
    'current_nfl_status', 'nflRosterStatus', 'nfl_roster_status'].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isResolvedEligibility(value) {
  return value && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, 'recommendationEligible')
    && (CURRENT_PLAYER_ELIGIBILITY_STATES.includes(value.state) || value.state == null);
}

function normalizeToken(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}
