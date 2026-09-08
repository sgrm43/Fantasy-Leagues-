import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRosterStrategy } from '../src/analytics/roster-strategy.js';

test('season strategy ranks same-position upgrades without inventing ROS values', () => {
  const team = { roster: [{ playerId: 's', name: 'Starter', position: 'WR', slot: 'WR', seasonProjection: 220 }, { playerId: 'b', name: 'Bench', position: 'WR', slot: 'bench', seasonProjection: 90 }] };
  const league = { availablePlayers: [{ playerId: 'a', name: 'Available', position: 'WR', seasonProjection: 150 }] };
  const result = analyzeRosterStrategy(team, league);
  assert.equal(result.recommendations[0].add.playerId, 'a'); assert.equal(result.recommendations[0].drop.playerId, 'b'); assert.equal(result.recommendations[0].seasonProjectionDelta, 60); assert.ok(result.missing.includes('Calibrated rest-of-season distributions'));
});

test('strategy never recommends dropping a starter or IR stash', () => {
  const team = { roster: [{ playerId: 's', name: 'Starter', position: 'RB', slot: 'RB', seasonProjection: 10 }, { playerId: 'ir', name: 'IR', position: 'RB', slot: 'IR', seasonProjection: 1 }] };
  const league = { availablePlayers: [{ playerId: 'a', name: 'Available', position: 'RB', seasonProjection: 200 }] };
  assert.equal(analyzeRosterStrategy(team, league).recommendations.length, 0);
});

test('missing season projections stay missing instead of becoming zero-value drops', () => {
  const team = { roster: [{ playerId: 'b', name: 'Unknown Bench', position: 'WR', slot: 'bench', seasonProjection: null }] };
  const league = { availablePlayers: [{ playerId: 'a', name: 'Available', position: 'WR', seasonProjection: 150 }] };
  const result = analyzeRosterStrategy(team, league);
  assert.equal(result.recommendations.length, 0);
  assert.equal(result.positionGroups.find((group) => group.position === 'WR').bestBench, null);
});
