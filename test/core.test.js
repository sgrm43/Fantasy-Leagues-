import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreSleeperProjection, scoreStats, summarizeSamples } from '../src/scoring.js';
import { validateLineup, optimizeLineup } from '../src/lineup.js';
import { normalizeSleeperScoring } from '../src/adapters/sleeper.js';
import { normalizeEspn } from '../src/adapters/espn.js';

test('Sleeper scoring is translated without losing raw rules', () => {
  const result = normalizeSleeperScoring({ pass_yd: .04, pass_td: 6, rec: 1, bonus_rec_yd_100: 3 });
  assert.equal(result.rules.passYards, .04); assert.equal(result.rules.passTd, 6); assert.equal(result.rules.receptions, 1); assert.equal(result.rules.bonus_rec_yd_100, 3); assert.equal(result.raw.rec, 1);
});

test('league-specific scoring produces an auditable breakdown', () => {
  const score = scoreStats({ passYards: 300, passTd: 2, interceptions: 1 }, { passYards: .04, passTd: 4, interceptions: -2, bonuses: [{ stat: 'passYards', threshold: 300, points: 3 }] });
  assert.equal(score.total, 21); assert.equal(score.breakdown.length, 4);
});

test('Sleeper raw projections use exact custom rules and threshold bonuses', () => {
  const result = scoreSleeperProjection(
    { pass_yd: 310, pass_td: 2, pass_int: 1, pass_cmp: 26 },
    { pass_yd: .02, pass_td: 6, pass_int: -1, pass_cmp: .25, bonus_pass_yd_300: 1, bonus_pass_cmp_25: 1 }
  );
  assert.equal(result.total, 25.7);
  assert.equal(result.breakdown.filter((row) => row.bonus).length, 2);
});

test('projection samples return distribution statistics', () => {
  const result = summarizeSamples([{ rushYards: 10 }, { rushYards: 20 }, { rushYards: 30 }, { rushYards: 40 }, { rushYards: 50 }], { rushYards: .1 }, [3]);
  assert.equal(result.median, 3); assert.equal(result.thresholds[0].probability, .6);
});

test('lineup validation prevents duplicate and ineligible players', () => {
  const players = [{ id: 'a', name: 'A', position: 'QB' }];
  const result = validateLineup(players, [{ slot: 'QB', playerId: 'a', eligiblePositions: ['QB'] }, { slot: 'RB', playerId: 'a', eligiblePositions: ['RB'] }]);
  assert.equal(result.legal, false); assert.equal(result.errors.length, 1);
});

test('optimizer assigns constrained slots before flex', () => {
  const players = [{ id: 'rb', position: 'RB', projection: { mean: 10 } }, { id: 'wr', position: 'WR', projection: { mean: 15 } }];
  const result = optimizeLineup(players, [{ name: 'FLEX', eligiblePositions: ['RB', 'WR'] }, { name: 'RB', eligiblePositions: ['RB'] }]);
  assert.deepEqual(result, [{ slot: 'RB', playerId: 'rb' }, { slot: 'FLEX', playerId: 'wr' }]);
});

test('ESPN normalizer preserves platform IDs rather than joining on names', () => {
  const data = normalizeEspn({ id: '1', key: 'x', name: 'X' }, { id: 1, seasonId: 2026, status: { currentMatchupPeriod: 1 }, settings: { name: 'X', rosterSettings: { lineupSlotCounts: { 0: 1 } }, scoringSettings: { scoringItems: [{ statId: 53, points: 1 }] } }, teams: [{ id: 7, name: 'Team', roster: { entries: [{ playerId: 123, lineupSlotId: 0, playerPoolEntry: { player: { fullName: 'Player', defaultPositionId: 1, stats: [{ scoringPeriodId: 1, statSourceId: 0, appliedTotal: 17.25 }, { scoringPeriodId: 1, statSourceId: 1, appliedTotal: 19.5 }] } } }] } }] });
  assert.equal(data.teams[0].roster[0].playerId, 'espn:123'); assert.equal(data.scoring.rules['stat:53'], 1);
  assert.equal(data.teams[0].roster[0].actualPoints, 17.25); assert.equal(data.teams[0].roster[0].projection, 19.5); assert.deepEqual(data.dataIssues, []);
});
