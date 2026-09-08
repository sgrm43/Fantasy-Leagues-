import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSystemSelfEvaluation } from '../src/system-self-evaluation.js';

const SCORING_ID = 'espn:0123456789abcdef';

function completedRecord({
  season = 2026,
  week = 1,
  position = 'QB',
  playerId,
  gameId,
  leagueId = 'league-a',
  median = 15,
  floor = 10,
  ceiling = 22,
  actual = 17
} = {}) {
  const resolvedPlayerId = playerId ?? `espn:${position.toLowerCase()}-${week}`;
  const resolvedGameId = gameId ?? `game-${week}-${resolvedPlayerId}`;
  const kickoffMs = Date.UTC(season, 8, 1 + (week * 7));
  const kickoff = new Date(kickoffMs).toISOString();
  const capturedAt = new Date(kickoffMs - 60_000).toISOString();
  const recordId = [season, week, resolvedGameId, resolvedPlayerId, leagueId]
    .map((value) => encodeURIComponent(String(value)))
    .join('|');

  return {
    record_id: recordId,
    season,
    week,
    nfl_game_id: resolvedGameId,
    kickoff,
    lock_at: kickoff,
    player_id: resolvedPlayerId,
    player_name: `${position} ${resolvedPlayerId}`,
    nfl_team: 'SF',
    opponent: 'LAR',
    position,
    fantasy_league_id: leagueId,
    scoring_settings_id: SCORING_ID,
    projection: { median, floor, ceiling },
    captured_at: capturedAt,
    first_capture_at: capturedAt,
    latest_capture_at: capturedAt,
    result: {
      status: 'attached',
      actual_fantasy_points: actual,
      nfl_game_status: 'final',
      source: 'espn-fantasy-applied-total',
      completed_at: new Date(kickoffMs + 3 * 60 * 60 * 1000).toISOString(),
      attached_at: new Date(kickoffMs + 3 * 60 * 60 * 1000 + 60_000).toISOString()
    }
  };
}

function decisionPair({
  season = 2026,
  week = 1,
  leagueId = 'league-a',
  position = 'QB',
  suffix = `${leagueId}-${position}-${week}`,
  probability = 0.7,
  recommendedActual = 20,
  alternativeActual = 12,
  expectedGain = 3,
  type = 'swap',
  followed = true
} = {}) {
  const recommended = completedRecord({
    season,
    week,
    leagueId,
    position,
    playerId: `espn:recommended-${suffix}`,
    gameId: `recommended-game-${suffix}`,
    actual: recommendedActual,
    median: 18
  });
  const alternative = completedRecord({
    season,
    week,
    leagueId,
    position,
    playerId: `espn:alternative-${suffix}`,
    gameId: `alternative-game-${suffix}`,
    actual: alternativeActual,
    median: 15
  });
  const lockAt = recommended.lock_at < alternative.lock_at
    ? recommended.lock_at
    : alternative.lock_at;
  const decisionId = `decision-${suffix}`;
  const decision = {
    decision_id: decisionId,
    season,
    week,
    fantasy_league_id: leagueId,
    scoring_settings_id: SCORING_ID,
    captured_at: new Date(Date.parse(lockAt) - 30_000).toISOString(),
    lock_at: lockAt,
    type,
    recommended_player_record_id: recommended.record_id,
    alternative_player_record_id: alternative.record_id,
    recommended_player_id: recommended.player_id,
    alternative_player_id: alternative.player_id,
    current_player_id: type === 'agreement' ? recommended.player_id : alternative.player_id,
    actual_user_started_player_id: followed ? recommended.player_id : alternative.player_id,
    probability_recommended_outscores: probability,
    expected_gain: expectedGain,
    confidence_label: 'High',
    support_classification: type === 'agreement' ? 'keep-current' : 'actionable'
  };

  return { recommended, alternative, decision };
}

function history(pairs = []) {
  const records = {};
  const decisions = {};
  for (const pair of pairs) {
    records[pair.recommended.record_id] = pair.recommended;
    records[pair.alternative.record_id] = pair.alternative;
    decisions[pair.decision.decision_id] = pair.decision;
  }
  return {
    version: 1,
    updated_at: '2026-09-15T00:00:00.000Z',
    records,
    decisions
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

test('zero completed observations reports Collecting and never displays a fake 0/100 score', () => {
  const report = evaluateSystemSelfEvaluation(history(), { season: 2026, week: 1 });

  assert.equal(report.status, 'collecting');
  assert.equal(report.score, null);
  assert.equal(report.display, 'System Score: Collecting');
  assert.equal(report.sample.completedDecisions, 0);
  assert.match(report.message, /more completed 2026/i);
  assert.doesNotMatch(`${report.display} ${report.message}`, /0(?:\.0+)?\s*\/\s*100/);
});

test('a wrong 95% recommendation receives a larger Brier penalty than a wrong 55% recommendation', () => {
  const wrong95 = evaluateSystemSelfEvaluation(history([decisionPair({
    suffix: 'wrong-95', probability: 0.95, recommendedActual: 8, alternativeActual: 18
  })]), { season: 2026, week: 1 });
  const wrong55 = evaluateSystemSelfEvaluation(history([decisionPair({
    suffix: 'wrong-55', probability: 0.55, recommendedActual: 8, alternativeActual: 18
  })]), { season: 2026, week: 1 });

  assert.equal(wrong95.components.probabilityCalibration.brierScore, 0.9025);
  assert.equal(wrong55.components.probabilityCalibration.brierScore, 0.3025);
  assert.ok(wrong95.components.probabilityCalibration.brierScore > wrong55.components.probabilityCalibration.brierScore);
  assert.ok(wrong95.components.probabilityCalibration.score < wrong55.components.probabilityCalibration.score);
});

test('a correct 95% recommendation receives proper Brier credit', () => {
  const report = evaluateSystemSelfEvaluation(history([decisionPair({
    suffix: 'correct-95', probability: 0.95, recommendedActual: 21, alternativeActual: 11
  })]), { season: 2026, week: 1 });

  assert.equal(report.components.probabilityCalibration.evaluated, 1);
  assert.equal(report.components.probabilityCalibration.brierScore, 0.0025);
  assert.equal(report.components.probabilityCalibration.score, 99.75);
});

test('decision value reports points added, points lost, and net counterfactual value', () => {
  const report = evaluateSystemSelfEvaluation(history([
    decisionPair({ suffix: 'value-win', recommendedActual: 19, alternativeActual: 12 }),
    decisionPair({ suffix: 'value-loss', recommendedActual: 10, alternativeActual: 14 }),
    decisionPair({ suffix: 'value-tie', recommendedActual: 15, alternativeActual: 15 })
  ]), { season: 2026, week: 1 });

  assert.equal(report.components.decisionValue.evaluated, 3);
  assert.equal(report.components.decisionValue.totalPointsAdded, 7);
  assert.equal(report.components.decisionValue.totalPointsLost, -4);
  assert.equal(report.components.decisionValue.pointsLostMagnitude, 4);
  assert.equal(report.components.decisionValue.netPoints, 3);
});

test('recommendations are still evaluated when the user ignores them', () => {
  const report = evaluateSystemSelfEvaluation(history([decisionPair({
    suffix: 'ignored', recommendedActual: 23, alternativeActual: 13, followed: false
  })]), { season: 2026, week: 1 });

  assert.equal(report.components.startSitDecisionAccuracy.evaluated, 1);
  assert.equal(report.components.startSitDecisionAccuracy.wins, 1);
  assert.equal(report.components.decisionValue.netPoints, 10);
  assert.equal(report.components.counterfactualTracking.evaluated, 1);
  assert.equal(report.components.counterfactualTracking.ignored, 1);
  assert.equal(report.components.counterfactualTracking.followed, 0);
});

test('agreement decisions are gradeable when the locked pregame alternative is present', () => {
  const report = evaluateSystemSelfEvaluation(history([decisionPair({
    suffix: 'agreement', type: 'agreement', recommendedActual: 18, alternativeActual: 12
  })]), { season: 2026, week: 1 });

  assert.equal(report.components.agreementAccuracy.evaluated, 1);
  assert.equal(report.components.agreementAccuracy.correct, 1);
  assert.equal(report.components.agreementAccuracy.incorrect, 0);
});

test('weekly evaluation and season-to-date evaluation remain separate', () => {
  const report = evaluateSystemSelfEvaluation(history([
    decisionPair({ week: 1, suffix: 'week-1', recommendedActual: 20, alternativeActual: 10 }),
    decisionPair({ week: 2, suffix: 'week-2', recommendedActual: 8, alternativeActual: 16 })
  ]), { season: 2026, week: 2 });

  assert.equal(report.weekly.sample.completedDecisions, 1);
  assert.equal(report.weekly.components.startSitDecisionAccuracy.losses, 1);
  assert.equal(report.season.sample.completedDecisions, 2);
  assert.equal(report.season.components.startSitDecisionAccuracy.wins, 1);
  assert.equal(report.season.components.startSitDecisionAccuracy.losses, 1);
  assert.equal(report.byWeek['1'].sample.completedDecisions, 1);
  assert.equal(report.byWeek['2'].sample.completedDecisions, 1);
});

test('fantasy leagues and scoring contexts are reported separately', () => {
  const report = evaluateSystemSelfEvaluation(history([
    decisionPair({ leagueId: 'league-a', suffix: 'league-a' }),
    decisionPair({ leagueId: 'league-b', suffix: 'league-b' })
  ]), { season: 2026, week: 1 });

  assert.equal(report.byLeague['league-a'].sample.completedDecisions, 1);
  assert.equal(report.byLeague['league-b'].sample.completedDecisions, 1);
  assert.equal(report.season.sample.completedDecisions, 2);
});

test('QB, RB, WR, and TE evaluation structures remain separate', () => {
  const positions = ['QB', 'RB', 'WR', 'TE'];
  const report = evaluateSystemSelfEvaluation(history(positions.map((position) => decisionPair({
    position,
    suffix: `position-${position}`
  }))), { season: 2026, week: 1 });

  for (const position of positions) {
    assert.equal(report.byPosition[position].sample.completedDecisions, 1);
    assert.equal(report.byPosition[position].components.startSitDecisionAccuracy.evaluated, 1);
  }
});

test('an insufficient sample cannot produce a numeric overall system score', () => {
  const report = evaluateSystemSelfEvaluation(history([decisionPair({ suffix: 'too-small' })]), {
    season: 2026,
    week: 1
  });

  assert.equal(report.status, 'collecting');
  assert.equal(report.score, null);
  assert.match(report.display, /Collecting/);
  assert.ok(report.sample.completedDecisions < report.thresholds.season.scored.observations);
});

test('self-evaluation does not change locked projection values', () => {
  const input = history([decisionPair({ suffix: 'projection-isolation' })]);
  const before = Object.fromEntries(Object.entries(input.records).map(([id, value]) => [id, structuredClone(value.projection)]));

  const report = evaluateSystemSelfEvaluation(input, { season: 2026, week: 1 });

  for (const [id, projection] of Object.entries(before)) assert.deepEqual(input.records[id].projection, projection);
  assert.equal(report.projectionsAdjusted, false);
});

test('self-evaluation does not change an optimizer object or its output', () => {
  const optimizer = deepFreeze({
    objective: 'expected_points',
    output: { starters: ['espn:starter'], bench: ['espn:bench'], expectedPoints: 112.4 }
  });
  const before = structuredClone(optimizer);

  const report = evaluateSystemSelfEvaluation(history([decisionPair({ suffix: 'optimizer-isolation' })]), {
    season: 2026,
    week: 1,
    optimizer
  });

  assert.deepEqual(optimizer, before);
  assert.equal(report.optimizerAdjusted, false);
});

test('evaluation accepts deeply frozen locked history and leaves it immutable', () => {
  const input = history([decisionPair({ suffix: 'frozen-history' })]);
  const before = structuredClone(input);
  deepFreeze(input);

  assert.doesNotThrow(() => evaluateSystemSelfEvaluation(input, { season: 2026, week: 1 }));
  assert.deepEqual(input, before);
});

test('the report exposes read-only safeguards and applies no calibration or model changes', () => {
  const report = evaluateSystemSelfEvaluation(history([decisionPair({ suffix: 'read-only' })]), {
    season: 2026,
    week: 1
  });

  assert.equal(report.safeguards.readOnly, true);
  assert.equal(report.safeguards.calibrationWeightsApplied, false);
  assert.equal(report.safeguards.modelSelfModification, false);
  assert.equal(report.projectionsAdjusted, false);
  assert.equal(report.optimizerAdjusted, false);
  assert.equal(report.historyAdjusted, false);
  assert.equal(report.componentWeights.provisional, true);
});
