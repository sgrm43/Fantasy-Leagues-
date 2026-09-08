import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHistoricalMatchupComparisonEvidence,
  buildHistoricalOpponentPriors
} from '../src/analytics/historical-opponent-priors.js';
import {
  PRIOR_ADJUSTED_EVIDENCE_GROUPS,
  PROVISIONAL_PRIOR_MODEL_LIMITS,
  buildPriorAdjustedDecision
} from '../src/analytics/prior-adjusted-decisions.js';
import { projectRoster, recommendStartSit } from '../src/analytics/projections.js';
import { buildWeeklyIntelligence } from '../src/analytics/weekly-intelligence.js';
import { buildTopActionsToday } from '../src/analytics/top-actions-today.js';
import { isCurrentPlayerRecommendationEligible } from '../src/current-player-eligibility.js';

const NOW = '2026-09-02T12:00:00.000Z';
const PROVENANCE = { source: 'Provider projection', retrievedAt: '2026-09-02T10:00:00.000Z' };

test('historical and current opponent response remain one bounded Matchup group', () => {
  const recommendedPrior = priorFixture('recommended', 'Alpha Receiver', 0.22, 'moderate');
  const alternativePrior = priorFixture('alternative', 'Beta Receiver', -0.08, 'moderate');
  const historicalMatchup = buildHistoricalMatchupComparisonEvidence({
    recommendedPrior,
    alternativePrior
  });
  const currentMatchupEvidence = {
    group: 'matchup',
    status: 'available',
    assessment: 'supports_recommended',
    strength: 'moderate',
    summary: 'Current opponent-position response supports the recommended player.',
    facts: [{ metric: 'opponentOpportunityIndex' }]
  };
  const matchup = buildHistoricalMatchupComparisonEvidence({
    recommendedPrior,
    alternativePrior,
    currentMatchupEvidence
  });

  assert.equal(matchup.group, 'matchup');
  assert.equal(matchup.countedAsOneGroup, true);
  assert.equal(matchup.correlatedInputsCollapsed, true);
  assert.equal(matchup.sourceSignalCount, 2);
  assert.deepEqual(matchup.facts.map((fact) => fact.metric), [
    'historicalOpponentPrior',
    'currentMatchupContext'
  ]);

  const decision = buildPriorAdjustedDecision(decisionFixture({
    matchupPrior: historicalMatchup,
    comparison: comparisonFixture(currentMatchupEvidence)
  }));
  const applied = PRIOR_ADJUSTED_EVIDENCE_GROUPS
    .filter((group) => decision.evidenceGroups[group].appliedLogOddsAdjustment !== 0);

  assert.deepEqual(applied, ['matchup']);
  assert.equal(decision.evidenceGroups.matchup.sourceMetricCount, 2);
  assert.ok(Math.abs(decision.evidenceGroups.matchup.appliedLogOddsAdjustment)
    <= PROVISIONAL_PRIOR_MODEL_LIMITS.groupLogOddsCaps.matchup);
});

test('historical Matchup evidence still respects the centralized total probability cap', () => {
  const matchup = buildHistoricalMatchupComparisonEvidence({
    recommendedPrior: priorFixture('recommended', 'Alpha Receiver', 0.35, 'strong'),
    alternativePrior: priorFixture('alternative', 'Beta Receiver', -0.2, 'strong'),
    currentMatchupEvidence: {
      status: 'available',
      assessment: 'supports_recommended',
      strength: 'strong'
    }
  });
  const decision = buildPriorAdjustedDecision(decisionFixture({
    baselineProbability: 0.5,
    historicalPrior: {
      status: 'available', direction: 'supports_recommended', strength: 'strong',
      sampleSize: 60, summary: 'Strong historical player cohort.'
    },
    coachingPrior: {
      verified: true, historical: true, direction: 'supports_recommended', strength: 'strong'
    },
    matchupPrior: matchup,
    comparison: comparisonFixture(evidenceGroup('supports_recommended'), {
      volumeOpportunity: evidenceGroup('supports_recommended'),
      role: evidenceGroup('supports_recommended'),
      scoringOpportunity: evidenceGroup('supports_recommended'),
      gameEnvironment: evidenceGroup('supports_recommended'),
      healthAvailability: evidenceGroup('supports_recommended'),
      efficiency: evidenceGroup('supports_recommended')
    }),
    mediaEvents: [{
      playerId: 'recommended',
      headline: 'Full workload.',
      trust: 'official_primary'
    }]
  }));

  assert.equal(decision.totalAdjustmentCapApplied, true);
  assert.equal(decision.probabilityShift, PROVISIONAL_PRIOR_MODEL_LIMITS.totalProbabilityShift);
  assert.equal(decision.priorAdjustedProbability, 0.65);
  assert.ok(decision.evidenceGroups.matchup.appliedLogOddsAdjustment
    <= PROVISIONAL_PRIOR_MODEL_LIMITS.groupLogOddsCaps.matchup);
});

test('building historical opponent context leaves every projection number unchanged', () => {
  const players = opponentPlayers();
  const originalPlayers = structuredClone(players);
  const options = { now: NOW, provenance: PROVENANCE, thresholds: [10, 15, 20] };
  const before = projectRoster(players, options).map(projectionNumbers);

  const priors = buildHistoricalOpponentPriors(opponentInput(players));
  const after = projectRoster(players, options).map(projectionNumbers);

  assert.deepEqual(after, before);
  assert.deepEqual(players, originalPlayers);
  assert.equal(priors.projectionsAdjusted, false);
  assert.ok(priors.players.every((player) => player.projectionsAdjusted === false));
});

test('building historical opponent context leaves recommendStartSit output unchanged', () => {
  const players = opponentPlayers();
  const lineupInput = {
    players,
    slots: ['WR'],
    minimumGain: 0.5,
    now: NOW,
    provenance: PROVENANCE
  };
  const before = recommendStartSit(lineupInput);
  const protectedBefore = structuredClone(before);

  const priors = buildHistoricalOpponentPriors(opponentInput(players));
  const after = recommendStartSit(lineupInput);

  assert.deepEqual(after, before);
  assert.deepEqual(before, protectedBefore);
  assert.equal(priors.optimizerAdjusted, false);
  assert.ok(priors.players.every((player) => player.optimizerAdjusted === false));
});

test('explicit inactive and UFA players are rejected before opponent-prior selection', () => {
  const candidates = [
    eligiblePlayer('active', 'active', 'SEA'),
    eligiblePlayer('inactive', 'inactive'),
    eligiblePlayer('ufa', 'UFA')
  ];

  assert.equal(isCurrentPlayerRecommendationEligible(candidates[0]), true);
  assert.equal(isCurrentPlayerRecommendationEligible(candidates[1]), false);
  assert.equal(isCurrentPlayerRecommendationEligible(candidates[2]), false);

  const relevantPlayers = candidates.filter((player) => isCurrentPlayerRecommendationEligible(player));
  const priors = buildHistoricalOpponentPriors({
    season: 2026,
    currentWeek: 1,
    players: relevantPlayers
  });

  assert.deepEqual(priors.players.map((player) => player.requestedPlayerId), ['gsis:active']);
  assert.ok(!priors.players.some((player) => ['gsis:inactive', 'gsis:ufa'].includes(player.requestedPlayerId)));
});

test('Weekly Intelligence and Top Actions augment an existing decision without creating a matchup-only action', () => {
  let transactionCalls = 0;
  const executeTransaction = () => { transactionCalls += 1; };
  const matchup = buildHistoricalMatchupComparisonEvidence({
    recommendedPrior: priorFixture('recommended', 'Alpha Receiver', 0.2, 'moderate'),
    alternativePrior: priorFixture('alternative', 'Beta Receiver', -0.1, 'moderate')
  });
  const recommendation = recommendationFixture();
  const lineup = {
    recommendations: [recommendation],
    current: { assignments: [{ slotId: 'WR:1', slot: 'WR', playerId: 'alternative' }] },
    recommended: { assignments: [{ slotId: 'WR:1', slot: 'WR', playerId: 'recommended' }] },
    executeTransaction
  };
  const comparison = {
    ...comparisonFixture(matchup),
    supportingGroups: ['matchup'],
    conflictingGroups: [],
    supportClassification: 'supported',
    confidence: 'Moderate',
    reasons: [matchup.summary],
    warnings: []
  };
  const recommendationQuality = { comparisons: [comparison] };
  const weekly = buildWeeklyIntelligence({
    league: { season: 2026, currentWeek: 1 },
    lineup,
    recommendationQuality,
    executeTransaction
  });
  const top = buildTopActionsToday({
    lineup,
    recommendationQuality,
    weeklyIntelligence: weekly,
    executeTransaction
  });
  const matchupOnly = buildTopActionsToday({
    weeklyIntelligence: {
      observations: [{
        kind: 'supporting_evidence',
        headline: 'Favorable historical matchup',
        explanation: matchup.summary,
        evidenceCategories: ['matchup'],
        playerIds: ['recommended']
      }]
    },
    executeTransaction
  });
  const decision = buildPriorAdjustedDecision(decisionFixture({ comparison }));

  assert.ok(weekly.whyThisLineup[0].evidenceCategories.includes('matchup'));
  assert.equal(top.actions.length, 1);
  assert.match(top.actions[0].action, /Start Alpha Receiver over Beta Receiver/);
  assert.equal(matchupOnly.actions.length, 0);
  assert.equal(transactionCalls, 0);
  for (const result of [matchup, decision, weekly, top, matchupOnly]) {
    assert.deepEqual(result.safeguards, { readOnly: true, transactionsPerformed: false });
  }
  assert.equal(decision.projectionsAdjusted, false);
  assert.equal(decision.optimizerAdjusted, false);
  assert.equal(weekly.projectionsAdjusted, false);
  assert.equal(weekly.optimizerAdjusted, false);
  assert.equal(top.projectionsAdjusted, false);
  assert.equal(top.optimizerAdjusted, false);
});

function priorFixture(playerId, name, score, confidence) {
  return {
    requestedPlayerId: playerId,
    name,
    playerStyle: { style: 'deep_threat' },
    matchupEvidence: {
      group: 'matchup',
      status: 'available',
      assessment: score >= 0 ? 'favorable' : 'difficult',
      score,
      confidence,
      countedAsOneGroup: true,
      correlatedInputsCollapsed: true
    },
    projectionsAdjusted: false,
    optimizerAdjusted: false,
    safeguards: { readOnly: true, transactionsPerformed: false }
  };
}

function decisionFixture(overrides = {}) {
  return {
    season: 2026,
    currentWeek: 1,
    currentSeasonSample: { completedGames: 0 },
    baselineProbability: 0.55,
    recommendation: recommendationFixture(),
    comparison: comparisonFixture(),
    ...overrides
  };
}

function comparisonFixture(matchup = evidenceGroup('neutral'), otherEvidence = {}) {
  return {
    comparisonId: 'WR:1|recommended|alternative',
    comparisonType: 'start_sit',
    targetSlot: 'WR',
    targetSlotId: 'WR:1',
    recommendedPlayer: { playerId: 'recommended', name: 'Alpha Receiver', position: 'WR' },
    alternativePlayer: { playerId: 'alternative', name: 'Beta Receiver', position: 'WR' },
    projectionDifference: 1,
    evidence: { ...otherEvidence, matchup }
  };
}

function recommendationFixture() {
  return {
    action: 'start_sit',
    start: { playerId: 'recommended', name: 'Alpha Receiver', position: 'WR' },
    sit: { playerId: 'alternative', name: 'Beta Receiver', position: 'WR' },
    targetSlot: 'WR',
    targetSlotId: 'WR:1',
    expectedGain: 1,
    probabilityStartOutscoresSit: 0.55
  };
}

function evidenceGroup(assessment, strength = 'strong') {
  return {
    group: 'matchup',
    assessment,
    strength,
    summary: 'Existing grouped evidence.',
    facts: [{ metric: 'fixture' }],
    countedAsOneGroup: true
  };
}

function opponentPlayers() {
  return [
    {
      playerId: 'recommended',
      name: 'Alpha Receiver',
      position: 'WR',
      projection: 15,
      slot: 'bench',
      style: 'deep_threat',
      defense: { team: 'NYG', tendency: 'limits_explosive_passing' }
    },
    {
      playerId: 'alternative',
      name: 'Beta Receiver',
      position: 'WR',
      projection: 12,
      slot: 'WR',
      style: 'slot_short_area_target',
      defense: { team: 'DAL', tendency: 'allows_short_area_targets' }
    }
  ];
}

function opponentInput(players) {
  return {
    season: 2026,
    currentWeek: 1,
    players,
    historicalDefenseRows: [
      { season: 2025, defense: 'NYG', position: 'WR', defenseTendency: 'limits_explosive_passing', score: -0.12, sampleSize: 30 },
      { season: 2025, defense: 'DAL', position: 'WR', defenseTendency: 'allows_short_area_targets', score: 0.1, sampleSize: 30 }
    ],
    historicalMatchupRows: [
      { playerId: 'cohort-deep', season: 2025, position: 'WR', style: 'deep_threat', role: 'receiver', defenseTendency: 'limits_explosive_passing', score: -0.15, sampleSize: 30 },
      { playerId: 'cohort-slot', season: 2025, position: 'WR', style: 'slot_short_area_target', role: 'receiver', defenseTendency: 'allows_short_area_targets', score: 0.14, sampleSize: 30 }
    ]
  };
}

function eligiblePlayer(id, state, team = null) {
  return {
    playerId: `gsis:${id}`,
    name: id,
    position: 'WR',
    style: 'deep_threat',
    eligibility: { source: 'official-nfl', state, team }
  };
}

function projectionNumbers(projection) {
  return {
    playerId: projection.playerId,
    baseline: projection.baseline,
    mean: projection.mean,
    median: projection.median,
    floor: projection.floor,
    ceiling: projection.ceiling,
    bustProbability: projection.bustProbability,
    spikeProbability: projection.spikeProbability,
    thresholdProbabilities: projection.thresholdProbabilities
  };
}
