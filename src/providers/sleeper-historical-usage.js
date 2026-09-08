export const SLEEPER_PLAYER_CATALOG_ENDPOINT = 'https://api.sleeper.app/v1/players/nfl';
export const SLEEPER_WEEKLY_STATS_ENDPOINT = 'https://api.sleeper.com/stats/nfl';
export const DEFAULT_SLEEPER_USAGE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RECENCY_DECAY = 0.72;

const OPPORTUNITY_FIELDS = Object.freeze([
  'snaps',
  'snapShare',
  'routes',
  'targets',
  'carries',
  'redZoneTargets',
  'redZoneCarries',
  'passAttempts'
]);

const LOG_FIELDS = Object.freeze([
  ...OPPORTUNITY_FIELDS,
  'teamOffensiveSnaps',
  'receptions',
  'rushingYards',
  'receivingYards',
  'fantasyPoints'
]);

/** Build the public Sleeper weekly-stat URL for one regular-season week. */
export function buildSleeperWeeklyStatsUrl({ season, week, seasonType = 'regular' } = {}) {
  const normalizedSeason = positiveInteger(season, 'season');
  const normalizedWeek = positiveInteger(week, 'week');
  const normalizedSeasonType = nonEmptyText(seasonType, 'seasonType');
  const query = new URLSearchParams({ season_type: normalizedSeasonType });
  return `${SLEEPER_WEEKLY_STATS_ENDPOINT}/${normalizedSeason}/${normalizedWeek}?${query}`;
}

/**
 * Create a provider with an isolated in-memory response cache. This is useful for
 * repeated league analyses because the large player catalog only needs one read.
 */
export function createSleeperHistoricalUsageProvider(defaults = {}) {
  const cache = new Map();
  return {
    fetch: (options = {}) => fetchSleeperHistoricalUsage({ ...defaults, ...options, cache }),
    clearCache: () => cache.clear(),
    get cacheSize() { return cache.size; }
  };
}

/**
 * Fetch and normalize selected players' historical weekly usage. `players` may
 * contain the normalized roster records already used by this app. Sleeper
 * players resolve from a Sleeper ID; ESPN players resolve only through the
 * catalog's `espn_id`. Names are intentionally ignored.
 */
export async function fetchSleeperHistoricalUsage({
  season,
  weeks,
  players,
  seasonType = 'regular',
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  staleAfterMs = DEFAULT_SLEEPER_USAGE_STALE_AFTER_MS,
  timeoutMs = 20_000,
  signal,
  cache = null,
  cacheTtlMs = DEFAULT_SLEEPER_USAGE_STALE_AFTER_MS,
  recencyDecay = DEFAULT_RECENCY_DECAY
} = {}) {
  const normalizedSeason = positiveInteger(season, 'season');
  const normalizedWeeks = normalizeWeeks(weeks);
  if (!Array.isArray(players)) throw new TypeError('players must be an array');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) throw new TypeError('staleAfterMs must be zero or greater');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be greater than zero');
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) throw new TypeError('cacheTtlMs must be zero or greater');

  const weeklyUrls = normalizedWeeks.map((week) => buildSleeperWeeklyStatsUrl({
    season: normalizedSeason,
    week,
    seasonType
  }));
  const urls = [SLEEPER_PLAYER_CATALOG_ENDPOINT, ...weeklyUrls];
  const responses = await Promise.all(urls.map((url) => requestJson(url, {
    fetchImpl,
    now,
    timeoutMs,
    signal,
    cache,
    cacheTtlMs
  })));
  const [catalogResponse, ...weekResponses] = responses;
  const weeklyStats = Object.fromEntries(normalizedWeeks.map((week, index) => [
    week,
    weekResponses[index].payload
  ]));
  const sources = {
    catalog: sourceRecord(SLEEPER_PLAYER_CATALOG_ENDPOINT, catalogResponse.retrievedAt, now, staleAfterMs),
    weeklyStats: Object.fromEntries(normalizedWeeks.map((week, index) => [
      week,
      sourceRecord(weeklyUrls[index], weekResponses[index].retrievedAt, now, staleAfterMs)
    ]))
  };

  return normalizeSleeperHistoricalUsage({
    season: normalizedSeason,
    weeks: normalizedWeeks,
    players,
    catalog: catalogResponse.payload,
    weeklyStats,
    sources,
    seasonType,
    recencyDecay
  });
}

/**
 * Pure normalizer for fixture tests or callers that already have Sleeper data.
 */
export function normalizeSleeperHistoricalUsage({
  season,
  weeks,
  players,
  catalog,
  weeklyStats,
  sources,
  seasonType = 'regular',
  retrievedAt = null,
  now = new Date(),
  staleAfterMs = DEFAULT_SLEEPER_USAGE_STALE_AFTER_MS,
  recencyDecay = DEFAULT_RECENCY_DECAY
} = {}) {
  const normalizedSeason = positiveInteger(season, 'season');
  const normalizedWeeks = normalizeWeeks(weeks);
  if (!Array.isArray(players)) throw new TypeError('players must be an array');
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new TypeError('catalog must be a Sleeper player-catalog object');
  }
  if (!weeklyStats || typeof weeklyStats !== 'object' || Array.isArray(weeklyStats)) {
    throw new TypeError('weeklyStats must be an object keyed by week');
  }
  validateRecencyDecay(recencyDecay);

  const normalizedSources = normalizeSources({
    sources,
    weeks: normalizedWeeks,
    season: normalizedSeason,
    seasonType,
    retrievedAt,
    now,
    staleAfterMs
  });
  const resolved = resolveSleeperPlayers(players, catalog);
  const selectedIds = new Set(resolved.players.map((player) => player.platformPlayerId));
  const rowsByWeek = new Map(normalizedWeeks.map((week) => [
    week,
    indexWeeklyRows(weeklyStats[week] ?? weeklyStats[String(week)], selectedIds)
  ]));

  const normalizedPlayers = resolved.players.map((player) => {
    const gameLogs = [];
    const missingWeeks = [];
    for (const week of normalizedWeeks) {
      const row = rowsByWeek.get(week).get(player.platformPlayerId);
      if (!row) {
        missingWeeks.push(week);
        continue;
      }
      gameLogs.push(normalizeSleeperGameLog(row, {
        season: normalizedSeason,
        week,
        source: normalizedSources.weeklyStats[week]
      }));
    }
    const summary = summarizeSleeperUsage(gameLogs, { recencyDecay });
    const missing = [...player.missing, ...missingWeeks.map((week) => `weeks.${week}.stats`)];
    if (!gameLogs.length) missing.push('gameLogs');
    for (const field of OPPORTUNITY_FIELDS) {
      if (summary.opportunity[field].sampleSize === 0) missing.push(`summary.opportunity.${field}`);
    }
    return {
      ...player,
      gameLogs,
      summary,
      requestedWeeks: normalizedWeeks,
      missingWeeks,
      source: {
        catalog: normalizedSources.catalog.url,
        weeklyStats: normalizedWeeks.map((week) => normalizedSources.weeklyStats[week].url)
      },
      retrievedAt: latestTimestamp([
        normalizedSources.catalog.retrievedAt,
        ...normalizedWeeks.map((week) => normalizedSources.weeklyStats[week].retrievedAt)
      ]),
      stale: normalizedSources.catalog.stale
        || normalizedWeeks.some((week) => normalizedSources.weeklyStats[week].stale),
      missing
    };
  });
  const allSources = [normalizedSources.catalog, ...normalizedWeeks.map((week) => normalizedSources.weeklyStats[week])];
  const missing = [];
  if (!normalizedSources.catalog.retrievedAt) missing.push('sources.catalog.retrievedAt');
  for (const week of normalizedWeeks) {
    if (!normalizedSources.weeklyStats[week].retrievedAt) missing.push(`sources.weeklyStats.${week}.retrievedAt`);
  }
  if (resolved.unresolved.length) missing.push(...resolved.unresolved.map((player) => `players.${player.requestedPlayerId}.platformPlayerId`));
  for (const player of normalizedPlayers) {
    for (const field of player.missing) missing.push(`players.${player.requestedPlayerId}.${field}`);
  }

  return {
    provider: 'sleeper',
    sport: 'football',
    league: 'nfl',
    season: normalizedSeason,
    seasonType,
    requestedWeeks: normalizedWeeks,
    players: normalizedPlayers,
    unresolvedPlayers: resolved.unresolved,
    source: {
      catalog: normalizedSources.catalog.url,
      weeklyStats: normalizedWeeks.map((week) => normalizedSources.weeklyStats[week].url)
    },
    sources: allSources,
    retrievedAt: latestTimestamp(allSources.map((item) => item.retrievedAt)),
    stale: allSources.some((item) => item.stale),
    missing,
    issues: resolved.unresolved.map((player) => ({
      code: player.reason,
      playerId: player.requestedPlayerId,
      message: player.message
    }))
  };
}

/** Resolve selected records without ever falling back to a name comparison. */
export function resolveSleeperPlayers(players, catalog) {
  if (!Array.isArray(players)) throw new TypeError('players must be an array');
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new TypeError('catalog must be a Sleeper player-catalog object');
  }

  const sleeperById = new Map();
  const sleeperIdsByEspnId = new Map();
  for (const [key, value] of Object.entries(catalog)) {
    if (!value || typeof value !== 'object') continue;
    const sleeperId = idOrNull(value.player_id ?? key);
    if (!sleeperId) continue;
    sleeperById.set(sleeperId, value);
    const espnId = idOrNull(value.espn_id);
    if (espnId) {
      const matches = sleeperIdsByEspnId.get(espnId) || [];
      matches.push(sleeperId);
      sleeperIdsByEspnId.set(espnId, matches);
    }
  }

  const resolvedPlayers = [];
  const unresolvedPlayers = [];
  const seenSleeperIds = new Set();
  for (const [index, requested] of players.entries()) {
    const identity = playerIdentity(requested, index);
    let sleeperId = identity.sleeperId;
    let resolvedBy = sleeperId ? 'sleeper_player_id' : null;
    if (!sleeperId && identity.espnId) {
      const matches = sleeperIdsByEspnId.get(identity.espnId) || [];
      if (matches.length === 1) {
        sleeperId = matches[0];
        resolvedBy = 'catalog_espn_id';
      } else if (matches.length > 1) {
        unresolvedPlayers.push(unresolved(identity, 'ambiguous_espn_id', `ESPN ID ${identity.espnId} maps to more than one Sleeper player.`));
        continue;
      }
    }
    if (!sleeperId) {
      const hasEspnId = identity.espnId != null;
      unresolvedPlayers.push(unresolved(
        identity,
        hasEspnId ? 'espn_id_not_found' : 'durable_id_unavailable',
        hasEspnId
          ? `ESPN ID ${identity.espnId} was not present in the Sleeper catalog; name matching is disabled.`
          : 'No Sleeper player ID or ESPN player ID was supplied; name matching is disabled.'
      ));
      continue;
    }
    if (seenSleeperIds.has(sleeperId)) continue;
    seenSleeperIds.add(sleeperId);
    const catalogPlayer = sleeperById.get(sleeperId) || null;
    resolvedPlayers.push({
      requestedPlayerId: identity.requestedPlayerId,
      platformPlayerId: sleeperId,
      espnId: identity.espnId ?? idOrNull(catalogPlayer?.espn_id),
      gsisId: idOrNull(catalogPlayer?.gsis_id),
      resolvedBy,
      catalogMatched: catalogPlayer != null,
      name: textOrNull(catalogPlayer?.full_name)
        ?? joinedName(catalogPlayer?.first_name, catalogPlayer?.last_name),
      position: textOrNull(catalogPlayer?.position),
      nflTeam: textOrNull(catalogPlayer?.team),
      missing: catalogPlayer ? [] : ['catalog']
    });
  }
  return { players: resolvedPlayers, unresolved: unresolvedPlayers };
}

/** Normalize one weekly Sleeper row while preserving unavailable fields as null. */
export function normalizeSleeperGameLog(row, { season, week, source } = {}) {
  const stats = row?.stats && typeof row.stats === 'object' ? row.stats : (row || {});
  const snaps = firstNumber(stats, ['off_snp', 'snaps', 'offensive_snaps']);
  const teamOffensiveSnaps = firstNumber(stats, ['tm_off_snp', 'team_off_snp', 'team_offensive_snaps']);
  const explicitSnapShare = firstNumber(stats, ['snap_share', 'snapShare', 'snap_pct', 'off_snp_pct']);
  const snapShare = normalizeShare(explicitSnapShare)
    ?? (snaps != null && teamOffensiveSnaps != null && teamOffensiveSnaps > 0
      ? round(snaps / teamOffensiveSnaps, 4)
      : null);
  const fantasy = fantasyPointValues(stats);
  const normalized = {
    season: integerOrNull(row?.season) ?? integerOrNull(season),
    week: integerOrNull(row?.week) ?? integerOrNull(week),
    opponent: textOrNull(row?.opponent ?? row?.opp),
    team: textOrNull(row?.team),
    gameId: idOrNull(row?.game_id ?? row?.gameId),
    snaps,
    teamOffensiveSnaps,
    snapShare,
    targets: firstNumber(stats, ['rec_tgt', 'targets', 'tgt']),
    receptions: firstNumber(stats, ['rec', 'receptions']),
    routes: firstNumber(stats, ['routes', 'rec_routes', 'routes_run', 'route_run', 'rec_route', 'rec_route_run']),
    carries: firstNumber(stats, ['rush_att', 'carries']),
    rushingYards: firstNumber(stats, ['rush_yd', 'rushing_yards']),
    receivingYards: firstNumber(stats, ['rec_yd', 'receiving_yards']),
    redZoneTargets: firstNumber(stats, ['rec_rz_tgt', 'rz_tgt', 'red_zone_targets', 'redzone_targets']),
    redZoneCarries: firstNumber(stats, ['rush_rz_att', 'rz_rush_att', 'rz_car', 'red_zone_carries', 'redzone_carries']),
    passAttempts: firstNumber(stats, ['pass_att', 'passing_attempts']),
    fantasyPoints: fantasy.value,
    fantasyPointsFormat: fantasy.format,
    fantasyPointsByFormat: fantasy.byFormat,
    source: source?.url ?? textOrNull(source),
    retrievedAt: source?.retrievedAt ?? null,
    stale: source?.stale ?? true,
    derived: explicitSnapShare == null && snapShare != null ? ['snapShare'] : [],
    missing: []
  };
  normalized.missing = LOG_FIELDS.filter((field) => normalized[field] == null);
  if (normalized.source == null) normalized.missing.push('source');
  if (normalized.retrievedAt == null) normalized.missing.push('retrievedAt');
  return normalized;
}

/**
 * Summarize each opportunity signal independently. Missing weeks or metrics do
 * not become zeroes and therefore cannot silently depress a player's average.
 */
export function summarizeSleeperUsage(gameLogs, { recencyDecay = DEFAULT_RECENCY_DECAY } = {}) {
  if (!Array.isArray(gameLogs)) throw new TypeError('gameLogs must be an array');
  validateRecencyDecay(recencyDecay);
  const orderedLogs = [...gameLogs].sort((a, b) => (integerOrNull(a.week) ?? 0) - (integerOrNull(b.week) ?? 0));
  const opportunity = Object.fromEntries(OPPORTUNITY_FIELDS.map((field) => [
    field,
    summarizeMetric(orderedLogs, field, recencyDecay)
  ]));
  const productionFields = ['receptions', 'rushingYards', 'receivingYards', 'fantasyPoints'];
  const production = Object.fromEntries(productionFields.map((field) => [
    field,
    summarizeMetric(orderedLogs, field, recencyDecay)
  ]));
  const directional = OPPORTUNITY_FIELDS
    .map((field) => ({ field, ...opportunity[field] }))
    .filter((item) => item.direction !== 'unavailable');
  const rising = directional.filter((item) => item.direction === 'increasing').map((item) => item.field);
  const falling = directional.filter((item) => item.direction === 'decreasing').map((item) => item.field);
  const stable = directional.filter((item) => item.direction === 'stable').map((item) => item.field);

  return {
    sampleSize: orderedLogs.length,
    weeks: orderedLogs.map((log) => integerOrNull(log.week)).filter((week) => week != null),
    recencyDecay,
    opportunity,
    production,
    recencyWeighted: Object.fromEntries(Object.entries({ ...opportunity, ...production })
      .map(([field, summary]) => [field, summary.weightedAverage])),
    metricSampleSizes: Object.fromEntries(Object.entries({ ...opportunity, ...production })
      .map(([field, summary]) => [field, summary.sampleSize])),
    trend: {
      direction: overallDirection(rising.length, falling.length, stable.length),
      sampleSize: orderedLogs.length,
      evaluatedMetricCount: directional.length,
      rising,
      falling,
      stable
    },
    missing: OPPORTUNITY_FIELDS.filter((field) => opportunity[field].sampleSize === 0)
  };
}

function summarizeMetric(logs, field, recencyDecay) {
  const observations = logs
    .map((log, index) => ({
      week: integerOrNull(log.week) ?? index + 1,
      value: finiteNumber(log[field])
    }))
    .filter((item) => item.value != null);
  if (!observations.length) return emptyMetricSummary();
  const latestWeek = Math.max(...observations.map((item) => item.week));
  const weighted = observations.map((item) => ({
    ...item,
    weight: recencyDecay ** Math.max(0, latestWeek - item.week)
  }));
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  const weightedAverage = weighted.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
  const slope = observations.length >= 2 ? weightedSlope(weighted) : null;
  return {
    sampleSize: observations.length,
    weeks: observations.map((item) => item.week),
    latest: round(observations.at(-1).value, 4),
    weightedAverage: round(weightedAverage, 4),
    changeFromOldest: observations.length >= 2
      ? round(observations.at(-1).value - observations[0].value, 4)
      : null,
    changePerWeek: slope == null ? null : round(slope, 4),
    direction: slope == null ? 'unavailable' : metricDirection(field, slope)
  };
}

function emptyMetricSummary() {
  return {
    sampleSize: 0,
    weeks: [],
    latest: null,
    weightedAverage: null,
    changeFromOldest: null,
    changePerWeek: null,
    direction: 'unavailable'
  };
}

function weightedSlope(observations) {
  const totalWeight = observations.reduce((sum, item) => sum + item.weight, 0);
  const meanWeek = observations.reduce((sum, item) => sum + item.week * item.weight, 0) / totalWeight;
  const meanValue = observations.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
  const numerator = observations.reduce((sum, item) => sum + item.weight * (item.week - meanWeek) * (item.value - meanValue), 0);
  const denominator = observations.reduce((sum, item) => sum + item.weight * (item.week - meanWeek) ** 2, 0);
  return denominator === 0 ? 0 : numerator / denominator;
}

function metricDirection(field, slope) {
  const threshold = field === 'snapShare' ? 0.01 : 0.25;
  if (Math.abs(slope) < threshold) return 'stable';
  return slope > 0 ? 'increasing' : 'decreasing';
}

function overallDirection(rising, falling, stable) {
  if (rising === 0 && falling === 0 && stable === 0) return 'unavailable';
  if (rising > falling) return 'increasing';
  if (falling > rising) return 'decreasing';
  if (rising === 0 && falling === 0) return 'stable';
  return 'mixed';
}

function indexWeeklyRows(payload, selectedIds) {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? Object.entries(payload).map(([key, value]) => ({ ...(value || {}), player_id: value?.player_id ?? key }))
      : [];
  const indexed = new Map();
  for (const row of rows) {
    const playerId = idOrNull(row?.player_id ?? row?.playerId);
    if (playerId && selectedIds.has(playerId)) indexed.set(playerId, row);
  }
  return indexed;
}

function playerIdentity(player, index) {
  if (typeof player === 'string' || typeof player === 'number') {
    const value = String(player);
    const [prefix, suffix] = splitPrefixedId(value);
    return {
      requestedPlayerId: value,
      sleeperId: prefix === 'espn' ? null : idOrNull(suffix ?? value),
      espnId: prefix === 'espn' ? idOrNull(suffix) : null
    };
  }
  const value = player && typeof player === 'object' ? player : {};
  const suppliedPlayerId = idOrNull(value.playerId ?? value.id);
  const requestedPlayerId = suppliedPlayerId ?? `index:${index}`;
  const [prefix, prefixedId] = suppliedPlayerId ? splitPrefixedId(suppliedPlayerId) : [null, null];
  const platform = textOrNull(value.platform)?.toLowerCase() ?? prefix;
  const explicitSleeperId = idOrNull(value.sleeperPlayerId ?? value.sleeperId ?? value.externalIds?.sleeper);
  const explicitEspnId = idOrNull(value.espnPlayerId ?? value.espnId ?? value.externalIds?.espn);
  const platformPlayerId = idOrNull(value.platformPlayerId);
  return {
    requestedPlayerId,
    sleeperId: explicitSleeperId
      ?? (prefix === 'sleeper' ? prefixedId : null)
      ?? (platform === 'sleeper' ? platformPlayerId : null)
      ?? (platform == null && prefix == null ? platformPlayerId : null),
    espnId: explicitEspnId
      ?? (prefix === 'espn' ? prefixedId : null)
      ?? (platform === 'espn' ? platformPlayerId : null)
  };
}

function unresolved(identity, reason, message) {
  return {
    requestedPlayerId: identity.requestedPlayerId,
    sleeperId: identity.sleeperId,
    espnId: identity.espnId,
    reason,
    message
  };
}

function splitPrefixedId(value) {
  const match = /^([a-z]+):(.+)$/i.exec(String(value));
  return match ? [match[1].toLowerCase(), match[2]] : [null, null];
}

function normalizeSources({ sources, weeks, season, seasonType, retrievedAt, now, staleAfterMs }) {
  if (sources?.catalog && sources?.weeklyStats) return sources;
  const normalizedRetrievedAt = toIso(retrievedAt);
  return {
    catalog: sourceRecord(SLEEPER_PLAYER_CATALOG_ENDPOINT, normalizedRetrievedAt, now, staleAfterMs),
    weeklyStats: Object.fromEntries(weeks.map((week) => [
      week,
      sourceRecord(buildSleeperWeeklyStatsUrl({ season, week, seasonType }), normalizedRetrievedAt, now, staleAfterMs)
    ]))
  };
}

function sourceRecord(url, retrievedAt, now, staleAfterMs) {
  const timestamp = toIso(retrievedAt);
  const nowDate = resolveNow(now);
  const retrievedDate = timestamp ? new Date(timestamp) : null;
  return {
    url,
    retrievedAt: timestamp,
    stale: !retrievedDate || !Number.isFinite(retrievedDate.getTime())
      || nowDate.getTime() - retrievedDate.getTime() > staleAfterMs
  };
}

async function requestJson(url, { fetchImpl, now, timeoutMs, signal, cache, cacheTtlMs }) {
  const nowDate = resolveNow(now);
  const cached = cache instanceof Map ? cache.get(url) : null;
  if (cached && nowDate.getTime() - new Date(cached.retrievedAt).getTime() <= cacheTtlMs) return cached;
  const timeoutSignal = signal || globalThis.AbortSignal?.timeout?.(timeoutMs);
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    ...(timeoutSignal ? { signal: timeoutSignal } : {})
  });
  if (!response?.ok) {
    const status = response?.status ?? null;
    const error = new Error(`Sleeper historical usage returned HTTP ${status ?? 'unknown'}`);
    error.code = 'SLEEPER_HISTORICAL_USAGE_HTTP';
    error.status = status;
    error.sourceUrl = url;
    throw error;
  }
  const value = { payload: await response.json(), retrievedAt: toIso(resolveNow(now)) };
  if (cache instanceof Map) cache.set(url, value);
  return value;
}

function fantasyPointValues(stats) {
  const byFormat = {
    standard: firstNumber(stats, ['pts_std', 'fantasy_points_standard']),
    halfPpr: firstNumber(stats, ['pts_half_ppr', 'fantasy_points_half_ppr']),
    ppr: firstNumber(stats, ['pts_ppr', 'fantasy_points_ppr'])
  };
  const generic = firstNumber(stats, ['fantasy_points', 'fantasy_pts', 'fpts']);
  if (generic != null) return { value: generic, format: 'source', byFormat };
  if (byFormat.ppr != null) return { value: byFormat.ppr, format: 'ppr', byFormat };
  if (byFormat.halfPpr != null) return { value: byFormat.halfPpr, format: 'half_ppr', byFormat };
  if (byFormat.standard != null) return { value: byFormat.standard, format: 'standard', byFormat };
  return { value: null, format: null, byFormat };
}

function normalizeWeeks(weeks) {
  if (!Array.isArray(weeks) || !weeks.length) throw new TypeError('weeks must be a non-empty array');
  return [...new Set(weeks.map((week) => positiveInteger(week, 'week')))].sort((a, b) => a - b);
}

function validateRecencyDecay(value) {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new RangeError('recencyDecay must be greater than zero and at most one');
  }
}

function firstNumber(object, keys) {
  for (const key of keys) {
    const value = finiteNumber(object?.[key]);
    if (value != null) return value;
  }
  return null;
}

function normalizeShare(value) {
  if (value == null) return null;
  if (value >= 0 && value <= 1) return round(value, 4);
  if (value > 1 && value <= 100) return round(value / 100, 4);
  return null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new TypeError(`${label} must be a positive integer`);
  return number;
}

function integerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function idOrNull(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function textOrNull(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function nonEmptyText(value, label) {
  const normalized = textOrNull(value);
  if (!normalized) throw new TypeError(`${label} must be non-empty text`);
  return normalized;
}

function joinedName(first, last) {
  const name = [textOrNull(first), textOrNull(last)].filter(Boolean).join(' ');
  return name || null;
}

function latestTimestamp(values) {
  const timestamps = values.filter(Boolean).map((value) => new Date(value)).filter((date) => Number.isFinite(date.getTime()));
  return timestamps.length ? new Date(Math.max(...timestamps.map((date) => date.getTime()))).toISOString() : null;
}

function resolveNow(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now must resolve to a valid date');
  return date;
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
