import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecommendationQualityReport, evaluateRecommendationQuality } from '../src/analytics/recommendation-quality.js';
import { recommendStartSit } from '../src/analytics/projections.js';

const NOW = '2026-09-02T12:00:00.000Z';
const FRESH_PROVENANCE = { source: 'Provider projection', retrievedAt: '2026-09-02T10:00:00.000Z' };

test('higher opportunity supports the existing projected player', () => {
  const result = compare(
    evidencePlayer('a', 'WR', 15, { targets: 9 }),
    evidencePlayer('b', 'WR', 13, { targets: 5 }),
    2
  );

  assert.equal(result.recommendedPlayer.playerId, 'a');
  assert.equal(result.projectionDifference, 2);
  assert.equal(result.evidence.volumeOpportunity.assessment, 'supports_recommended');
  assert.equal(result.supportClassification, 'supported');
  assert.equal(result.confidence, 'Moderate');
});

test('a narrow projection edge with clearly weaker workload is a projection conflict', () => {
  const recommended = evidencePlayer('a', 'WR', 14.8, {
    targets: 4, routes: 20, routeParticipation: 0.55, snapShare: 0.58, redZoneTargets: 0
  }, { targets: 'decreasing', routes: 'decreasing' });
  const alternative = evidencePlayer('b', 'WR', 14, {
    targets: 9, routes: 34, routeParticipation: 0.9, snapShare: 0.88, redZoneTargets: 3
  }, { targets: 'increasing', routes: 'increasing' });
  const result = compare(recommended, alternative, 0.8);

  assert.equal(result.recommendedPlayer.playerId, 'a');
  assert.equal(result.evidence.volumeOpportunity.assessment, 'supports_alternative');
  assert.equal(result.evidence.role.assessment, 'supports_alternative');
  assert.equal(result.evidence.scoringOpportunity.assessment, 'supports_alternative');
  assert.equal(result.evidence.recentTrend.assessment, 'supports_alternative');
  assert.equal(result.supportClassification, 'projection_conflict');
  assert.equal(result.confidence, 'Low');
  assert.ok(result.reasons.some((reason) => /b has the stronger/i.test(reason)));
});

test('extreme efficiency on tiny volume receives a sustainability warning', () => {
  const result = compare(
    evidencePlayer('a', 'WR', 13, { targets: 3, receptions: 2, routes: 15, avgYacAboveExpectation: 55, fantasyPoints: 18 }, {}, 1),
    evidencePlayer('b', 'WR', 12.4, { targets: 7, routes: 31, avgYacAboveExpectation: 2 }),
    0.6
  );

  assert.ok(result.warnings.some((warning) => warning.code === 'efficiency_dependent_production'));
  assert.notEqual(result.supportClassification, 'strongly_supported');
  assert.notEqual(result.confidence, 'High');
});

test('strong opportunity despite low recent scoring is recognized', () => {
  const result = compare(
    evidencePlayer('a', 'WR', 14, { targets: 10, routes: 35, routeParticipation: 0.92, airYards: 125, fantasyPoints: 6 }),
    evidencePlayer('b', 'WR', 13.2, { targets: 5, routes: 25, routeParticipation: 0.64, airYards: 50, fantasyPoints: 13 }),
    0.8
  );

  assert.ok(result.warnings.some((warning) => warning.code === 'opportunity_without_recent_scoring'));
  assert.equal(result.evidence.volumeOpportunity.assessment, 'supports_recommended');
  assert.equal(result.supportClassification, 'supported');
  assert.equal(result.confidence, 'Moderate');
  assert.ok(!result.warnings.some((warning) => warning.code === 'efficiency_dependent_production'));
});

test('targets, target share, routes, and route participation remain grouped', () => {
  const result = compare(
    evidencePlayer('a', 'WR', 13, { targets: 10, targetShare: 0.3, routes: 36, routeParticipation: 0.92 }),
    evidencePlayer('b', 'WR', 12.5, { targets: 5, targetShare: 0.15, routes: 24, routeParticipation: 0.62 }),
    0.5
  );

  assert.deepEqual(result.supportingGroups, ['volumeOpportunity', 'role']);
  assert.equal(result.evidence.volumeOpportunity.directionalVoteCount, 1);
  assert.equal(result.evidence.role.directionalVoteCount, 1);
  assert.equal(result.supportClassification, 'supported');
});

test('carries, rushing share, and snap share remain grouped', () => {
  const result = compare(
    evidencePlayer('a', 'RB', 14, { carries: 20, rushingShare: 0.72, snapShare: 0.8 }),
    evidencePlayer('b', 'RB', 13.4, { carries: 8, rushingShare: 0.31, snapShare: 0.45 }),
    0.6
  );

  assert.deepEqual(result.supportingGroups, ['volumeOpportunity', 'role']);
  assert.equal(result.evidence.volumeOpportunity.directionalVoteCount, 1);
  assert.equal(result.evidence.role.directionalVoteCount, 1);
  assert.equal(result.supportClassification, 'supported');
});

test('missing evidence is neutral instead of zero', () => {
  const result = compare(evidencePlayer('a', 'TE', 16), evidencePlayer('b', 'TE', 14), 2);

  assert.equal(result.supportClassification, 'insufficient_evidence');
  assert.equal(result.confidence, 'Uncertain');
  assert.deepEqual(result.conflictingGroups, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.positionStatistics, { recommended: [], alternative: [] });
});

test('Learning NGS and nflverse context remains neutral', () => {
  const recommended = evidencePlayer('a', 'WR', 15, { targets: 9 });
  const alternative = evidencePlayer('b', 'WR', 13.5, { targets: 5 });
  const withoutLearning = compare(recommended, alternative, 1.5);
  const learning = { available: false, learning: true, season: 2026, current: null, sampleSize: 0 };
  const withLearning = evaluateRecommendationQuality({
    recommendedPlayer: recommended,
    alternativePlayer: alternative,
    projectionDifference: 1.5,
    recommendedContext: { nextGen: learning, nflverse: learning, season: 2026, nextGenSeason: 2026 },
    alternativeContext: { nextGen: learning, nflverse: learning, season: 2026, nextGenSeason: 2026 }
  });

  assert.equal(withLearning.supportClassification, withoutLearning.supportClassification);
  assert.equal(withLearning.confidence, withoutLearning.confidence);
  assert.deepEqual(withLearning.supportingGroups, withoutLearning.supportingGroups);
  assert.deepEqual(withLearning.conflictingGroups, withoutLearning.conflictingGroups);
  assert.deepEqual(withLearning.warnings, withoutLearning.warnings);
});

test('confidence labels change deterministically with evidence quality', () => {
  const cases = [
    {
      expected: ['strongly_supported', 'High'],
      left: evidencePlayer('high-a', 'WR', 16, { targets: 10, routeParticipation: 0.92, redZoneTargets: 3 }, { targets: 'increasing' }),
      right: evidencePlayer('high-b', 'WR', 13, { targets: 5, routeParticipation: 0.6, redZoneTargets: 0 }, { targets: 'decreasing' }),
      difference: 3
    },
    { expected: ['supported', 'Moderate'], left: evidencePlayer('mod-a', 'WR', 15, { targets: 9 }), right: evidencePlayer('mod-b', 'WR', 13, { targets: 5 }), difference: 2 },
    {
      expected: ['projection_conflict', 'Low'],
      left: evidencePlayer('low-a', 'WR', 14.8, { targets: 4, routes: 20, routeParticipation: 0.55, redZoneTargets: 0 }, { targets: 'decreasing' }),
      right: evidencePlayer('low-b', 'WR', 14, { targets: 9, routes: 34, routeParticipation: 0.9, redZoneTargets: 3 }, { targets: 'increasing' }),
      difference: 0.8
    },
    { expected: ['insufficient_evidence', 'Uncertain'], left: evidencePlayer('none-a', 'TE', 14), right: evidencePlayer('none-b', 'TE', 13.5), difference: 0.5 }
  ];

  for (const fixture of cases) {
    const result = compare(fixture.left, fixture.right, fixture.difference);
    assert.deepEqual([result.supportClassification, result.confidence], fixture.expected);
    assert.equal('confidencePercentage' in result, false);
    assert.equal('confidenceProbability' in result, false);
  }
});

test('quality evaluation leaves optimizer output unchanged', () => {
  const players = [
    evidencePlayer('rb-low', 'RB', 10, { carries: 22, snapShare: 0.85, redZoneCarries: 4 }, {}, 3, 'RB'),
    evidencePlayer('wr-low', 'WR', 8, { targets: 10, routeParticipation: 0.9 }, {}, 3, 'FLEX'),
    evidencePlayer('rb-high', 'RB', 20, { carries: 5, snapShare: 0.3 }, {}, 3, 'bench'),
    evidencePlayer('wr-high', 'WR', 18, { targets: 3, routeParticipation: 0.4 }, {}, 3, 'bench')
  ];
  const lineup = recommendStartSit({ players, slots: ['FLEX', 'RB'], now: NOW, provenance: FRESH_PROVENANCE });
  const protectedBefore = structuredClone({ current: lineup.current, recommended: lineup.recommended, expectedGain: lineup.expectedGain, recommendations: lineup.recommendations.map(({ start, sit }) => ({ start, sit })) });

  buildRecommendationQualityReport({ lineup, players, season: 2026, usageSeason: 2026 });

  assert.deepEqual({ current: lineup.current, recommended: lineup.recommended, expectedGain: lineup.expectedGain, recommendations: lineup.recommendations.map(({ start, sit }) => ({ start, sit })) }, protectedBefore);
  assert.equal(new Map(lineup.recommended.assignments.map((item) => [item.slot, item.playerId])).get('RB'), 'rb-high');
  assert.equal(lineup.expectedGain, 20);
});

test('quality evaluation leaves every projection value unchanged', () => {
  const players = [
    evidencePlayer('current', 'WR', 14.4, { targets: 11, routes: 36, redZoneTargets: 3 }, {}, 3, 'WR'),
    evidencePlayer('projected', 'WR', 15.2, { targets: 3, routes: 16, redZoneTargets: 0 }, {}, 3, 'bench')
  ];
  const lineup = recommendStartSit({ players, slots: ['WR'], now: NOW, provenance: FRESH_PROVENANCE, thresholds: [10, 15, 20], minimumGain: 0.5 });
  const before = structuredClone({
    projections: lineup.projections.map(protectedProjection),
    comparisonProbability: lineup.recommendations[0].probabilityStartOutscoresSit
  });

  buildRecommendationQualityReport({ lineup, players, season: 2026, usageSeason: 2026 });

  assert.deepEqual({
    projections: lineup.projections.map(protectedProjection),
    comparisonProbability: lineup.recommendations[0].probabilityStartOutscoresSit
  }, before);
});

test('quality evaluation remains read-only and never performs a transaction', () => {
  const safeguards = Object.freeze({ readOnly: true, transactionsPerformed: false });
  let transactionCalls = 0;
  const result = evaluateRecommendationQuality({
    recommendedPlayer: evidencePlayer('a', 'RB', 15, { carries: 18 }),
    alternativePlayer: evidencePlayer('b', 'RB', 13, { carries: 10 }),
    projectionDifference: 2,
    safeguards,
    executeTransaction: () => { transactionCalls += 1; }
  });

  assert.equal(transactionCalls, 0);
  assert.deepEqual(safeguards, { readOnly: true, transactionsPerformed: false });
  assert.deepEqual(result.safeguards, { readOnly: true, transactionsPerformed: false });
  assert.equal(result.projectionsAdjusted, false);
  assert.equal(result.optimizerAdjusted, false);
  assert.equal('transaction' in result, false);
});

function compare(recommendedPlayer, alternativePlayer, projectionDifference) {
  return evaluateRecommendationQuality({ recommendedPlayer, alternativePlayer, projectionDifference });
}

function evidencePlayer(id, position, projection, values = {}, directions = {}, sampleSize = 3, slot = 'bench') {
  const opportunity = Object.fromEntries(Object.entries(directions).map(([key, direction]) => [key, {
    sampleSize,
    weightedAverage: values[key] ?? null,
    direction
  }]));
  return {
    playerId: id,
    name: id.toUpperCase(),
    position,
    projection,
    slot,
    evidence: {
      sampleSize,
      ...values,
      summary: { sampleSize, opportunity, trend: { direction: 'unavailable' } }
    }
  };
}

function protectedProjection(projection) {
  return {
    playerId: projection.playerId,
    available: projection.available,
    mean: projection.mean,
    floor: projection.floor,
    median: projection.median,
    ceiling: projection.ceiling,
    bustProbability: projection.bustProbability,
    spikeProbability: projection.spikeProbability,
    thresholdProbabilities: projection.thresholdProbabilities
  };
}
