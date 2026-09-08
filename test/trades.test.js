import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTrade } from '../src/analytics/trades.js';

const league = { teams: [
  { id: 'a', name: 'A', roster: [{ playerId: 'a1', name: 'A RB', position: 'RB', slot: 'RB', projection: 10 }, { playerId: 'a2', name: 'A WR', position: 'WR', slot: 'WR', projection: 20 }, { playerId: 'ab', name: 'A Bench', position: 'RB', slot: 'bench', projection: 8 }] },
  { id: 'b', name: 'B', roster: [{ playerId: 'b1', name: 'B RB', position: 'RB', slot: 'RB', projection: 18 }, { playerId: 'b2', name: 'B WR', position: 'WR', slot: 'WR', projection: 12 }, { playerId: 'bb', name: 'B Bench', position: 'WR', slot: 'bench', projection: 9 }] }
] };

test('trade analyzer measures both teams and remains read-only', () => {
  const result = evaluateTrade({ league, fromTeamId: 'a', toTeamId: 'b', givePlayerIds: ['a2'], receivePlayerIds: ['b1'], now: '2026-09-02T00:00:00Z' });
  assert.equal(result.readOnly, true); assert.equal(result.trade.give[0].name, 'A WR'); assert.equal(result.sides.from.team.name, 'A'); assert.equal(result.sides.to.team.name, 'B');
  assert.match(result.caveats.join(' '), /rest-of-season/i);
});

test('trade analyzer rejects players not owned by selected side', () => {
  assert.throws(() => evaluateTrade({ league, fromTeamId: 'a', toTeamId: 'b', givePlayerIds: ['b1'], receivePlayerIds: ['a1'] }), /not on the selected team/);
});

test('trade depth excludes players promoted into the optimized starting lineup', () => {
  const depthLeague = { teams: [
    { id: 'a', name: 'A', roster: [{ playerId: 'a-rb', name: 'A RB', position: 'RB', slot: 'RB', projection: 10 }, { playerId: 'a-wr', name: 'A WR', position: 'WR', slot: 'WR', projection: 10 }, { playerId: 'a-bench', name: 'A Bench', position: 'RB', slot: 'bench', projection: 5 }] },
    { id: 'b', name: 'B', roster: [{ playerId: 'b-rb', name: 'B RB', position: 'RB', slot: 'RB', projection: 20 }, { playerId: 'b-wr', name: 'B WR', position: 'WR', slot: 'WR', projection: 10 }, { playerId: 'b-bench', name: 'B Bench', position: 'WR', slot: 'bench', projection: 1 }] }
  ] };
  const result = evaluateTrade({ league: depthLeague, fromTeamId: 'a', toTeamId: 'b', givePlayerIds: ['a-rb'], receivePlayerIds: ['b-rb'], now: '2026-09-02T00:00:00Z' });
  assert.equal(result.sides.from.postTradeDepthScore, 5);
  assert.equal(result.sides.from.depthDelta, 0);
});

test('trade analyzer separates weekly impact from a broad full-season lineup signal', () => {
  const seasonLeague = { teams: [
    { id: 'a', name: 'A', roster: [{ playerId: 'a1', name: 'A RB', position: 'RB', slot: 'RB', projection: 15, seasonProjection: 180 }, { playerId: 'ab', name: 'A Bench', position: 'RB', slot: 'bench', projection: 5, seasonProjection: 80 }] },
    { id: 'b', name: 'B', roster: [{ playerId: 'b1', name: 'B RB', position: 'RB', slot: 'RB', projection: 10, seasonProjection: 240 }, { playerId: 'bb', name: 'B Bench', position: 'RB', slot: 'bench', projection: 4, seasonProjection: 70 }] }
  ] };
  const result = evaluateTrade({ league: seasonLeague, fromTeamId: 'a', toTeamId: 'b', givePlayerIds: ['a1'], receivePlayerIds: ['b1'], now: '2026-09-02T00:00:00Z' });
  assert.equal(result.sides.from.expectedLineupDelta, -5);
  assert.equal(result.sides.from.seasonSignal.available, true);
  assert.equal(result.sides.from.seasonSignal.expectedLineupDelta, 60);
  assert.match(result.sides.from.seasonSignal.basis, /broad roster-value signal/i);
});
