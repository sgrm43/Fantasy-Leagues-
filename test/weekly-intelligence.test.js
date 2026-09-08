import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeeklyIntelligence } from '../src/analytics/weekly-intelligence.js';

const EVIDENCE_GROUPS = [
  'volumeOpportunity',
  'role',
  'scoringOpportunity',
  'efficiency',
  'recentTrend',
  'gameEnvironment',
  'matchup',
  'healthAvailability'
];

test('multiple evidence categories synthesize into one concise explanation', () => {
  const comparison = comparisonFixture({
    supportClassification: 'strongly_supported',
    confidence: 'High',
    groups: {
      volumeOpportunity: evidenceGroup('volumeOpportunity', 'supports_recommended', [
        metricFact('targets', 'Targets', 10, 5),
        metricFact('targetShare', 'Target share', 0.3, 0.15)
      ]),
      role: evidenceGroup('role', 'supports_recommended', [
        metricFact('routes', 'Routes', 36, 24),
        metricFact('routeParticipation', 'Route participation', 0.92, 0.62)
      ]),
      matchup: evidenceGroup('matchup', 'supports_recommended', [
        metricFact('opponentOpportunityIndex', 'Opponent opportunity allowed vs league', 0.22, -0.12)
      ])
    }
  });
  const result = buildWeeklyIntelligence(inputFixture(comparison));
  const observation = observationFor(result, comparison);

  assert.ok(observation);
  assert.equal(result.observations.filter((item) => item.comparisonId === comparison.comparisonId).length, 1);
  assert.deepEqual(new Set(observation.evidenceCategories), new Set(['volumeOpportunity', 'role', 'matchup']));
  assert.match(itemText(observation), /Alpha Receiver/i);
  assert.ok(sentenceCount(itemText(observation)) <= 4);
});

test('conflicting evidence is surfaced explicitly instead of hidden', () => {
  const comparison = comparisonFixture({
    projectionDifference: 0.8,
    supportClassification: 'projection_conflict',
    confidence: 'Low',
    groups: {
      volumeOpportunity: evidenceGroup('volumeOpportunity', 'supports_alternative', [
        metricFact('targets', 'Targets', 4, 9)
      ]),
      role: evidenceGroup('role', 'supports_alternative', [
        metricFact('routes', 'Routes', 20, 34),
        metricFact('routeParticipation', 'Route participation', 0.55, 0.9)
      ]),
      matchup: evidenceGroup('matchup', 'supports_recommended', [
        metricFact('opponentOpportunityIndex', 'Opponent opportunity allowed vs league', 0.18, -0.08)
      ])
    }
  });
  const result = buildWeeklyIntelligence(inputFixture(comparison));
  const explanation = whyFor(result, comparison);
  const text = `${itemText(explanation)} ${itemText(result.keyUncertainty)}`;

  assert.equal(explanation.supportClassification, 'projection_conflict');
  assert.equal(explanation.confidence, 'Low');
  assert.match(text, /projection|projected/i);
  assert.match(text, /Beta Receiver/i);
  assert.match(text, /but|however|while|despite|conflict|works against/i);
});

test('Learning and missing evidence stay neutral and are omitted', () => {
  const comparison = comparisonFixture({
    groups: {
      volumeOpportunity: evidenceGroup('volumeOpportunity', 'supports_recommended', [
        metricFact('targets', 'Targets', 9, 5)
      ]),
      efficiency: evidenceGroup('efficiency', 'insufficient', [{
        metric: 'nextGenStatus',
        label: 'Next Gen Stats',
        recommended: 'Learning',
        alternative: null,
        source: 'nflverse Next Gen Stats',
        directional: false
      }], 'Next Gen Stats are Learning.'),
      gameEnvironment: evidenceGroup('gameEnvironment', 'insufficient', [], 'Weather and odds are unavailable.')
    }
  });
  const result = buildWeeklyIntelligence(inputFixture(comparison));
  const explanation = whyFor(result, comparison);
  const text = outputText(result);

  assert.deepEqual(explanation.evidenceCategories, ['volumeOpportunity']);
  assert.doesNotMatch(text, /Learning|missing|unavailable|not available/i);
  assert.equal(result.keyUncertainty, null);
});

test('QB, RB, WR, and TE explanations use position-relevant football language', () => {
  const cases = [
    { position: 'QB', metric: 'passAttempts', label: 'Pass attempts', expected: /pass attempts|passing volume/i },
    { position: 'RB', metric: 'carries', label: 'Carries', expected: /carries|rushing workload/i },
    { position: 'WR', metric: 'routes', label: 'Routes', expected: /routes|route participation/i },
    { position: 'TE', metric: 'targets', label: 'Targets', expected: /targets|target volume/i }
  ];

  for (const fixture of cases) {
    const recommendedPlayer = player(`preferred-${fixture.position}`, `Preferred ${fixture.position}`, fixture.position, 15);
    const alternativePlayer = player(`current-${fixture.position}`, `Current ${fixture.position}`, fixture.position, 13);
    const groupName = fixture.metric === 'routes' ? 'role' : 'volumeOpportunity';
    const comparison = comparisonFixture({
      recommendedPlayer,
      alternativePlayer,
      targetSlot: fixture.position,
      targetSlotId: `${fixture.position}:1`,
      groups: {
        [groupName]: evidenceGroup(groupName, 'supports_recommended', [
          metricFact(fixture.metric, fixture.label, 30, 20)
        ])
      }
    });
    const result = buildWeeklyIntelligence(inputFixture(comparison));
    assert.match(itemText(whyFor(result, comparison)), fixture.expected, fixture.position);
  }
});

test('correlated opportunity and role metrics are consolidated by evidence group', () => {
  const comparison = comparisonFixture({
    groups: {
      volumeOpportunity: evidenceGroup('volumeOpportunity', 'supports_recommended', [
        metricFact('targets', 'Targets', 10, 5),
        metricFact('targetShare', 'Target share', 0.3, 0.15)
      ]),
      role: evidenceGroup('role', 'supports_recommended', [
        metricFact('routes', 'Routes', 36, 24),
        metricFact('routeParticipation', 'Route participation', 0.92, 0.62)
      ])
    }
  });
  const result = buildWeeklyIntelligence(inputFixture(comparison));
  const explanation = whyFor(result, comparison);
  const observations = result.observations.filter((item) => item.comparisonId === comparison.comparisonId);

  assert.deepEqual(explanation.evidenceCategories, ['volumeOpportunity', 'role']);
  assert.equal(new Set(explanation.evidenceCategories).size, explanation.evidenceCategories.length);
  assert.equal(observations.length, 1);
  assert.ok(sentenceCount(itemText(explanation)) <= 4);
});

test('recommendation-quality classification and confidence are respected verbatim', () => {
  const cases = [
    { classification: 'strongly_supported', confidence: 'High' },
    { classification: 'supported', confidence: 'Moderate' },
    { classification: 'mixed', confidence: 'Low' },
    { classification: 'projection_conflict', confidence: 'Low' },
    { classification: 'insufficient_evidence', confidence: 'Uncertain' }
  ];

  for (const fixture of cases) {
    const groups = classificationGroups(fixture.classification);
    const comparison = comparisonFixture({
      comparisonId: `quality-${fixture.classification}`,
      supportClassification: fixture.classification,
      confidence: fixture.confidence,
      groups
    });
    const result = buildWeeklyIntelligence(inputFixture(comparison));
    const explanation = whyFor(result, comparison);

    assert.equal(explanation.supportClassification, fixture.classification);
    assert.equal(explanation.confidence, fixture.confidence);
  }
});

test('current and recommended lineup player IDs and names are referenced in the correct direction', () => {
  const comparison = comparisonFixture();
  const { lineup, ...input } = inputFixture(comparison);
  lineup.projections.push(projection(player('decoy', 'Unrelated Player', 'WR', 30)));
  const result = buildWeeklyIntelligence({ ...input, lineup });
  const explanation = whyFor(result, comparison);
  const text = itemText(explanation);

  assert.equal(explanation.recommendedPlayerId, 'wr-new');
  assert.equal(explanation.alternativePlayerId, 'wr-old');
  assert.equal(explanation.targetSlotId, 'WR:1');
  assert.match(text, /Alpha Receiver/i);
  assert.match(text, /Beta Receiver/i);
  assert.doesNotMatch(text, /Unrelated Player/i);
});

test('meaningful critical news is surfaced while routine news is omitted', () => {
  const comparison = comparisonFixture();
  const newsChanges = [
    {
      id: 'critical-wr-news',
      severity: 'critical',
      significance: 'critical',
      meaningful: true,
      playerId: 'wr-new',
      playerName: 'Alpha Receiver',
      from: 'Questionable',
      to: 'Out',
      previous: { availabilityStatus: 'Questionable' },
      current: { availabilityStatus: 'Out' },
      summary: 'Alpha Receiver was downgraded from Questionable to OUT.',
      reason: 'The availability change requires lineup reanalysis.',
      requiresReanalysis: true,
      requires_reanalysis: true
    },
    {
      id: 'routine-decoy-news',
      severity: 'none',
      significance: 'none',
      meaningful: false,
      playerId: 'decoy',
      playerName: 'Routine Decoy',
      summary: 'Routine Decoy had no material change.'
    }
  ];
  const result = buildWeeklyIntelligence(inputFixture(comparison, { newsChanges }));
  const newsObservation = result.observations.find((item) => item.kind === 'news');

  assert.ok(newsObservation);
  assert.match(itemText(newsObservation), /Alpha Receiver/i);
  assert.match(itemText(newsObservation), /OUT/i);
  assert.doesNotMatch(outputText(result), /Routine Decoy/i);
});

test('Weekly Intelligence does not mutate any projection value', () => {
  const comparison = comparisonFixture();
  const input = inputFixture(comparison);
  input.lineup.projections[0].thresholdProbabilities = [
    { threshold: 10, probability: 0.75 },
    { threshold: 15, probability: 0.45 },
    { threshold: 20, probability: 0.2 }
  ];
  const before = structuredClone(input.lineup.projections);

  const result = buildWeeklyIntelligence(input);

  assert.deepEqual(input.lineup.projections, before);
  assert.equal(result.projectionsAdjusted, false);
});

test('Weekly Intelligence does not mutate optimizer output', () => {
  const comparison = comparisonFixture();
  const input = inputFixture(comparison);
  input.lineup.current.assignments.push(
    { slotId: 'RB:2', slot: 'RB', playerId: 'rb-two', player: 'Second Runner', position: 'RB', value: 12 },
    { slotId: 'RB:1', slot: 'RB', playerId: 'rb-one', player: 'First Runner', position: 'RB', value: 14 }
  );
  input.lineup.recommended.assignments.push(
    { slotId: 'RB:2', slot: 'RB', playerId: 'rb-two', player: 'Second Runner', position: 'RB', value: 12 },
    { slotId: 'RB:1', slot: 'RB', playerId: 'rb-one', player: 'First Runner', position: 'RB', value: 14 }
  );
  const before = structuredClone({
    objective: input.lineup.objective,
    objectiveLabel: input.lineup.objectiveLabel,
    expectedGain: input.lineup.expectedGain,
    current: input.lineup.current,
    recommended: input.lineup.recommended,
    recommendations: input.lineup.recommendations
  });

  const result = buildWeeklyIntelligence(input);

  assert.deepEqual({
    objective: input.lineup.objective,
    objectiveLabel: input.lineup.objectiveLabel,
    expectedGain: input.lineup.expectedGain,
    current: input.lineup.current,
    recommended: input.lineup.recommended,
    recommendations: input.lineup.recommendations
  }, before);
  assert.equal(result.optimizerAdjusted, false);
});

test('Weekly Intelligence remains read-only and never invokes a transaction callback', () => {
  const comparison = comparisonFixture();
  const input = inputFixture(comparison);
  let transactionCalls = 0;
  input.lineup.safeguards = Object.freeze({ readOnly: true, transactionsPerformed: false });
  input.recommendationQuality.safeguards = Object.freeze({ readOnly: true, transactionsPerformed: false });
  deepFreeze(input.lineup);
  deepFreeze(input.recommendationQuality);
  deepFreeze(input.newsChanges);

  const result = buildWeeklyIntelligence({
    ...input,
    executeTransaction: () => { transactionCalls += 1; }
  });

  assert.equal(transactionCalls, 0);
  assert.deepEqual(result.safeguards, { readOnly: true, transactionsPerformed: false });
  assert.equal(result.projectionsAdjusted, false);
  assert.equal(result.optimizerAdjusted, false);
  assert.equal('transaction' in result, false);
  assert.equal('executeTransaction' in result, false);
});

function inputFixture(comparison, overrides = {}) {
  return {
    lineup: lineupFixture(comparison),
    recommendationQuality: qualityFixture(comparison),
    newsChanges: [],
    ...overrides
  };
}

function comparisonFixture({
  comparisonId = 'WR:1|wr-new|wr-old',
  recommendedPlayer = player('wr-new', 'Alpha Receiver', 'WR', 15),
  alternativePlayer = player('wr-old', 'Beta Receiver', 'WR', 13),
  projectionDifference = 2,
  targetSlot = 'WR',
  targetSlotId = 'WR:1',
  supportClassification = 'supported',
  confidence = 'Moderate',
  groups = {
    volumeOpportunity: evidenceGroup('volumeOpportunity', 'supports_recommended', [
      metricFact('targets', 'Targets', 9, 5)
    ])
  }
} = {}) {
  const evidence = Object.fromEntries(EVIDENCE_GROUPS.map((name) => [
    name,
    groups[name] || evidenceGroup(name, 'insufficient', [])
  ]));
  const supportingGroups = EVIDENCE_GROUPS.filter((name) => evidence[name].assessment === 'supports_recommended');
  const conflictingGroups = EVIDENCE_GROUPS.filter((name) => evidence[name].assessment === 'supports_alternative');
  return {
    comparisonId,
    comparisonType: 'start_sit',
    targetSlot,
    targetSlotId,
    recommendedPlayer: publicPlayer(recommendedPlayer),
    alternativePlayer: publicPlayer(alternativePlayer),
    projectionDifference,
    evidence,
    supportingGroups,
    conflictingGroups,
    supportClassification,
    confidence,
    confidenceBasis: `${supportClassification} fixture; this is not a probability.`,
    reasons: [
      `${recommendedPlayer.name} keeps the existing projection edge by ${projectionDifference} points.`,
      ...supportingGroups.map((name) => evidence[name].summary),
      ...conflictingGroups.map((name) => evidence[name].summary)
    ].slice(0, 3),
    warnings: [],
    positionStatistics: {
      recommended: availableFacts(evidence, 'recommended'),
      alternative: availableFacts(evidence, 'alternative')
    },
    safeguards: { readOnly: true, transactionsPerformed: false },
    projectionsAdjusted: false,
    optimizerAdjusted: false
  };
}

function lineupFixture(comparison) {
  const start = player(
    comparison.recommendedPlayer.playerId,
    comparison.recommendedPlayer.name,
    comparison.recommendedPlayer.position,
    15
  );
  const sit = player(
    comparison.alternativePlayer.playerId,
    comparison.alternativePlayer.name,
    comparison.alternativePlayer.position,
    13
  );
  const gain = comparison.projectionDifference;
  return {
    objective: 'mean',
    objectiveLabel: 'mean outcome',
    expectedGain: gain,
    current: {
      complete: true,
      total: 13,
      assignments: [{
        slotId: comparison.targetSlotId,
        slot: comparison.targetSlot,
        playerId: sit.playerId,
        player: sit.name,
        position: sit.position,
        value: sit.projection
      }]
    },
    recommended: {
      complete: true,
      total: 13 + gain,
      assignments: [{
        slotId: comparison.targetSlotId,
        slot: comparison.targetSlot,
        playerId: start.playerId,
        player: start.name,
        position: start.position,
        value: start.projection
      }]
    },
    recommendations: [{
      action: 'start_sit',
      start: projectionSummary(start),
      sit: projectionSummary(sit),
      targetSlot: comparison.targetSlot,
      targetSlotId: comparison.targetSlotId,
      expectedGain: gain,
      probabilityStartOutscoresSit: 0.65,
      confidence: { level: 'medium', basis: 'Input quality, not a win probability.' },
      rationale: [`${start.name} has the stronger mean case by ${gain} points.`],
      caveats: ['The likely outcome ranges overlap.'],
      whatCouldChange: ['Late injury news.'],
      lineupMoves: [{
        slotId: comparison.targetSlotId,
        slot: comparison.targetSlot,
        playerId: start.playerId,
        player: start.name
      }]
    }],
    projections: [projection(start), projection(sit)],
    warnings: [],
    safeguards: { readOnly: true, transactionsPerformed: false }
  };
}

function qualityFixture(comparison) {
  return {
    model: 'grouped-football-evidence',
    decisionUse: 'descriptive_only',
    projectionAnchor: 'mean outcome',
    comparisons: [comparison],
    safeguards: { readOnly: true, transactionsPerformed: false },
    projectionsAdjusted: false,
    optimizerAdjusted: false
  };
}

function classificationGroups(classification) {
  const supports = (name, metric, label) => evidenceGroup(name, 'supports_recommended', [metricFact(metric, label, 10, 5)]);
  const conflicts = (name, metric, label) => evidenceGroup(name, 'supports_alternative', [metricFact(metric, label, 5, 10)]);
  if (classification === 'strongly_supported') return {
    volumeOpportunity: supports('volumeOpportunity', 'targets', 'Targets'),
    role: supports('role', 'routes', 'Routes'),
    scoringOpportunity: supports('scoringOpportunity', 'redZoneTargets', 'Red-zone targets')
  };
  if (classification === 'supported') return {
    volumeOpportunity: supports('volumeOpportunity', 'targets', 'Targets')
  };
  if (classification === 'mixed') return {
    volumeOpportunity: supports('volumeOpportunity', 'targets', 'Targets'),
    role: conflicts('role', 'routes', 'Routes')
  };
  if (classification === 'projection_conflict') return {
    volumeOpportunity: conflicts('volumeOpportunity', 'targets', 'Targets'),
    role: conflicts('role', 'routes', 'Routes')
  };
  return {};
}

function evidenceGroup(group, assessment, facts, summary = null) {
  const directional = assessment === 'supports_recommended' || assessment === 'supports_alternative';
  return {
    group,
    assessment,
    summary: summary || groupSummary(group, assessment),
    facts,
    groupedMetricCount: facts.length,
    directionalVoteCount: directional ? 1 : assessment === 'mixed' ? 2 : 0,
    countedAsOneGroup: true
  };
}

function groupSummary(group, assessment) {
  const label = group.replace(/([A-Z])/g, ' $1').toLowerCase();
  if (assessment === 'supports_recommended') return `Alpha Receiver has the stronger ${label} evidence.`;
  if (assessment === 'supports_alternative') return `Beta Receiver has the stronger ${label} evidence, which works against the projection choice.`;
  if (assessment === 'mixed') return `${label} evidence points in both directions.`;
  return `Comparable ${label} evidence is unavailable.`;
}

function metricFact(metric, label, recommended, alternative) {
  return {
    metric,
    label,
    recommended,
    alternative,
    source: 'Deterministic fixture',
    directional: true
  };
}

function player(playerId, name, position, projectionValue) {
  return { playerId, name, position, projection: projectionValue };
}

function publicPlayer(value) {
  return { playerId: value.playerId, name: value.name, position: value.position };
}

function projection(value) {
  return {
    playerId: value.playerId,
    name: value.name,
    position: value.position,
    available: true,
    baseline: value.projection,
    mean: value.projection,
    median: value.projection - 0.5,
    floor: value.projection - 5,
    ceiling: value.projection + 5,
    bustProbability: 0.25,
    spikeProbability: 0.2,
    thresholdProbabilities: [{ threshold: 10, probability: 0.7 }],
    confidence: { level: 'medium', score: 0.7, meaning: 'Input quality, not a probability.' },
    freshness: { status: 'fresh' },
    adjustments: []
  };
}

function projectionSummary(value) {
  return {
    playerId: value.playerId,
    name: value.name,
    position: value.position,
    objectiveValue: value.projection,
    mean: value.projection,
    floor: value.projection - 5,
    ceiling: value.projection + 5,
    confidence: 'medium',
    freshness: 'fresh'
  };
}

function availableFacts(evidence, side) {
  return Object.values(evidence).flatMap((group) => group.facts.flatMap((fact) => (
    typeof fact[side] === 'number'
      ? [{ key: fact.metric, label: fact.label, group: group.group, value: fact[side], source: fact.source }]
      : []
  )));
}

function observationFor(result, comparison) {
  return result.observations.find((item) => item.comparisonId === comparison.comparisonId)
    || result.observations.find((item) => item.playerIds?.includes(comparison.recommendedPlayer.playerId));
}

function whyFor(result, comparison) {
  const item = result.whyThisLineup.find((entry) => entry.comparisonId === comparison.comparisonId)
    || result.whyThisLineup.find((entry) => entry.recommendedPlayerId === comparison.recommendedPlayer.playerId);
  assert.ok(item, `Missing Why this lineup entry for ${comparison.comparisonId}`);
  return item;
}

function itemText(item) {
  if (!item) return '';
  return [item.headline, item.explanation, item.text, item.summary]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' ');
}

function outputText(result) {
  return [
    ...result.observations.map(itemText),
    ...result.whyThisLineup.map(itemText),
    itemText(result.keyUncertainty)
  ].filter(Boolean).join(' ');
}

function sentenceCount(value) {
  return value.split(/[.!?]+(?:\s|$)/).filter((part) => part.trim()).length;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
