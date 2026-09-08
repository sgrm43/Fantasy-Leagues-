import { CALIBRATION_POSITIONS } from './calibration/calibration-readiness.js';
import { readPregameDecisionSnapshots } from './storage.js';

export const SYSTEM_SELF_EVALUATION_VERSION = 1;

/**
 * These gates are deliberately conservative. An observation is one completed,
 * leakage-safe decision; unique player-games and NFL weeks are separate gates
 * so duplicate league rows cannot make a narrow sample look mature.
 */
export const SYSTEM_SELF_EVALUATION_THRESHOLDS = Object.freeze({
  weekly: Object.freeze({
    earlyAnalysis: Object.freeze({ observations: 6, uniquePlayerGames: 6, weeks: 1, positions: 2 }),
    scored: Object.freeze({ observations: 12, uniquePlayerGames: 10, weeks: 1, positions: 3 })
  }),
  season: Object.freeze({
    earlyAnalysis: Object.freeze({ observations: 20, uniquePlayerGames: 20, weeks: 4, positions: 4 }),
    scored: Object.freeze({ observations: 60, uniquePlayerGames: 60, weeks: 8, positions: 4 })
  })
});

/** Named, provisional v1 weights. They are configuration, never learned here. */
export const PROVISIONAL_SYSTEM_SCORE_COMPONENT_WEIGHTS = Object.freeze({
  startSitDecisionAccuracy: 0.2,
  decisionValue: 0.2,
  probabilityCalibration: 0.2,
  projectionAccuracy: 0.2,
  rangeUncertaintyAccuracy: 0.2
});

// Friendly aliases for callers that use the shorter feature name.
export const SYSTEM_SCORE_READINESS_THRESHOLDS = SYSTEM_SELF_EVALUATION_THRESHOLDS;
export const SYSTEM_SCORE_COMPONENT_WEIGHTS = PROVISIONAL_SYSTEM_SCORE_COMPONENT_WEIGHTS;

/** Read the shared v1 history file and evaluate it without writing any state. */
export async function readSystemSelfEvaluation({
  season = 2026,
  week,
  leagueId,
  read = readPregameDecisionSnapshots,
  thresholds = SYSTEM_SELF_EVALUATION_THRESHOLDS,
  componentWeights = PROVISIONAL_SYSTEM_SCORE_COMPONENT_WEIGHTS
} = {}) {
  return evaluateSystemSelfEvaluation(await read(), {
    season,
    week,
    leagueId,
    thresholds,
    componentWeights
  });
}

/**
 * Pure historical evaluation. It neither changes prediction fields nor calls
 * projections, optimizers, calibration, or providers.
 */
export function evaluateSystemSelfEvaluation(historyState, {
  season = 2026,
  week,
  leagueId,
  thresholds = SYSTEM_SELF_EVALUATION_THRESHOLDS,
  componentWeights = PROVISIONAL_SYSTEM_SCORE_COMPONENT_WEIGHTS,
  optimizer: _optimizer
} = {}) {
  const selectedSeason = positiveInteger(season, 'season');
  const selectedWeek = week == null ? null : positiveInteger(week, 'week');
  const selectedLeague = leagueId == null ? null : textOrNull(leagueId);
  if (leagueId != null && !selectedLeague) throw new TypeError('leagueId must be non-empty');

  const resolvedThresholds = resolveThresholds(thresholds);
  const resolvedWeights = resolveComponentWeights(componentWeights);
  const quality = createQualityCounts();
  const records = selectCompletedRecords(historyState, { season: selectedSeason, leagueId: selectedLeague, quality });
  const decisions = selectCompletedDecisions(historyState, records, {
    season: selectedSeason,
    leagueId: selectedLeague,
    quality
  });

  const seasonScope = evaluateScope(records, decisions, {
    kind: 'season',
    thresholds: resolvedThresholds,
    componentWeights: resolvedWeights
  });
  const availableWeeks = sortedNumbers(new Set([
    ...records.map((record) => record.week),
    ...decisions.map((decision) => decision.week)
  ]));
  const activeWeek = selectedWeek ?? availableWeeks.at(-1) ?? null;
  const weeklyRecords = activeWeek == null ? [] : records.filter((record) => record.week === activeWeek);
  const weeklyDecisions = activeWeek == null ? [] : decisions.filter((decision) => decision.week === activeWeek);
  const weeklyScope = {
    season: selectedSeason,
    week: activeWeek,
    ...evaluateScope(weeklyRecords, weeklyDecisions, {
      kind: 'weekly',
      thresholds: resolvedThresholds,
      componentWeights: resolvedWeights
    })
  };

  const byWeek = Object.fromEntries(availableWeeks.map((nflWeek) => [String(nflWeek), {
    season: selectedSeason,
    week: nflWeek,
    ...evaluateScope(
      records.filter((record) => record.week === nflWeek),
      decisions.filter((decision) => decision.week === nflWeek),
      { kind: 'weekly', thresholds: resolvedThresholds, componentWeights: resolvedWeights }
    )
  }]));

  const byPosition = Object.fromEntries(CALIBRATION_POSITIONS.map((position) => [position, evaluateScope(
    records.filter((record) => record.position === position),
    decisions.filter((decision) => decision.recommended.position === position),
    { kind: 'season', thresholds: resolvedThresholds, componentWeights: resolvedWeights }
  )]));

  const leagueIds = [...new Set([
    ...records.map((record) => record.leagueId),
    ...decisions.map((decision) => decision.leagueId)
  ])].sort();
  const byLeague = Object.fromEntries(leagueIds.map((id) => [id, evaluateScope(
    records.filter((record) => record.leagueId === id),
    decisions.filter((decision) => decision.leagueId === id),
    { kind: 'season', thresholds: resolvedThresholds, componentWeights: resolvedWeights }
  )]));

  return {
    version: SYSTEM_SELF_EVALUATION_VERSION,
    selectedSeason,
    selectedWeek: activeWeek,
    selectedLeagueId: selectedLeague,
    status: seasonScope.status,
    score: seasonScope.score,
    display: scoreDisplay(seasonScope.status, seasonScope.score),
    message: scoreMessage(seasonScope.status, selectedSeason),
    sample: seasonScope.sample,
    components: seasonScope.components,
    weekly: weeklyScope,
    season: { season: selectedSeason, ...seasonScope },
    byWeek,
    byPosition,
    byLeague,
    dataQuality: quality,
    thresholds: resolvedThresholds,
    componentWeights: resolvedWeights,
    weighting: {
      name: 'provisional-v1',
      provisional: true,
      optimizedFromHistory: false,
      aggregation: 'raw completed events; season scores are not averages of weekly scores'
    },
    safeguards: {
      readOnly: true,
      leakageSafeCompletedOnly: true,
      seasonIsolated: true,
      leagueDuplicatesKeptButUniquelyCounted: true,
      confidenceLabelsConvertedToProbabilities: false,
      ignoredRecommendationsGradedCounterfactually: true,
      calibrationWeightsApplied: false,
      modelSelfModification: false
    },
    projectionsAdjusted: false,
    optimizerAdjusted: false,
    historyAdjusted: false
  };
}

function evaluateScope(records, decisions, { kind, thresholds, componentWeights }) {
  const sample = sampleMetrics(records, decisions);
  const status = readinessStatus(sample, thresholds[kind]);
  const components = componentMetrics(records, decisions);
  const score = status === 'scored' ? weightedScore(components, componentWeights) : null;
  return {
    status: score == null && status === 'scored' ? 'early_analysis' : status,
    score,
    display: scoreDisplay(score == null && status === 'scored' ? 'early_analysis' : status, score),
    message: scoreMessage(score == null && status === 'scored' ? 'early_analysis' : status, records[0]?.season ?? decisions[0]?.season ?? 2026),
    sample,
    components
  };
}

function componentMetrics(records, decisions) {
  const margins = decisions.map((decision) => decision.actualMargin);
  const wins = margins.filter((margin) => margin > 0).length;
  const losses = margins.filter((margin) => margin < 0).length;
  const ties = margins.length - wins - losses;
  const accuracy = margins.length ? (wins + (ties * 0.5)) / margins.length : null;
  const positive = sum(margins.filter((margin) => margin > 0));
  const negative = sum(margins.filter((margin) => margin < 0));
  const decidedMagnitude = positive + Math.abs(negative);
  const decisionValueScore = margins.length
    ? decidedMagnitude ? (positive / decidedMagnitude) * 100 : 50
    : null;
  const probabilityEvents = decisions
    .filter((decision) => probability(decision.probability) != null && decision.actualMargin !== 0)
    .map((decision) => ({
      probability: probability(decision.probability),
      outcome: decision.actualMargin > 0 ? 1 : 0,
      confidence: decision.confidenceLabel || 'Unlabeled'
    }));
  const probabilityMetric = brierMetric(probabilityEvents);
  const residuals = records.map((record) => record.actual - record.median);
  const normalizedProjectionScores = records.map((record) => {
    const scale = Math.max(Math.abs(record.actual), Math.abs(record.median), 1);
    return Math.max(0, 1 - (Math.abs(record.actual - record.median) / scale)) * 100;
  });
  const range = rangeMetrics(records);
  const probabilityByConfidence = groupBrierByConfidence(probabilityEvents);
  const agreements = decisions.filter((decision) => decision.type === 'agreement');
  const ignored = decisions.filter((decision) => decision.followThrough === 'ignored');
  const followed = decisions.filter((decision) => decision.followThrough === 'followed');

  return {
    startSitDecisionAccuracy: {
      evaluated: margins.length,
      wins,
      losses,
      ties,
      accuracy: roundOrNull(accuracy),
      averageActualMargin: roundOrNull(mean(margins)),
      actualMargins: margins.map((value) => round(value)),
      score: accuracy == null ? null : round(accuracy * 100)
    },
    decisionValue: {
      evaluated: margins.length,
      totalPointsAdded: round(positive),
      totalPointsLost: round(negative),
      pointsLostMagnitude: round(Math.abs(negative)),
      netPoints: round(positive + negative),
      averageMargin: roundOrNull(mean(margins)),
      score: roundOrNull(decisionValueScore),
      basis: 'actual recommended-player points minus locked alternative-player points'
    },
    probabilityCalibration: {
      ...probabilityMetric,
      eventDefinition: 'recommended player outscores the locked alternative',
      missingProbability: decisions.length - probabilityEvents.length
    },
    projectionAccuracy: {
      evaluated: records.length,
      meanAbsoluteError: roundOrNull(mean(residuals.map(Math.abs))),
      mae: roundOrNull(mean(residuals.map(Math.abs))),
      bias: roundOrNull(mean(residuals)),
      rootMeanSquaredError: roundOrNull(records.length ? Math.sqrt(mean(residuals.map((value) => value ** 2))) : null),
      score: roundOrNull(mean(normalizedProjectionScores)),
      scoreMethod: 'mean bounded relative-error skill: max(0, 1 - |actual-median| / max(|actual|, |median|, 1))'
    },
    rangeUncertaintyAccuracy: range,
    bustSpikeProbabilityQuality: bustSpikeMetrics(records),
    confidenceDiscipline: {
      evaluated: probabilityEvents.length,
      groups: probabilityByConfidence,
      score: probabilityMetric.score,
      labelsConvertedToProbabilities: false,
      basis: 'Brier error grouped by the confidence label stored before kickoff'
    },
    agreementAccuracy: agreementMetrics(agreements),
    counterfactualTracking: {
      evaluated: decisions.length,
      followed: followed.length,
      ignored: ignored.length,
      unknownFollowThrough: decisions.length - followed.length - ignored.length,
      ignoredSystemWins: ignored.filter((decision) => decision.actualMargin > 0).length,
      ignoredSystemLosses: ignored.filter((decision) => decision.actualMargin < 0).length,
      ignoredNetPoints: round(sum(ignored.map((decision) => decision.actualMargin))),
      gradingBasis: 'system recommendation versus locked alternative, whether or not the user followed it'
    }
  };
}

function rangeMetrics(records) {
  let belowFloor = 0;
  let floorToMedian = 0;
  let medianToCeiling = 0;
  let aboveCeiling = 0;
  let invalidRange = 0;
  for (const record of records) {
    if (!(record.floor <= record.median && record.median <= record.ceiling)) { invalidRange += 1; continue; }
    if (record.actual < record.floor) belowFloor += 1;
    else if (record.actual < record.median) floorToMedian += 1;
    else if (record.actual <= record.ceiling) medianToCeiling += 1;
    else aboveCeiling += 1;
  }
  const evaluated = records.length - invalidRange;
  const insideRange = floorToMedian + medianToCeiling;
  const coverage = evaluated ? insideRange / evaluated : null;
  return {
    evaluated,
    belowFloor,
    floorToMedian,
    medianToCeiling,
    aboveCeiling,
    insideRange,
    outsideRange: belowFloor + aboveCeiling,
    invalidRange,
    coverage: roundOrNull(coverage),
    score: coverage == null ? null : round(coverage * 100),
    scoreMethod: 'observed share inside the locked floor-to-ceiling range; no percentile claim is inferred'
  };
}

function bustSpikeMetrics(records) {
  const bust = [];
  const spike = [];
  const threshold = [];
  const definitions = new Set();
  for (const record of records) {
    const prediction = record.prediction;
    const definition = textOrNull(valueOf(prediction, 'definition_version', 'definitionVersion'));
    if (!prediction || !definition) continue;
    definitions.add(definition);
    const bustProbability = probability(valueOf(prediction, 'bust_probability', 'bustProbability'));
    const bustThreshold = finiteNumber(valueOf(prediction, 'bust_threshold', 'bustThreshold'));
    if (bustProbability != null && bustThreshold != null) {
      bust.push({ probability: bustProbability, outcome: record.actual <= bustThreshold ? 1 : 0 });
    }
    const spikeProbability = probability(valueOf(prediction, 'spike_probability', 'spikeProbability'));
    const spikeThreshold = finiteNumber(valueOf(prediction, 'spike_threshold', 'spikeThreshold'));
    if (spikeProbability != null && spikeThreshold != null) {
      spike.push({ probability: spikeProbability, outcome: record.actual >= spikeThreshold ? 1 : 0 });
    }
    const storedThresholds = valueOf(prediction, 'threshold_probabilities', 'thresholdProbabilities');
    if (Array.isArray(storedThresholds)) {
      for (const item of storedThresholds) {
        const thresholdValue = finiteNumber(valueOf(item, 'threshold', 'value'));
        const thresholdProbability = probability(valueOf(item, 'probability', 'probabilityAbove'));
        if (thresholdValue != null && thresholdProbability != null) {
          threshold.push({ probability: thresholdProbability, outcome: record.actual >= thresholdValue ? 1 : 0 });
        }
      }
    }
  }
  const all = [...bust, ...spike, ...threshold];
  return {
    ...brierMetric(all),
    bust: brierMetric(bust),
    spike: brierMetric(spike),
    threshold: brierMetric(threshold),
    definitions: [...definitions].sort(),
    onlyLockedDefinitionsEvaluated: true
  };
}

function agreementMetrics(decisions) {
  const correct = decisions.filter((decision) => decision.actualMargin > 0).length;
  const incorrect = decisions.filter((decision) => decision.actualMargin < 0).length;
  const ties = decisions.length - correct - incorrect;
  const accuracy = decisions.length ? (correct + (ties * 0.5)) / decisions.length : null;
  return {
    evaluated: decisions.length,
    correct,
    incorrect,
    ties,
    accuracy: roundOrNull(accuracy),
    score: accuracy == null ? null : round(accuracy * 100),
    requiresLockedAlternative: true
  };
}

function brierMetric(events) {
  if (!events.length) return { evaluated: 0, brierScore: null, score: null };
  const brierScore = mean(events.map((event) => (event.probability - event.outcome) ** 2));
  return { evaluated: events.length, brierScore: round(brierScore, 6), score: round((1 - brierScore) * 100, 4) };
}

function groupBrierByConfidence(events) {
  const groups = new Map();
  for (const event of events) {
    const list = groups.get(event.confidence) || [];
    list.push(event);
    groups.set(event.confidence, list);
  }
  return Object.fromEntries([...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, values]) => [label, brierMetric(values)]));
}

function weightedScore(components, weights) {
  let weighted = 0;
  let totalWeight = 0;
  for (const name of Object.keys(PROVISIONAL_SYSTEM_SCORE_COMPONENT_WEIGHTS)) {
    const weight = weights[name];
    const score = finiteNumber(components[name]?.score);
    if (score == null) return null;
    weighted += score * weight;
    totalWeight += weight;
  }
  return totalWeight ? round(weighted / totalWeight, 2) : null;
}

function sampleMetrics(records, decisions) {
  const recordPlayerGames = new Set(records.map((record) => record.playerGameKey));
  const decisionPlayerGames = new Set(decisions.flatMap((decision) => [
    decision.recommended.playerGameKey,
    decision.alternative.playerGameKey
  ]));
  const decisionWeeks = new Set(decisions.map((decision) => decision.week));
  const allWeeks = new Set(records.map((record) => record.week));
  const decisionPositions = new Set(decisions.map((decision) => decision.recommended.position));
  const allPositions = new Set(records.map((record) => record.position));
  const allLeagues = new Set(records.map((record) => record.leagueId));
  const weeks = sortedNumbers(allWeeks);
  return {
    completedRecords: records.length,
    completedDecisions: decisions.length,
    leagueSpecificObservations: records.length,
    uniquePlayerGames: recordPlayerGames.size,
    uniqueDecisionPlayerGames: decisionPlayerGames.size,
    weeksRepresented: allWeeks.size,
    decisionWeeksRepresented: decisionWeeks.size,
    positionsRepresented: allPositions.size,
    decisionPositionsRepresented: decisionPositions.size,
    leaguesRepresented: allLeagues.size,
    uniquePlayers: new Set(records.map((record) => record.playerId)).size,
    uniqueNflGames: new Set(records.map((record) => `${record.season}|${record.week}|${record.gameId}`)).size,
    earliestWeek: weeks[0] ?? null,
    latestWeek: weeks.at(-1) ?? null,
    deduplication: {
      leagueSpecificObservation: 'season + week + nfl_game_id + player_id + fantasy_league_id',
      uniquePlayerGame: 'season + week + nfl_game_id + player_id'
    }
  };
}

function readinessStatus(sample, gates) {
  if (meetsGate(sample, gates.scored)) return 'scored';
  if (meetsGate(sample, gates.earlyAnalysis)) return 'early_analysis';
  return 'collecting';
}

function meetsGate(sample, gate) {
  return sample.completedDecisions >= gate.observations
    && sample.uniqueDecisionPlayerGames >= (gate.uniquePlayerGames ?? 0)
    && sample.decisionWeeksRepresented >= gate.weeks
    && sample.decisionPositionsRepresented >= (gate.positions ?? 0);
}

function selectCompletedRecords(historyState, { season, leagueId, quality }) {
  if (historyState == null) return [];
  if (!plainObject(historyState) || Number(historyState.version) !== 1 || !plainObject(historyState.records)) {
    quality.rejectedInvalid += 1;
    return [];
  }
  const completed = [];
  for (const raw of Object.values(historyState.records)) {
    const recordSeason = integerOrNull(valueOf(raw, 'season'));
    if (recordSeason == null) { quality.rejectedInvalid += 1; continue; }
    if (recordSeason !== season) { quality.otherSeason += 1; continue; }
    const record = validateRecord(raw, season);
    if (!record) { quality.rejectedInvalid += 1; continue; }
    if (leagueId && record.leagueId !== leagueId) continue;
    const resultState = completedResult(raw.result, record);
    if (resultState.status !== 'completed') { quality[resultState.status] += 1; continue; }
    completed.push({
      ...record,
      actual: resultState.actual,
      prediction: plainObject(raw.prediction) ? raw.prediction : null
    });
  }
  return completed.sort((left, right) => left.recordId.localeCompare(right.recordId));
}

function validateRecord(raw, season) {
  if (!plainObject(raw)) return null;
  const week = positiveIntegerOrNull(valueOf(raw, 'week'));
  const gameId = textOrNull(valueOf(raw, 'nfl_game_id', 'nflGameId'));
  const playerId = textOrNull(valueOf(raw, 'player_id', 'playerId'));
  const leagueId = textOrNull(valueOf(raw, 'fantasy_league_id', 'fantasyLeagueId'));
  const scoringSettingsId = textOrNull(valueOf(raw, 'scoring_settings_id', 'scoringSettingsId'));
  const recordId = textOrNull(valueOf(raw, 'record_id', 'recordId'));
  const position = String(valueOf(raw, 'position') || '').trim().toUpperCase();
  const kickoff = timestamp(valueOf(raw, 'kickoff'));
  const lockAt = timestamp(valueOf(raw, 'lock_at', 'lockAt') ?? valueOf(raw, 'kickoff'));
  const capturedAt = timestamp(valueOf(raw, 'captured_at', 'capturedAt'));
  const latestCaptureAt = timestamp(valueOf(raw, 'latest_capture_at', 'latestCaptureAt') ?? valueOf(raw, 'captured_at', 'capturedAt'));
  const platform = scoringPlatform(scoringSettingsId);
  const expectedId = week && gameId && playerId && leagueId
    ? identityId([season, week, gameId, playerId, leagueId])
    : null;
  const median = finiteNumber(raw.projection?.median);
  const floor = finiteNumber(raw.projection?.floor);
  const ceiling = finiteNumber(raw.projection?.ceiling);
  if (!week || !gameId || !playerId || !leagueId || !platform || !CALIBRATION_POSITIONS.includes(position)
    || !playerId.startsWith(`${platform}:`) || !recordId || recordId !== expectedId
    || kickoff == null || lockAt == null || capturedAt == null || latestCaptureAt == null
    || !(capturedAt < lockAt && capturedAt < kickoff && latestCaptureAt < lockAt && latestCaptureAt < kickoff && lockAt <= kickoff)
    || median == null || floor == null || ceiling == null) return null;
  return {
    raw,
    recordId,
    season,
    week,
    gameId,
    playerId,
    leagueId,
    scoringSettingsId,
    platform,
    position,
    kickoff,
    lockAt,
    median,
    floor,
    ceiling,
    playerGameKey: `${season}|${week}|${gameId}|${playerId}`
  };
}

function completedResult(result, record) {
  if (result == null) return { status: 'pending' };
  if (!plainObject(result)) return { status: 'rejectedInvalid' };
  const status = String(result.status || '').trim().toLowerCase();
  const gameStatus = String(valueOf(result, 'nfl_game_status', 'nflGameStatus') || '').trim().toLowerCase();
  if (status === 'unmatched') return { status: 'unmatched' };
  if (status === 'unavailable') return { status: 'unavailable' };
  if (status === 'pending' || gameStatus !== 'final') return { status: 'pending' };
  if (status !== 'attached') return { status: 'rejectedInvalid' };
  const actual = finiteNumber(valueOf(result, 'actual_fantasy_points', 'actualFantasyPoints'));
  if (actual == null) return { status: 'missingActual' };
  const attachedAt = timestamp(valueOf(result, 'attached_at', 'attachedAt'));
  const completedAtRaw = valueOf(result, 'completed_at', 'completedAt');
  const completedAt = completedAtRaw == null ? null : timestamp(completedAtRaw);
  const source = textOrNull(result.source);
  const expectedSource = record.platform === 'espn'
    ? 'espn-fantasy-applied-total'
    : 'sleeper-league-matchup-points';
  if (attachedAt == null || attachedAt <= record.kickoff || source !== expectedSource
    || (completedAtRaw != null && (completedAt == null || completedAt <= record.kickoff))) {
    return { status: 'rejectedInvalid' };
  }
  return { status: 'completed', actual };
}

function selectCompletedDecisions(historyState, records, { season, leagueId, quality }) {
  if (!plainObject(historyState?.decisions)) return [];
  const byId = new Map(records.map((record) => [record.recordId, record]));
  const completed = [];
  const seen = new Set();
  for (const raw of Object.values(historyState.decisions)) {
    const decision = validateDecision(raw, byId, season);
    if (!decision) { quality.rejectedDecisions += 1; continue; }
    if (leagueId && decision.leagueId !== leagueId) continue;
    if (seen.has(decision.decisionId)) { quality.duplicateDecisions += 1; continue; }
    seen.add(decision.decisionId);
    completed.push(decision);
  }
  return completed.sort((left, right) => left.decisionId.localeCompare(right.decisionId));
}

function validateDecision(raw, recordsById, season) {
  if (!plainObject(raw)) return null;
  const decisionId = textOrNull(valueOf(raw, 'decision_id', 'decisionId'));
  const decisionSeason = positiveIntegerOrNull(raw.season);
  const week = positiveIntegerOrNull(raw.week);
  const leagueId = textOrNull(valueOf(raw, 'fantasy_league_id', 'fantasyLeagueId'));
  const scoringSettingsId = textOrNull(valueOf(raw, 'scoring_settings_id', 'scoringSettingsId'));
  const typeValue = String(raw.type || '').trim().toLowerCase();
  const type = typeValue === 'agreement' ? 'agreement'
    : ['start_sit', 'start-sit', 'swap'].includes(typeValue) ? 'start_sit' : null;
  const recommendedId = textOrNull(valueOf(raw, 'recommended_player_record_id', 'recommendedPlayerRecordId'));
  const alternativeId = textOrNull(valueOf(raw, 'alternative_player_record_id', 'alternativePlayerRecordId'));
  const recommended = recommendedId ? recordsById.get(recommendedId) : null;
  const alternative = alternativeId ? recordsById.get(alternativeId) : null;
  const capturedAt = timestamp(valueOf(raw, 'captured_at', 'capturedAt'));
  const latestCaptureAt = timestamp(valueOf(raw, 'latest_capture_at', 'latestCaptureAt') ?? valueOf(raw, 'captured_at', 'capturedAt'));
  const lockAt = timestamp(valueOf(raw, 'lock_at', 'lockAt'));
  if (!decisionId || decisionSeason !== season || !week || !leagueId || !type || !recommended || !alternative
    || recommended.recordId === alternative.recordId
    || recommended.season !== decisionSeason || alternative.season !== decisionSeason
    || recommended.week !== week || alternative.week !== week
    || recommended.leagueId !== leagueId || alternative.leagueId !== leagueId
    || recommended.scoringSettingsId !== alternative.scoringSettingsId
    || (scoringSettingsId && scoringSettingsId !== recommended.scoringSettingsId)
    || capturedAt == null || latestCaptureAt == null || lockAt == null
    || !(capturedAt < lockAt && latestCaptureAt < lockAt)
    || lockAt > Math.min(recommended.lockAt, alternative.lockAt)) return null;
  const explicitRecommendedPlayer = textOrNull(valueOf(raw, 'recommended_player_id', 'recommendedPlayerId'));
  const explicitAlternativePlayer = textOrNull(valueOf(raw, 'alternative_player_id', 'alternativePlayerId'));
  if ((explicitRecommendedPlayer && explicitRecommendedPlayer !== recommended.playerId)
    || (explicitAlternativePlayer && explicitAlternativePlayer !== alternative.playerId)) return null;
  const actualUserStartedPlayerId = textOrNull(valueOf(raw, 'actual_user_started_player_id', 'actualUserStartedPlayerId'));
  const probabilityRecommended = probability(valueOf(raw, 'probability_recommended_outscores', 'probabilityRecommendedOutscores'));
  return {
    raw,
    decisionId,
    season,
    week,
    leagueId,
    scoringSettingsId: recommended.scoringSettingsId,
    type,
    recommended,
    alternative,
    probability: probabilityRecommended,
    confidenceLabel: textOrNull(valueOf(raw, 'confidence_label', 'confidenceLabel')),
    expectedGain: finiteNumber(valueOf(raw, 'expected_gain', 'expectedGain')),
    actualMargin: recommended.actual - alternative.actual,
    actualUserStartedPlayerId,
    followThrough: actualUserStartedPlayerId === recommended.playerId
      ? 'followed'
      : actualUserStartedPlayerId && actualUserStartedPlayerId !== recommended.playerId ? 'ignored' : 'unknown'
  };
}

function createQualityCounts() {
  return {
    pending: 0,
    unmatched: 0,
    unavailable: 0,
    missingActual: 0,
    rejectedInvalid: 0,
    rejectedDecisions: 0,
    duplicateDecisions: 0,
    otherSeason: 0
  };
}

function resolveThresholds(value) {
  if (value == null) return cloneThresholds(SYSTEM_SELF_EVALUATION_THRESHOLDS);
  const result = {};
  for (const scope of ['weekly', 'season']) {
    result[scope] = {};
    for (const stage of ['earlyAnalysis', 'scored']) {
      const supplied = value?.[scope]?.[stage] ?? value?.[scope]?.[stage === 'earlyAnalysis' ? 'early_analysis' : stage];
      const fallback = SYSTEM_SELF_EVALUATION_THRESHOLDS[scope][stage];
      const source = plainObject(supplied) ? supplied : fallback;
      const observations = nonNegativeInteger(valueOf(source, 'observations', 'minObservations'), `${scope}.${stage}.observations`);
      const weeks = nonNegativeInteger(valueOf(source, 'weeks', 'minWeeks'), `${scope}.${stage}.weeks`);
      const gate = { observations, weeks };
      const unique = valueOf(source, 'uniquePlayerGames', 'unique_player_games', 'minUniquePlayerGames');
      const positions = valueOf(source, 'positions', 'minPositions');
      // Compact injected fixtures may intentionally provide only observation/week gates.
      if (unique != null) gate.uniquePlayerGames = nonNegativeInteger(unique, `${scope}.${stage}.uniquePlayerGames`);
      if (positions != null) gate.positions = nonNegativeInteger(positions, `${scope}.${stage}.positions`);
      result[scope][stage] = gate;
    }
  }
  return result;
}

function cloneThresholds(value) {
  return Object.fromEntries(Object.entries(value).map(([scope, stages]) => [scope,
    Object.fromEntries(Object.entries(stages).map(([stage, gate]) => [stage, { ...gate }]))
  ]));
}

function resolveComponentWeights(value) {
  const source = plainObject(value?.values) ? value.values : value;
  const result = {};
  for (const name of Object.keys(PROVISIONAL_SYSTEM_SCORE_COMPONENT_WEIGHTS)) {
    const weight = finiteNumber(source?.[name]);
    if (weight == null || weight < 0) throw new TypeError(`Invalid component weight: ${name}`);
    result[name] = weight;
  }
  if (!(sum(Object.values(result)) > 0)) throw new TypeError('At least one component weight must be positive');
  return { ...result, provisional: true };
}

function scoreDisplay(status, score) {
  if (status === 'scored' && finiteNumber(score) != null) return `System Score: ${round(score, 1).toFixed(1)}/100`;
  if (status === 'early_analysis') return 'System Score: Early Analysis';
  return 'System Score: Collecting';
}

function scoreMessage(status, season) {
  if (status === 'scored') return `Scored from a leakage-safe, multi-week ${season} sample using provisional v1 component weights.`;
  if (status === 'early_analysis') return `Early analysis — completed ${season} data can be inspected, but no production score or weights are applied.`;
  return `Collecting — more completed ${season} games are required.`;
}

function scoringPlatform(value) {
  return /^(espn|sleeper):[a-f0-9]{16}$/i.exec(value || '')?.[1]?.toLowerCase() ?? null;
}

function identityId(parts) {
  return parts.map((value) => encodeURIComponent(String(value))).join('|');
}

function valueOf(object, ...keys) {
  for (const key of keys) if (object?.[key] !== undefined) return object[key];
  return undefined;
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function probability(value) {
  const number = finiteNumber(value);
  return number != null && number >= 0 && number <= 1 ? number : null;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function integerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function positiveIntegerOrNull(value) {
  const number = integerOrNull(value);
  return number != null && number > 0 ? number : null;
}

function positiveInteger(value, label) {
  const number = positiveIntegerOrNull(value);
  if (!number) throw new TypeError(`${label} must be a positive integer`);
  return number;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return number;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values) {
  return values.length ? sum(values) / values.length : null;
}

function sortedNumbers(values) {
  return [...values].sort((left, right) => left - right);
}

function roundOrNull(value, digits = 4) {
  return finiteNumber(value) == null ? null : round(value, digits);
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
