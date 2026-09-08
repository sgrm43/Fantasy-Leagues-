import { config } from './config.js';
import { readLeague } from './storage.js';
import { buildOutcomeProjection } from './analytics/projections.js';
import { scoreSleeperProjection } from './scoring.js';
import { readSystemSelfEvaluation } from './system-self-evaluation.js';

const ESPN_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';
const SLEEPER_PROJECTIONS = 'https://api.sleeper.com/projections/nfl';
const SLEEPER_STATS = 'https://api.sleeper.com/stats/nfl';
const CACHE_TTL_MS = 24 * 60 * 60_000;
const MIN_PROJECTION = 3;
const MODEL_VERSION = 'range-heuristic-v1';
const cache = new Map();

export async function buildLeagueBacktest(key, { force = false, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const definition = config.leagues.find((league) => league.key === key);
  if (!definition) throw Object.assign(new Error(`Unknown league: ${key}`), { status: 404 });
  const envelope = await readLeague(key);
  if (!envelope) throw Object.assign(new Error('Sync this league before running a historical check'), { status: 409 });
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

  const league = envelope.data;
  const selfEvaluation = await readSystemSelfEvaluation({ season: league.season, week: league.currentWeek });
  const window = selectBacktestWindow(league.season, league.currentWeek);
  const scoringKey = leagueScoringFingerprint(league);
  const cacheKey = `${key}:${MODEL_VERSION}:${window.season}:${window.weeks.join(',')}:${scoringKey}`;
  const saved = cache.get(cacheKey);
  const nowDate = validDate(now()) || new Date();
  if (!force && saved && nowDate.getTime() - Date.parse(saved.generatedAt) < CACHE_TTL_MS) return { ...saved, selfEvaluation };

  let fallback = null;
  let fetched;
  if (league.platform === 'espn') {
    fetched = await fetchEspnSamples({ definition, season: window.season, weeks: window.weeks, fetchImpl });
    if (!fetched.includedWeeks.length) {
      for (const candidate of await compatibleEspnFallbacks(key, league)) {
        const candidateResult = await fetchEspnSamples({ definition: candidate.definition, season: window.season, weeks: window.weeks, fetchImpl });
        if (!candidateResult.includedWeeks.length) continue;
        fetched = candidateResult;
        fallback = {
          leagueKey: candidate.definition.key,
          leagueName: candidate.league.name,
          reason: 'The selected ESPN league has no archive for this historical season.',
          scoringMatch: 'same current scoring rules'
        };
        break;
      }
    }
  } else {
    fetched = await fetchSleeperSamples({ season: window.season, weeks: window.weeks, rules: league.scoring?.raw || {}, fetchImpl });
  }
  requireCompletedHistoricalWeek(fetched, key);
  const summary = summarizeBacktestSamples(fetched.samples);
  const result = {
    type: 'historical-model-check',
    validationLevel: 'preliminary',
    modelVersion: MODEL_VERSION,
    generatedAt: nowDate.toISOString(),
    readOnly: true,
    selfEvaluation,
    league: { key, id: league.id, name: league.name, platform: league.platform },
    window,
    source: fetched.source,
    fallback,
    sampleSize: summary.sampleSize,
    metrics: summary.metrics,
    byPosition: summary.byPosition,
    calibration: summary.calibration,
    partial: fetched.failedWeeks.length > 0,
    includedWeeks: fetched.includedWeeks,
    failedWeeks: fetched.failedWeeks,
    methodology: {
      eligibility: `Completed player-weeks with a platform projection of at least ${MIN_PROJECTION} points. A missing actual-stat row is treated as zero.`,
      interval: 'The same position-volatility heuristic used by the live dashboard creates each floor-to-ceiling range.',
      thresholds: 'Brier error checks 10+, 15+, and 20+ point probabilities; lower is better.',
      leakageRisk: 'Historical APIs identify same-week projection rows but may not preserve the exact final pre-kickoff version, so this is a preliminary check rather than proof of leak-free calibration.'
    },
    limitations: [
      fallback ? `The selected league has no ${window.season} ESPN archive, so this check uses ${fallback.leagueName} player-weeks with the same scoring rules. It checks general model behavior, not this roster’s history.` : null,
      'This checks projection error and range behavior, not whether every historical lineup recommendation would have been optimal.',
      league.platform === 'sleeper'
        ? 'Past NFL games are rescored with the league’s current Sleeper rules; scoring-rule changes are not reconstructed.'
        : 'ESPN applied totals preserve that historical league season’s scoring for the returned player rows.',
      league.platform === 'sleeper'
        ? 'Sleeper checks the public projected-player pool; ESPN checks players returned by league roster history, so platform results are not directly comparable.'
        : 'ESPN checks players returned by this league’s roster history; Sleeper uses a broader projected-player pool, so platform results are not directly comparable.',
      'A four-week window is useful for monitoring but too small to establish stable player-specific confidence.'
    ].filter(Boolean)
  };
  cache.set(cacheKey, result);
  return result;
}

export function selectBacktestWindow(season, currentWeek) {
  const numericSeason = Number(season);
  const week = Number(currentWeek);
  if (Number.isInteger(week) && week >= 5) {
    return { season: numericSeason, weeks: [week - 4, week - 3, week - 2, week - 1], basis: 'four completed weeks before the current week' };
  }
  return { season: numericSeason - 1, weeks: [12, 13, 14, 15], basis: 'four late-season weeks from the prior season' };
}

export function summarizeBacktestSamples(samples) {
  if (!Array.isArray(samples)) throw new TypeError('samples must be an array');
  const normalized = samples.flatMap((sample) => {
    const projection = finiteNumber(sample?.projection);
    const actual = finiteNumber(sample?.actual);
    const position = normalizePosition(sample?.position);
    if (projection == null || actual == null || projection < MIN_PROJECTION || !position) return [];
    const range = buildOutcomeProjection({ id: sample.playerId, position, projection, thresholds: [10, 15, 20] });
    return [{ ...sample, projection, actual, position, range }];
  });
  const metrics = summarizeGroup(normalized);
  const positions = [...new Set(normalized.map((sample) => sample.position))].sort();
  const byPosition = positions.map((position) => ({ position, ...summarizeGroup(normalized.filter((sample) => sample.position === position)) }));
  return { sampleSize: normalized.length, metrics, byPosition, calibration: calibrationBins(normalized) };
}

async function fetchEspnSamples({ definition, season, weeks, fetchImpl }) {
  const headers = config.espn.s2 && config.espn.swid ? { Cookie: `espn_s2=${config.espn.s2}; SWID=${config.espn.swid}` } : {};
  const settled = await Promise.allSettled(weeks.map(async (week) => {
    const url = `${ESPN_BASE}/seasons/${season}/segments/0/leagues/${definition.id}?scoringPeriodId=${week}&view=mRoster&view=mTeam`;
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error('ESPN session expired'), { code: 'ESPN_AUTH' });
    if (!response.ok) throw new Error(`ESPN historical data returned HTTP ${response.status}`);
    const payload = await response.json();
    const samples = [];
    for (const team of payload.teams || []) {
      for (const entry of team.roster?.entries || []) {
        const player = entry.playerPoolEntry?.player;
        const projection = appliedTotal(player, week, 1);
        if (projection == null) continue;
        const actual = appliedTotal(player, week, 0);
        samples.push({ playerId: `espn:${player?.id || entry.playerId}`, position: espnPosition(player?.defaultPositionId), projection, actual: actual ?? 0, week, actualSource: actual == null ? 'missing_stat_row_assumed_zero' : 'applied_total' });
      }
    }
    return { week, url, samples };
  }));
  const result = settledResult(settled, weeks, 'ESPN Fantasy historical applied totals');
  result.source.league = { key: definition.key, id: definition.id, name: definition.name };
  return result;
}

export async function fetchSleeperSamples({ season, weeks, rules, fetchImpl }) {
  const settled = await Promise.allSettled(weeks.map(async (week) => {
    const projectionUrl = `${SLEEPER_PROJECTIONS}/${season}/${week}?season_type=regular`;
    const statsUrl = `${SLEEPER_STATS}/${season}/${week}?season_type=regular`;
    const [projectionResponse, statsResponse] = await Promise.all([
      fetchImpl(projectionUrl, { signal: AbortSignal.timeout(20_000) }),
      fetchImpl(statsUrl, { signal: AbortSignal.timeout(20_000) })
    ]);
    if (!projectionResponse.ok) throw new Error(`Sleeper historical projections returned HTTP ${projectionResponse.status}`);
    if (!statsResponse.ok) throw new Error(`Sleeper historical stats returned HTTP ${statsResponse.status}`);
    const [projections, stats] = await Promise.all([projectionResponse.json(), statsResponse.json()]);
    const actualById = new Map((stats || []).map((row) => [String(row.player_id), row]));
    const samples = [];
    for (const row of projections || []) {
      const projection = scoreSleeperProjection(row.stats || {}, rules).total;
      const actualRow = actualById.get(String(row.player_id));
      const actual = actualRow ? scoreSleeperProjection(actualRow.stats || {}, rules).total : 0;
      const position = normalizePosition(row.player?.fantasy_positions?.[0] || row.player?.position || actualRow?.player?.fantasy_positions?.[0] || actualRow?.player?.position);
      samples.push({ playerId: `sleeper:${row.player_id}`, position, projection, actual, week, actualSource: actualRow ? 'weekly_stats' : 'missing_stat_row_assumed_zero' });
    }
    return { week, url: `${projectionUrl} + ${statsUrl}`, samples };
  }));
  return settledResult(settled, weeks, 'Sleeper historical projections and stats scored with league rules');
}

export function requireCompletedHistoricalWeek(fetched, key = 'league') {
  if (fetched?.includedWeeks?.length) return fetched;
  throw Object.assign(new Error(`Historical data could not be loaded for ${key}`), { status: 502 });
}

async function compatibleEspnFallbacks(key, league) {
  const fingerprint = leagueScoringFingerprint(league);
  const candidates = [];
  for (const definition of config.leagues) {
    if (definition.key === key || definition.platform !== 'espn') continue;
    const envelope = await readLeague(definition.key);
    if (envelope?.data && leagueScoringFingerprint(envelope.data) === fingerprint) candidates.push({ definition, league: envelope.data });
  }
  return candidates;
}

function leagueScoringFingerprint(league) {
  return JSON.stringify(Object.entries(league?.scoring?.rules || {}).sort(([left], [right]) => left.localeCompare(right)));
}

function settledResult(settled, weeks, sourceName) {
  const fulfilled = settled.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  const includedWeeks = fulfilled.map((result) => result.week).sort((a, b) => a - b);
  const failedWeeks = weeks.filter((week) => !includedWeeks.includes(week)).map((week) => {
    const index = weeks.indexOf(week); const result = settled[index];
    return { week, error: result?.status === 'rejected' ? result.reason?.message || 'Request failed' : 'Request failed' };
  });
  return {
    samples: [...new Map(fulfilled.flatMap((result) => result.samples).map((sample) => [`${sample.week}:${sample.playerId}`, sample])).values()],
    includedWeeks,
    failedWeeks,
    source: { name: sourceName, retrievedAt: new Date().toISOString(), requests: fulfilled.map((result) => ({ week: result.week, url: result.url })) }
  };
}

function summarizeGroup(samples) {
  if (!samples.length) return { sampleSize: 0, mae: null, rmse: null, bias: null, correlation: null, intervalCoverage: null, brierError: null };
  const errors = samples.map((sample) => sample.actual - sample.projection);
  const thresholdEvents = samples.flatMap((sample) => sample.range.thresholdProbabilities.map((threshold) => ({ probability: threshold.probability, occurred: sample.actual >= threshold.threshold ? 1 : 0 })));
  return {
    sampleSize: samples.length,
    mae: round(errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length),
    rmse: round(Math.sqrt(errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length)),
    bias: round(errors.reduce((sum, error) => sum + error, 0) / errors.length),
    correlation: roundProbability(pearson(samples.map((sample) => sample.projection), samples.map((sample) => sample.actual))),
    intervalCoverage: roundProbability(samples.filter((sample) => sample.actual >= sample.range.floor && sample.actual <= sample.range.ceiling).length / samples.length),
    brierError: thresholdEvents.length ? roundProbability(thresholdEvents.reduce((sum, event) => sum + (event.probability - event.occurred) ** 2, 0) / thresholdEvents.length) : null
  };
}

function calibrationBins(samples) {
  const events = samples.flatMap((sample) => sample.range.thresholdProbabilities.map((threshold) => ({ probability: threshold.probability, occurred: sample.actual >= threshold.threshold ? 1 : 0 })));
  const bins = [
    { minimum: 0, maximum: 0.2, label: '0–20%' },
    { minimum: 0.2, maximum: 0.4, label: '20–40%' },
    { minimum: 0.4, maximum: 0.6, label: '40–60%' },
    { minimum: 0.6, maximum: 0.8, label: '60–80%' },
    { minimum: 0.8, maximum: 1.001, label: '80–100%' }
  ];
  return bins.map((bin, index) => {
    const members = events.filter((event) => event.probability >= bin.minimum && (index === bins.length - 1 ? event.probability <= 1 : event.probability < bin.maximum));
    return { label: bin.label, count: members.length, predictedAverage: members.length ? roundProbability(members.reduce((sum, event) => sum + event.probability, 0) / members.length) : null, observedRate: members.length ? roundProbability(members.reduce((sum, event) => sum + event.occurred, 0) / members.length) : null };
  }).filter((bin) => bin.count > 0);
}

function appliedTotal(player, week, sourceId) { const row = (player?.stats || []).find((stat) => Number(stat.scoringPeriodId) === Number(week) && Number(stat.statSourceId) === sourceId); return finiteNumber(row?.appliedTotal); }
function espnPosition(id) { return ({ 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' })[id] || null; }
function normalizePosition(value) { const position = String(value || '').trim().toUpperCase(); if (['DEF', 'DST'].includes(position)) return 'D/ST'; return ['QB', 'RB', 'WR', 'TE', 'K', 'D/ST'].includes(position) ? position : null; }
function finiteNumber(value) { if (value == null || value === '') return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function round(value) { return value == null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10; }
function roundProbability(value) { return value == null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100; }
function validDate(value) { const date = value instanceof Date ? value : new Date(value); return Number.isNaN(date.getTime()) ? null : date; }
function pearson(x, y) {
  if (x.length < 2 || y.length !== x.length) return null;
  const xMean = x.reduce((a, b) => a + b, 0) / x.length; const yMean = y.reduce((a, b) => a + b, 0) / y.length;
  const numerator = x.reduce((sum, value, index) => sum + (value - xMean) * (y[index] - yMean), 0);
  const xSpread = Math.sqrt(x.reduce((sum, value) => sum + (value - xMean) ** 2, 0)); const ySpread = Math.sqrt(y.reduce((sum, value) => sum + (value - yMean) ** 2, 0));
  return xSpread && ySpread ? numerator / (xSpread * ySpread) : null;
}
