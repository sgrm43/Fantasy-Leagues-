export const HISTORICAL_PRIOR_OUTCOME_CUTOFF_SEASON = 2026;

export const HISTORICAL_PRIOR_SAMPLE_THRESHOLDS = Object.freeze({
  strong: 50,
  moderate: 25,
  weak: 10
});

export const HISTORICAL_PRIOR_DRAFT_BUCKETS = Object.freeze([
  'R1',
  'R2-3',
  'R4-5',
  'R6-7',
  'UDFA'
]);

export const HISTORICAL_PRIOR_USAGE_BUCKETS = Object.freeze({
  QB: Object.freeze({ metric: 'pass attempts per game', mediumAt: 28, highAt: 35 }),
  RB: Object.freeze({ metric: 'rush attempts per game', mediumAt: 10, highAt: 17 }),
  WR: Object.freeze({ metric: 'targets per game', mediumAt: 5, highAt: 8 }),
  TE: Object.freeze({ metric: 'targets per game', mediumAt: 4, highAt: 6.5 })
});

export const HISTORICAL_PRIOR_COHORT_ORDER = Object.freeze([
  Object.freeze({ key: 'position+career+draft+usage', fields: Object.freeze(['position', 'careerBucket', 'draftBucket', 'usageBucket']) }),
  Object.freeze({ key: 'position+career+usage', fields: Object.freeze(['position', 'careerBucket', 'usageBucket']) }),
  Object.freeze({ key: 'position+career+draft', fields: Object.freeze(['position', 'careerBucket', 'draftBucket']) }),
  Object.freeze({ key: 'position+career', fields: Object.freeze(['position', 'careerBucket']) })
]);

const SAFE_METADATA_FALLBACKS = Object.freeze([
  Object.freeze({ key: 'position+usage', fields: Object.freeze(['position', 'usageBucket']) }),
  Object.freeze({ key: 'position', fields: Object.freeze(['position']) })
]);
const SUPPORTED_POSITIONS = new Set(Object.keys(HISTORICAL_PRIOR_USAGE_BUCKETS));
const USAGE_BUCKET_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });
const PRIOR_VERSION = 'historical-player-archetype-v1';

/**
 * Build descriptive historical priors for roster players. Historical outcomes
 * are hard-limited to seasons completed before 2026 and never alter decisions.
 */
export function buildHistoricalArchetypePriors({ players = [], playerSeasons = [] } = {}) {
  if (!Array.isArray(players)) throw new TypeError('players must be an array');
  if (!Array.isArray(playerSeasons)) throw new TypeError('playerSeasons must be an array');
  const rows = normalizePlayerSeasons(playerSeasons);
  const outputs = players.map((player) => buildOnePrior(player, rows));
  return {
    provider: 'existing historical datasets',
    model: PRIOR_VERSION,
    outcomeCutoffSeason: HISTORICAL_PRIOR_OUTCOME_CUTOFF_SEASON,
    sourceSeasonMaximum: HISTORICAL_PRIOR_OUTCOME_CUTOFF_SEASON - 2,
    followUpSeasonMaximum: HISTORICAL_PRIOR_OUTCOME_CUTOFF_SEASON - 1,
    thresholds: { ...HISTORICAL_PRIOR_SAMPLE_THRESHOLDS, insufficientBelow: HISTORICAL_PRIOR_SAMPLE_THRESHOLDS.weak },
    cohortOrder: HISTORICAL_PRIOR_COHORT_ORDER.map((level) => level.key),
    players: outputs,
    available: outputs.some((player) => player.status === 'available'),
    decisionUse: 'descriptive_only',
    projectionsAdjusted: false,
    optimizerAdjusted: false,
    safeguards: { readOnly: true, transactionsPerformed: false },
    limitations: [
      'Historical cohorts are descriptive and are not projection or recommendation weights.',
      'Missing next-season rows are excluded rather than treated as zero production.',
      'Age, draft capital, and career year are never inferred when the supplied data omits them.',
      'Source availability and qualification rules can create survivor and selection bias.'
    ]
  };
}

export function buildHistoricalArchetypePrior(player, playerSeasons = []) {
  if (!Array.isArray(playerSeasons)) throw new TypeError('playerSeasons must be an array');
  return buildOnePrior(player, normalizePlayerSeasons(playerSeasons));
}

export function draftBucket(value) {
  if (value?.undrafted === true) return 'UDFA';
  const supplied = value && typeof value === 'object'
    ? value.draftRound ?? value.draft_round ?? value.draftBucket
    : value;
  if (typeof supplied === 'string') {
    const normalized = supplied.trim().toUpperCase().replace(/\s+/g, '');
    if (normalized === 'UDFA' || normalized === 'UNDRAFTED') return 'UDFA';
    if (HISTORICAL_PRIOR_DRAFT_BUCKETS.includes(normalized)) return normalized;
  }
  if (supplied == null || supplied === '') return null;
  const round = Number(supplied);
  if (!Number.isInteger(round)) return null;
  if (round === 0) return 'UDFA';
  if (round === 1) return 'R1';
  if (round >= 2 && round <= 3) return 'R2-3';
  if (round >= 4 && round <= 5) return 'R4-5';
  if (round >= 6 && round <= 7) return 'R6-7';
  return null;
}

export function careerBucket(value) {
  if (value == null || value === '') return null;
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1) return null;
  if (year <= 3) return `year_${year}`;
  if (year <= 5) return 'years_4_5';
  return 'years_6_plus';
}

export function usageBucket(position, value) {
  const normalizedPosition = normalizePosition(position);
  const usage = finiteNonNegative(value);
  const definition = HISTORICAL_PRIOR_USAGE_BUCKETS[normalizedPosition];
  if (!definition || usage == null) return null;
  if (usage >= definition.highAt) return 'high';
  if (usage >= definition.mediumAt) return 'medium';
  return 'low';
}

export function sampleStrength(sampleSize) {
  const count = nonNegativeInteger(sampleSize);
  if (count >= HISTORICAL_PRIOR_SAMPLE_THRESHOLDS.strong) return 'strong';
  if (count >= HISTORICAL_PRIOR_SAMPLE_THRESHOLDS.moderate) return 'moderate';
  if (count >= HISTORICAL_PRIOR_SAMPLE_THRESHOLDS.weak) return 'weak';
  return 'insufficient';
}

/**
 * Convert existing normalized nflverse NGS rows without inventing metadata.
 * Weekly NGS rows can provide primary positional opportunity per observed week;
 * summary-only rows remain visible but cannot be converted to per-game usage.
 */
export function convertNflverseNextGenDatasetsToPlayerSeasons(datasets = {}) {
  const groups = new Map();
  for (const statType of ['passing', 'receiving', 'rushing']) {
    for (const row of datasets?.[statType]?.rows || []) {
      const season = positiveIntegerOrNull(row?.season);
      const position = normalizePosition(row?.position);
      const playerId = text(row?.gsisId);
      if (!season || season >= HISTORICAL_PRIOR_OUTCOME_CUTOFF_SEASON || !position || !playerId || String(row?.seasonType || '').toUpperCase() !== 'REG') continue;
      if (primaryNgsStatType(position) !== statType) continue;
      const key = `${playerId}|${season}|${position}`;
      const group = groups.get(key) || {
        playerId,
        gsisId: playerId,
        playerName: text(row.playerName),
        season,
        position,
        team: text(row.team),
        weekly: new Map(),
        summaryOpportunity: null
      };
      const opportunity = ngsOpportunity(position, row?.metrics);
      const week = Number(row?.week);
      if (Number.isInteger(week) && week > 0 && opportunity != null) group.weekly.set(week, opportunity);
      if (week === 0 && opportunity != null) group.summaryOpportunity = opportunity;
      if (!group.playerName && text(row.playerName)) group.playerName = text(row.playerName);
      if (text(row.team)) group.team = text(row.team);
      groups.set(key, group);
    }
  }
  return [...groups.values()].sort(comparePlayerSeason).map((group) => {
    const weeklyValues = [...group.weekly.entries()].sort((left, right) => left[0] - right[0]).map(([, value]) => value);
    return {
      playerId: group.playerId,
      gsisId: group.gsisId,
      playerName: group.playerName,
      season: group.season,
      position: group.position,
      team: group.team,
      careerYear: null,
      draftRound: null,
      opportunityPerGame: weeklyValues.length ? round(mean(weeklyValues), 4) : null,
      opportunityTotal: group.summaryOpportunity,
      fantasyPointsPerGame: null,
      games: weeklyValues.length || null,
      source: 'nflverse-next-gen-stats',
      missingMetadata: ['careerYear', 'draftRound', 'fantasyPointsPerGame'],
      limitations: weeklyValues.length
        ? ['Opportunity per game uses observed weekly NGS rows, which can omit non-qualifying weeks.']
        : ['Only an NGS season summary was available, so per-game opportunity was not inferred.']
    };
  });
}

function buildOnePrior(player, rows) {
  const target = normalizeTarget(player);
  if (!target.position) return unavailablePrior(target, 'unsupported_position', 'A supported QB, RB, WR, or TE position is required.');

  const levels = target.careerBucket
    ? HISTORICAL_PRIOR_COHORT_ORDER
    : [...HISTORICAL_PRIOR_COHORT_ORDER, ...SAFE_METADATA_FALLBACKS];
  const attempts = [];
  let selected = null;
  for (const level of levels) {
    const missingTargetFields = level.fields.filter((field) => target[field] == null);
    if (missingTargetFields.length) {
      attempts.push({ level: level.key, eligible: false, sampleSize: 0, reason: `target_${missingTargetFields.join('_and_')}_unavailable` });
      continue;
    }
    if (!target.careerBucket && !level.key.startsWith('position+career') && level.key === 'position+usage' && !target.usageBucket) continue;
    const evaluated = evaluateLevel(level, target, rows);
    attempts.push({ level: level.key, eligible: true, sampleSize: evaluated.pairs.length, candidateSourceSeasons: evaluated.candidates.length, missingFollowUp: evaluated.missingFollowUp, missingOutcome: evaluated.missingOutcome, reason: evaluated.pairs.length < HISTORICAL_PRIOR_SAMPLE_THRESHOLDS.weak ? 'below_minimum_sample' : null });
    selected = { level, ...evaluated };
    if (evaluated.pairs.length >= HISTORICAL_PRIOR_SAMPLE_THRESHOLDS.weak) break;
  }
  if (!selected) return unavailablePrior(target, 'cohort_metadata_unavailable', 'No safe cohort level could be evaluated.', attempts);

  const strength = sampleStrength(selected.pairs.length);
  const fallback = !selected.level.key.startsWith('position+career');
  const fallbackReasons = fallback
    ? [
        'career_year_unavailable',
        selected.level.key === 'position' && target.usageBucket == null ? 'usage_metadata_unavailable' : null,
        target.draftBucket != null ? 'draft_not_used_without_verified_career_stage' : null
      ].filter(Boolean)
    : [];
  const sourceSeasons = [...new Set(selected.pairs.map((pair) => pair.source.season))].sort((a, b) => a - b);
  const uniquePlayers = new Set(selected.pairs.map((pair) => pair.source.playerId));
  return {
    requestedPlayerId: target.requestedPlayerId,
    name: target.name,
    position: target.position,
    status: strength === 'insufficient' ? 'learning' : 'available',
    sampleStrength: strength,
    profile: profileView(target),
    cohort: {
      level: selected.level.key,
      criteria: Object.fromEntries(selected.level.fields.map((field) => [field, target[field]])),
      fallback,
      fallbackReasons,
      attempts,
      sample: {
        completedFollowUps: selected.pairs.length,
        uniquePlayers: uniquePlayers.size,
        sourceSeasons,
        earliestSourceSeason: sourceSeasons[0] ?? null,
        latestSourceSeason: sourceSeasons.at(-1) ?? null,
        candidateSourceSeasons: selected.candidates.length,
        excludedMissingFollowUp: selected.missingFollowUp,
        excludedMissingOutcome: selected.missingOutcome
      }
    },
    outcomes: summarizeOutcomes(selected.pairs),
    message: strength === 'insufficient'
      ? `Learning — only ${selected.pairs.length} completed historical follow-up${selected.pairs.length === 1 ? '' : 's'} matched this cohort.`
      : `${capitalize(strength)} historical cohort (${selected.pairs.length} completed follow-ups).`,
    issues: target.missingMetadata.map((field) => ({ code: `${field}_unavailable`, message: `${field} was not supplied and was not inferred.` })),
    decisionUse: 'descriptive_only',
    projectionsAdjusted: false,
    optimizerAdjusted: false,
    safeguards: { readOnly: true, transactionsPerformed: false }
  };
}

function evaluateLevel(level, target, rows) {
  const candidates = rows.filter((row) => row.season + 1 < HISTORICAL_PRIOR_OUTCOME_CUTOFF_SEASON
    && level.fields.every((field) => row[field] === target[field]));
  const byKey = new Map(rows.map((row) => [`${row.playerId}|${row.position}|${row.season}`, row]));
  const pairs = [];
  let missingFollowUp = 0;
  let missingOutcome = 0;
  for (const source of candidates) {
    const followUp = byKey.get(`${source.playerId}|${source.position}|${source.season + 1}`);
    if (!followUp || followUp.season >= HISTORICAL_PRIOR_OUTCOME_CUTOFF_SEASON) {
      missingFollowUp += 1;
      continue;
    }
    const outcome = outcomeValues(source, followUp);
    if (Object.values(outcome).every((value) => value == null)) {
      missingOutcome += 1;
      continue;
    }
    pairs.push({ source, followUp, outcome });
  }
  return { candidates, pairs, missingFollowUp, missingOutcome };
}

function outcomeValues(source, followUp) {
  const sourceUsageRank = USAGE_BUCKET_RANK[source.usageBucket];
  const followUpUsageRank = USAGE_BUCKET_RANK[followUp.usageBucket];
  return {
    nextYearOpportunityPerGame: followUp.opportunityPerGame,
    opportunityChangePerGame: difference(followUp.opportunityPerGame, source.opportunityPerGame),
    nextYearFantasyPointsPerGame: followUp.fantasyPointsPerGame,
    fantasyPointsChangePerGame: difference(followUp.fantasyPointsPerGame, source.fantasyPointsPerGame),
    roleExpanded: Number.isInteger(sourceUsageRank) && Number.isInteger(followUpUsageRank) ? followUpUsageRank > sourceUsageRank : null
  };
}

function summarizeOutcomes(pairs) {
  const values = (key) => pairs.map((pair) => pair.outcome[key]).filter((value) => typeof value === 'number' && Number.isFinite(value));
  const role = pairs.map((pair) => pair.outcome.roleExpanded).filter((value) => typeof value === 'boolean');
  const expanded = role.filter(Boolean).length;
  return {
    nextYearOpportunityPerGame: summarizeNumbers(values('nextYearOpportunityPerGame'), 'opportunities/game'),
    opportunityChangePerGame: summarizeNumbers(values('opportunityChangePerGame'), 'opportunities/game'),
    nextYearFantasyPointsPerGame: summarizeNumbers(values('nextYearFantasyPointsPerGame'), 'fantasy points/game'),
    fantasyPointsChangePerGame: summarizeNumbers(values('fantasyPointsChangePerGame'), 'fantasy points/game'),
    roleExpansion: {
      sampleSize: role.length,
      expandedCount: expanded,
      rate: role.length ? round(expanded / role.length, 4) : null,
      definition: 'The next-season position-specific usage bucket is higher than the source-season bucket.'
    }
  };
}

function summarizeNumbers(values, unit) {
  const ordered = [...values].sort((a, b) => a - b);
  return {
    sampleSize: ordered.length,
    mean: ordered.length ? round(mean(ordered), 4) : null,
    median: percentile(ordered, 0.5),
    p25: percentile(ordered, 0.25),
    p75: percentile(ordered, 0.75),
    minimum: ordered.length ? round(ordered[0], 4) : null,
    maximum: ordered.length ? round(ordered.at(-1), 4) : null,
    unit
  };
}

function normalizePlayerSeasons(rows) {
  const normalized = rows.flatMap((row) => {
    const value = normalizePlayerSeason(row);
    return value ? [value] : [];
  }).sort(comparePlayerSeason);
  const unique = new Map();
  for (const row of normalized) {
    const key = `${row.playerId}|${row.position}|${row.season}`;
    if (!unique.has(key)) unique.set(key, row);
  }
  return [...unique.values()];
}

function normalizePlayerSeason(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const playerId = text(row.playerId ?? row.gsisId ?? row.player_id);
  const position = normalizePosition(row.position);
  const season = positiveIntegerOrNull(row.season);
  if (!playerId || !position || !season || season >= HISTORICAL_PRIOR_OUTCOME_CUTOFF_SEASON) return null;
  const careerYear = positiveIntegerOrNull(row.careerYear ?? row.career_year);
  const opportunityPerGame = resolveOpportunityPerGame(row, position);
  const fantasyPointsPerGame = resolveFantasyPointsPerGame(row);
  return {
    playerId,
    season,
    position,
    careerYear,
    careerBucket: careerBucket(careerYear),
    draftBucket: draftBucket(row),
    opportunityPerGame,
    fantasyPointsPerGame,
    usageBucket: usageBucket(position, opportunityPerGame)
  };
}

function normalizeTarget(player) {
  const value = player && typeof player === 'object' && !Array.isArray(player) ? player : {};
  const position = normalizePosition(value.position);
  const careerYear = positiveIntegerOrNull(value.careerYear ?? value.career_year);
  const opportunityPerGame = position ? resolveOpportunityPerGame(value, position) : null;
  const target = {
    requestedPlayerId: text(value.requestedPlayerId ?? value.playerId ?? value.gsisId ?? value.id),
    name: text(value.name ?? value.playerName),
    position,
    careerYear,
    careerBucket: careerBucket(careerYear),
    draftBucket: draftBucket(value),
    opportunityPerGame,
    usageBucket: usageBucket(position, opportunityPerGame)
  };
  target.missingMetadata = [
    target.careerYear == null ? 'career_year' : null,
    target.draftBucket == null ? 'draft_capital' : null,
    target.usageBucket == null ? 'usage' : null
  ].filter(Boolean);
  return target;
}

function profileView(target) {
  return {
    careerYear: target.careerYear,
    careerBucket: target.careerBucket,
    draftBucket: target.draftBucket,
    opportunityPerGame: target.opportunityPerGame,
    usageBucket: target.usageBucket,
    usageDefinition: target.position ? HISTORICAL_PRIOR_USAGE_BUCKETS[target.position] : null,
    missingMetadata: [...target.missingMetadata]
  };
}

function unavailablePrior(target, code, message, attempts = []) {
  return {
    requestedPlayerId: target.requestedPlayerId,
    name: target.name,
    position: target.position,
    status: 'unavailable',
    sampleStrength: 'insufficient',
    profile: profileView(target),
    cohort: { level: null, criteria: {}, fallback: false, fallbackReasons: [], attempts, sample: emptySample() },
    outcomes: summarizeOutcomes([]),
    message,
    issues: [{ code, message }],
    decisionUse: 'descriptive_only',
    projectionsAdjusted: false,
    optimizerAdjusted: false,
    safeguards: { readOnly: true, transactionsPerformed: false }
  };
}

function emptySample() {
  return { completedFollowUps: 0, uniquePlayers: 0, sourceSeasons: [], earliestSourceSeason: null, latestSourceSeason: null, candidateSourceSeasons: 0, excludedMissingFollowUp: 0, excludedMissingOutcome: 0 };
}

function resolveOpportunityPerGame(row, position) {
  const explicit = finiteNonNegative(row.opportunityPerGame ?? row.opportunity_per_game ?? row.usage?.opportunityPerGame);
  if (explicit != null) return explicit;
  const games = positiveNumberOrNull(row.games ?? row.gamesPlayed ?? row.sampleGames);
  if (games == null) return null;
  const total = position === 'QB'
    ? finiteNonNegative(row.passAttempts ?? row.pass_attempts ?? row.metrics?.attempts)
    : position === 'RB'
      ? finiteNonNegative(row.rushAttempts ?? row.rush_attempts ?? row.metrics?.rushAttempts)
      : finiteNonNegative(row.targets ?? row.metrics?.targets);
  return total == null ? null : round(total / games, 4);
}

function resolveFantasyPointsPerGame(row) {
  const explicit = finiteNumber(row.fantasyPointsPerGame ?? row.fantasy_points_per_game ?? row.fantasyPpg);
  if (explicit != null) return explicit;
  const games = positiveNumberOrNull(row.games ?? row.gamesPlayed ?? row.sampleGames);
  const total = finiteNumber(row.fantasyPoints ?? row.fantasy_points);
  return games == null || total == null ? null : round(total / games, 4);
}

function primaryNgsStatType(position) {
  if (position === 'QB') return 'passing';
  if (position === 'RB') return 'rushing';
  return 'receiving';
}

function ngsOpportunity(position, metrics) {
  if (position === 'QB') return finiteNonNegative(metrics?.attempts);
  if (position === 'RB') return finiteNonNegative(metrics?.rushAttempts);
  return finiteNonNegative(metrics?.targets);
}

function normalizePosition(value) {
  const position = String(value || '').trim().toUpperCase();
  return SUPPORTED_POSITIONS.has(position) ? position : null;
}

function difference(after, before) {
  return after == null || before == null ? null : round(after - before, 4);
}

function percentile(ordered, quantile) {
  if (!ordered.length) return null;
  const index = (ordered.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return round(ordered[lower], 4);
  return round(ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower), 4);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function comparePlayerSeason(left, right) {
  return left.season - right.season || String(left.playerId).localeCompare(String(right.playerId)) || String(left.position).localeCompare(String(right.position));
}

function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function positiveNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNonNegative(value) {
  const number = finiteNumber(value);
  return number != null && number >= 0 ? number : null;
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function text(value) {
  const result = String(value ?? '').trim();
  return result || null;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  const result = Math.round(value * factor) / factor;
  return Object.is(result, -0) ? 0 : result;
}

function capitalize(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
