import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeWaivers,
  createWaiverReport,
  rankAddDropPairs,
  weeklyProjection
} from '../src/analytics/waivers.js';

const player = (id, name, position, slot, projection, extra = {}) => ({
  playerId: id,
  name,
  position,
  slot,
  projection,
  injuryStatus: null,
  percentOwned: 20,
  ...extra
});

test('ranks positive weekly add/drop pairs and prefers a same-position bench upgrade', () => {
  const roster = [
    player('starter-rb', 'Starter RB', 'RB', 'RB', 16),
    player('bench-rb', 'Bench RB', 'RB', 'bench', 6),
    player('bench-wr', 'Bench WR', 'WR', 'bench', 3)
  ];
  const available = [
    player('add-rb', 'Available RB', 'RB', 'available', 11, { percentOwned: 72 }),
    player('add-wr', 'Available WR', 'WR', 'available', 5, { percentOwned: 10 })
  ];

  const moves = rankAddDropPairs(roster, available);

  assert.equal(moves.length, 2);
  assert.equal(moves[0].rank, 1);
  assert.equal(moves[0].add.playerId, 'add-rb');
  assert.equal(moves[0].drop.playerId, 'bench-rb');
  assert.equal(moves[0].expectedWeeklyDelta, 5);
  assert.equal(moves[0].positionFit, 'same-position');
  assert.equal(moves[0].urgency, 'high');
  assert.ok(moves[0].reasons.length >= 2);
  assert.ok(moves[0].caveats.some((text) => text.includes('rest-of-season')));
});

test('protects current starters and unknown roster slots from drops by default', () => {
  const roster = [
    player('starter', 'Low Starter', 'WR', 'WR', 1),
    player('unknown', 'Unknown Slot', 'WR', null, 0),
    player('bench', 'Bench Player', 'WR', 'bench', 6)
  ];
  const moves = rankAddDropPairs(roster, [player('add', 'Waiver Player', 'WR', 'available', 10)]);

  assert.equal(moves.length, 1);
  assert.equal(moves[0].drop.playerId, 'bench');
  assert.notEqual(moves[0].drop.playerId, 'starter');
  assert.notEqual(moves[0].drop.playerId, 'unknown');
});

test('reports weekly scope and never fabricates rest-of-season values', () => {
  const team = { roster: [player('bench', 'Bench Player', 'TE', 'bench', 4)] };
  const league = { availablePlayers: [player('add', 'Waiver TE', 'TE', 'available', 8)] };

  const report = createWaiverReport(team, league);

  assert.equal(report.scope, 'weekly');
  assert.match(report.scopeLabel, /Weekly only/);
  assert.equal(report.restOfSeasonIncluded, false);
  assert.equal(report.readOnly, true);
  assert.equal(report.recommendations[0].expectedWeeklyDelta, 4);
  assert.equal('restOfSeasonValue' in report.recommendations[0], false);
  assert.ok(report.caveats.some((text) => text.includes('no rest-of-season')));
});

test('filters unavailable additions and protects injured bench stashes unless explicitly overridden', () => {
  const roster = [
    player('healthy', 'Healthy Bench', 'RB', 'bench', 7),
    player('ir', 'IR Stash', 'RB', 'bench', 1, { injuryStatus: 'OUT' })
  ];
  const available = [
    player('out-add', 'Unavailable Add', 'RB', 'available', 15, { injuryStatus: 'OUT' }),
    player('healthy-add', 'Healthy Add', 'RB', 'available', 10)
  ];

  const report = analyzeWaivers({ roster, availablePlayers: available });

  assert.equal(report.recommendations.length, 1);
  assert.equal(report.recommendations[0].add.playerId, 'healthy-add');
  assert.equal(report.recommendations[0].drop.playerId, 'healthy');
  assert.deepEqual(report.protections.injuredBenchPlayers.map((entry) => entry.playerId), ['ir']);

  const overridden = rankAddDropPairs(roster, available, { allowInjuredDrops: true });
  assert.equal(overridden[0].drop.playerId, 'ir');
  assert.equal(overridden[0].expectedWeeklyDelta, 9);
});

test('accepts distribution means without treating missing projections as zero', () => {
  assert.equal(weeklyProjection({ projection: { mean: 9.25, floor: 4, ceiling: 15 } }), 9.25);
  assert.equal(weeklyProjection({ projection: null }), null);

  const moves = rankAddDropPairs(
    [player('missing', 'Missing Projection', 'QB', 'bench', null), player('known', 'Known Bench QB', 'QB', 'bench', { mean: 5 })],
    [player('add', 'Available QB', 'QB', 'available', { mean: 8 })]
  );
  assert.equal(moves[0].drop.playerId, 'known');
  assert.equal(moves[0].expectedWeeklyDelta, 3);
});

test('labels cross-position moves and warns about changed roster depth', () => {
  const moves = rankAddDropPairs(
    [player('bench-wr', 'Bench WR', 'WR', 'bench', 2)],
    [player('add-te', 'Available TE', 'TE', 'available', 9)]
  );

  assert.equal(moves[0].positionFit, 'cross-position');
  assert.ok(moves[0].caveats.some((text) => text.includes('changes roster depth')));
});

test('ranking accepts normalized team and league objects directly', () => {
  const team = { roster: [player('bench', 'Bench WR', 'WR', 'bench', 4)] };
  const league = { availablePlayers: [player('add', 'Waiver WR', 'WR', 'available', 7)] };

  const moves = rankAddDropPairs(team, league);

  assert.equal(moves[0].expectedWeeklyDelta, 3);
});
