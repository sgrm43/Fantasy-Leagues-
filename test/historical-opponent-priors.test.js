import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORICAL_OPPONENT_COHORT_ORDER,
  HISTORICAL_OPPONENT_PRIOR_SAMPLE_THRESHOLDS,
  buildDefensiveCoordinatorHistoricalPrior,
  buildHistoricalMatchupComparisonEvidence,
  buildHistoricalOpponentPrior,
  buildHistoricalOpponentPriors,
  buildPlayerStyleMatchupPrior,
  classifyPlayerStyle,
  sampleQuality
} from '../src/analytics/historical-opponent-priors.js';

const CURRENT_LEARNING = Object.freeze({ season: 2026, completedGames: 0, status: 'learning' });

test('1. Week 1 produces a defensive historical prior with zero 2026 defensive games', () => {
  const result = buildHistoricalOpponentPrior({
    season: 2026,
    currentWeek: 1,
    player: rushingQb('qb'),
    defense: { team: 'WSH', tendency: 'qb_rush_vulnerable' },
    positionContext: opponentPositionContext({ defense: 'WAS', position: 'QB', index: 120, sampleSize: 30 }),
    currentSeasonDefense: CURRENT_LEARNING,
    historicalMatchupRows: cohort('QB', 'rushing_qb', 'mobile_qb', 'qb_rush_vulnerable', 30, 0.18)
  });

  assert.equal(result.week, 1);
  assert.equal(result.historicalDefensePrior.status, 'available');
  assert.equal(result.historicalDefensePrior.assessment, 'favorable');
  assert.equal(result.historicalDefensePrior.sampleSize, 30);
  assert.equal(result.currentSeasonDefense.status, 'learning');
  assert.equal(result.currentSeasonDefense.completedGames, 0);
});

test('2. historical defense prior remains separate from current-season Learning evidence', () => {
  const result = buildHistoricalOpponentPrior(baseInput({
    player: passCatchingRb('rb'),
    defense: { team: 'SEA', tendency: 'rb_target_friendly' },
    historicalDefenseRows: defenseEvidence('SEA', 'RB', 40, 0.1, 'rb_target_friendly'),
    historicalMatchupRows: cohort('RB', 'pass_catching_back', 'receiving_back', 'rb_target_friendly', 40, 0.16)
  }));

  assert.equal(result.historicalDefensePrior.label, 'Team historical reference');
  assert.equal(result.historicalDefensePrior.sourceSeason.latest, 2025);
  assert.equal(result.currentSeasonDefense.label, '2026 defense sample: Learning');
  assert.equal(result.currentSeasonDefense.historical, false);
  assert.equal(result.currentSeasonDefense.usedInHistoricalPrior, false);
  assert.equal(result.historicalPriorUsedAsCurrentEvidence, false);
});

test('3. a verified defensive coordinator change prevents old team-period attribution', () => {
  const coachingContext = {
    roles: {
      defensiveCoordinator: {
        status: 'verified',
        name: 'New Coordinator',
        period: { tenureId: '2026:WAS:new', coachName: 'New Coordinator', startWeek: 1 }
      }
    }
  };
  const periods = [{
    status: 'verified', role: 'defensiveCoordinator', coordinatorName: 'Old Coordinator',
    team: 'WSH', season: 2025, sampleSize: 60, score: -0.2
  }];
  const coordinator = buildDefensiveCoordinatorHistoricalPrior({
    season: 2026, defense: { team: 'WAS' }, coachingContext, defensiveCoordinatorPeriods: periods
  });
  const result = buildHistoricalOpponentPrior(baseInput({
    player: deepWr('wr'),
    defense: { team: 'WAS', tendency: 'explosive_pass_suppressing' },
    coachingContext,
    defensiveCoordinatorPeriods: periods,
    historicalDefenseRows: defenseEvidence('WSH', 'WR', 60, -0.2, 'explosive_pass_suppressing'),
    historicalMatchupRows: cohort('WR', 'deep_threat', 'perimeter_receiver', 'explosive_pass_suppressing', 60, -0.2)
  }));

  assert.equal(coordinator.status, 'insufficient');
  assert.equal(coordinator.changeDetected, true);
  assert.equal(coordinator.periodsUsed.length, 0);
  assert.equal(coordinator.continuity.currentTeamVerified, false);
  assert.match(coordinator.summary, /not attributed/i);
  assert.equal(result.historicalDefensePrior.attributedToCurrentCoordinator, false);
  assert.equal(result.historicalDefensePrior.referenceOnly, true);
  assert.equal(result.historicalDefensePrior.confidence, 'moderate');
});

test('4. QB, RB, WR, and TE styles map deterministically from explicit role/usage/NGS fields', () => {
  const players = [
    rushingQb('qb'),
    passCatchingRb('rb'),
    deepWr('wr'),
    shortTe('te')
  ];
  const first = players.map(classifyPlayerStyle);
  const second = players.map(classifyPlayerStyle);

  assert.deepEqual(first, second);
  assert.deepEqual(first.map((item) => item.style), [
    'rushing_qb',
    'pass_catching_back',
    'deep_threat',
    'short_intermediate_te'
  ]);
  assert.ok(first.every((item) => item.evidence.length > 0));
});

test('5. insufficient player-style evidence stays neutral and explicitly not confident', () => {
  const player = { playerId: 'unknown', name: 'Unknown Role', position: 'WR' };
  const style = classifyPlayerStyle(player);
  const matchup = buildPlayerStyleMatchupPrior({
    season: 2026,
    player,
    playerStyle: style,
    defenseTendency: 'explosive_pass_suppressing',
    historicalMatchupRows: cohort('WR', 'deep_threat', 'perimeter_receiver', 'explosive_pass_suppressing', 60, 0.2)
  });

  assert.equal(style.status, 'style_not_confident');
  assert.equal(style.style, 'style_not_confident');
  assert.equal(matchup.status, 'insufficient');
  assert.equal(matchup.assessment, 'insufficient_evidence');
  assert.equal(matchup.score, 0);
});

test('6. a rushing QB receives different historical context than a pocket QB', () => {
  const rows = [
    ...cohort('QB', 'rushing_qb', 'mobile_qb', 'pressure_heavy', 30, 0.22),
    ...cohort('QB', 'pocket_passer', 'passer', 'pressure_heavy', 30, -0.2)
  ];
  const common = {
    defense: { team: 'PIT', tendency: 'pressure_heavy' },
    historicalDefenseRows: defenseEvidence('PIT', 'QB', 60, 0, 'pressure_heavy'),
    historicalMatchupRows: rows
  };
  const rushing = buildHistoricalOpponentPrior(baseInput({ ...common, player: rushingQb('rush') }));
  const pocket = buildHistoricalOpponentPrior(baseInput({ ...common, player: pocketQb('pocket') }));

  assert.equal(rushing.styleMatchupPrior.assessment, 'favorable');
  assert.equal(pocket.styleMatchupPrior.assessment, 'difficult');
  assert.ok(rushing.matchupEvidence.score > pocket.matchupEvidence.score);
  assert.match(rushing.explanation, /quarterback-rushing environment/i);
});

test('7. a pass-catching RB receives different context than an early-down RB', () => {
  const rows = [
    ...cohort('RB', 'pass_catching_back', 'receiving_back', 'run_resistant_target_friendly', 30, 0.2),
    ...cohort('RB', 'early_down_runner', 'early_down_back', 'run_resistant_target_friendly', 30, -0.18)
  ];
  const common = {
    defense: { team: 'BAL', tendency: 'run_resistant_target_friendly' },
    historicalDefenseRows: defenseEvidence('BAL', 'RB', 60, 0, 'run_resistant_target_friendly'),
    historicalMatchupRows: rows
  };
  const receiving = buildHistoricalOpponentPrior(baseInput({ ...common, player: passCatchingRb('receiving') }));
  const runner = buildHistoricalOpponentPrior(baseInput({ ...common, player: earlyDownRb('runner') }));

  assert.equal(receiving.playerStyle.style, 'pass_catching_back');
  assert.equal(runner.playerStyle.style, 'early_down_runner');
  assert.ok(receiving.matchupEvidence.score > runner.matchupEvidence.score);
  assert.match(receiving.explanation, /receiving-back opportunity/i);
});

test('8. a deep WR receives different context than a short-area WR', () => {
  const rows = [
    ...cohort('WR', 'deep_threat', 'perimeter_receiver', 'explosive_pass_suppressing', 30, -0.22),
    ...cohort('WR', 'slot_short_area_target', 'slot_receiver', 'explosive_pass_suppressing', 30, 0.16)
  ];
  const common = {
    defense: { team: 'NYJ', tendency: 'explosive_pass_suppressing' },
    historicalDefenseRows: defenseEvidence('NYJ', 'WR', 60, 0, 'explosive_pass_suppressing'),
    historicalMatchupRows: rows
  };
  const deep = buildHistoricalOpponentPrior(baseInput({ ...common, player: deepWr('deep') }));
  const short = buildHistoricalOpponentPrior(baseInput({ ...common, player: shortWr('short') }));

  assert.equal(deep.playerStyle.style, 'deep_threat');
  assert.equal(short.playerStyle.style, 'slot_short_area_target');
  assert.ok(deep.matchupEvidence.score < short.matchupEvidence.score);
  assert.match(deep.explanation, /downfield upside more than target opportunity/i);
});

test('9. correlated team, coordinator, style, and opponent signals remain one Matchup group', () => {
  const currentCoordinator = {
    roles: { defensiveCoordinator: { status: 'verified', name: 'Same Coordinator', period: { tenureId: 'dc-tenure', startWeek: 1 } } }
  };
  const result = buildHistoricalOpponentPrior(baseInput({
    player: passCatchingRb('recommended'),
    defense: { team: 'SEA', tendency: 'rb_target_friendly' },
    coachingContext: currentCoordinator,
    defensiveCoordinatorPeriods: [{
      status: 'verified', coordinatorName: 'Same Coordinator', team: 'SEA', season: 2025,
      sampleSize: 50, score: 0.18, continuityVerified: true
    }],
    historicalDefenseRows: defenseEvidence('SEA', 'RB', 50, 0.16, 'rb_target_friendly'),
    historicalMatchupRows: cohort('RB', 'pass_catching_back', 'receiving_back', 'rb_target_friendly', 50, 0.2)
  }));
  const alternative = buildHistoricalOpponentPrior(baseInput({
    player: earlyDownRb('alternative'),
    defense: { team: 'DEN', tendency: 'run_resistant' },
    historicalDefenseRows: defenseEvidence('DEN', 'RB', 50, -0.16, 'run_resistant'),
    historicalMatchupRows: cohort('RB', 'early_down_runner', 'early_down_back', 'run_resistant', 50, -0.2)
  }));
  const comparison = buildHistoricalMatchupComparisonEvidence({
    recommendedPrior: result,
    alternativePrior: alternative,
    currentMatchupEvidence: { assessment: 'supports_recommended', strength: 'moderate', facts: [{ metric: 'opponentOpportunityIndex' }] }
  });

  assert.equal(result.matchupEvidence.group, 'matchup');
  assert.equal(result.matchupEvidence.sourceSignalCount, 3);
  assert.equal(result.matchupEvidence.appliedSignalCount, 1);
  assert.equal(result.matchupEvidence.correlatedInputsCollapsed, true);
  assert.equal(comparison.group, 'matchup');
  assert.equal(comparison.countedAsOneGroup, true);
  assert.equal(comparison.correlatedInputsCollapsed, true);
  assert.equal(comparison.assessment, 'supports_recommended');
  assert.equal(Array.isArray(comparison.facts), true);
});

test('10. conflicting team and style evidence stays mixed and lowers confidence', () => {
  const result = buildHistoricalOpponentPrior(baseInput({
    player: deepWr('conflict'),
    defense: { team: 'SF', tendency: 'split_signal' },
    historicalDefenseRows: defenseEvidence('SF', 'WR', 60, -0.2, 'split_signal'),
    historicalMatchupRows: cohort('WR', 'deep_threat', 'perimeter_receiver', 'split_signal', 60, 0.24)
  }));

  assert.equal(result.historicalDefensePrior.confidence, 'strong');
  assert.equal(result.styleMatchupPrior.confidence, 'strong');
  assert.equal(result.matchupEvidence.status, 'mixed');
  assert.equal(result.matchupEvidence.assessment, 'mixed');
  assert.equal(result.matchupEvidence.confidence, 'moderate');
  assert.equal(result.matchupEvidence.strength, 'weak');
  assert.equal(result.matchupEvidence.conflict.preserved, true);
  assert.match(result.explanation, /confidence is lower/i);
});

test('cohorts broaden in the centralized order and always retain sample size', () => {
  const player = deepWr('broadening');
  const rows = [
    ...cohort('WR', 'deep_threat', 'perimeter_receiver', 'two_high', 5, -0.2),
    ...cohort('WR', 'possession_receiver', 'perimeter_receiver', 'two_high', 20, 0.1),
    ...cohort('WR', 'slot_short_area_target', 'slot_receiver', 'two_high', 30, 0)
  ];
  const result = buildPlayerStyleMatchupPrior({
    season: 2026,
    player,
    playerStyle: classifyPlayerStyle(player),
    defenseTendency: 'two_high',
    historicalMatchupRows: rows
  });

  assert.deepEqual(HISTORICAL_OPPONENT_COHORT_ORDER.map((item) => item.key), [
    'exact_style+tendency', 'role+tendency', 'position+tendency', 'position'
  ]);
  assert.deepEqual(HISTORICAL_OPPONENT_PRIOR_SAMPLE_THRESHOLDS, { strong: 50, moderate: 25, weak: 10 });
  assert.equal(sampleQuality(9), 'insufficient');
  assert.equal(sampleQuality(10), 'weak');
  assert.equal(result.cohort.selectedLevel, 'role+tendency');
  assert.equal(result.cohort.broadened, true);
  assert.equal(result.sampleSize, 25);
  assert.equal(result.sample.comparablePlayerGames, 25);
});

test('the layer is pure, read-only, roster-scoped, and never adjusts projections or the optimizer', () => {
  const input = {
    season: 2026,
    currentWeek: 1,
    players: [deepWr('selected'), { playerId: 'k', position: 'K' }],
    defense: { team: 'SEA', tendency: 'two_high' },
    currentSeasonDefense: CURRENT_LEARNING,
    historicalDefenseRows: defenseEvidence('SEA', 'WR', 30, -0.1, 'two_high'),
    historicalMatchupRows: cohort('WR', 'deep_threat', 'perimeter_receiver', 'two_high', 30, -0.2)
  };
  const before = structuredClone(input);
  const result = buildHistoricalOpponentPriors(input);

  assert.deepEqual(input, before);
  assert.equal(result.players.length, 1);
  assert.equal(result.players[0].requestedPlayerId, 'selected');
  assert.equal(result.projectionsAdjusted, false);
  assert.equal(result.optimizerAdjusted, false);
  assert.deepEqual(result.safeguards, { readOnly: true, transactionsPerformed: false });
  assert.equal(result.players[0].matchupEvidence.projectionsAdjusted, false);
  assert.deepEqual(result.players[0].matchupEvidence.safeguards, { readOnly: true, transactionsPerformed: false });
});

function baseInput(overrides = {}) {
  return {
    season: 2026,
    currentWeek: 1,
    currentSeasonDefense: CURRENT_LEARNING,
    ...overrides
  };
}

function opponentPositionContext({ defense, position, index, sampleSize }) {
  return {
    provider: 'fixture-normalized',
    model: 'recent-opponent-position-allowance',
    season: 2025,
    basis: 'prior-season historical baseline',
    defense: { abbreviation: defense },
    position,
    sample: { includedGames: sampleSize },
    metrics: { opportunity: { label: 'position opportunity', index, sampleGames: sampleSize } },
    assessment: { label: index > 105 ? 'higher_than_league' : index < 95 ? 'lower_than_league' : 'near_league' }
  };
}

function defenseEvidence(defense, position, sampleSize, score, defenseTendency) {
  return [{
    historical: true,
    season: 2025,
    defense,
    position,
    sampleSize,
    score,
    defenseTendency
  }];
}

function cohort(position, style, role, defenseTendency, sampleSize, score) {
  return [{
    historical: true,
    season: 2025,
    playerId: `${style}:${defenseTendency}`,
    position,
    style,
    role,
    defenseTendency,
    sampleSize,
    score
  }];
}

function rushingQb(playerId) {
  return {
    playerId,
    name: `Rushing QB ${playerId}`,
    position: 'QB',
    analysisUsage: { summary: { opportunity: { carries: { weightedAverage: 6 }, passAttempts: { weightedAverage: 31 } } } }
  };
}

function pocketQb(playerId) {
  return {
    playerId,
    name: `Pocket QB ${playerId}`,
    position: 'QB',
    analysisUsage: { summary: { opportunity: { carries: { weightedAverage: 1 }, passAttempts: { weightedAverage: 34 } } } }
  };
}

function passCatchingRb(playerId) {
  return {
    playerId,
    name: `Receiving Back ${playerId}`,
    position: 'RB',
    analysisUsage: { summary: { opportunity: { carries: { weightedAverage: 8 }, targets: { weightedAverage: 5 } } } }
  };
}

function earlyDownRb(playerId) {
  return {
    playerId,
    name: `Early Runner ${playerId}`,
    position: 'RB',
    analysisUsage: { summary: { opportunity: { carries: { weightedAverage: 16 }, targets: { weightedAverage: 1 } } } }
  };
}

function deepWr(playerId) {
  return {
    playerId,
    name: `Deep Receiver ${playerId}`,
    position: 'WR',
    nextGen: {
      reference: {
        label: '2025 reference',
        metrics: [{ key: 'target_depth', values: { avgIntendedAirYards: 15 } }]
      }
    }
  };
}

function shortWr(playerId) {
  return {
    playerId,
    name: `Slot Receiver ${playerId}`,
    position: 'WR',
    role: 'slot receiver',
    nextGen: {
      reference: {
        label: '2025 reference',
        metrics: [{ key: 'target_depth', values: { avgIntendedAirYards: 7 } }]
      }
    }
  };
}

function shortTe(playerId) {
  return {
    playerId,
    name: `Short Tight End ${playerId}`,
    position: 'TE',
    analysisUsage: { summary: { opportunity: { targets: { weightedAverage: 5 } } } },
    nextGen: {
      reference: {
        label: '2025 reference',
        metrics: [{ key: 'target_depth', values: { avgIntendedAirYards: 7 } }]
      }
    }
  };
}

