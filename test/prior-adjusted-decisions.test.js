import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIOR_ADJUSTED_EVIDENCE_GROUPS,
  PROVISIONAL_PRIOR_MODEL_LIMITS,
  buildPriorAdjustedDecision,
  buildPriorAdjustedDecisionReport,
  classifyTrustedMediaLanguage
} from '../src/analytics/prior-adjusted-decisions.js';

test('Week 1 with zero 2026 games still produces a historical prior', () => {
  const result = decision({ historicalPrior: cohortPrior() });

  assert.equal(result.currentSeason.status, 'learning');
  assert.equal(result.historicalPrior.status, 'available');
  assert.equal(result.historicalPrior.sampleSize, 43);
  assert.ok(result.priorAdjustedProbability > result.baselineProbability);
});

test('current-season Learning remains separate and does not erase prior or context', () => {
  const result = decision({
    historicalPrior: cohortPrior(),
    comparison: comparison({ matchup: group('supports_recommended', 'Favorable current matchup evidence.') })
  });

  assert.match(result.currentSeason.label, /Learning.*2026/i);
  assert.equal(result.currentSeason.historicalPriorUsedAsCurrentEvidence, false);
  assert.equal(result.evidenceGroups.matchup.status, 'available');
  assert.ok(result.priorAdjustedProbability > 0.55);
});

test('a supplied Year-2 historical cohort produces a deterministic prior', () => {
  const input = { historicalPrior: cohortPrior(), comparison: comparison() };
  assert.deepEqual(decision(input), decision(structuredClone(input)));
  assert.match(decision(input).historicalPrior.summary, /Year-2 WR/i);
});

test('deterministic cohort broadening metadata is retained for explanation', () => {
  const prior = cohortPrior({
    selection: {
      selectedLevel: 'position+career_year+usage',
      attemptedLevels: ['position+career_year+draft_capital+usage', 'position+career_year+usage']
    }
  });
  const result = decision({ historicalPrior: prior });

  assert.equal(result.historicalPrior.selection.selectedLevel, 'position+career_year+usage');
  assert.deepEqual(result.historicalPrior.selection.attemptedLevels, [
    'position+career_year+draft_capital+usage',
    'position+career_year+usage'
  ]);
});

test('an insufficient cohort is labeled and contributes no adjustment', () => {
  const result = decision({ historicalPrior: cohortPrior({ sampleSize: 9 }) });

  assert.equal(result.historicalPrior.status, 'insufficient');
  assert.equal(result.historicalPrior.sampleSize, 9);
  assert.equal(result.historicalPrior.appliedLogOddsAdjustment, 0);
  assert.equal(result.priorAdjustedProbability, result.baselineProbability);
});

test('historical prior never masquerades as current 2026 evidence', () => {
  const result = decision({ historicalPrior: cohortPrior() });

  assert.equal(result.historicalPrior.historical, true);
  assert.equal(result.currentSeason.season, 2026);
  assert.equal(result.currentSeason.status, 'learning');
  assert.equal(result.currentSeason.historicalPriorUsedAsCurrentEvidence, false);
});

test('current opportunity and role can support or conflict with the projection', () => {
  const supporting = decision({ comparison: comparison({
    volumeOpportunity: group('supports_recommended'),
    role: group('supports_recommended')
  }) });
  const conflicting = decision({ comparison: comparison({
    volumeOpportunity: group('supports_alternative'),
    role: group('supports_alternative')
  }) });

  assert.ok(supporting.priorAdjustedProbability > supporting.baselineProbability);
  assert.ok(conflicting.priorAdjustedProbability < conflicting.baselineProbability);
  assert.equal(supporting.evidenceGroups.currentOpportunityRole.direction, 'supports_recommended');
  assert.equal(conflicting.evidenceGroups.currentOpportunityRole.direction, 'supports_alternative');
});

test('verified coaching evidence remains explicitly labeled as a historical prior', () => {
  const result = decision({ coachingPrior: {
    verified: true,
    historical: true,
    direction: 'supports_recommended',
    strength: 'moderate',
    periodId: 'oc:DET:2024-2025',
    priorTeam: 'DET',
    summary: 'Coordinator historical prior from a verified Detroit period.'
  } });

  assert.equal(result.evidenceGroups.coachingSchemePrior.status, 'available');
  assert.equal(result.evidenceGroups.coachingSchemePrior.historical, true);
  assert.equal(result.evidenceGroups.coachingSchemePrior.priorTeam, 'DET');
  assert.match(result.evidenceGroups.coachingSchemePrior.summary, /historical prior/i);
});

test('trusted specific media language creates only a bounded weak adjustment', () => {
  const result = decision({ mediaEvents: [{
    playerId: 'recommended',
    headline: 'The coach confirmed he will handle a full workload.',
    trust: 'official_primary',
    source: 'official-team-report'
  }] });
  const media = result.evidenceGroups.mediaNewsLanguage;

  assert.equal(media.direction, 'supports_recommended');
  assert.ok(media.appliedLogOddsAdjustment > 0);
  assert.ok(media.appliedLogOddsAdjustment <= PROVISIONAL_PRIOR_MODEL_LIMITS.groupLogOddsCaps.mediaNewsLanguage);
  assert.equal(media.evidence[0].matchedPhrase, 'full workload');
});

test('vague media language is neutral and cannot dominate a recommendation', () => {
  const classification = classifyTrustedMediaLanguage({
    headline: 'We want to get him involved this week.',
    trust: 'official_secondary'
  });
  const result = decision({ mediaEvents: [{
    playerId: 'alternative',
    headline: 'We want to get him involved this week.',
    trust: 'official_secondary',
    source: 'official-team-news'
  }] });

  assert.equal(classification.classification, 'neutral');
  assert.equal(result.evidenceGroups.mediaNewsLanguage.appliedLogOddsAdjustment, 0);
  assert.equal(result.priorAdjustedProbability, result.baselineProbability);
});

test('related opportunity metrics and groups create only one bounded update', () => {
  const result = decision({ comparison: comparison({
    volumeOpportunity: group('supports_recommended', 'Targets favor the recommended player.', 4),
    role: group('supports_recommended', 'Routes favor the recommended player.', 5),
    scoringOpportunity: group('supports_recommended', 'Red-zone work favors the recommended player.', 3),
    recentTrend: group('supports_recommended', 'Recent usage is rising.', 2)
  }) });
  const opportunity = result.evidenceGroups.currentOpportunityRole;

  assert.deepEqual(opportunity.sourceGroups, ['volumeOpportunity', 'role', 'scoringOpportunity', 'recentTrend']);
  assert.equal(PRIOR_ADJUSTED_EVIDENCE_GROUPS.filter((name) => name === 'currentOpportunityRole').length, 1);
  assert.ok(opportunity.appliedLogOddsAdjustment <= PROVISIONAL_PRIOR_MODEL_LIMITS.groupLogOddsCaps.currentOpportunityRole);
});

test('evidence disagreement is shown and lowers confidence', () => {
  const aligned = decision({
    historicalPrior: cohortPrior(),
    comparison: comparison({ matchup: group('supports_recommended') })
  });
  const mixed = decision({
    historicalPrior: cohortPrior(),
    comparison: comparison({ matchup: group('supports_alternative') })
  });

  assert.equal(aligned.confidence, 'Moderate');
  assert.equal(mixed.confidence, 'Low');
  assert.equal(mixed.evidenceAgreement, 'mixed');
  assert.ok(mixed.favorableFactors.length > 0);
  assert.ok(mixed.opposingFactors.length > 0);
});

test('baseline and prior-adjusted probability are both retained', () => {
  const input = fixture({ historicalPrior: cohortPrior() });
  const before = structuredClone(input);
  const result = buildPriorAdjustedDecision(input);

  assert.equal(result.baselineProbability, 0.55);
  assert.notEqual(result.priorAdjustedProbability, result.baselineProbability);
  assert.deepEqual(input, before);
});

test('the centralized total provisional probability-shift cap is enforced', () => {
  const result = decision({
    baselineProbability: 0.5,
    historicalPrior: cohortPrior({ sampleSize: 60, strength: 'strong' }),
    coachingPrior: { verified: true, historical: true, direction: 'supports_recommended', strength: 'strong' },
    comparison: comparison({
      volumeOpportunity: group('supports_recommended'),
      matchup: group('supports_recommended'),
      gameEnvironment: group('supports_recommended'),
      healthAvailability: group('supports_recommended'),
      efficiency: group('supports_recommended')
    }),
    mediaEvents: [{ playerId: 'recommended', headline: 'Full workload.', trust: 'official_primary' }]
  });

  assert.equal(result.totalAdjustmentCapApplied, true);
  assert.equal(result.probabilityShift, PROVISIONAL_PRIOR_MODEL_LIMITS.totalProbabilityShift);
  assert.equal(result.priorAdjustedProbability, 0.65);
});

test('historical influence fades and current evidence grows with completed games', () => {
  const weekOne = decision({ historicalPrior: cohortPrior(), comparison: comparison({ efficiency: group('supports_recommended') }) });
  const later = decision({
    historicalPrior: cohortPrior(),
    comparison: comparison({ efficiency: group('supports_recommended') }),
    currentSeasonSample: { completedGames: 8 }
  });

  assert.ok(weekOne.maturity.historical > later.maturity.historical);
  assert.ok(weekOne.maturity.current < later.maturity.current);
  assert.equal(later.maturity.phase, 'current_season_mature');
});

test('building a report leaves existing optimizer legality and assignments unchanged', () => {
  const lineup = lineupFixture();
  const before = structuredClone(lineup);
  deepFreeze(lineup);

  const result = buildPriorAdjustedDecisionReport({
    season: 2026,
    currentWeek: 1,
    lineup,
    recommendationQuality: { comparisons: [comparison()] },
    historicalPriors: { recommended: cohortPrior() }
  });

  assert.equal(result.decisions.length, 1);
  assert.deepEqual(lineup, before);
  assert.equal(result.optimizerAdjusted, false);
});

test('core projection numbers remain unchanged', () => {
  const projections = [{
    playerId: 'recommended', mean: 16, median: 15.5, floor: 9, ceiling: 23,
    bustProbability: 0.2, spikeProbability: 0.15,
    thresholdProbabilities: [{ threshold: 15, probability: 0.55 }]
  }];
  const before = structuredClone(projections);
  deepFreeze(projections);

  const result = buildPriorAdjustedDecision({ ...fixture({ historicalPrior: cohortPrior() }), projections });

  assert.deepEqual(projections, before);
  assert.equal(result.projectionsAdjusted, false);
});

test('the provisional decision layer remains read-only and never invokes callbacks', () => {
  let transactionCalls = 0;
  const executeTransaction = () => { transactionCalls += 1; };
  const result = buildPriorAdjustedDecision({
    ...fixture({ historicalPrior: cohortPrior() }),
    executeTransaction,
    recommendation: { ...recommendation(), submitLineup: executeTransaction }
  });

  assert.equal(transactionCalls, 0);
  assert.deepEqual(result.safeguards, { readOnly: true, transactionsPerformed: false });
  assert.equal(result.projectionsAdjusted, false);
  assert.equal(result.optimizerAdjusted, false);
  assert.equal(result.calibrationApplied, false);
  assert.doesNotMatch(JSON.stringify(result), /executeTransaction|submitLineup/);
});

function decision(overrides = {}) {
  return buildPriorAdjustedDecision(fixture(overrides));
}

function fixture(overrides = {}) {
  return {
    season: 2026,
    currentWeek: 1,
    currentSeasonSample: { completedGames: 0 },
    comparison: comparison(),
    recommendation: recommendation(),
    ...overrides
  };
}

function comparison(evidence = {}) {
  return {
    comparisonId: 'WR:1|recommended|alternative',
    comparisonType: 'start_sit',
    targetSlot: 'WR',
    targetSlotId: 'WR:1',
    recommendedPlayer: { playerId: 'recommended', name: 'Alpha Receiver', position: 'WR' },
    alternativePlayer: { playerId: 'alternative', name: 'Beta Receiver', position: 'WR' },
    projectionDifference: 1.2,
    evidence
  };
}

function recommendation() {
  return {
    action: 'start_sit',
    start: { playerId: 'recommended', name: 'Alpha Receiver', position: 'WR' },
    sit: { playerId: 'alternative', name: 'Beta Receiver', position: 'WR' },
    targetSlot: 'WR',
    targetSlotId: 'WR:1',
    expectedGain: 1.2,
    probabilityStartOutscoresSit: 0.55
  };
}

function cohortPrior(overrides = {}) {
  return {
    status: 'available',
    direction: 'supports_recommended',
    strength: 'moderate',
    sampleSize: 43,
    summary: 'Comparable Year-2 WR cohort was moderately favorable.',
    cohort: { careerStage: 'Year 2', position: 'WR', draftCapital: 'Rounds 2–3' },
    ...overrides
  };
}

function group(assessment, summary = 'Existing grouped evidence.', factCount = 1) {
  return {
    assessment,
    summary,
    facts: Array.from({ length: factCount }, (_, index) => ({ metric: `metric-${index + 1}` }))
  };
}

function lineupFixture() {
  return {
    objective: 'mean',
    expectedGain: 1.2,
    current: { complete: true, assignments: [{ slotId: 'WR:1', slot: 'WR', playerId: 'alternative' }] },
    recommended: { complete: true, assignments: [{ slotId: 'WR:1', slot: 'WR', playerId: 'recommended' }] },
    recommendations: [recommendation()],
    projections: [
      { playerId: 'recommended', mean: 16, median: 15.5, floor: 9, ceiling: 23 },
      { playerId: 'alternative', mean: 14.8, median: 14.5, floor: 8, ceiling: 22 }
    ]
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
