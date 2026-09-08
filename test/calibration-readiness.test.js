import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALIBRATION_READINESS_THRESHOLDS,
  evaluateCalibrationReadiness
} from '../src/calibration/calibration-readiness.js';

const SCORING_ID = 'espn:0123456789abcdef';

function record({
  season = 2026,
  week = 1,
  position = 'QB',
  playerId = `espn:${position.toLowerCase()}-${week}`,
  gameId = `game-${week}`,
  leagueId = 'league-a',
  median = 15,
  actual = 17,
  resultStatus = 'attached',
  gameStatus = 'final',
  result = undefined,
  captureAfterKickoff = false
} = {}) {
  const kickoffTime = Date.UTC(season, 8, 1) + (week * 7 * 24 * 60 * 60 * 1000);
  const kickoff = new Date(kickoffTime).toISOString();
  const capturedAt = new Date(kickoffTime + (captureAfterKickoff ? 60_000 : -60_000)).toISOString();
  const recordId = [season, week, gameId, playerId, leagueId].map((value) => encodeURIComponent(String(value))).join('|');
  const resolvedResult = result === undefined ? {
    status: resultStatus,
    actual_fantasy_points: actual,
    nfl_game_status: gameStatus,
    source: 'espn-fantasy-applied-total',
    completed_at: new Date(kickoffTime + 3 * 60 * 60 * 1000).toISOString(),
    attached_at: new Date(kickoffTime + 3 * 60 * 60 * 1000 + 60_000).toISOString()
  } : result;
  return {
    record_id: recordId,
    season,
    week,
    nfl_game_id: gameId,
    kickoff,
    lock_at: kickoff,
    player_id: playerId,
    player_name: `${position} Test Player`,
    nfl_team: 'SF',
    opponent: 'LAR',
    position,
    fantasy_league_id: leagueId,
    scoring_settings_id: SCORING_ID,
    projection: { median, floor: 10, ceiling: 25 },
    captured_at: capturedAt,
    first_capture_at: capturedAt,
    latest_capture_at: capturedAt,
    ...(resolvedResult === null ? {} : { result: resolvedResult })
  };
}

function state(records) {
  return {
    version: 1,
    updated_at: '2026-09-01T00:00:00.000Z',
    records: Object.fromEntries(records.map((value, index) => [`${value.record_id}#${index}`, value]))
  };
}

function generatedRecords({ weeks, playersPerWeek }) {
  return ['QB', 'RB', 'WR', 'TE'].flatMap((position) => Array.from({ length: weeks }, (_, weekIndex) =>
    Array.from({ length: playersPerWeek }, (_, playerIndex) => record({
      position,
      week: weekIndex + 1,
      playerId: `espn:${position.toLowerCase()}-${weekIndex + 1}-${playerIndex + 1}`,
      gameId: `game-${weekIndex + 1}-${playerIndex + 1}`
    }))
  ).flat());
}

test('only completed leakage-safe 2026 records count', () => {
  const valid = record();
  const invalidTiming = record({ playerId: 'espn:late', captureAfterKickoff: true });
  const missingProjection = record({ playerId: 'espn:no-projection', median: null });
  const missingActual = record({ playerId: 'espn:no-actual', actual: null });
  const priorSeason = record({ season: 2025, playerId: 'espn:prior-season' });
  const report = evaluateCalibrationReadiness(state([valid, invalidTiming, missingProjection, missingActual, priorSeason]), { season: 2026 });

  assert.equal(report.totals.completed_league_observations, 1);
  assert.equal(report.data_quality.rejected_invalid, 1);
  assert.equal(report.data_quality.missing_projection, 1);
  assert.equal(report.data_quality.missing_actual, 1);
});

test('pending and non-final results do not count', () => {
  const report = evaluateCalibrationReadiness(state([
    record({ playerId: 'espn:no-result', result: null }),
    record({ playerId: 'espn:pending', resultStatus: 'pending' }),
    record({ playerId: 'espn:in-progress', gameStatus: 'in_progress' })
  ]), { season: 2026 });
  assert.equal(report.totals.completed_league_observations, 0);
  assert.equal(report.data_quality.pending, 3);
});

test('unmatched and unavailable results stay separate and do not count', () => {
  const report = evaluateCalibrationReadiness(state([
    record({ playerId: 'espn:unmatched', resultStatus: 'unmatched', actual: null }),
    record({ playerId: 'espn:unavailable', resultStatus: 'unavailable', actual: null })
  ]), { season: 2026 });
  assert.equal(report.totals.completed_league_observations, 0);
  assert.equal(report.data_quality.unmatched, 1);
  assert.equal(report.data_quality.unavailable, 1);
});

test('QB, RB, WR, and TE completed counts remain separate', () => {
  const records = ['QB', 'RB', 'WR', 'TE'].map((position) => record({ position, playerId: `espn:${position.toLowerCase()}` }));
  const report = evaluateCalibrationReadiness(state(records), { season: 2026 });
  for (const position of ['QB', 'RB', 'WR', 'TE']) {
    assert.equal(report.positions[position].completed_league_observations, 1);
    assert.equal(report.positions[position].unique_player_games, 1);
  }
  assert.equal(report.totals.completed_league_observations, 4);
});

test('league-specific observations and unique player-games are both reported', () => {
  const shared = { playerId: 'espn:101', gameId: 'game-shared', week: 2 };
  const report = evaluateCalibrationReadiness(state([
    record({ ...shared, leagueId: 'league-a', actual: 18.4 }),
    record({ ...shared, leagueId: 'league-b', actual: 22.9 })
  ]), { season: 2026 });
  assert.equal(report.positions.QB.completed_league_observations, 2);
  assert.equal(report.positions.QB.unique_player_games, 1);
});

test('duplicate fantasy-league versions do not inflate unique player, game, or week counts', () => {
  const shared = { playerId: 'espn:101', gameId: 'game-shared', week: 2 };
  const report = evaluateCalibrationReadiness(state(['a', 'b', 'c'].map((suffix) =>
    record({ ...shared, leagueId: `league-${suffix}` })
  )), { season: 2026 });
  assert.deepEqual(report.totals, {
    completed_league_observations: 3,
    unique_player_games: 1,
    nfl_weeks_represented: 1,
    unique_players: 1,
    unique_nfl_games: 1,
    earliest_completed_week: 2,
    latest_completed_week: 2
  });
});

test('NFL weeks and earliest/latest completed weeks are calculated from completed records', () => {
  const report = evaluateCalibrationReadiness(state([
    record({ week: 1, playerId: 'espn:p1', gameId: 'g1', leagueId: 'a' }),
    record({ week: 1, playerId: 'espn:p1', gameId: 'g1', leagueId: 'b' }),
    record({ week: 3, playerId: 'espn:p2', gameId: 'g3', leagueId: 'a' })
  ]), { season: 2026 });
  assert.equal(report.totals.nfl_weeks_represented, 2);
  assert.equal(report.totals.earliest_completed_week, 1);
  assert.equal(report.totals.latest_completed_week, 3);
});

test('a large one-week sample remains collecting', () => {
  const records = ['QB', 'RB', 'WR', 'TE'].flatMap((position) => Array.from({ length: 25 }, (_, index) =>
    record({ position, playerId: `espn:${position.toLowerCase()}-${index}`, gameId: `game-${index}` })
  ));
  const report = evaluateCalibrationReadiness(state(records), { season: 2026 });
  assert.equal(report.status, 'collecting');
  assert.match(report.message, /^Collecting/);
});

test('sufficient multi-week diversity reaches early analysis and then calibration candidate', () => {
  const early = evaluateCalibrationReadiness(state(generatedRecords({ weeks: 4, playersPerWeek: 5 })), { season: 2026 });
  const candidate = evaluateCalibrationReadiness(state(generatedRecords({ weeks: 8, playersPerWeek: 8 })), { season: 2026 });
  assert.equal(early.status, 'early_analysis');
  assert.equal(candidate.status, 'calibration_candidate');
  assert.deepEqual(early.thresholds, CALIBRATION_READINESS_THRESHOLDS);
  assert.equal(early.weights_applied, false);
  assert.equal(candidate.weights_applied, false);
});

test('readiness evaluation does not modify projections or historical records', () => {
  const input = state([record({ median: 19.75, actual: 23.4 })]);
  const before = structuredClone(input);
  deepFreeze(input);
  const report = evaluateCalibrationReadiness(input, { season: 2026 });
  assert.deepEqual(input, before);
  assert.deepEqual(input.records[Object.keys(input.records)[0]].projection, { median: 19.75, floor: 10, ceiling: 25 });
  assert.equal(report.weights_applied, false);
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
