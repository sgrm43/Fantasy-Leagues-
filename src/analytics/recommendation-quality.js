export const RECOMMENDATION_EVIDENCE_GROUPS = Object.freeze([
  'volumeOpportunity',
  'role',
  'scoringOpportunity',
  'efficiency',
  'recentTrend',
  'gameEnvironment',
  'matchup',
  'healthAvailability'
]);

export const RECOMMENDATION_QUALITY_THRESHOLDS = Object.freeze({
  narrowProjectionEdge: 2,
  strongSupportGroups: 3,
  minimumTrendGames: 3,
  opportunity: Object.freeze({
    QB: Object.freeze({ low: 20, strong: 30 }),
    RB: Object.freeze({ low: 8, strong: 16 }),
    WR: Object.freeze({ low: 5, strong: 8 }),
    TE: Object.freeze({ low: 4, strong: 6 })
  }),
  lowRecentFantasyPoints: Object.freeze({ QB: 14, RB: 8, WR: 8, TE: 6 }),
  highRecentFantasyPoints: Object.freeze({ QB: 22, RB: 15, WR: 15, TE: 12 })
});

const GROUP_ASSESSMENTS = Object.freeze({
  RECOMMENDED: 'supports_recommended',
  ALTERNATIVE: 'supports_alternative',
  MIXED: 'mixed',
  NEUTRAL: 'neutral',
  INSUFFICIENT: 'insufficient'
});

const PRIMARY_GROUPS = Object.freeze([
  'volumeOpportunity',
  'role',
  'scoringOpportunity',
  'recentTrend',
  'healthAvailability'
]);

const METRIC_DEFINITIONS = Object.freeze({
  passAttempts: metric('Pass attempts', 'volumeOpportunity', 4),
  completions: metric('Completions', 'volumeOpportunity', 3),
  carries: metric('Carries', 'volumeOpportunity', 3),
  targets: metric('Targets', 'volumeOpportunity', 2),
  targetShare: metric('Target share', 'volumeOpportunity', 0.05),
  rushingShare: metric('Rushing share', 'volumeOpportunity', 0.08),
  snaps: metric('Offensive snaps', 'role', 8),
  snapShare: metric('Snap share', 'role', 0.1),
  routes: metric('Routes', 'role', 5),
  routeParticipation: metric('Route participation', 'role', 0.1),
  receptions: metric('Receptions', 'role', 2),
  redZoneCarries: metric('Red-zone carries', 'scoringOpportunity', 1),
  redZoneTargets: metric('Red-zone targets', 'scoringOpportunity', 1),
  goalLineCarries: metric('Goal-line carries', 'scoringOpportunity', 1),
  endZoneTargets: metric('End-zone targets', 'scoringOpportunity', 1),
  redZonePassAttempts: metric('Red-zone pass attempts', 'scoringOpportunity', 2),
  airYards: metric('Air yards', 'role', 25),
  airYardsShare: metric('Team air-yards share', 'role', 0.05),
  yardsPerCarry: metric('Yards per carry', 'efficiency', 0.8),
  catchRate: metric('Catch rate', 'efficiency', 0.08),
  completionPercentageAboveExpectation: metric('Completion % above expectation', 'efficiency', 2),
  rushYardsOverExpectedPerAtt: metric('Rush yards over expected per attempt', 'efficiency', 0.4),
  avgYacAboveExpectation: metric('YAC above expectation', 'efficiency', 0.8),
  avgYac: metric('Average yards after catch', 'efficiency', null, false),
  avgExpectedYac: metric('Expected yards after catch', 'efficiency', null, false),
  avgSeparation: metric('Average separation', 'efficiency', 0.3),
  avgTimeToThrow: metric('Average time to throw', 'efficiency', null, false),
  avgIntendedAirYards: metric('Average intended air yards', 'efficiency', null, false),
  avgCompletedAirYards: metric('Average completed air yards', 'efficiency', null, false),
  aggressiveness: metric('Aggressiveness', 'efficiency', null, false),
  efficiency: metric('NGS rushing path efficiency', 'efficiency', null, false),
  avgTimeToLos: metric('Average time to line of scrimmage', 'efficiency', null, false),
  percentAttemptsGteEightDefenders: metric('Stacked-box rate', 'efficiency', null, false),
  avgCushion: metric('Average cushion', 'efficiency', null, false),
  gameTotal: metric('Game total', 'gameEnvironment', 4),
  positionTendency: metric('Position-aligned team tendency', 'gameEnvironment', 0.08),
  paceSecondsPerPlay: metric('Seconds per play', 'gameEnvironment', 2, true, true),
  offensivePlaysPerGame: metric('Offensive plays per game', 'gameEnvironment', 4),
  opponentOpportunityIndex: metric('Opponent opportunity allowed vs league', 'matchup', 0.1)
});

const POSITION_METRICS = Object.freeze({
  QB: Object.freeze({
    volumeOpportunity: ['passAttempts', 'completions', 'carries'],
    role: ['snaps', 'snapShare'],
    scoringOpportunity: ['redZonePassAttempts', 'redZoneCarries'],
    efficiency: ['completionPercentageAboveExpectation', 'rushYardsOverExpectedPerAtt', 'avgTimeToThrow', 'avgIntendedAirYards', 'avgCompletedAirYards', 'aggressiveness']
  }),
  RB: Object.freeze({
    volumeOpportunity: ['carries', 'rushingShare', 'targets'],
    role: ['snapShare', 'snaps', 'routes', 'routeParticipation', 'receptions'],
    scoringOpportunity: ['redZoneCarries', 'redZoneTargets', 'goalLineCarries'],
    efficiency: ['yardsPerCarry', 'rushYardsOverExpectedPerAtt', 'avgYacAboveExpectation', 'efficiency', 'avgTimeToLos', 'percentAttemptsGteEightDefenders']
  }),
  WR: Object.freeze({
    volumeOpportunity: ['targets', 'targetShare'],
    role: ['routes', 'routeParticipation', 'snapShare', 'snaps', 'receptions', 'airYards', 'airYardsShare'],
    scoringOpportunity: ['redZoneTargets', 'endZoneTargets'],
    efficiency: ['catchRate', 'avgYacAboveExpectation', 'avgYac', 'avgExpectedYac', 'avgSeparation', 'avgCushion', 'avgIntendedAirYards']
  }),
  TE: Object.freeze({
    volumeOpportunity: ['targets', 'targetShare'],
    role: ['routes', 'routeParticipation', 'snapShare', 'snaps', 'receptions', 'airYards', 'airYardsShare'],
    scoringOpportunity: ['redZoneTargets', 'endZoneTargets'],
    efficiency: ['catchRate', 'avgYacAboveExpectation', 'avgYac', 'avgExpectedYac', 'avgSeparation', 'avgCushion', 'avgIntendedAirYards']
  })
});

/**
 * Build a read-only evidence report beside the optimizer output. It never feeds
 * evidence back into projections or legal-lineup selection.
 */
export function buildRecommendationQualityReport({
  lineup,
  players = [],
  coachTracker = null,
  nextGenContext = null,
  nflContext = null,
  weatherContext = null,
  season = null,
  usageSeason = null
} = {}) {
  const playersById = new Map((players || []).map((player) => [playerId(player), player]));
  const contextsById = new Map((players || []).map((player) => [
    playerId(player),
    providerContextForPlayer(player, { coachTracker, nextGenContext, nflContext, weatherContext, season, usageSeason })
  ]));
  const comparisons = lineupComparisons(lineup).flatMap((comparison) => {
    const recommendedPlayer = playersById.get(String(comparison.start?.playerId));
    const alternativePlayer = comparison.sit ? playersById.get(String(comparison.sit.playerId)) : null;
    if (!recommendedPlayer) return [];
    return [evaluateRecommendationQuality({
      recommendedPlayer,
      alternativePlayer,
      recommendedContext: contextsById.get(playerId(recommendedPlayer)),
      alternativeContext: alternativePlayer ? contextsById.get(playerId(alternativePlayer)) : null,
      projectionDifference: comparison.expectedGain,
      comparisonType: comparison.comparisonType,
      targetSlot: comparison.targetSlot,
      targetSlotId: comparison.targetSlotId
    })];
  });

  return {
    model: 'grouped-football-evidence',
    decisionUse: 'descriptive_only',
    projectionAnchor: lineup?.objectiveLabel || null,
    comparisons,
    safeguards: { readOnly: true, transactionsPerformed: false },
    projectionsAdjusted: false,
    optimizerAdjusted: false,
    methodology: {
      grouping: 'Correlated statistics are collapsed into eight evidence groups; each group can contribute at most one direction.',
      priority: 'Opportunity, role, and scoring opportunity receive priority over short-term efficiency.',
      missing: 'Missing, stale, unavailable, Learning, and prior-season reference data are neutral rather than zero.',
      limitation: 'This layer explains whether current football evidence supports the existing projection choice; it does not create or override a lineup decision.'
    }
  };
}

/** Evaluate one already-selected player against one already-identified alternative. */
export function evaluateRecommendationQuality(input = {}) {
  const recommendedPlayer = input.recommendedPlayer || input.recommended;
  const alternativePlayer = input.alternativePlayer || input.alternative || null;
  if (!recommendedPlayer || typeof recommendedPlayer !== 'object') throw new TypeError('recommendedPlayer is required');

  const recommended = normalizePlayerEvidence(recommendedPlayer, input.recommendedContext || input.contextsByPlayer?.[playerId(recommendedPlayer)]);
  const alternative = alternativePlayer
    ? normalizePlayerEvidence(alternativePlayer, input.alternativeContext || input.contextsByPlayer?.[playerId(alternativePlayer)])
    : null;
  const projectionDifference = finiteNumber(input.projectionDifference)
    ?? difference(projectionValue(recommendedPlayer), projectionValue(alternativePlayer));

  const evidence = Object.fromEntries(RECOMMENDATION_EVIDENCE_GROUPS.map((group) => [
    group,
    buildEvidenceGroup(group, recommended, alternative)
  ]));
  const warnings = sustainabilityWarnings(recommended);
  const classification = classifySupport(evidence, projectionDifference);
  const confidence = confidenceFor(classification, evidence, warnings, recommended, alternative);
  const supportingGroups = RECOMMENDATION_EVIDENCE_GROUPS.filter((group) => evidence[group].assessment === GROUP_ASSESSMENTS.RECOMMENDED);
  const conflictingGroups = RECOMMENDATION_EVIDENCE_GROUPS.filter((group) => evidence[group].assessment === GROUP_ASSESSMENTS.ALTERNATIVE);

  return {
    comparisonId: [input.targetSlotId || input.targetSlot || 'comparison', recommended.playerId, alternative?.playerId || 'open'].join('|'),
    comparisonType: input.comparisonType || (alternative ? 'start_sit' : 'fill_lineup'),
    targetSlot: input.targetSlot || null,
    targetSlotId: input.targetSlotId || null,
    recommendedPlayer: publicPlayer(recommended),
    alternativePlayer: alternative ? publicPlayer(alternative) : null,
    projectionDifference: round(projectionDifference),
    evidence,
    supportingGroups,
    conflictingGroups,
    supportClassification: classification,
    confidence,
    confidenceBasis: confidenceBasis(classification),
    reasons: conciseReasons({ recommended, alternative, projectionDifference, evidence, classification }),
    warnings,
    positionStatistics: {
      recommended: availableStatistics(recommended),
      alternative: alternative ? availableStatistics(alternative) : []
    },
    safeguards: { readOnly: true, transactionsPerformed: false },
    projectionsAdjusted: false,
    optimizerAdjusted: false
  };
}

function providerContextForPlayer(player, { coachTracker, nextGenContext, nflContext, weatherContext, season, usageSeason }) {
  const id = playerId(player);
  const offense = (coachTracker?.offenses || []).find((group) => (group.players || []).some((item) => playerId(item) === id));
  const defense = (coachTracker?.defenses || []).find((group) => (group.affectedPlayers || []).some((item) => playerId(item) === id));
  const matchup = defense?.positionContexts?.find((item) => String(item.position || '').toUpperCase() === String(player.position || '').toUpperCase()) || null;
  const nextGen = (nextGenContext?.players || []).find((item) => String(item.requestedPlayerId) === id) || null;
  const team = String(offense?.team?.abbreviation || player.nflTeam || '').toUpperCase();
  const teamId = player.nflTeamId == null ? null : String(player.nflTeamId);
  const game = (nflContext?.games || []).find((item) => [item.teams?.home, item.teams?.away].some((candidate) => candidate && (teamId ? String(candidate.id) === teamId : team && normalizeTeam(candidate.abbreviation) === normalizeTeam(team)))) || null;
  const weather = game ? (weatherContext?.games || []).find((item) => String(item.gameId) === String(game.id)) || null : null;
  return {
    usage: player.analysisUsage || null,
    usageSeason,
    season,
    nextGen: nextGenContext?.stale === true ? null : nextGen,
    nextGenSeason: nextGenContext?.season ?? season,
    nflverse: offense?.teamTrend?.nflverse || null,
    teamTrend: offense?.teamTrend || null,
    matchup,
    game,
    weather,
    health: player.analysisInjury || null
  };
}

function lineupComparisons(lineup) {
  if (!lineup || typeof lineup !== 'object') return [];
  const explicit = (lineup.recommendations || []).map((recommendation) => ({
    ...recommendation,
    comparisonType: recommendation.sit ? 'start_sit' : 'fill_lineup'
  }));
  if (explicit.length || !(finiteNumber(lineup.expectedGain) > 0)) return explicit;

  const currentIds = new Set((lineup.current?.assignments || []).map((item) => String(item.playerId)));
  const recommendedIds = new Set((lineup.recommended?.assignments || []).map((item) => String(item.playerId)));
  const incoming = (lineup.recommended?.assignments || []).filter((item) => !currentIds.has(String(item.playerId)));
  const outgoing = (lineup.current?.assignments || []).filter((item) => !recommendedIds.has(String(item.playerId)));
  if (incoming.length !== 1 || outgoing.length !== 1) return [];
  const projections = new Map((lineup.projections || []).map((item) => [String(item.playerId), item]));
  const start = projections.get(String(incoming[0].playerId));
  const sit = projections.get(String(outgoing[0].playerId));
  if (!start || !sit) return [];
  return [{
    start,
    sit,
    expectedGain: round((finiteNumber(start[lineup.objective]) ?? start.mean) - (finiteNumber(sit[lineup.objective]) ?? sit.mean)),
    targetSlot: incoming[0].slot,
    targetSlotId: incoming[0].slotId,
    comparisonType: 'close_call'
  }];
}

function normalizePlayerEvidence(player, context = {}) {
  const explicit = context?.evidence || player.recommendationEvidence || player.evidence || {};
  const candidateUsage = context?.usage || player.analysisUsage || null;
  const usage = candidateUsage?.stale === true ? null : candidateUsage;
  const summary = usage?.summary || explicit.summary || {};
  const values = {};
  const metadata = {};
  const set = (key, value, source, sampleSize = null) => {
    const numeric = finiteNumber(value);
    if (numeric == null || values[key] != null) return;
    values[key] = numeric;
    metadata[key] = { source, sampleSize: finiteNumber(sampleSize) };
  };

  for (const key of ['snaps', 'snapShare', 'routes', 'targets', 'carries', 'redZoneTargets', 'redZoneCarries', 'passAttempts']) {
    const record = summary.opportunity?.[key];
    set(key, record?.weightedAverage, 'Sleeper recent usage', record?.sampleSize);
  }
  for (const key of ['receptions', 'rushingYards', 'receivingYards', 'fantasyPoints']) {
    const record = summary.production?.[key];
    set(key, record?.weightedAverage, 'Sleeper recent usage', record?.sampleSize);
  }

  const logs = Array.isArray(usage?.gameLogs) ? usage.gameLogs : [];
  for (const key of ['completions', 'targetShare', 'rushingShare', 'routeParticipation', 'goalLineCarries', 'endZoneTargets', 'redZonePassAttempts', 'airYards']) {
    set(key, average(logs.map((log) => log?.[key])), 'Historical weekly usage', logs.length);
  }

  for (const key of Object.keys(METRIC_DEFINITIONS).concat(['fantasyPoints', 'rushingYards', 'receivingYards'])) {
    const supplied = explicitValue(explicit, key);
    set(key, supplied?.value, supplied?.source || 'Supplied evidence', supplied?.sampleSize ?? explicit.sampleSize);
  }

  if (values.carries > 0 && values.rushingYards != null) set('yardsPerCarry', values.rushingYards / values.carries, 'Derived from rushing yards and carries', minimumSample(metadata.carries, metadata.rushingYards));
  if (values.targets > 0 && values.receptions != null) set('catchRate', values.receptions / values.targets, 'Derived from receptions and targets', minimumSample(metadata.targets, metadata.receptions));

  const nextGen = normalizeCurrentNextGen(context?.nextGen || explicit.nextGen, context?.nextGenSeason || context?.season);
  for (const [key, value] of Object.entries(nextGen)) set(key, value, 'nflverse Next Gen Stats', null);
  set('airYardsShare', nextGen.percentShareOfIntendedAirYards, 'nflverse Next Gen Stats', null);

  const game = context?.game || explicit.game || null;
  set('gameTotal', game?.odds?.total ?? explicitValue(explicit, 'gameTotal')?.value, 'NFL game betting context', null);
  const nflverse = usableNflverse(context?.nflverse || explicit.nflverse);
  if (nflverse) {
    const position = normalizePosition(player.position);
    const passRate = finiteNumber(nflverse.metrics?.neutralPassRate?.value)
      ?? finiteNumber(nflverse.metrics?.earlyDownPassRate?.value)
      ?? finiteNumber(nflverse.metrics?.overallPassRate?.value);
    if (passRate != null) set('positionTendency', position === 'RB' ? 1 - passRate : passRate, 'Current nflverse team tendency', nflverse.window?.includedGames);
    set('paceSecondsPerPlay', nflverse.metrics?.secondsPerPlay?.value, 'Current nflverse team tendency', nflverse.window?.includedGames);
  } else {
    const teamTrend = usableTeamTrend(context?.teamTrend || explicit.teamTrend);
    const position = normalizePosition(player.position);
    const passRate = finiteNumber(teamTrend?.metrics?.passAttemptRate?.value);
    if (passRate != null) set('positionTendency', position === 'RB' ? 1 - passRate : passRate, 'Current team tendency', teamTrend.window?.includedGames);
    set('offensivePlaysPerGame', teamTrend?.metrics?.offensivePlaysPerGame?.value, 'Current team tendency', teamTrend?.window?.includedGames);
  }

  const matchup = context?.matchup || explicit.matchup;
  if (usableMatchup(matchup)) {
    const allowed = finiteNumber(matchup.metrics?.opportunity?.valuePerGame);
    const league = finiteNumber(matchup.metrics?.opportunity?.leagueValuePerGame);
    if (allowed != null && league > 0) set('opponentOpportunityIndex', allowed / league - 1, 'Opponent position response', matchup.sample?.includedGames);
  }

  const status = normalizeHealthStatus(player.injuryStatus, context?.health || player.analysisInjury || explicit.health);
  const trend = normalizeTrend(summary, normalizePosition(player.position), context?.usageSeason, context?.season);
  const weather = usableWeather(context?.weather || explicit.weather);
  const historicalUsage = context?.usageSeason != null && context?.season != null && Number(context.usageSeason) !== Number(context.season);

  return {
    playerId: playerId(player),
    name: player.name || player.fullName || playerId(player),
    position: normalizePosition(player.position),
    values,
    metadata,
    sampleSize: finiteNumber(summary.sampleSize) ?? finiteNumber(explicit.sampleSize),
    trend,
    healthStatus: status,
    weather,
    historicalUsage
  };
}

function buildEvidenceGroup(group, recommended, alternative) {
  if (!alternative) return emptyGroup(group, GROUP_ASSESSMENTS.INSUFFICIENT, 'No comparison player is available.');
  if (group === 'recentTrend') return trendGroup(recommended, alternative);
  if (group === 'healthAvailability') return healthGroup(recommended, alternative);

  const recommendedKeys = metricKeys(recommended.position, group);
  const alternativeKeys = metricKeys(alternative.position, group);
  const keys = [...new Set([...recommendedKeys, ...alternativeKeys])];
  const facts = keys.flatMap((key) => {
    const definition = METRIC_DEFINITIONS[key];
    const recommendedValue = finiteNumber(recommended.values[key]);
    const alternativeValue = finiteNumber(alternative.values[key]);
    if (!definition || (recommendedValue == null && alternativeValue == null)) return [];
    return [{
      metric: key,
      label: definition.label,
      recommended: recommendedValue,
      alternative: alternativeValue,
      source: commonSource(recommended.metadata[key]?.source, alternative.metadata[key]?.source),
      directional: definition.directional
    }];
  });
  if (group === 'gameEnvironment' && (recommended.weather || alternative.weather)) {
    facts.push({
      metric: 'weather',
      label: 'Official weather context',
      recommended: recommended.weather?.label || null,
      alternative: alternative.weather?.label || null,
      source: 'National Weather Service',
      directional: false,
      alreadyReflectedInProjection: true
    });
  }
  if (!facts.length) return emptyGroup(group, GROUP_ASSESSMENTS.INSUFFICIENT, 'No reliable current evidence is available for either player.');

  const comparableKeys = recommended.position === alternative.position
    ? keys
    : crossPositionKeys(group, recommended, alternative);
  let recommendedVotes = 0;
  let alternativeVotes = 0;
  for (const key of comparableKeys) {
    const definition = METRIC_DEFINITIONS[key];
    const left = finiteNumber(recommended.values[key]);
    const right = finiteNumber(alternative.values[key]);
    if (!definition?.directional || definition.materialDifference == null || left == null || right == null) continue;
    const differenceValue = definition.lowerIsBetter ? right - left : left - right;
    if (differenceValue >= definition.materialDifference) recommendedVotes += 1;
    else if (differenceValue <= -definition.materialDifference) alternativeVotes += 1;
  }

  if (recommended.position !== alternative.position && recommendedVotes === 0 && alternativeVotes === 0 && ['volumeOpportunity', 'role', 'scoringOpportunity'].includes(group)) {
    const leftLevel = groupLevel(group, recommended);
    const rightLevel = groupLevel(group, alternative);
    if (leftLevel != null && rightLevel != null && leftLevel !== rightLevel) {
      if (leftLevel > rightLevel) recommendedVotes += 1;
      else alternativeVotes += 1;
    }
  }

  const assessment = recommendedVotes && alternativeVotes
    ? GROUP_ASSESSMENTS.MIXED
    : recommendedVotes
      ? GROUP_ASSESSMENTS.RECOMMENDED
      : alternativeVotes
        ? GROUP_ASSESSMENTS.ALTERNATIVE
        : GROUP_ASSESSMENTS.NEUTRAL;
  return {
    group,
    assessment,
    summary: groupSummary(group, assessment, recommended, alternative),
    facts,
    groupedMetricCount: facts.length,
    directionalVoteCount: assessment === GROUP_ASSESSMENTS.MIXED ? 2 : [GROUP_ASSESSMENTS.RECOMMENDED, GROUP_ASSESSMENTS.ALTERNATIVE].includes(assessment) ? 1 : 0,
    countedAsOneGroup: true
  };
}

function trendGroup(recommended, alternative) {
  const facts = [recommended, alternative].some((player) => player.trend.available)
    ? [{ metric: 'recentOpportunityTrend', label: 'Recent opportunity trend', recommended: recommended.trend.direction, alternative: alternative.trend.direction, source: 'Sleeper recent usage', directional: true }]
    : [];
  if (!recommended.trend.available || !alternative.trend.available) {
    return { ...emptyGroup('recentTrend', facts.length ? GROUP_ASSESSMENTS.NEUTRAL : GROUP_ASSESSMENTS.INSUFFICIENT, 'Comparable multi-week trend evidence is unavailable.'), facts };
  }
  if (recommended.trend.score === alternative.trend.score) return groupResult('recentTrend', GROUP_ASSESSMENTS.NEUTRAL, recommended, alternative, facts);
  return groupResult('recentTrend', recommended.trend.score > alternative.trend.score ? GROUP_ASSESSMENTS.RECOMMENDED : GROUP_ASSESSMENTS.ALTERNATIVE, recommended, alternative, facts);
}

function healthGroup(recommended, alternative) {
  const facts = [recommended.healthStatus, alternative.healthStatus].some(Boolean)
    ? [{ metric: 'availability', label: 'Health / availability', recommended: recommended.healthStatus?.label || null, alternative: alternative.healthStatus?.label || null, source: 'Current injury status', directional: true }]
    : [];
  if (!recommended.healthStatus || !alternative.healthStatus) {
    return { ...emptyGroup('healthAvailability', facts.length ? GROUP_ASSESSMENTS.NEUTRAL : GROUP_ASSESSMENTS.INSUFFICIENT, 'Comparable explicit health statuses are unavailable.'), facts };
  }
  if (recommended.healthStatus.rank === alternative.healthStatus.rank) return groupResult('healthAvailability', GROUP_ASSESSMENTS.NEUTRAL, recommended, alternative, facts);
  return groupResult('healthAvailability', recommended.healthStatus.rank < alternative.healthStatus.rank ? GROUP_ASSESSMENTS.RECOMMENDED : GROUP_ASSESSMENTS.ALTERNATIVE, recommended, alternative, facts);
}

function classifySupport(evidence, projectionDifference) {
  const recommendedPrimary = PRIMARY_GROUPS.filter((group) => evidence[group].assessment === GROUP_ASSESSMENTS.RECOMMENDED);
  const alternativePrimary = PRIMARY_GROUPS.filter((group) => evidence[group].assessment === GROUP_ASSESSMENTS.ALTERNATIVE);
  const mixed = RECOMMENDATION_EVIDENCE_GROUPS.filter((group) => evidence[group].assessment === GROUP_ASSESSMENTS.MIXED);
  const recommendedAll = RECOMMENDATION_EVIDENCE_GROUPS.filter((group) => evidence[group].assessment === GROUP_ASSESSMENTS.RECOMMENDED);
  const alternativeAll = RECOMMENDATION_EVIDENCE_GROUPS.filter((group) => evidence[group].assessment === GROUP_ASSESSMENTS.ALTERNATIVE);
  const narrow = projectionDifference == null || projectionDifference <= RECOMMENDATION_QUALITY_THRESHOLDS.narrowProjectionEdge;

  if (!recommendedAll.length && !alternativeAll.length && !mixed.length) return 'insufficient_evidence';
  if (alternativePrimary.length >= 2 && recommendedPrimary.length === 0 && narrow) return 'projection_conflict';
  if (recommendedPrimary.length >= RECOMMENDATION_QUALITY_THRESHOLDS.strongSupportGroups
    && recommendedPrimary.includes('volumeOpportunity')
    && alternativePrimary.length === 0
    && !mixed.length
    && !alternativeAll.length) return 'strongly_supported';
  if (recommendedPrimary.length && !alternativePrimary.length && !mixed.length) {
    const onlyEfficiencyAgainst = alternativeAll.every((group) => group === 'efficiency');
    return alternativeAll.length && !onlyEfficiencyAgainst ? 'mixed' : 'supported';
  }
  if (recommendedPrimary.length || alternativePrimary.length || mixed.length) return 'mixed';
  if (recommendedAll.length && !alternativeAll.length && !recommendedAll.every((group) => group === 'efficiency')) return 'supported';
  return 'insufficient_evidence';
}

function confidenceFor(classification, evidence, warnings, recommended, alternative) {
  if (classification === 'insufficient_evidence') return 'Uncertain';
  if (classification === 'projection_conflict' || classification === 'mixed') return 'Low';
  if (classification === 'strongly_supported') {
    const uncertainHealth = [recommended, alternative].some((player) => player?.healthStatus?.rank === 1);
    const efficiencyDependent = warnings.some((warning) => warning.code === 'efficiency_dependent_production');
    const historicalOnly = recommended.historicalUsage && alternative?.historicalUsage;
    return uncertainHealth || efficiencyDependent || historicalOnly ? 'Moderate' : 'High';
  }
  return 'Moderate';
}

function sustainabilityWarnings(player) {
  const warnings = [];
  const opportunity = primaryOpportunity(player);
  const thresholds = RECOMMENDATION_QUALITY_THRESHOLDS.opportunity[player.position];
  const recentPoints = finiteNumber(player.values.fantasyPoints);
  if (!thresholds) return warnings;

  const extremeEfficiency = (finiteNumber(player.values.rushYardsOverExpectedPerAtt) ?? -Infinity) >= 1
    || (finiteNumber(player.values.avgYacAboveExpectation) ?? -Infinity) >= 2
    || (finiteNumber(player.values.completionPercentageAboveExpectation) ?? -Infinity) >= 5
    || (finiteNumber(player.values.yardsPerCarry) ?? -Infinity) >= 6.5;
  if (opportunity != null && opportunity < thresholds.low
    && (extremeEfficiency || recentPoints >= RECOMMENDATION_QUALITY_THRESHOLDS.highRecentFantasyPoints[player.position])) {
    warnings.push({
      code: 'efficiency_dependent_production',
      playerId: player.playerId,
      message: `${player.name}'s recent production depends on efficiency despite a small opportunity sample; it may be difficult to sustain.`
    });
  }
  if (opportunity != null && opportunity >= thresholds.strong
    && recentPoints != null && recentPoints <= RECOMMENDATION_QUALITY_THRESHOLDS.lowRecentFantasyPoints[player.position]) {
    warnings.push({
      code: 'opportunity_without_recent_scoring',
      playerId: player.playerId,
      message: `${player.name} has strong recent opportunity despite limited fantasy scoring; the workload is more stable evidence than the short scoring result.`
    });
  }
  return warnings;
}

function primaryOpportunity(player) {
  if (player.position === 'QB') return finiteNumber(player.values.passAttempts);
  if (player.position === 'RB') {
    const carries = finiteNumber(player.values.carries);
    const targets = finiteNumber(player.values.targets);
    return carries == null && targets == null ? null : (carries || 0) + (targets || 0);
  }
  return finiteNumber(player.values.targets);
}

function groupLevel(group, player) {
  if (group === 'volumeOpportunity') {
    const value = primaryOpportunity(player);
    const thresholds = RECOMMENDATION_QUALITY_THRESHOLDS.opportunity[player.position];
    if (value == null || !thresholds) return null;
    if (value >= thresholds.strong) return 3;
    if (value >= thresholds.low) return 2;
    return 1;
  }
  if (group === 'role') {
    const share = finiteNumber(player.values.routeParticipation) ?? finiteNumber(player.values.snapShare);
    if (share != null) return share >= 0.8 ? 3 : share >= 0.6 ? 2 : 1;
    const routes = finiteNumber(player.values.routes);
    if (routes == null) return null;
    return routes >= 30 ? 3 : routes >= 20 ? 2 : 1;
  }
  if (group === 'scoringOpportunity') {
    const value = ['redZoneCarries', 'redZoneTargets', 'goalLineCarries', 'endZoneTargets', 'redZonePassAttempts']
      .map((key) => finiteNumber(player.values[key])).filter((item) => item != null).reduce((total, item) => total + item, 0);
    const available = ['redZoneCarries', 'redZoneTargets', 'goalLineCarries', 'endZoneTargets', 'redZonePassAttempts'].some((key) => finiteNumber(player.values[key]) != null);
    if (!available) return null;
    return value >= 3 ? 3 : value >= 1 ? 2 : 1;
  }
  return null;
}

function normalizeCurrentNextGen(nextGen, expectedSeason) {
  if (!nextGen || nextGen.stale || nextGen.available !== true || nextGen.learning === true || nextGen.current?.available !== true) return {};
  if (expectedSeason != null && Number(nextGen.current.season) !== Number(expectedSeason)) return {};
  const values = {};
  for (const item of nextGen.current.metrics || []) {
    for (const [key, value] of Object.entries(item?.values || {})) {
      const numeric = finiteNumber(value);
      if (numeric != null && values[key] == null) values[key] = numeric;
    }
  }
  return values;
}

function usableNflverse(value) {
  if (!value || value.available !== true || value.learning === true || value.stale === true) return null;
  return value;
}

function usableTeamTrend(value) {
  if (!value || value.available !== true || value.learning === true || value.stale === true) return null;
  return value;
}

function usableMatchup(value) {
  return Boolean(value?.available === true && value?.sample?.adequate === true && value?.stale !== true && value?.partial !== true);
}

function usableWeather(value) {
  if (!value || value.available !== true || value.stale === true) return null;
  const forecast = value.forecast || {};
  const flags = Array.isArray(value.flags) ? value.flags : [];
  const notable = flags.find((flag) => ['high_wind', 'heavy_precipitation', 'extreme_cold', 'hazardous_weather'].includes(String(flag.code || flag)));
  return notable ? { status: 'risk', label: notable.label || notable.code || String(notable) } : forecast.hazardous ? { status: 'risk', label: 'Hazardous weather' } : { status: 'normal', label: value.summary || 'No major official weather flag' };
}

function normalizeTrend(summary, position, usageSeason, season) {
  const currentSeason = usageSeason == null || season == null || Number(usageSeason) === Number(season);
  if (!currentSeason || finiteNumber(summary?.sampleSize) < RECOMMENDATION_QUALITY_THRESHOLDS.minimumTrendGames) return { available: false, direction: 'unavailable', score: null };
  const relevant = trendMetricKeys(position).flatMap((key) => {
    const record = summary.opportunity?.[key];
    return record && ['increasing', 'decreasing', 'stable'].includes(record.direction) ? [record.direction] : [];
  });
  let direction = relevant.length ? collapseDirections(relevant) : summary?.trend?.direction;
  if (!['increasing', 'decreasing', 'stable'].includes(direction)) return { available: false, direction: direction || 'unavailable', score: null };
  return { available: true, direction, score: direction === 'increasing' ? 1 : direction === 'decreasing' ? -1 : 0 };
}

function normalizeHealthStatus(playerStatus, injury) {
  if (injury?.stale === true) return null;
  const raw = String(injury?.status || injury?.designation?.abbreviation || injury?.designation?.name || playerStatus || '').trim().toUpperCase();
  if (!raw) return null;
  if (['ACTIVE', 'HEALTHY', 'FULL'].includes(raw)) return { label: 'Active', rank: 0 };
  if (['Q', 'QUESTIONABLE', 'LIMITED'].includes(raw)) return { label: 'Questionable', rank: 1 };
  if (['D', 'DOUBTFUL'].includes(raw)) return { label: 'Doubtful', rank: 2 };
  if (['O', 'OUT', 'IR', 'INJURED_RESERVE', 'INJURY_RESERVE', 'SUSPENDED', 'INACTIVE', 'PUP', 'NFI'].includes(raw)) return { label: 'Unavailable', rank: 3 };
  return null;
}

function conciseReasons({ recommended, alternative, projectionDifference, evidence, classification }) {
  const reasons = [];
  if (alternative) reasons.push(`${recommended.name} keeps the existing projection edge${projectionDifference == null ? '' : ` by ${formatPoint(projectionDifference)} points`}; this evidence review does not change that choice.`);
  const supportive = RECOMMENDATION_EVIDENCE_GROUPS.find((group) => evidence[group].assessment === GROUP_ASSESSMENTS.RECOMMENDED);
  const conflicting = RECOMMENDATION_EVIDENCE_GROUPS.find((group) => evidence[group].assessment === GROUP_ASSESSMENTS.ALTERNATIVE);
  if (supportive) reasons.push(evidence[supportive].summary);
  if (conflicting) reasons.push(evidence[conflicting].summary);
  if (classification === 'insufficient_evidence') reasons.push('Too little comparable current evidence is available to validate or challenge the projection edge.');
  return reasons.slice(0, 3);
}

function availableStatistics(player) {
  return Object.entries(player.values).flatMap(([key, value]) => {
    const definition = METRIC_DEFINITIONS[key];
    return definition && finiteNumber(value) != null ? [{ key, label: definition.label, group: definition.group, value: round(value), source: player.metadata[key]?.source || null }] : [];
  });
}

function metricKeys(position, group) {
  if (group === 'gameEnvironment') return ['gameTotal', 'positionTendency', 'paceSecondsPerPlay', 'offensivePlaysPerGame'];
  if (group === 'matchup') return ['opponentOpportunityIndex'];
  return POSITION_METRICS[position]?.[group] || [];
}

function crossPositionKeys(group, recommended, alternative) {
  const shared = metricKeys(recommended.position, group).filter((key) => metricKeys(alternative.position, group).includes(key));
  return shared;
}

function trendMetricKeys(position) {
  if (position === 'QB') return ['passAttempts', 'carries', 'redZoneCarries'];
  if (position === 'RB') return ['carries', 'targets', 'snapShare', 'routes', 'redZoneCarries', 'redZoneTargets'];
  return ['targets', 'routes', 'snapShare', 'redZoneTargets'];
}

function collapseDirections(directions) {
  const increasing = directions.filter((item) => item === 'increasing').length;
  const decreasing = directions.filter((item) => item === 'decreasing').length;
  if (increasing > decreasing) return 'increasing';
  if (decreasing > increasing) return 'decreasing';
  if (!increasing && !decreasing) return 'stable';
  return 'mixed';
}

function groupSummary(group, assessment, recommended, alternative) {
  const label = splitCamel(group).toLowerCase();
  if (assessment === GROUP_ASSESSMENTS.RECOMMENDED) return `${recommended.name} has the stronger ${label} evidence.`;
  if (assessment === GROUP_ASSESSMENTS.ALTERNATIVE) return `${alternative.name} has the stronger ${label} evidence, which works against the projection choice.`;
  if (assessment === GROUP_ASSESSMENTS.MIXED) return `${splitCamel(group)} evidence points in both directions.`;
  if (assessment === GROUP_ASSESSMENTS.NEUTRAL) return `${splitCamel(group)} evidence does not materially separate the players.`;
  return `Comparable ${label} evidence is unavailable.`;
}

function groupResult(group, assessment, recommended, alternative, facts) {
  return {
    group,
    assessment,
    summary: groupSummary(group, assessment, recommended, alternative),
    facts,
    groupedMetricCount: facts.length,
    directionalVoteCount: [GROUP_ASSESSMENTS.RECOMMENDED, GROUP_ASSESSMENTS.ALTERNATIVE].includes(assessment) ? 1 : 0,
    countedAsOneGroup: true
  };
}

function emptyGroup(group, assessment, summary) {
  return { group, assessment, summary, facts: [], groupedMetricCount: 0, directionalVoteCount: 0, countedAsOneGroup: true };
}

function publicPlayer(player) {
  return { playerId: player.playerId, name: player.name, position: player.position };
}

function confidenceBasis(classification) {
  if (classification === 'strongly_supported') return 'Multiple independent evidence groups support the projected player, including opportunity; this is not a probability.';
  if (classification === 'supported') return 'At least one stable evidence group supports the projected player without a stronger stable conflict; this is not a probability.';
  if (classification === 'projection_conflict') return 'Multiple stable workload groups favor the alternative despite a narrow projection edge; this is not a probability.';
  if (classification === 'mixed') return 'Current evidence points in different directions or does not overcome a wider projection edge; this is not a probability.';
  return 'Too little comparable current evidence is available; this is not a probability.';
}

function explicitValue(explicit, key) {
  const direct = explicit?.[key];
  if (direct != null) return valueRecord(direct, explicit?.sampleSize);
  for (const group of Object.values(explicit || {})) {
    if (group && typeof group === 'object' && !Array.isArray(group) && group[key] != null) return valueRecord(group[key], explicit?.sampleSize);
  }
  return null;
}

function valueRecord(value, fallbackSample) {
  if (value && typeof value === 'object') return { value: value.value ?? value.weightedAverage, sampleSize: value.sampleSize ?? fallbackSample, source: value.source };
  return { value, sampleSize: fallbackSample, source: null };
}

function projectionValue(player) {
  if (!player) return null;
  return finiteNumber(player.objectiveValue) ?? finiteNumber(player.mean) ?? finiteNumber(player.projection);
}

function difference(left, right) {
  return left == null || right == null ? null : left - right;
}

function metric(label, group, materialDifference, directional = true, lowerIsBetter = false) {
  return Object.freeze({ label, group, materialDifference, directional, lowerIsBetter });
}

function commonSource(left, right) {
  if (left && right && left === right) return left;
  return [left, right].filter(Boolean).join(' / ') || null;
}

function minimumSample(left, right) {
  const values = [left?.sampleSize, right?.sampleSize].map(finiteNumber).filter((value) => value != null);
  return values.length ? Math.min(...values) : null;
}

function average(values) {
  const numbers = values.map(finiteNumber).filter((value) => value != null);
  return numbers.length ? numbers.reduce((total, value) => total + value, 0) / numbers.length : null;
}

function playerId(player) {
  return String(player?.playerId ?? player?.id ?? '');
}

function normalizePosition(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeTeam(value) {
  const team = String(value || '').trim().toUpperCase();
  return ({ JAC: 'JAX', LA: 'LAR', OAK: 'LV', SD: 'LAC', STL: 'LAR', WAS: 'WSH' }[team] || team);
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value) {
  const number = finiteNumber(value);
  return number == null ? null : Math.round(number * 1000) / 1000;
}

function formatPoint(value) {
  const rounded = round(value);
  return rounded == null ? 'an unknown number of' : Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function splitCamel(value) {
  const text = String(value || '').replace(/([a-z])([A-Z])/g, '$1 $2');
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
