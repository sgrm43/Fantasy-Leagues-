import { scoreSleeperProjection } from '../scoring.js';

export const SLEEPER_PLAYER_CATALOG_URL = 'https://api.sleeper.app/v1/players/nfl';
export const SLEEPER_WEEKLY_STATS_URL = 'https://api.sleeper.com/stats/nfl';
const CACHE_TTL_MS = 24 * 60 * 60_000;
const SUPPORTED_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
const TEAM_ALIASES = Object.freeze({ JAC: 'JAX', JAX: 'JAX', WSH: 'WAS', WAS: 'WAS', LA: 'LAR', LAR: 'LAR', STL: 'LAR', SD: 'LAC', OAK: 'LV' });

export function selectOpponentHistoryWindow(season, currentWeek) {
  const year = positiveInteger(season, 'season');
  const week = positiveInteger(currentWeek, 'currentWeek');
  if (week <= 1) return { season: year - 1, weeks: [14, 15, 16, 17], basis: 'prior-season historical baseline' };
  const count = Math.min(4, week - 1);
  const first = week - count;
  return { season: year, weeks: Array.from({ length: count }, (_, index) => first + index), basis: 'current-season completed games' };
}

export function buildSleeperOpponentStatsUrl(season, week) {
  return `${SLEEPER_WEEKLY_STATS_URL}/${positiveInteger(season, 'season')}/${positiveInteger(week, 'week')}?season_type=regular`;
}

export function createSleeperOpponentPositionProvider(defaults = {}) {
  const cache = new Map();
  return {
    fetch: (options = {}) => fetchSleeperOpponentPosition({ ...defaults, ...options, cache }),
    clearCache: () => cache.clear()
  };
}

export async function fetchSleeperOpponentPosition({
  season,
  weeks,
  defense,
  position,
  rawScoringRules = null,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  cache = null,
  cacheTtlMs = CACHE_TTL_MS,
  timeoutMs = 20_000
} = {}) {
  const year = positiveInteger(season, 'season');
  const normalizedWeeks = normalizeWeeks(weeks);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const urls = [SLEEPER_PLAYER_CATALOG_URL, ...normalizedWeeks.map((week) => buildSleeperOpponentStatsUrl(year, week))];
  const settled = await Promise.allSettled(urls.map((url) => requestJson(url, { fetchImpl, now, cache, cacheTtlMs, timeoutMs })));
  if (settled[0].status === 'rejected') throw settled[0].reason;

  const catalogResult = settled[0].value;
  const weeklyStats = {};
  const weeklySources = {};
  const missingWeeks = [];
  const fetchIssues = [];
  normalizedWeeks.forEach((week, index) => {
    const result = settled[index + 1];
    if (result.status === 'fulfilled') {
      weeklyStats[week] = result.value.payload;
      weeklySources[week] = sourceOnly(result.value);
    } else {
      missingWeeks.push(week);
      fetchIssues.push({ code: 'weekly_stats_unavailable', week, message: result.reason?.message || 'Weekly stats request failed.' });
    }
  });

  return normalizeSleeperOpponentPosition({
    season: year,
    weeks: normalizedWeeks,
    defense,
    position,
    catalog: catalogResult.payload,
    weeklyStats,
    sources: { catalog: sourceOnly(catalogResult), weeklyStats: weeklySources },
    rawScoringRules,
    missingWeeks,
    fetchIssues
  });
}

export function normalizeSleeperOpponentPosition({
  season,
  weeks,
  defense,
  position,
  catalog,
  weeklyStats,
  sources = {},
  rawScoringRules = null,
  missingWeeks = [],
  fetchIssues = []
} = {}) {
  const year = positiveInteger(season, 'season');
  const normalizedWeeks = normalizeWeeks(weeks);
  const normalizedPosition = normalizePosition(position);
  if (!SUPPORTED_POSITIONS.has(normalizedPosition)) throw new TypeError('position must be QB, RB, WR, or TE');
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new TypeError('catalog must be an object keyed by player ID');
  if (!weeklyStats || typeof weeklyStats !== 'object' || Array.isArray(weeklyStats)) throw new TypeError('weeklyStats must be keyed by week');
  const normalizedDefense = { id: idOrNull(defense?.id), abbreviation: normalizeNflAbbreviation(defense?.abbreviation) };
  if (!normalizedDefense.abbreviation) throw new TypeError('defense abbreviation is required');
  const scoringSupported = Boolean(rawScoringRules && typeof rawScoringRules === 'object' && Object.keys(rawScoringRules).length > 0);
  const playerRows = new Map();
  let unresolvedPlayerRows = 0;

  for (const week of normalizedWeeks) {
    for (const row of rowsFromPayload(weeklyStats[week] ?? weeklyStats[String(week)])) {
      const playerId = idOrNull(row?.player_id ?? row?.playerId);
      const catalogPlayer = playerId ? catalog[playerId] : null;
      if (!playerId || !catalogPlayer) { unresolvedPlayerRows += 1; continue; }
      const historicalPosition = row.player?.position ?? row.player?.fantasy_positions?.[0];
      if (normalizePosition(historicalPosition ?? catalogPlayer.position ?? catalogPlayer.fantasy_positions?.[0]) !== normalizedPosition) continue;
      const opponent = normalizeNflAbbreviation(row.opponent ?? row.opp);
      if (!opponent) continue;
      const key = `${week}:${playerId}`;
      if (playerRows.has(key)) continue;
      const stats = row.stats && typeof row.stats === 'object' ? row.stats : row;
      playerRows.set(key, {
        week,
        playerId,
        playerName: catalogPlayer.full_name || [catalogPlayer.first_name, catalogPlayer.last_name].filter(Boolean).join(' ') || playerId,
        position: normalizedPosition,
        offense: normalizeNflAbbreviation(row.team ?? row.player?.team),
        defense: opponent,
        primary: primaryOpportunity(normalizedPosition, stats),
        fantasyPoints: scoringSupported ? scoreSleeperProjection(stats, rawScoringRules).total : null,
        stats: styleRelevantStats(normalizedPosition, stats)
      });
    }
  }

  const grouped = groupDefenseGames([...playerRows.values()], normalizedPosition, scoringSupported);
  const leagueGames = [...grouped.values()];
  const targetGames = leagueGames.filter((game) => game.defense === normalizedDefense.abbreviation).sort((a, b) => a.week - b.week);
  const targetPlayerGames = [...playerRows.values()]
    .filter((game) => game.defense === normalizedDefense.abbreviation)
    .sort((left, right) => left.week - right.week || left.playerId.localeCompare(right.playerId));
  const primary = metricSummary(targetGames, leagueGames, 'primary', primaryDescriptor(normalizedPosition));
  const fantasyPoints = scoringSupported ? metricSummary(targetGames, leagueGames, 'fantasyPoints', { label: 'league fantasy points', unit: 'points/game' }) : unavailableMetric('league fantasy points', 'points/game');
  const adequate = primary.adequate;
  const assessment = assess(primary, adequate, primary.sampleGames);
  const sourceList = [sources.catalog, ...Object.values(sources.weeklyStats || {})].filter(Boolean);
  const retrievedAt = latestTimestamp(sourceList.map((source) => source.retrievedAt));
  const stale = sourceList.some((source) => source.stale === true || source.status === 'cached_after_failure');
  const available = primary.valuePerGame != null && primary.sampleGames > 0;
  const issues = [...fetchIssues];
  if (unresolvedPlayerRows) issues.push({ code: 'catalog_player_unresolved', count: unresolvedPlayerRows, message: `${unresolvedPlayerRows} weekly rows were excluded because their player ID was not in the catalog.` });
  if (!available) issues.push({ code: 'no_target_games', message: `No ${normalizedPosition} rows against ${normalizedDefense.abbreviation} were available.` });
  else if (!adequate) issues.push({ code: 'insufficient_sample', message: 'At least three defense games and 16 league defense-games are required for a comparison band.' });

  return {
    provider: 'sleeper',
    model: 'recent-opponent-position-allowance',
    available,
    partial: missingWeeks.length > 0,
    stale,
    season: year,
    requestedWeeks: normalizedWeeks,
    defense: normalizedDefense,
    position: normalizedPosition,
    sample: { requestedGames: normalizedWeeks.length, includedGames: primary.sampleGames, groupedGames: targetGames.length, playerGames: targetPlayerGames.length, leagueDefenseGames: primary.leagueSampleGames, adequate },
    metrics: { opportunity: primary, fantasyPoints },
    assessment,
    games: targetGames.filter((game) => game.primary != null).map((game) => ({ week: game.week, opponentOffense: game.offense, playerCount: game.playerCount, opportunity: game.primary, fantasyPoints: game.fantasyPoints })),
    historicalPlayerGames: targetPlayerGames.map((game) => ({
      playerId: game.playerId,
      playerName: game.playerName,
      position: game.position,
      season: year,
      week: game.week,
      offense: game.offense,
      defense: game.defense,
      opportunity: game.primary,
      fantasyPoints: game.fantasyPoints,
      defenseTendency: tendencyBucket(primary.index),
      stats: game.stats
    })),
    scoring: { supported: scoringSupported, source: scoringSupported ? 'current Sleeper league scoring rules' : null, historicalRuleChangesReconstructed: false },
    decisionUse: 'context_only',
    retrievedAt,
    sources,
    missingWeeks: [...missingWeeks],
    missing: [available ? null : 'games', primary.valuePerGame == null ? 'metrics.opportunity' : null, scoringSupported && fantasyPoints.valuePerGame == null ? 'metrics.fantasyPoints' : null].filter(Boolean),
    issues,
    limitations: [
      'Recent allowance is affected by opponents faced, injuries, and game script.',
      'It does not establish defensive scheme, coverage, or coaching intent.',
      scoringSupported ? 'Fantasy totals use the current league rules; historical scoring-rule changes are not reconstructed.' : null,
      'It is descriptive context and is not used as a projection adjustment.'
    ].filter(Boolean)
  };
}

export function normalizeNflAbbreviation(value) {
  const abbreviation = String(value || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (!abbreviation) return null;
  return TEAM_ALIASES[abbreviation] || abbreviation;
}

function groupDefenseGames(rows, position, scoringSupported) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.week}:${row.defense}`;
    const group = groups.get(key) || { week: row.week, defense: row.defense, offense: row.offense, playerCount: 0, primaryValues: [], fantasyValues: [] };
    group.playerCount += 1;
    if (row.primary != null) group.primaryValues.push(row.primary);
    if (scoringSupported && row.fantasyPoints != null) group.fantasyValues.push(row.fantasyPoints);
    groups.set(key, group);
  }
  return new Map([...groups].map(([key, group]) => [key, {
    week: group.week,
    defense: group.defense,
    offense: group.offense,
    position,
    playerCount: group.playerCount,
    primary: group.primaryValues.length ? round(group.primaryValues.reduce((sum, value) => sum + value, 0)) : null,
    fantasyPoints: scoringSupported && group.fantasyValues.length ? round(group.fantasyValues.reduce((sum, value) => sum + value, 0)) : null
  }]));
}

function metricSummary(targetGames, leagueGames, field, descriptor) {
  const target = targetGames.map((game) => game[field]).filter(Number.isFinite);
  const baseline = leagueGames.map((game) => game[field]).filter(Number.isFinite);
  const valuePerGame = average(target);
  const leagueValuePerGame = average(baseline);
  const index = valuePerGame != null && leagueValuePerGame > 0 ? Math.round(valuePerGame / leagueValuePerGame * 20) * 5 : null;
  const adequate = target.length >= 3 && baseline.length >= 16;
  return { ...descriptor, valuePerGame, leagueValuePerGame, sampleGames: target.length, leagueSampleGames: baseline.length, adequate, index, band: adequate ? bandFor(index) : 'insufficient sample' };
}

function unavailableMetric(label, unit) { return { label, unit, valuePerGame: null, leagueValuePerGame: null, sampleGames: 0, leagueSampleGames: 0, adequate: false, index: null, band: 'unavailable' }; }

function assess(metric, adequate, games) {
  if (!adequate || metric.index == null) return { label: 'insufficient_sample', confidence: 'low', projectionAdjustmentEligible: false, explanation: `Only ${games} defense game${games === 1 ? '' : 's'} were available.` };
  const label = metric.index > 110 ? 'higher_than_league' : metric.index < 90 ? 'lower_than_league' : 'near_league';
  return { label, confidence: 'low', projectionAdjustmentEligible: false, explanation: `${metric.label} was ${metric.band} in the requested sample.` };
}

function bandFor(index) {
  if (index == null) return 'unavailable';
  if (index <= 80) return '20%+ below league';
  if (index < 95) return '10–20% below league';
  if (index <= 105) return 'near league';
  if (index < 120) return '10–20% above league';
  return '20%+ above league';
}

function primaryDescriptor(position) {
  if (position === 'QB') return { label: 'pass attempts', unit: 'attempts/game' };
  if (position === 'RB') return { label: 'carries + targets', unit: 'opportunities/game' };
  return { label: 'targets', unit: 'targets/game' };
}

function primaryOpportunity(position, stats) {
  if (position === 'QB') return firstNumber(stats, ['pass_att', 'passing_attempts']);
  if (position === 'RB') return sumPresent(firstNumber(stats, ['rush_att', 'carries']), firstNumber(stats, ['rec_tgt', 'targets', 'tgt']));
  return firstNumber(stats, ['rec_tgt', 'targets', 'tgt']);
}

function styleRelevantStats(position, stats) {
  const common = {
    passAttempts: firstNumber(stats, ['pass_att', 'passing_attempts']),
    passYards: firstNumber(stats, ['pass_yd', 'passing_yards']),
    passingAirYards: firstNumber(stats, ['pass_air_yd', 'passing_air_yards']),
    rushAttempts: firstNumber(stats, ['rush_att', 'carries']),
    rushYards: firstNumber(stats, ['rush_yd', 'rushing_yards']),
    targets: firstNumber(stats, ['rec_tgt', 'targets', 'tgt']),
    receptions: firstNumber(stats, ['rec', 'receptions']),
    receivingYards: firstNumber(stats, ['rec_yd', 'receiving_yards']),
    receivingAirYards: firstNumber(stats, ['rec_air_yd', 'receiving_air_yards']),
    receivingYac: firstNumber(stats, ['rec_yac', 'receiving_yards_after_catch']),
    passingTouchdowns: firstNumber(stats, ['pass_td', 'passing_touchdowns']),
    rushingTouchdowns: firstNumber(stats, ['rush_td', 'rushing_touchdowns']),
    receivingTouchdowns: firstNumber(stats, ['rec_td', 'receiving_touchdowns'])
  };
  if (common.passingAirYards != null && common.passAttempts > 0) common.avgIntendedAirYards = round(common.passingAirYards / common.passAttempts);
  if (common.receivingAirYards != null && common.targets > 0) common.avgIntendedAirYards = round(common.receivingAirYards / common.targets);
  if (common.receptions != null && common.targets > 0) common.catchRate = round(common.receptions / common.targets);
  if (common.receivingYac != null && common.receptions > 0) common.yardsAfterCatchPerReception = round(common.receivingYac / common.receptions);
  const allowed = position === 'QB'
    ? ['passAttempts', 'passYards', 'passingAirYards', 'avgIntendedAirYards', 'rushAttempts', 'rushYards', 'passingTouchdowns', 'rushingTouchdowns']
    : position === 'RB'
      ? ['rushAttempts', 'rushYards', 'targets', 'receptions', 'catchRate', 'receivingYards', 'receivingAirYards', 'avgIntendedAirYards', 'receivingYac', 'yardsAfterCatchPerReception', 'rushingTouchdowns', 'receivingTouchdowns']
      : ['targets', 'receptions', 'catchRate', 'receivingYards', 'receivingAirYards', 'avgIntendedAirYards', 'receivingYac', 'yardsAfterCatchPerReception', 'receivingTouchdowns'];
  return Object.fromEntries(allowed.filter((key) => common[key] != null).map((key) => [key, common[key]]));
}

function tendencyBucket(index) {
  if (!Number.isFinite(index)) return 'unknown';
  if (index <= 90) return 'restrictive';
  if (index >= 110) return 'permissive';
  return 'neutral';
}

async function requestJson(url, { fetchImpl, now, cache, cacheTtlMs, timeoutMs }) {
  const nowDate = resolveNow(now);
  const cached = cache instanceof Map ? cache.get(url) : null;
  if (cached && nowDate.getTime() - Date.parse(cached.retrievedAt) <= cacheTtlMs) return { ...cached, status: 'cached', stale: false };
  try {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: globalThis.AbortSignal?.timeout?.(timeoutMs) });
    if (!response?.ok) throw Object.assign(new Error(`Sleeper opponent context returned HTTP ${response?.status ?? 'unknown'}`), { status: response?.status });
    const value = { url, payload: await response.json(), retrievedAt: nowDate.toISOString(), status: 'ok', stale: false };
    if (cache instanceof Map) cache.set(url, value);
    return value;
  } catch (error) {
    if (cached) return { ...cached, status: 'cached_after_failure', stale: true, refreshError: error.message };
    throw error;
  }
}

function sourceOnly(value) { return { url: value.url, retrievedAt: value.retrievedAt, status: value.status, stale: Boolean(value.stale), refreshError: value.refreshError || null }; }
function rowsFromPayload(payload) { return Array.isArray(payload) ? payload : payload && typeof payload === 'object' ? Object.entries(payload).map(([id, row]) => ({ ...(row || {}), player_id: row?.player_id ?? id })) : []; }
function normalizePosition(value) { const position = String(value || '').trim().toUpperCase(); return SUPPORTED_POSITIONS.has(position) ? position : null; }
function firstNumber(object, keys) { for (const key of keys) { const value = finiteNumber(object?.[key]); if (value != null) return value; } return null; }
function sumPresent(...values) { const present = values.filter(Number.isFinite); return present.length ? present.reduce((sum, value) => sum + value, 0) : null; }
function average(values) { return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null; }
function finiteNumber(value) { if (value == null || value === '') return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function positiveInteger(value, label) { const number = Number(value); if (!Number.isInteger(number) || number <= 0) throw new TypeError(`${label} must be a positive integer`); return number; }
function normalizeWeeks(weeks) { if (!Array.isArray(weeks) || !weeks.length) throw new TypeError('weeks must be a non-empty array'); return [...new Set(weeks.map((week) => positiveInteger(week, 'week')))].sort((a, b) => a - b); }
function idOrNull(value) { if (value == null) return null; const id = String(value).trim(); return id || null; }
function resolveNow(now) { const value = typeof now === 'function' ? now() : now; const date = value instanceof Date ? value : new Date(value); if (Number.isNaN(date.getTime())) throw new TypeError('now must resolve to a valid date'); return date; }
function latestTimestamp(values) { const dates = values.filter(Boolean).map((value) => new Date(value)).filter((date) => !Number.isNaN(date.getTime())); return dates.length ? new Date(Math.max(...dates.map((date) => date.getTime()))).toISOString() : null; }
function round(value) { return Math.round(value * 10) / 10; }
