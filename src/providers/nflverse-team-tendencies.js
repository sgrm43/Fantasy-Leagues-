import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

export const NFLVERSE_PBP_RELEASE_URL = 'https://github.com/nflverse/nflverse-data/releases/download/pbp';
export const NFLVERSE_DATASET_TTL_MS = 6 * 60 * 60_000;

const REQUIRED_COLUMNS = Object.freeze([
  'game_id', 'game_date', 'season_type', 'week', 'posteam', 'play_id', 'drive', 'qtr', 'down',
  'yardline_100', 'game_seconds_remaining', 'play_type', 'qb_dropback', 'rush_attempt',
  'qb_kneel', 'qb_spike', 'two_point_attempt', 'vegas_wp', 'wp'
]);

const RATE_LABEL_THRESHOLD = 0.05;
const RED_ZONE_LABEL_THRESHOLD = 0.08;
const PACE_LABEL_THRESHOLD_SECONDS = 2;

export function buildNflversePbpUrl(season) {
  const year = positiveInteger(season, 'season');
  return `${NFLVERSE_PBP_RELEASE_URL}/play_by_play_${year}.csv.gz`;
}

export function createNflverseTeamTendencyProvider(defaults = {}) {
  const cache = defaults.cache instanceof Map ? defaults.cache : new Map();
  const pending = new Map();
  return {
    fetch: (options = {}) => fetchNflverseTeamTendencies({ ...defaults, ...options, cache, pending }),
    clearCache: () => { cache.clear(); pending.clear(); }
  };
}

export async function fetchNflverseTeamTendencies({
  season,
  currentWeek,
  teams,
  periods = {},
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  cache = new Map(),
  pending = new Map(),
  cacheTtlMs = NFLVERSE_DATASET_TTL_MS,
  timeoutMs = 45_000
} = {}) {
  const year = positiveInteger(season, 'season');
  const week = positiveInteger(currentWeek, 'currentWeek');
  const requestedTeams = normalizeTeams(teams);
  if (!requestedTeams.length) return emptyResult(year, week, [], null, 'no_relevant_teams');
  if (week <= 1) return emptyResult(year, week, requestedTeams, null, 'no_completed_weeks');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const dataset = await getDataset({ season: year, fetchImpl, now, cache, pending, cacheTtlMs, timeoutMs });
  return summarizeNflverseTeamTendencies(dataset, { season: year, currentWeek: week, teams: requestedTeams, periods });
}

/** Parse a deterministic CSV fixture or already-decompressed nflverse file. */
export function normalizeNflversePbpCsv(csv, provenance = {}) {
  if (typeof csv !== 'string') throw new TypeError('csv must be a string');
  const records = parseCsvText(csv);
  return aggregateRecords(records, provenance);
}

export function summarizeNflverseTeamTendencies(dataset, { season, currentWeek, teams, periods = {} } = {}) {
  const year = positiveInteger(season, 'season');
  const week = positiveInteger(currentWeek, 'currentWeek');
  const requestedTeams = normalizeTeams(teams);
  const finalWeek = week - 1;
  if (!dataset?.available) return emptyResult(year, week, requestedTeams, dataset, dataset?.reasonCode || 'dataset_unavailable');
  const allCompleted = (dataset.games || []).filter((game) => game.seasonType === 'REG' && game.week <= finalWeek);
  const outputs = requestedTeams.map((team) => {
    const period = periods?.[team] || periods?.[denormalizeWashington(team)] || null;
    const startWeek = Math.max(1, Number(period?.startWeek || 1));
    const firstSeenDate = isoDate(period?.firstSeenAt);
    const games = allCompleted.filter((game) => game.team === team && game.week >= startWeek && (!firstSeenDate || !game.gameDate || game.gameDate >= firstSeenDate));
    const baseline = allCompleted.filter((game) => game.week >= startWeek && (!firstSeenDate || !game.gameDate || game.gameDate >= firstSeenDate));
    return summarizeTeam(team, games, baseline, { season: year, currentWeek: week, period });
  });
  return {
    provider: 'nflverse',
    model: 'roster-relevant-offensive-tendencies',
    available: outputs.some((team) => team.available),
    season: year,
    currentWeek: week,
    teams: outputs,
    cache: { datasetKey: `${year}:${week}:${dataset.dataVersion || 'unversioned'}`, dataVersion: dataset.dataVersion || null, status: dataset.cacheStatus || 'loaded' },
    sourceUrl: dataset.sourceUrl || buildNflversePbpUrl(year),
    retrievedAt: dataset.retrievedAt || null,
    stale: Boolean(dataset.stale),
    issues: dataset.issues || [],
    limitations: [
      'Play-by-play tendencies describe team behavior and do not prove that a specific coach caused it.',
      'Neutral situations mean quarters 1–3 with possession-team win probability between 20% and 80%.',
      'Seconds per play is estimated from consecutive offensive snaps within a drive; long stoppages are excluded.'
    ]
  };
}

async function getDataset({ season, fetchImpl, now, cache, pending, cacheTtlMs, timeoutMs }) {
  const key = String(season);
  const nowDate = resolveNow(now);
  const saved = cache.get(key);
  if (saved && nowDate.getTime() - Date.parse(saved.cachedAt) <= cacheTtlMs) return { ...saved.dataset, cacheStatus: 'memory_hit' };
  if (pending.has(key)) return pending.get(key);
  const task = loadDataset({ season, fetchImpl, nowDate, saved, timeoutMs }).then((dataset) => {
    cache.set(key, { cachedAt: nowDate.toISOString(), dataset });
    return dataset;
  }).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

async function loadDataset({ season, fetchImpl, nowDate, saved, timeoutMs }) {
  const sourceUrl = buildNflversePbpUrl(season);
  const headers = { Accept: 'application/gzip,application/octet-stream' };
  if (saved?.dataset?.etag) headers['If-None-Match'] = saved.dataset.etag;
  if (saved?.dataset?.lastModified) headers['If-Modified-Since'] = saved.dataset.lastModified;
  try {
    const response = await fetchImpl(sourceUrl, { headers, signal: globalThis.AbortSignal?.timeout?.(timeoutMs) });
    if (response?.status === 304 && saved?.dataset) return { ...saved.dataset, retrievedAt: nowDate.toISOString(), stale: false, cacheStatus: 'revalidated' };
    if (response?.status === 404) return unavailableDataset(season, sourceUrl, nowDate, 'season_not_published', 'The current-season nflverse play-by-play file has not been published yet.');
    if (!response?.ok) throw Object.assign(new Error(`nflverse play-by-play returned HTTP ${response?.status ?? 'unknown'}`), { status: response?.status });
    const etag = headerValue(response.headers, 'etag');
    const lastModified = headerValue(response.headers, 'last-modified');
    const dataVersion = etag || lastModified || nowDate.toISOString();
    const dataset = await aggregateGzipResponse(response, { season, sourceUrl, retrievedAt: nowDate.toISOString(), dataVersion, etag, lastModified });
    return { ...dataset, cacheStatus: 'downloaded' };
  } catch (error) {
    if (saved?.dataset?.available) return { ...saved.dataset, stale: true, cacheStatus: 'cached_after_failure', issues: [...(saved.dataset.issues || []), { code: 'refresh_failed', message: error.message }] };
    throw error;
  }
}

async function aggregateGzipResponse(response, provenance) {
  const compressed = response.body && typeof response.body.getReader === 'function'
    ? Readable.fromWeb(response.body)
    : Readable.from(Buffer.from(await response.arrayBuffer()));
  const records = parseCsvStream(compressed.pipe(createGunzip()));
  return aggregateRecords(records, provenance);
}

async function aggregateRecords(records, provenance) {
  const iterable = records[Symbol.asyncIterator] ? records : toAsync(records);
  const iterator = iterable[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) return unavailableDataset(provenance.season, provenance.sourceUrl, new Date(provenance.retrievedAt || Date.now()), 'empty_dataset', 'The nflverse file was empty.');
  const header = first.value;
  const indexes = Object.fromEntries(REQUIRED_COLUMNS.map((name) => [name, header.indexOf(name)]));
  const missing = REQUIRED_COLUMNS.filter((name) => indexes[name] < 0 && !['vegas_wp', 'wp', 'play_type'].includes(name));
  if (missing.length) throw new Error(`nflverse CSV is missing required columns: ${missing.join(', ')}`);
  const games = new Map();
  const priorSnaps = new Map();
  for await (const values of { [Symbol.asyncIterator]: () => iterator }) {
    const get = (name) => indexes[name] < 0 ? '' : values[indexes[name]];
    const seasonType = String(get('season_type') || '').toUpperCase();
    const team = normalizeTeam(get('posteam'));
    const gameId = textOrNull(get('game_id'));
    const week = integerOrNull(get('week'));
    if (seasonType !== 'REG' || !team || !gameId || !week) continue;
    const playType = String(get('play_type') || '').toLowerCase();
    const dropback = binary(get('qb_dropback')) === 1 || playType === 'pass';
    const rush = !dropback && binary(get('rush_attempt')) === 1;
    if ((!dropback && !rush) || playType === 'no_play' || binary(get('qb_kneel')) === 1 || binary(get('qb_spike')) === 1 || binary(get('two_point_attempt')) === 1) continue;
    const key = `${gameId}:${team}`;
    const game = games.get(key) || emptyGame({ gameId, gameDate: isoDate(get('game_date')), seasonType, week, team });
    game.plays += 1;
    if (dropback) game.dropbacks += 1; else game.rushes += 1;
    const qtr = numberOrNull(get('qtr')); const down = numberOrNull(get('down')); const yardline = numberOrNull(get('yardline_100'));
    const winProbability = numberOrNull(get('vegas_wp')) ?? numberOrNull(get('wp'));
    if (qtr != null && qtr <= 3 && winProbability != null && winProbability >= 0.2 && winProbability <= 0.8) addSplit(game.neutral, dropback);
    if (down != null && down <= 2) addSplit(game.earlyDown, dropback);
    if (yardline != null && yardline <= 20) addSplit(game.redZone, dropback);
    const drive = textOrNull(get('drive')); const clock = numberOrNull(get('game_seconds_remaining')); const playId = numberOrNull(get('play_id'));
    if (drive && clock != null && playId != null) {
      const snapKey = `${key}:${drive}`; const prior = priorSnaps.get(snapKey); const elapsed = prior ? prior.clock - clock : null;
      if (prior && playId > prior.playId && elapsed >= 5 && elapsed <= 60) { game.pace.totalSeconds += elapsed; game.pace.intervals += 1; }
      priorSnaps.set(snapKey, { clock, playId });
    }
    games.set(key, game);
  }
  return {
    provider: 'nflverse', available: true, season: Number(provenance.season), games: [...games.values()].sort(compareGames),
    sourceUrl: provenance.sourceUrl || null, retrievedAt: toIso(provenance.retrievedAt), dataVersion: provenance.dataVersion || null,
    etag: provenance.etag || null, lastModified: provenance.lastModified || null, stale: false, issues: []
  };
}

function summarizeTeam(team, games, baselineGames, { season, currentWeek, period }) {
  const totals = sumGames(games); const baseline = sumGames(baselineGames);
  const metrics = {
    neutralPassRate: rateMetric(totals.neutral.dropbacks, totals.neutral.plays, baseline.neutral.dropbacks, baseline.neutral.plays, RATE_LABEL_THRESHOLD, 'Pass-heavy in neutral situations', 'Run-heavy in neutral situations', 'Near league neutral pass rate', 'QB dropbacks in neutral situations / neutral offensive plays.'),
    overallPassRate: rateMetric(totals.dropbacks, totals.plays, baseline.dropbacks, baseline.plays, RATE_LABEL_THRESHOLD, 'Passing more than league average', 'Running more than league average', 'Near league overall pass rate', 'QB dropbacks / (QB dropbacks + non-scramble rushes).'),
    overallRunRate: complementMetric(totals.rushes, totals.plays, baseline.rushes, baseline.plays, 'Non-dropback rushes / offensive tendency plays.'),
    secondsPerPlay: paceMetric(totals.pace, baseline.pace),
    earlyDownPassRate: rateMetric(totals.earlyDown.dropbacks, totals.earlyDown.plays, baseline.earlyDown.dropbacks, baseline.earlyDown.plays, RATE_LABEL_THRESHOLD, 'Passing more than league average on early downs', 'Running more than league average on early downs', 'Near league early-down pass rate', 'QB dropbacks on first and second down / early-down offensive plays.'),
    redZonePassRate: rateMetric(totals.redZone.dropbacks, totals.redZone.plays, baseline.redZone.dropbacks, baseline.redZone.plays, RED_ZONE_LABEL_THRESHOLD, 'Red-zone usage currently favors the pass', 'Red-zone usage currently favors the run', 'Near league red-zone pass rate', 'QB dropbacks at the opponent 20-yard line or closer / red-zone offensive plays.'),
    redZoneRunRate: complementMetric(totals.redZone.rushes, totals.redZone.plays, baseline.redZone.rushes, baseline.redZone.plays, 'Non-dropback rushes at the opponent 20-yard line or closer / red-zone offensive plays.')
  };
  const weekly = games.map((game) => ({
    week: game.week, gameId: game.gameId, gameDate: game.gameDate, plays: game.plays,
    overallPassRate: safeRate(game.dropbacks, game.plays), neutralPassRate: safeRate(game.neutral.dropbacks, game.neutral.plays),
    earlyDownPassRate: safeRate(game.earlyDown.dropbacks, game.earlyDown.plays), redZonePassRate: safeRate(game.redZone.dropbacks, game.redZone.plays),
    secondsPerPlay: safeRate(game.pace.totalSeconds, game.pace.intervals)
  })).sort((a, b) => a.week - b.week);
  return {
    team, available: games.length > 0 && metrics.overallPassRate.value != null, learning: games.length === 0,
    season, currentWeek, period: period || null, window: { startWeek: Number(period?.startWeek || 1), throughWeek: currentWeek - 1, includedGames: games.length },
    metrics, recentChange: recentChange(weekly), weekly,
    issues: games.length ? [] : [{ code: 'no_current_period_games', message: 'No completed nflverse games fall inside this verified coaching period yet.' }]
  };
}

function rateMetric(numerator, denominator, leagueNumerator, leagueDenominator, threshold, high, low, middle, definition) {
  const value = safeRate(numerator, denominator); const leagueValue = safeRate(leagueNumerator, leagueDenominator); const delta = value == null || leagueValue == null ? null : roundRate(value - leagueValue);
  return { value, leagueValue, delta, samplePlays: denominator, label: delta == null ? 'Not enough data' : delta >= threshold ? high : delta <= -threshold ? low : middle, unit: 'share', definition };
}

function complementMetric(numerator, denominator, leagueNumerator, leagueDenominator, definition) {
  const value = safeRate(numerator, denominator); const leagueValue = safeRate(leagueNumerator, leagueDenominator);
  return { value, leagueValue, delta: value == null || leagueValue == null ? null : roundRate(value - leagueValue), samplePlays: denominator, unit: 'share', definition };
}

function paceMetric(pace, leaguePace) {
  const value = pace.intervals >= 5 ? roundOne(pace.totalSeconds / pace.intervals) : null;
  const leagueValue = leaguePace.intervals >= 20 ? roundOne(leaguePace.totalSeconds / leaguePace.intervals) : null;
  const delta = value == null || leagueValue == null ? null : roundOne(value - leagueValue);
  const label = delta == null ? 'Not enough data' : delta <= -PACE_LABEL_THRESHOLD_SECONDS ? 'Fast offensive pace' : delta >= PACE_LABEL_THRESHOLD_SECONDS ? 'Slow offensive pace' : 'Near league offensive pace';
  return { value, leagueValue, delta, sampleIntervals: pace.intervals, label, unit: 'seconds/play', definition: 'Estimated seconds between consecutive offensive snaps in the same drive; gaps over 60 seconds are excluded.' };
}

function recentChange(weekly) {
  if (weekly.length < 2) return { available: false, label: 'Not enough weekly data', overallPassRateDelta: null, neutralPassRateDelta: null, comparisonWeeks: [] };
  const latest = weekly.at(-1); const prior = weekly.slice(Math.max(0, weekly.length - 4), -1);
  const priorOverall = average(prior.map((week) => week.overallPassRate)); const priorNeutral = average(prior.map((week) => week.neutralPassRate));
  const overallDelta = latest.overallPassRate == null || priorOverall == null ? null : roundRate(latest.overallPassRate - priorOverall);
  const neutralDelta = latest.neutralPassRate == null || priorNeutral == null ? null : roundRate(latest.neutralPassRate - priorNeutral);
  const signal = neutralDelta ?? overallDelta;
  const label = signal == null ? 'Not enough weekly data' : signal >= RATE_LABEL_THRESHOLD ? 'Passing more in the latest week' : signal <= -RATE_LABEL_THRESHOLD ? 'Running more in the latest week' : 'Recent pass/run mix is stable';
  return { available: signal != null, label, overallPassRateDelta: overallDelta, neutralPassRateDelta: neutralDelta, comparisonWeeks: [...prior.map((item) => item.week), latest.week] };
}

function sumGames(games) {
  return games.reduce((sum, game) => {
    sum.plays += game.plays; sum.dropbacks += game.dropbacks; sum.rushes += game.rushes;
    for (const split of ['neutral', 'earlyDown', 'redZone']) { sum[split].plays += game[split].plays; sum[split].dropbacks += game[split].dropbacks; sum[split].rushes += game[split].rushes; }
    sum.pace.totalSeconds += game.pace.totalSeconds; sum.pace.intervals += game.pace.intervals; return sum;
  }, { plays: 0, dropbacks: 0, rushes: 0, neutral: split(), earlyDown: split(), redZone: split(), pace: { totalSeconds: 0, intervals: 0 } });
}

function emptyGame({ gameId, gameDate, seasonType, week, team }) { return { gameId, gameDate, seasonType, week, team, plays: 0, dropbacks: 0, rushes: 0, neutral: split(), earlyDown: split(), redZone: split(), pace: { totalSeconds: 0, intervals: 0 } }; }
function split() { return { plays: 0, dropbacks: 0, rushes: 0 }; }
function addSplit(target, dropback) { target.plays += 1; if (dropback) target.dropbacks += 1; else target.rushes += 1; }

function emptyResult(season, currentWeek, teams, dataset, reasonCode) {
  const message = reasonCode === 'no_completed_weeks' ? 'nflverse will begin after the first completed 2026 games are published.' : dataset?.issues?.[0]?.message || 'nflverse tendency data is not available.';
  return {
    provider: 'nflverse', model: 'roster-relevant-offensive-tendencies', available: false, season, currentWeek,
    teams: teams.map((team) => ({ team, available: false, learning: true, season, currentWeek, period: null, window: { startWeek: 1, throughWeek: currentWeek - 1, includedGames: 0 }, metrics: {}, recentChange: { available: false, label: 'Not enough weekly data' }, weekly: [], issues: [{ code: reasonCode, message }] })),
    cache: { datasetKey: dataset ? `${season}:${currentWeek}:${dataset.dataVersion || 'unversioned'}` : null, dataVersion: dataset?.dataVersion || null, status: dataset?.cacheStatus || 'not_requested' },
    sourceUrl: dataset?.sourceUrl || buildNflversePbpUrl(season), retrievedAt: dataset?.retrievedAt || null, stale: Boolean(dataset?.stale), issues: dataset?.issues || [{ code: reasonCode, message }], limitations: ['No tendency is guessed when current-season play-by-play is unavailable.']
  };
}

function unavailableDataset(season, sourceUrl, nowDate, code, message) { return { provider: 'nflverse', available: false, season, games: [], sourceUrl, retrievedAt: nowDate.toISOString(), dataVersion: null, etag: null, lastModified: null, stale: false, reasonCode: code, issues: [{ code, message }] }; }

async function* parseCsvStream(stream) {
  let row = []; let field = ''; let state = 'plain';
  const decoder = new TextDecoder();
  const consume = function* (text) {
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (state === 'quoted') { if (char === '"') state = 'after_quote'; else field += char; continue; }
      if (state === 'after_quote') {
        if (char === '"') { field += '"'; state = 'quoted'; continue; }
        if (char === ',') { row.push(field); field = ''; state = 'plain'; continue; }
        if (char === '\n') { row.push(field); const complete = row; row = []; field = ''; state = 'plain'; yield complete; continue; }
        if (char === '\r') continue;
        state = 'plain';
      }
      if (char === '"' && field === '') state = 'quoted';
      else if (char === ',') { row.push(field); field = ''; }
      else if (char === '\n') { row.push(field); const complete = row; row = []; field = ''; yield complete; }
      else if (char !== '\r') field += char;
    }
  };
  for await (const chunk of stream) yield* consume(decoder.decode(chunk, { stream: true }));
  yield* consume(decoder.decode());
  if (field || row.length) { row.push(field); yield row; }
}

function parseCsvText(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) { if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; } else if (char === '"') quoted = false; else field += char; }
    else if (char === '"' && field === '') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

async function* toAsync(records) { for (const record of records) yield record; }
function normalizeTeams(values) { return [...new Set((values || []).map((value) => normalizeTeam(typeof value === 'object' ? value.abbreviation : value)).filter(Boolean))]; }
function normalizeTeam(value) { const team = String(value || '').trim().toUpperCase(); return ({ JAC: 'JAX', WAS: 'WSH', LA: 'LAR', STL: 'LAR', SD: 'LAC', OAK: 'LV' })[team] || team || null; }
function denormalizeWashington(value) { return value === 'WSH' ? 'WAS' : value; }
function compareGames(a, b) { return a.week - b.week || String(a.gameId).localeCompare(String(b.gameId)) || a.team.localeCompare(b.team); }
function safeRate(numerator, denominator) { return denominator > 0 ? roundRate(numerator / denominator) : null; }
function average(values) { const present = values.filter(Number.isFinite); return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null; }
function roundRate(value) { return Math.round(value * 1000) / 1000; }
function roundOne(value) { return Math.round(value * 10) / 10; }
function binary(value) { return Number(value) === 1 ? 1 : 0; }
function numberOrNull(value) { if (value == null || value === '') return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function integerOrNull(value) { const number = Number(value); return Number.isInteger(number) ? number : null; }
function positiveInteger(value, label) { const number = Number(value); if (!Number.isInteger(number) || number < 1) throw new TypeError(`${label} must be a positive integer`); return number; }
function textOrNull(value) { const text = String(value ?? '').trim(); return text || null; }
function isoDate(value) { const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || '')); return match?.[1] || null; }
function toIso(value) { const date = value instanceof Date ? value : new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function resolveNow(now) { const value = typeof now === 'function' ? now() : now; const date = value instanceof Date ? value : new Date(value); if (Number.isNaN(date.getTime())) throw new TypeError('now must resolve to a valid date'); return date; }
function headerValue(headers, name) { return typeof headers?.get === 'function' ? headers.get(name) : null; }
