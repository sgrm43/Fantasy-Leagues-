import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTopActionsToday } from '../src/analytics/top-actions-today.js';

test('critical availability issue ranks above a normal lineup swap', () => {
  const input = fixture({
    lineup: lineupWithSwap(),
    players: [
      player('qb-out', 'Unavailable Quarterback', 'QB', 18, { injuryStatus: 'OUT', slot: 'QB' }),
      player('wr-old', 'Current Receiver', 'WR', 11, { slot: 'WR' }),
      player('wr-new', 'Bench Upgrade', 'WR', 14, { slot: 'BENCH' })
    ]
  });

  const result = buildTopActionsToday(input);

  assert.ok(result.actions.length >= 2);
  assert.match(actionText(result.actions[0]), /Unavailable Quarterback/i);
  assert.match(actionText(result.actions[0]), /out|inactive|unavailable/i);
  assert.match(actionText(result.actions[1]), /Bench Upgrade.*Current Receiver|Current Receiver.*Bench Upgrade/i);
});

test('a recommended lineup swap ranks above a lower-impact observation', () => {
  const input = fixture({
    lineup: lineupWithSwap(),
    weeklyIntelligence: {
      observations: [{
        id: 'warning:rb-watch',
        kind: 'sustainability_warning',
        headline: 'Watch Reserve Runner\'s role',
        explanation: 'His workload has moved slightly, but no lineup change is recommended.',
        playerIds: ['rb-watch'],
        confidence: 'Moderate'
      }]
    }
  });

  const result = buildTopActionsToday(input);

  assert.ok(result.actions.length >= 2);
  assert.match(actionText(result.actions[0]), /Start Bench Upgrade over Current Receiver/i);
  assert.match(actionText(result.actions[1]), /Reserve Runner|workload|role/i);
});

test('duplicate versions of the same lineup action merge into one action', () => {
  const input = fixture({
    lineup: lineupWithSwap(),
    recommendationQuality: qualityForSwap(),
    weeklyIntelligence: {
      observations: [{
        id: 'decision:WR:1|wr-new|wr-old',
        kind: 'lineup_decision',
        headline: 'Start Bench Upgrade over Current Receiver',
        explanation: 'Bench Upgrade has the stronger projection and target profile.',
        playerIds: ['wr-new', 'wr-old'],
        comparisonId: 'WR:1|wr-new|wr-old',
        supportClassification: 'supported',
        confidence: 'Moderate'
      }]
    }
  });

  const result = buildTopActionsToday(input);
  const matching = result.actions.filter((action) => /Bench Upgrade/i.test(actionText(action)) && /Current Receiver/i.test(actionText(action)));

  assert.equal(matching.length, 1);
  assert.equal(result.actions.length, 1);
});

test('configured maximum limits the number of displayed actions', () => {
  const observations = Array.from({ length: 7 }, (_, index) => ({
    id: `role:${index}`,
    kind: 'sustainability_warning',
    headline: `Watch Player ${index + 1}'s role`,
    explanation: `Player ${index + 1} has a meaningful workload trend to monitor.`,
    playerIds: [`player-${index + 1}`],
    confidence: 'Moderate'
  }));

  const result = buildTopActionsToday(fixture({
    maxActions: 3,
    weeklyIntelligence: { observations }
  }));

  assert.ok(result.actions.length > 0);
  assert.ok(result.actions.length <= 3);
});

test('no action is invented when the supplied analysis contains nothing meaningful', () => {
  const result = buildTopActionsToday(fixture());

  assert.deepEqual(result.actions, []);
  assert.doesNotMatch(outputText(result), /urgent|start .* over|add .* drop/i);
});

test('matching current and recommended lineups can produce a no-change action', () => {
  const assignment = { slotId: 'RB:1', slot: 'RB', playerId: 'rb-same', player: 'Correct Starter', position: 'RB', value: 15 };
  const result = buildTopActionsToday(fixture({
    lineup: {
      current: { complete: true, assignments: [assignment] },
      recommended: { complete: true, assignments: [{ ...assignment }] },
      recommendations: [],
      safeguards: { readOnly: true, transactionsPerformed: false }
    }
  }));

  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].status, 'No action');
  assert.match(actionText(result.actions[0]), /No starting-lineup changes needed/i);
});

test('projection conflict is presented as a close low-confidence decision', () => {
  const result = buildTopActionsToday(fixture({
    lineup: lineupWithSwap({ gain: 0.7 }),
    recommendationQuality: qualityForSwap({
      projectionDifference: 0.7,
      supportClassification: 'projection_conflict',
      confidence: 'Low'
    })
  }));

  assert.equal(result.actions[0].status, 'Close call');
  assert.match(actionText(result.actions[0]), /Close call/i);
  assert.match(actionText(result.actions[0]), /0\.7|projection/i);
  assert.match(actionText(result.actions[0]), /Low confidence|conflict|stronger recent (volume|workload)/i);
});

test('actionable critical news rises to the top priority', () => {
  const result = buildTopActionsToday(fixture({
    lineup: lineupWithSwap(),
    newsChanges: [{
      id: 'critical-news-player',
      playerId: 'news-player',
      playerName: 'News Receiver',
      materiality: 'critical',
      severity: 'critical',
      meaningful: true,
      summary: 'News Receiver was downgraded from Questionable to OUT.',
      reason: 'The availability change requires lineup reanalysis.',
      requiresReanalysis: true,
      requires_reanalysis: true
    }]
  }));

  assert.match(actionText(result.actions[0]), /News Receiver/i);
  assert.match(actionText(result.actions[0]), /OUT|critical|recheck|monitor/i);
  assert.notEqual(result.actions[0].status, 'No action');
});

test('existing waiver add-drop recommendation is reused without reranking', () => {
  const waivers = {
    readOnly: true,
    recommendations: [
      waiverMove(1, 'chosen-add', 'Chosen Add', 'chosen-drop', 'Chosen Drop', 1.2),
      waiverMove(2, 'decoy-add', 'Higher Raw Decoy', 'decoy-drop', 'Decoy Drop', 9.5)
    ]
  };
  deepFreeze(waivers);

  const result = buildTopActionsToday(fixture({ waivers }));

  assert.equal(result.actions.length, 1);
  assert.match(actionText(result.actions[0]), /Chosen Add/i);
  assert.match(actionText(result.actions[0]), /Chosen Drop/i);
  assert.doesNotMatch(actionText(result.actions[0]), /Higher Raw Decoy|Decoy Drop/i);
  assert.equal(waivers.recommendations[0].rank, 1);
});

test('building top actions leaves every projection value unchanged', () => {
  const input = fixture({
    lineup: lineupWithSwap(),
    players: [
      player('wr-new', 'Bench Upgrade', 'WR', { mean: 14, median: 13.5, floor: 7, ceiling: 22 }),
      player('wr-old', 'Current Receiver', 'WR', { mean: 11, median: 10.5, floor: 6, ceiling: 18 })
    ]
  });
  input.lineup.projections = [
    { playerId: 'wr-new', mean: 14, median: 13.5, floor: 7, ceiling: 22, bustProbability: 0.2, spikeProbability: 0.18 },
    { playerId: 'wr-old', mean: 11, median: 10.5, floor: 6, ceiling: 18, bustProbability: 0.25, spikeProbability: 0.14 }
  ];
  const before = structuredClone({ players: input.players, projections: input.lineup.projections });

  const result = buildTopActionsToday(input);

  assert.deepEqual({ players: input.players, projections: input.lineup.projections }, before);
  assert.equal(result.projectionsAdjusted, false);
});

test('building top actions leaves optimizer and organized lineup output unchanged', () => {
  const input = fixture({ lineup: lineupWithSwap() });
  const before = structuredClone(input.lineup);
  deepFreeze(input.lineup);

  const result = buildTopActionsToday(input);

  assert.deepEqual(input.lineup, before);
  assert.equal(result.optimizerAdjusted, false);
});

test('top actions are read-only and cannot perform a fantasy transaction', () => {
  let transactionCalls = 0;
  const executeTransaction = () => { transactionCalls += 1; };
  const result = buildTopActionsToday(fixture({
    lineup: { ...lineupWithSwap(), executeTransaction },
    waivers: { readOnly: true, recommendations: [waiverMove(1, 'add', 'Waiver Add', 'drop', 'Safe Drop', 3)], submitClaim: executeTransaction },
    executeTransaction
  }));

  assert.equal(transactionCalls, 0);
  assert.deepEqual(result.safeguards, { readOnly: true, transactionsPerformed: false });
  assert.equal(result.projectionsAdjusted, false);
  assert.equal(result.optimizerAdjusted, false);
  assert.equal('executeTransaction' in result, false);
  assert.equal('submitClaim' in result, false);
  assert.doesNotMatch(JSON.stringify(result), /executeTransaction|submitClaim/);
});

function fixture(overrides = {}) {
  return {
    lineup: null,
    recommendationQuality: { comparisons: [] },
    weeklyIntelligence: { observations: [], whyThisLineup: [], keyUncertainty: null },
    newsChanges: [],
    players: [],
    waivers: { readOnly: true, recommendations: [] },
    strategy: null,
    nflContext: null,
    ...overrides
  };
}

function lineupWithSwap({ gain = 3 } = {}) {
  const currentReceiver = player('wr-old', 'Current Receiver', 'WR', 11);
  const benchUpgrade = player('wr-new', 'Bench Upgrade', 'WR', 11 + gain);
  return {
    objective: 'mean',
    expectedGain: gain,
    current: {
      complete: true,
      assignments: [
        { slotId: 'QB:1', slot: 'QB', playerId: 'qb-out', player: 'Unavailable Quarterback', position: 'QB', value: 18 },
        { slotId: 'WR:1', slot: 'WR', playerId: 'wr-old', player: 'Current Receiver', position: 'WR', value: 11 }
      ]
    },
    recommended: {
      complete: true,
      assignments: [
        { slotId: 'QB:1', slot: 'QB', playerId: 'qb-out', player: 'Unavailable Quarterback', position: 'QB', value: 18 },
        { slotId: 'WR:1', slot: 'WR', playerId: 'wr-new', player: 'Bench Upgrade', position: 'WR', value: 11 + gain }
      ]
    },
    recommendations: [{
      action: 'start_sit',
      start: benchUpgrade,
      sit: currentReceiver,
      targetSlot: 'WR',
      targetSlotId: 'WR:1',
      expectedGain: gain,
      probabilityStartOutscoresSit: 0.66,
      confidence: { level: 'medium', basis: 'Input-quality label only.' },
      rationale: [`Bench Upgrade has a +${gain.toFixed(1)} median projection edge.`],
      caveats: ['Outcome ranges overlap.'],
      whatCouldChange: ['Material injury or role news.'],
      lineupMoves: [{ slotId: 'WR:1', slot: 'WR', playerId: 'wr-new', player: 'Bench Upgrade' }]
    }],
    projections: [benchUpgrade, currentReceiver],
    safeguards: { readOnly: true, transactionsPerformed: false }
  };
}

function qualityForSwap({
  projectionDifference = 3,
  supportClassification = 'supported',
  confidence = 'Moderate'
} = {}) {
  return {
    model: 'grouped-football-evidence',
    comparisons: [{
      comparisonId: 'WR:1|wr-new|wr-old',
      comparisonType: 'start_sit',
      targetSlot: 'WR',
      targetSlotId: 'WR:1',
      recommendedPlayer: player('wr-new', 'Bench Upgrade', 'WR', 11 + projectionDifference),
      alternativePlayer: player('wr-old', 'Current Receiver', 'WR', 11),
      projectionDifference,
      supportClassification,
      confidence,
      confidenceBasis: `${supportClassification} fixture; this is not a win probability.`,
      reasons: ['The existing projection favors Bench Upgrade.', 'Current Receiver has stronger recent workload.'],
      warnings: []
    }],
    safeguards: { readOnly: true, transactionsPerformed: false },
    projectionsAdjusted: false,
    optimizerAdjusted: false
  };
}

function waiverMove(rank, addId, addName, dropId, dropName, expectedWeeklyDelta) {
  return {
    rank,
    add: player(addId, addName, 'RB', 10),
    drop: player(dropId, dropName, 'RB', 10 - expectedWeeklyDelta),
    expectedWeeklyDelta,
    urgency: 'medium',
    reasons: [`${addName} has the existing provider's preferred weekly projection.`],
    caveats: ['Read-only recommendation.']
  };
}

function player(playerId, name, position, projection, extra = {}) {
  return { playerId, name, position, projection, ...extra };
}

function actionText(action) {
  return [action?.status, action?.action, action?.title, action?.headline, action?.reason, action?.explanation]
    .filter(Boolean)
    .join(' ');
}

function outputText(result) {
  return (result?.actions || []).map(actionText).join(' ');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
