import { gunzipSync } from 'node:zlib';

export const NFLVERSE_NGS_RELEASE_URL = 'https://github.com/nflverse/nflverse-data/releases/download/nextgen_stats';
export const NFLVERSE_NGS_DATASET_TTL_MS = 6 * 60 * 60_000;
export const NEXT_GEN_LEARNING_MESSAGE = 'Learning — no 2026 Next Gen Stats sample yet';

const STAT_TYPES = Object.freeze(['passing', 'receiving', 'rushing']);
const POSITION_STAT_TYPES = Object.freeze({
  QB: Object.freeze(['passing', 'rushing']),
  RB: Object.freeze(['rushing', 'receiving']),
  WR: Object.freeze(['receiving']),
  TE: Object.freeze(['receiving'])
});
const BASE_COLUMNS = Object.freeze(['season', 'season_type', 'week', 'player_display_name', 'player_position', 'team_abbr', 'player_gsis_id']);
const METRIC_FIELDS = Object.freeze({
  passing: Object.freeze({
    avg_time_to_throw: 'avgTimeToThrow',
    avg_completed_air_yards: 'avgCompletedAirYards',
    avg_intended_air_yards: 'avgIntendedAirYards',
    aggressiveness: 'aggressiveness',
    attempts: 'attempts',
    completion_percentage: 'completionPercentage',
    expected_completion_percentage: 'expectedCompletionPercentage',
    completion_percentage_above_expectation: 'completionPercentageAboveExpectation'
  }),
  receiving: Object.freeze({
    avg_cushion: 'avgCushion',
    avg_separation: 'avgSeparation',
    avg_intended_air_yards: 'avgIntendedAirYards',
    percent_share_of_intended_air_yards: 'percentShareOfIntendedAirYards',
    receptions: 'receptions',
    targets: 'targets',
    avg_yac: 'avgYac',
    avg_expected_yac: 'avgExpectedYac',
    avg_yac_above_expectation: 'avgYacAboveExpectation'
  }),
  rushing: Object.freeze({
    efficiency: 'efficiency',
    percent_attempts_gte_eight_defenders: 'percentAttemptsGteEightDefenders',
    avg_time_to_los: 'avgTimeToLos',
    rush_attempts: 'rushAttempts',
    expected_rush_yards: 'expectedRushYards',
    rush_yards_over_expected: 'rushYardsOverExpected',
    rush_yards_over_expected_per_att: 'rushYardsOverExpectedPerAtt',
    rush_pct_over_expected: 'rushPctOverExpected'
  })
});

export function buildNflverseNextGenUrl(statType) {
  const type = normalizeStatType(statType);
  return `${NFLVERSE_NGS_RELEASE_URL}/ngs_${type}.csv.gz`;
}

export function createNflverseNextGenStatsProvider(defaults = {}) {
  const cache = defaults.cache instanceof Map ? defaults.cache : new Map();
  const pending = new Map();
  return {
    fetch: (options = {}) => fetchNflverseNextGenStats({ ...defaults, ...options, cache, pending }),
    clearCache: () => { cache.clear(); pending.clear(); },
    get cacheSize() { return cache.size; }
  };
}

export async function fetchNflverseNextGenStats({
  season,
  currentWeek,
  players,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  cache = new Map(),
  pending = new Map(),
  cacheTtlMs = NFLVERSE_NGS_DATASET_TTL_MS,
  timeoutMs = 30_000
} = {}) {
  const year = positiveInteger(season, 'season');
  const week = positiveInteger(currentWeek, 'currentWeek');
  const requestedPlayers = normalizeRequestedPlayers(players);
  if (!requestedPlayers.length) return emptyResult(year, week, []);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const types = [...new Set(requestedPlayers.flatMap((player) => POSITION_STAT_TYPES[player.position]))].sort();
  const loaded = await Promise.all(types.map(async (statType) => [
    statType,
    await getDataset({ statType, fetchImpl, now, cache, pending, cacheTtlMs, timeoutMs })
  ]));
  return summarizeNflverseNextGenStats(Object.fromEntries(loaded), { season: year, currentWeek: week, players: requestedPlayers });
}

/** Parse a deterministic, already-decompressed nflverse NGS CSV fixture. */
export function normalizeNflverseNextGenCsv(csv, { statType, sourceUrl = null, retrievedAt = null, dataVersion = null } = {}) {
  if (typeof csv !== 'string') throw new TypeError('csv must be a string');
  const type = normalizeStatType(statType);
  const records = parseCsvText(csv);
  if (!records.length) return unavailableDataset(type, sourceUrl || buildNflverseNextGenUrl(type), retrievedAt, 'empty_dataset', 'The nflverse Next Gen file was empty.');
  const header = records[0].map((value, index) => index === 0 ? value.replace(/^\uFEFF/, '') : value);
  const required = [...BASE_COLUMNS, ...Object.keys(METRIC_FIELDS[type])];
  const indexes = Object.fromEntries(required.map((name) => [name, header.indexOf(name)]));
  const missing = required.filter((name) => indexes[name] < 0);
  if (missing.length) throw new Error(`nflverse ${type} CSV is missing required columns: ${missing.join(', ')}`);
  const rows = [];
  for (const values of records.slice(1)) {
    const get = (name) => values[indexes[name]] ?? '';
    const normalized = {
      season: integerOrNull(get('season')),
      seasonType: textOrNull(get('season_type'))?.toUpperCase() || null,
      week: integerOrNull(get('week')),
      playerName: textOrNull(get('player_display_name')),
      position: textOrNull(get('player_position'))?.toUpperCase() || null,
      team: normalizeTeam(get('team_abbr')),
      gsisId: textOrNull(get('player_gsis_id')),
      metrics: Object.fromEntries(Object.entries(METRIC_FIELDS[type]).map(([column, key]) => [key, numberOrNull(get(column))]))
    };
    if (normalized.season && normalized.seasonType && normalized.week != null && normalized.playerName && normalized.position) rows.push(normalized);
  }
  return {
    provider: 'nflverse',
    model: 'next-gen-stats',
    statType: type,
    available: true,
    rows: rows.sort(compareRows),
    sourceUrl: sourceUrl || buildNflverseNextGenUrl(type),
    retrievedAt: isoOrNull(retrievedAt),
    dataVersion: textOrNull(dataVersion),
    etag: null,
    lastModified: null,
    stale: false,
    issues: []
  };
}

export function summarizeNflverseNextGenStats(datasets, { season, currentWeek, players } = {}) {
  const year = positiveInteger(season, 'season');
  const week = positiveInteger(currentWeek, 'currentWeek');
  const requestedPlayers = normalizeRequestedPlayers(players);
  const normalizedDatasets = Object.fromEntries(STAT_TYPES.map((type) => [type, datasets?.[type] || null]));
  const outputs = requestedPlayers.map((player) => summarizePlayer(player, normalizedDatasets, year, week));
  const usedTypes = [...new Set(requestedPlayers.flatMap((player) => POSITION_STAT_TYPES[player.position]))].sort();
  const usedDatasets = usedTypes.map((type) => normalizedDatasets[type]).filter(Boolean);
  return {
    provider: 'nflverse',
    model: 'roster-relevant-next-gen-stats',
    season: year,
    currentWeek: week,
    available: outputs.some((player) => player.current?.available),
    historicalReferenceAvailable: outputs.some((player) => player.reference?.available),
    players: outputs,
    cache: {
      datasets: usedTypes.map((statType) => datasetCacheRecord(statType, normalizedDatasets[statType]))
    },
    sourceUrls: usedTypes.map((type) => normalizedDatasets[type]?.sourceUrl || buildNflverseNextGenUrl(type)),
    retrievedAt: latestIso(usedDatasets.map((dataset) => dataset?.retrievedAt)),
    stale: usedDatasets.some((dataset) => dataset?.stale),
    issues: usedDatasets.flatMap((dataset) => dataset?.issues || []),
    decisionUse: 'descriptive_only',
    projectionsAdjusted: false,
    safeguards: { readOnly: true, transactionsPerformed: false },
    limitations: [
      'Next Gen Stats is descriptive context and is not used to alter fantasy projections or recommendations.',
      'Players below NFL Next Gen Stats qualification thresholds can be absent; absence is not treated as zero.',
      'Prior-season values are labeled as historical reference and are never presented as current-season evidence.'
    ]
  };
}

async function getDataset({ statType, fetchImpl, now, cache, pending, cacheTtlMs, timeoutMs }) {
  const key = normalizeStatType(statType);
  const nowDate = resolveNow(now);
  const saved = cache.get(key);
  if (saved && nowDate.getTime() - Date.parse(saved.cachedAt) <= cacheTtlMs) return { ...saved.dataset, cacheStatus: 'memory_hit' };
  if (pending.has(key)) return pending.get(key);
  const task = loadDataset({ statType: key, fetchImpl, nowDate, saved, timeoutMs }).then((dataset) => {
    cache.set(key, { cachedAt: nowDate.toISOString(), dataset });
    return dataset;
  }).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

async function loadDataset({ statType, fetchImpl, nowDate, saved, timeoutMs }) {
  const sourceUrl = buildNflverseNextGenUrl(statType);
  const headers = { Accept: 'application/gzip,application/octet-stream' };
  if (saved?.dataset?.etag) headers['If-None-Match'] = saved.dataset.etag;
  if (saved?.dataset?.lastModified) headers['If-Modified-Since'] = saved.dataset.lastModified;
  try {
    const response = await fetchImpl(sourceUrl, { headers, signal: globalThis.AbortSignal?.timeout?.(timeoutMs) });
    if (response?.status === 304 && saved?.dataset) return { ...saved.dataset, retrievedAt: nowDate.toISOString(), stale: false, cacheStatus: 'revalidated' };
    if (response?.status === 404) return unavailableDataset(statType, sourceUrl, nowDate, 'dataset_not_published', `The nflverse ${statType} Next Gen file has not been published.`);
    if (!response?.ok) throw new Error(`nflverse ${statType} Next Gen Stats returned HTTP ${response?.status ?? 'unknown'}`);
    const etag = headerValue(response.headers, 'etag');
    const lastModified = headerValue(response.headers, 'last-modified');
    const dataVersion = etag || lastModified || nowDate.toISOString();
    const csv = gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8');
    const dataset = normalizeNflverseNextGenCsv(csv, { statType, sourceUrl, retrievedAt: nowDate.toISOString(), dataVersion });
    return { ...dataset, etag, lastModified, cacheStatus: 'downloaded' };
  } catch (error) {
    if (saved?.dataset?.available) {
      return { ...saved.dataset, stale: true, cacheStatus: 'cached_after_failure', issues: [...(saved.dataset.issues || []), { code: 'refresh_failed', statType, message: error.message }] };
    }
    return unavailableDataset(statType, sourceUrl, nowDate, 'dataset_unavailable', error.message);
  }
}

function summarizePlayer(player, datasets, season, currentWeek) {
  const identity = resolveIdentity(player, datasets, season);
  const types = POSITION_STAT_TYPES[player.position];
  const currentRows = identity.gsisId ? Object.fromEntries(types.map((type) => [type, selectSeasonRow(datasets[type]?.rows, identity.gsisId, season, currentWeek)])) : {};
  const referenceSeason = season - 1;
  const referenceRows = identity.gsisId ? Object.fromEntries(types.map((type) => [type, selectSeasonRow(datasets[type]?.rows, identity.gsisId, referenceSeason, null)])) : {};
  const current = buildSeasonContext(player.position, currentRows, datasets, season);
  const reference = buildSeasonContext(player.position, referenceRows, datasets, referenceSeason, 'reference');
  const issues = [];
  if (!identity.gsisId) issues.push({ code: identity.reason || 'player_unresolved', message: identity.message || 'No unambiguous Next Gen Stats player match was found.' });
  if (!current) issues.push({ code: 'no_current_season_sample', message: `No qualifying ${season} Next Gen Stats sample is available for this player.` });
  return {
    requestedPlayerId: player.requestedPlayerId,
    name: player.name,
    position: player.position,
    nflTeam: player.nflTeam,
    playerGsisId: identity.gsisId,
    resolvedBy: identity.resolvedBy,
    available: Boolean(current),
    learning: !current,
    status: current ? current.descriptions[0] : learningMessage(season),
    current,
    reference,
    issues
  };
}

function buildSeasonContext(position, rowsByType, datasets, season, kind = 'current') {
  const rows = Object.fromEntries(Object.entries(rowsByType || {}).filter(([, row]) => row));
  if (!Object.keys(rows).length) return null;
  const metrics = displayMetrics(position, rows).slice(0, 5);
  return {
    available: true,
    season,
    label: kind === 'reference' ? `${season} reference` : `${season} current`,
    sample: Object.fromEntries(Object.entries(rows).map(([type, row]) => [type, { week: row.week, basis: row.week === 0 ? 'regular-season summary' : `Week ${row.week}` }])),
    descriptions: describeRows(position, rows, datasets, season),
    metrics
  };
}

function resolveIdentity(player, datasets, season) {
  if (player.gsisId) return { gsisId: player.gsisId, resolvedBy: 'gsis_id' };
  const normalizedName = normalizeName(player.name);
  if (!normalizedName) return { gsisId: null, resolvedBy: null, reason: 'durable_id_unavailable', message: 'No GSIS ID or usable exact player name was supplied.' };
  const referenceSeason = season - 1;
  const candidates = [];
  for (const type of POSITION_STAT_TYPES[player.position]) {
    for (const row of datasets[type]?.rows || []) {
      if (![season, referenceSeason].includes(row.season) || row.seasonType !== 'REG' || row.position !== player.position || normalizeName(row.playerName) !== normalizedName || !row.gsisId) continue;
      candidates.push(row);
    }
  }
  const ids = [...new Set(candidates.map((row) => row.gsisId))];
  if (ids.length === 1) return { gsisId: ids[0], resolvedBy: 'exact_name_position' };
  if (ids.length > 1 && player.nflTeam) {
    const teamIds = [...new Set(candidates.filter((row) => row.team === player.nflTeam).map((row) => row.gsisId))];
    if (teamIds.length === 1) return { gsisId: teamIds[0], resolvedBy: 'exact_name_position_team' };
  }
  return ids.length > 1
    ? { gsisId: null, resolvedBy: null, reason: 'ambiguous_player_match', message: 'Exact name and position matched more than one GSIS player; no match was guessed.' }
    : { gsisId: null, resolvedBy: null, reason: 'player_not_found', message: 'No exact name-and-position match was found in current or prior-season Next Gen Stats.' };
}

function selectSeasonRow(rows = [], gsisId, season, currentWeek) {
  const matches = rows.filter((row) => row.gsisId === gsisId && row.season === season && row.seasonType === 'REG');
  const summary = matches.find((row) => row.week === 0);
  if (summary) return summary;
  return matches.filter((row) => row.week > 0 && (currentWeek == null || row.week < currentWeek)).sort((a, b) => b.week - a.week)[0] || null;
}

function displayMetrics(position, rows) {
  if (position === 'QB') {
    const passing = rows.passing?.metrics || {};
    const rushing = rows.rushing?.metrics || {};
    return compact([
      metric('time_to_throw', 'Time to throw', 'passing', { avgTimeToThrow: passing.avgTimeToThrow }, passing.avgTimeToThrow == null ? null : `${fixed(passing.avgTimeToThrow, 2)} sec`),
      metric('air_yards', 'Intended / completed air yards', 'passing', { avgIntendedAirYards: passing.avgIntendedAirYards, avgCompletedAirYards: passing.avgCompletedAirYards }, pair(passing.avgIntendedAirYards, passing.avgCompletedAirYards, 1)),
      metric('aggressiveness', 'Aggressiveness', 'passing', { aggressiveness: passing.aggressiveness }, percentage(passing.aggressiveness)),
      metric('completion_expectation', 'Expected completion / CPOE', 'passing', { expectedCompletionPercentage: passing.expectedCompletionPercentage, completionPercentageAboveExpectation: passing.completionPercentageAboveExpectation }, percentPair(passing.expectedCompletionPercentage, passing.completionPercentageAboveExpectation)),
      metric('rushing_over_expected', 'Rushing yards over expected / att', 'rushing', { rushYardsOverExpectedPerAtt: rushing.rushYardsOverExpectedPerAtt }, signed(rushing.rushYardsOverExpectedPerAtt, 2))
    ]);
  }
  if (position === 'RB') {
    const rushing = rows.rushing?.metrics || {};
    const receiving = rows.receiving?.metrics || {};
    return compact([
      metric('rushing_efficiency', 'Rushing efficiency', 'rushing', { efficiency: rushing.efficiency }, fixedOrNull(rushing.efficiency, 2)),
      metric('time_to_los', 'Time behind line', 'rushing', { avgTimeToLos: rushing.avgTimeToLos }, rushing.avgTimeToLos == null ? null : `${fixed(rushing.avgTimeToLos, 2)} sec`),
      metric('rushing_over_expected', 'Rushing yards over expected / att', 'rushing', { rushYardsOverExpectedPerAtt: rushing.rushYardsOverExpectedPerAtt }, signed(rushing.rushYardsOverExpectedPerAtt, 2)),
      metric('stacked_box', '8+ defenders in box', 'rushing', { percentAttemptsGteEightDefenders: rushing.percentAttemptsGteEightDefenders }, percentage(rushing.percentAttemptsGteEightDefenders)),
      metric('receiving_context', 'Targets / YAC above expected', 'receiving', { targets: receiving.targets, avgYacAboveExpectation: receiving.avgYacAboveExpectation }, countSignedPair(receiving.targets, receiving.avgYacAboveExpectation))
    ]);
  }
  const receiving = rows.receiving?.metrics || {};
  return compact([
    metric('targets', 'Targets', 'receiving', { targets: receiving.targets }, receiving.targets == null ? null : String(Math.round(receiving.targets))),
    metric('separation_cushion', 'Separation / cushion', 'receiving', { avgSeparation: receiving.avgSeparation, avgCushion: receiving.avgCushion }, pair(receiving.avgSeparation, receiving.avgCushion, 1)),
    metric('target_depth', 'Intended air yards', 'receiving', { avgIntendedAirYards: receiving.avgIntendedAirYards }, fixedOrNull(receiving.avgIntendedAirYards, 1)),
    metric('air_yards_share', 'Team intended air-yard share', 'receiving', { percentShareOfIntendedAirYards: receiving.percentShareOfIntendedAirYards }, percentage(receiving.percentShareOfIntendedAirYards)),
    metric('yac_expectation', 'YAC / expected / above', 'receiving', { avgYac: receiving.avgYac, avgExpectedYac: receiving.avgExpectedYac, avgYacAboveExpectation: receiving.avgYacAboveExpectation }, triple(receiving.avgYac, receiving.avgExpectedYac, receiving.avgYacAboveExpectation))
  ]);
}

function describeRows(position, rows, datasets, season) {
  const descriptions = [];
  if (position === 'QB' && rows.passing) {
    const metrics = rows.passing.metrics;
    descriptions.push(relativeDescription(metrics.avgTimeToThrow, baseline(datasets.passing, season, rows.passing.position, 'avgTimeToThrow'), 0.15, 'Longer time to throw than qualifying QBs', 'Quick release relative to qualifying QBs', 'Near qualifying-QB average time to throw'));
    descriptions.push(relativeDescription(metrics.avgIntendedAirYards, baseline(datasets.passing, season, rows.passing.position, 'avgIntendedAirYards'), 1, 'Deeper target profile than qualifying QBs', 'Shorter target profile than qualifying QBs', 'Near qualifying-QB average target depth'));
    descriptions.push(directDescription(metrics.completionPercentageAboveExpectation, 2, 'Completion rate above expectation', 'Completion rate below expectation', 'Completion rate near expectation'));
  } else if (position === 'RB' && rows.rushing) {
    const metrics = rows.rushing.metrics;
    descriptions.push(relativeDescription(metrics.efficiency, baseline(datasets.rushing, season, rows.rushing.position, 'efficiency'), 0.3, 'More lateral rushing path than qualifying RBs', 'More direct rushing path than qualifying RBs', 'Near qualifying-RB average rushing path'));
    descriptions.push(directDescription(metrics.rushYardsOverExpectedPerAtt, 0.4, 'Rushing above expected yards per attempt', 'Rushing below expected yards per attempt', 'Rushing near expected yards per attempt'));
    descriptions.push(relativeDescription(metrics.percentAttemptsGteEightDefenders, baseline(datasets.rushing, season, rows.rushing.position, 'percentAttemptsGteEightDefenders'), 5, 'Facing stacked boxes more often than qualifying RBs', 'Facing stacked boxes less often than qualifying RBs', 'Near qualifying-RB average stacked-box rate'));
  } else if (rows.receiving) {
    const metrics = rows.receiving.metrics;
    descriptions.push(relativeDescription(metrics.avgSeparation, baseline(datasets.receiving, season, rows.receiving.position, 'avgSeparation'), 0.4, 'More separation than qualifying peers', 'Less separation than qualifying peers', 'Near qualifying-peer average separation'));
    descriptions.push(relativeDescription(metrics.avgIntendedAirYards, baseline(datasets.receiving, season, rows.receiving.position, 'avgIntendedAirYards'), 1.5, 'Deeper target profile than qualifying peers', 'Shorter target profile than qualifying peers', 'Near qualifying-peer average target depth'));
    descriptions.push(directDescription(metrics.avgYacAboveExpectation, 0.5, 'YAC above expectation', 'YAC below expectation', 'YAC near expectation'));
  }
  return compact(descriptions).slice(0, 3).length ? compact(descriptions).slice(0, 3) : ['Qualifying Next Gen Stats sample available'];
}

function baseline(dataset, season, position, metricKey) {
  const summaryRows = (dataset?.rows || []).filter((row) => row.season === season && row.seasonType === 'REG' && row.week === 0 && row.position === position && row.metrics[metricKey] != null);
  const rows = summaryRows.length ? summaryRows : (dataset?.rows || []).filter((row) => row.season === season && row.seasonType === 'REG' && row.position === position && row.metrics[metricKey] != null);
  if (!rows.length) return null;
  return rows.reduce((total, row) => total + row.metrics[metricKey], 0) / rows.length;
}

function relativeDescription(value, average, threshold, high, low, middle) {
  if (value == null || average == null) return null;
  return value >= average + threshold ? high : value <= average - threshold ? low : middle;
}

function directDescription(value, threshold, high, low, middle) {
  if (value == null) return null;
  return value >= threshold ? high : value <= -threshold ? low : middle;
}

function metric(key, label, statType, values, display) {
  return display == null ? null : { key, label, statType, values, display };
}

function datasetCacheRecord(statType, dataset) {
  const dataVersion = dataset?.dataVersion || null;
  return {
    statType,
    datasetKey: dataVersion ? `${statType}:${dataVersion}` : null,
    dataVersion,
    status: dataset?.cacheStatus || (dataset?.available ? 'loaded' : 'unavailable'),
    sourceUrl: dataset?.sourceUrl || buildNflverseNextGenUrl(statType)
  };
}

function normalizeRequestedPlayers(players) {
  if (!Array.isArray(players)) throw new TypeError('players must be an array');
  const seen = new Set();
  return players.flatMap((value, index) => {
    if (!value || typeof value !== 'object') return [];
    const position = textOrNull(value.position)?.toUpperCase();
    const requestedPlayerId = textOrNull(value.requestedPlayerId ?? value.playerId ?? value.id) || `index:${index}`;
    if (!POSITION_STAT_TYPES[position] || seen.has(requestedPlayerId)) return [];
    seen.add(requestedPlayerId);
    return [{
      requestedPlayerId,
      name: textOrNull(value.name),
      position,
      nflTeam: normalizeTeam(value.nflTeam ?? value.team),
      gsisId: textOrNull(value.gsisId ?? value.playerGsisId ?? value.externalIds?.gsis)
    }];
  });
}

function emptyResult(season, currentWeek, players) {
  return {
    provider: 'nflverse', model: 'roster-relevant-next-gen-stats', season, currentWeek, available: false, historicalReferenceAvailable: false,
    players, cache: { datasets: [] }, sourceUrls: [], retrievedAt: null, stale: false, issues: [], decisionUse: 'descriptive_only', projectionsAdjusted: false,
    safeguards: { readOnly: true, transactionsPerformed: false }, limitations: ['No roster-relevant QB, RB, WR, or TE was supplied.']
  };
}

function unavailableDataset(statType, sourceUrl, nowValue, code, message) {
  return {
    provider: 'nflverse', model: 'next-gen-stats', statType, available: false, rows: [], sourceUrl,
    retrievedAt: isoOrNull(nowValue), dataVersion: null, etag: null, lastModified: null, stale: false,
    reasonCode: code, issues: [{ code, statType, message }], cacheStatus: 'unavailable'
  };
}

function normalizeStatType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (!STAT_TYPES.includes(type)) throw new TypeError(`statType must be one of: ${STAT_TYPES.join(', ')}`);
  return type;
}

function normalizeTeam(value) {
  const team = textOrNull(value)?.toUpperCase();
  return ({ JAC: 'JAX', LA: 'LAR', OAK: 'LV', SD: 'LAC', STL: 'LAR', WAS: 'WSH' }[team] || team || null);
}

function normalizeName(value) {
  return textOrNull(value)?.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '') || null;
}

function compareRows(a, b) {
  return a.season - b.season || a.week - b.week || String(a.gsisId || a.playerName).localeCompare(String(b.gsisId || b.playerName));
}

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows.filter((values) => values.some((value) => value !== ''));
}

function numberOrNull(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  const number = numberOrNull(value);
  return Number.isInteger(number) ? number : null;
}

function textOrNull(value) {
  const text = value == null ? '' : String(value).trim();
  return text || null;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new TypeError(`${label} must be a positive integer`);
  return number;
}

function headerValue(headers, name) {
  return typeof headers?.get === 'function' ? textOrNull(headers.get(name)) : null;
}

function resolveNow(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('now must resolve to a valid date');
  return date;
}

function isoOrNull(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function latestIso(values) {
  return values.filter(Boolean).sort().at(-1) || null;
}

function learningMessage(season) {
  return season === 2026 ? NEXT_GEN_LEARNING_MESSAGE : `Learning — no ${season} Next Gen Stats sample yet`;
}

function compact(values) { return values.filter((value) => value != null); }
function fixed(value, digits) { return Number(value).toFixed(digits); }
function fixedOrNull(value, digits) { return value == null ? null : fixed(value, digits); }
function percentage(value) { return value == null ? null : `${fixed(value, 1)}%`; }
function signed(value, digits = 1) { return value == null ? null : `${value >= 0 ? '+' : ''}${fixed(value, digits)}`; }
function pair(first, second, digits) { return first == null && second == null ? null : `${first == null ? '—' : fixed(first, digits)} / ${second == null ? '—' : fixed(second, digits)}`; }
function percentPair(first, second) { return first == null && second == null ? null : `${first == null ? '—' : `${fixed(first, 1)}%`} / ${second == null ? '—' : `${signed(second, 1)} pp`}`; }
function countSignedPair(first, second) { return first == null && second == null ? null : `${first == null ? '—' : Math.round(first)} / ${second == null ? '—' : signed(second, 1)}`; }
function triple(first, second, third) { return first == null && second == null && third == null ? null : `${first == null ? '—' : fixed(first, 1)} / ${second == null ? '—' : fixed(second, 1)} / ${third == null ? '—' : signed(third, 1)}`; }
