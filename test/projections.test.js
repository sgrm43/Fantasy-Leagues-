import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POSITION_VOLATILITY,
  buildOutcomeProjection,
  isEligibleForSlot,
  projectRoster,
  recommendStartSit
} from '../src/analytics/projections.js';

const NOW = '2026-09-02T12:00:00.000Z';
const FRESH_PROVENANCE = { source: 'Provider projection', retrievedAt: '2026-09-02T10:00:00.000Z' };

test('outcome projection returns a coherent, coarsely rounded distribution', () => {
  const result = buildOutcomeProjection(
    { playerId: 'wr1', name: 'Wide Receiver', position: 'WR', projection: 15.2 },
    { provenance: FRESH_PROVENANCE, now: NOW }
  );

  assert.equal(result.available, true);
  assert.equal(result.baseline, 15);
  assert.ok(result.floor < result.median);
  assert.ok(result.median <= result.mean);
  assert.ok(result.mean < result.ceiling);
  assert.equal((result.floor * 2) % 1, 0);
  assert.equal((result.bustProbability * 20) % 1, 0);
  assert.equal(result.methodology.range, 'Floor and ceiling are approximate 20th and 80th percentiles.');
  assert.match(result.methodology.limitation, /not a calibrated simulation/i);
});

test('threshold probabilities are normalized, bounded, and decrease as the target rises', () => {
  const result = buildOutcomeProjection(
    { playerId: 'wr-thresholds', name: 'Threshold WR', position: 'WR', projection: 15, thresholds: [20, 10, '15', 20, -5, 'bad'] },
    { provenance: FRESH_PROVENANCE, now: NOW }
  );

  assert.deepEqual(result.thresholdProbabilities.map((item) => item.threshold), [10, 15, 20]);
  assert.ok(result.thresholdProbabilities.every((item) => item.probability >= 0 && item.probability <= 1));
  assert.ok(result.thresholdProbabilities[0].probability >= result.thresholdProbabilities[1].probability);
  assert.ok(result.thresholdProbabilities[1].probability >= result.thresholdProbabilities[2].probability);
});

test('zero-output players have zero probability of exceeding zero', () => {
  const activeZero = buildOutcomeProjection({ id: 'zero', position: 'RB', projection: 0, thresholds: [0, 10] }, { now: NOW });
  const unavailable = buildOutcomeProjection({ id: 'out', position: 'RB', projection: 12, injuryStatus: 'OUT', thresholds: [0, 10] }, { now: NOW });
  assert.deepEqual(activeZero.thresholdProbabilities, [{ threshold: 0, probability: 0 }, { threshold: 10, probability: 0 }]);
  assert.deepEqual(unavailable.thresholdProbabilities, [{ threshold: 0, probability: 0 }, { threshold: 10, probability: 0 }]);
});

test('position volatility gives a WR a wider relative range than a QB', () => {
  const qb = buildOutcomeProjection({ id: 'qb', position: 'QB', projection: 20 }, { now: NOW });
  const wr = buildOutcomeProjection({ id: 'wr', position: 'WR', projection: 20 }, { now: NOW });

  assert.ok(POSITION_VOLATILITY.WR > POSITION_VOLATILITY.QB);
  assert.ok(wr.ceiling - wr.floor > qb.ceiling - qb.floor);
  assert.ok(wr.bustProbability >= qb.bustProbability);
});

test('explicit adjustments are bounded, applied, and explained', () => {
  const result = buildOutcomeProjection(
    { id: 'rb', name: 'Runner', position: 'RB', projection: 10 },
    {
      now: NOW,
      adjustments: [
        { label: 'Expanded route role', delta: 0.10, source: 'snap report' },
        { label: 'Extreme input ignored beyond cap', percent: 80 }
      ]
    }
  );

  assert.equal(result.mean, 16);
  assert.deepEqual(result.adjustments.map((item) => item.delta), [0.1, 0.5]);
  assert.ok(result.explanation.some((line) => line.includes('Expanded route role: +10%')));
  assert.ok(result.explanation.some((line) => line.includes('adjustment was capped')));
});

test('availability status never invents playable points for an out player', () => {
  const result = buildOutcomeProjection({ id: 'te', position: 'TE', projection: 12, injuryStatus: 'OUT' }, { now: NOW });
  assert.equal(result.mean, 0);
  assert.equal(result.floor, 0);
  assert.equal(result.ceiling, 0);
  assert.equal(result.bustProbability, 1);
  assert.equal(result.spikeProbability, 0);
  assert.match(result.explanation.join(' '), /sets the playable projection to zero/i);
});

test('common platform status aliases suppress unavailable players', () => {
  for (const status of ['O', 'INJURY_RESERVE', 'INJURED_RESERVE', 'PUP', 'NFI', 'NA']) {
    const result = buildOutcomeProjection({ id: status, position: 'RB', projection: 12, injuryStatus: status }, { now: NOW });
    assert.equal(result.mean, 0, `${status} should not retain playable points`);
  }
  assert.ok(buildOutcomeProjection({ id: 'q', position: 'RB', projection: 12, injuryStatus: 'Q' }, { now: NOW }).mean > 0);
});

test('missing projections remain visibly unavailable instead of becoming zero-point forecasts', () => {
  const result = buildOutcomeProjection({ id: 'missing', name: 'Unknown', position: 'RB', projection: null }, { now: NOW });
  assert.equal(result.available, false);
  assert.equal(result.mean, null);
  assert.equal(result.confidence.level, 'low');
  assert.match(result.explanation[0], /no numeric source projection/i);
});

test('freshness and provenance are preserved and stale data lowers confidence', () => {
  const fresh = buildOutcomeProjection(
    { id: 'fresh', position: 'QB', projection: { mean: 20, sampleSize: 10 } },
    { provenance: FRESH_PROVENANCE, now: NOW }
  );
  const stale = buildOutcomeProjection(
    { id: 'stale', position: 'QB', projection: { mean: 20, sampleSize: 10 } },
    { provenance: { source: 'Old model', retrievedAt: '2026-08-29T00:00:00.000Z' }, now: NOW }
  );

  assert.equal(fresh.provenance.source, 'Provider projection');
  assert.equal(fresh.freshness.status, 'fresh');
  assert.equal(fresh.freshness.ageHours, 2);
  assert.equal(stale.freshness.status, 'stale');
  assert.ok(fresh.confidence.score > stale.confidence.score);
  assert.match(fresh.confidence.meaning, /not the probability/i);
});

test('projectRoster accepts per-player situational context without mutating players', () => {
  const players = [
    { id: 'a', position: 'RB', projection: 10 },
    { id: 'b', position: 'WR', projection: 10 }
  ];
  const result = projectRoster(players, {
    now: NOW,
    byPlayer: { b: { adjustments: [{ label: 'Role increase', delta: 0.2 }] } }
  });

  assert.equal(result[0].mean, 10);
  assert.equal(result[1].mean, 12);
  assert.equal(players[1].projection, 10);
});

test('slot eligibility handles flex, superflex, defense aliases, and bench', () => {
  assert.equal(isEligibleForSlot({ position: 'RB' }, 'FLEX'), true);
  assert.equal(isEligibleForSlot({ position: 'QB' }, 'FLEX'), false);
  assert.equal(isEligibleForSlot({ position: 'QB' }, 'SUPER_FLEX'), true);
  assert.equal(isEligibleForSlot({ position: 'DEF' }, 'D/ST'), true);
  assert.equal(isEligibleForSlot({ position: 'WR' }, 'bench'), false);
  assert.equal(isEligibleForSlot({ positions: ['WR', 'RB'] }, { name: 'RB', eligiblePositions: ['RB'] }), true);
});

test('recommendations accept normalized ESPN slot-count descriptors', () => {
  const result = recommendStartSit({
    players: [
      { playerId: 'espn:1', name: 'RB One', position: 'RB', projection: 12, slot: 'RB' },
      { playerId: 'espn:2', name: 'RB Two', position: 'RB', projection: 11, slot: 'RB' },
      { playerId: 'espn:3', name: 'Bench RB', position: 'RB', projection: 15, slot: 'bench' }
    ],
    slots: [{ slotId: '2', count: 2 }],
    provenance: FRESH_PROVENANCE,
    now: NOW
  });

  assert.equal(result.recommended.assignments.length, 2);
  assert.deepEqual(new Set(result.recommended.assignments.map((item) => item.playerId)), new Set(['espn:1', 'espn:3']));
  assert.equal(result.expectedGain, 4);
});

test('player-level source metadata inherits a league retrieval time', () => {
  const result = buildOutcomeProjection(
    { id: 'mixed', position: 'WR', projection: { mean: 14, source: 'Player model' } },
    { provenance: { source: 'League API', retrievedAt: '2026-09-02T10:00:00.000Z' }, now: NOW }
  );

  assert.equal(result.provenance.source, 'Player model');
  assert.equal(result.provenance.retrievedAt, '2026-09-02T10:00:00.000Z');
  assert.equal(result.freshness.status, 'fresh');
});

test('recommendStartSit promotes a better eligible bench player and explains uncertainty', () => {
  const result = recommendStartSit({
    players: [
      { id: 'qb-start', name: 'Current QB', position: 'QB', projection: 18, slot: 'QB' },
      { id: 'rb-start', name: 'Current RB', position: 'RB', projection: 10, slot: 'RB' },
      { id: 'rb-bench', name: 'Better RB', position: 'RB', projection: 15, slot: 'bench' },
      { id: 'qb-bench', name: 'Backup QB', position: 'QB', projection: 17, slot: 'bench' }
    ],
    slots: ['QB', 'RB'],
    provenance: FRESH_PROVENANCE,
    now: NOW
  });

  assert.equal(result.current.complete, true);
  assert.equal(result.recommended.complete, true);
  assert.equal(result.expectedGain, 5);
  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].start.playerId, 'rb-bench');
  assert.equal(result.recommendations[0].sit.playerId, 'rb-start');
  assert.equal(result.recommendations[0].targetSlot, 'RB');
  assert.equal(result.recommendations[0].probabilityStartOutscoresSit, 0.8);
  assert.ok(result.recommendations[0].rationale.some((line) => line.includes('complete lineup is legal')));
  assert.ok(result.recommendations[0].whatCouldChange.some((line) => /injury/i.test(line)));
  assert.equal(result.freshness.status, 'fresh');
  assert.equal(result.provenance.source, 'Provider projection');
  assert.match(result.methodology.comparisonProbability, /independent-outcomes approximation/i);
});

test('lineup-wide custom thresholds are forwarded to every projection', () => {
  const result = recommendStartSit({
    players: [{ id: 'rb', name: 'RB', position: 'RB', projection: 12, slot: 'RB' }],
    slots: ['RB'],
    thresholds: [8, 16],
    now: NOW
  });

  assert.deepEqual(result.projections[0].thresholdProbabilities.map((item) => item.threshold), [8, 16]);
});

test('whole-lineup optimization preserves constrained slots before flex', () => {
  const result = recommendStartSit({
    players: [
      { id: 'rb-low', name: 'Low RB', position: 'RB', projection: 10, slot: 'RB' },
      { id: 'wr-low', name: 'Low WR', position: 'WR', projection: 8, slot: 'FLEX' },
      { id: 'rb-high', name: 'High RB', position: 'RB', projection: 20, slot: 'bench' },
      { id: 'wr-high', name: 'High WR', position: 'WR', projection: 18, slot: 'bench' }
    ],
    slots: ['FLEX', 'RB'],
    now: NOW
  });

  const assignments = new Map(result.recommended.assignments.map((item) => [item.slot, item.playerId]));
  assert.equal(assignments.get('RB'), 'rb-high');
  assert.equal(assignments.get('FLEX'), 'wr-high');
  assert.equal(result.expectedGain, 20);
});

test('an ineligible high projection cannot displace a flex player', () => {
  const result = recommendStartSit({
    players: [
      { id: 'wr', name: 'WR', position: 'WR', projection: 10, slot: 'FLEX' },
      { id: 'qb', name: 'QB', position: 'QB', projection: 40, slot: 'bench' }
    ],
    slots: ['FLEX'],
    now: NOW
  });

  assert.equal(result.recommended.assignments[0].playerId, 'wr');
  assert.equal(result.expectedGain, 0);
  assert.deepEqual(result.recommendations, []);
});

test('small projection edges are withheld as close calls', () => {
  const result = recommendStartSit({
    players: [
      { id: 'starter', name: 'Starter', position: 'TE', projection: 10, slot: 'TE' },
      { id: 'bench', name: 'Bench', position: 'TE', projection: 10.4, slot: 'bench' }
    ],
    slots: ['TE'],
    minimumGain: 1,
    now: NOW
  });

  assert.equal(result.recommendations.length, 0);
  assert.ok(result.warnings.some((warning) => /toss-up/i.test(warning)));
});

test('recommendations clearly report when the current lineup is unavailable', () => {
  const result = recommendStartSit({
    players: [{ id: 'rb', name: 'RB', position: 'RB', projection: 10 }],
    slots: ['RB'],
    now: NOW
  });

  assert.equal(result.expectedGain, null);
  assert.equal(result.recommendations.length, 0);
  assert.ok(result.warnings.some((warning) => /no current starters/i.test(warning)));
  assert.equal(result.recommended.assignments[0].playerId, 'rb');
});

test('an empty active slot produces a fill-lineup recommendation without inventing a sit player', () => {
  const result = recommendStartSit({
    players: [
      { id: 'qb', name: 'QB', position: 'QB', projection: 20, slot: 'QB' },
      { id: 'bench-rb', name: 'Bench RB', position: 'RB', projection: 11, slot: 'bench' }
    ],
    slots: ['QB', 'RB'],
    now: NOW
  });
  assert.equal(result.recommended.complete, true);
  assert.equal(result.recommendations.length, 1);
  assert.equal(result.recommendations[0].start.playerId, 'bench-rb');
  assert.equal(result.recommendations[0].sit, null);
  assert.equal(result.recommendations[0].probabilityStartOutscoresSit, null);
});
