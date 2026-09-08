import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRoster } from '../src/analytics/projections.js';
import {
  createNewsChangeEvaluatorStore,
  evaluateNewsChanges,
  updateNewsChangeState
} from '../src/news-change-evaluator.js';

const FIRST_TIME = '2026-09-09T12:00:00.000Z';
const NEXT_TIME = '2026-09-09T13:00:00.000Z';
const KICKOFF = '2026-09-10T20:20:00.000Z';

function observation(overrides = {}) {
  return {
    season: 2026,
    week: 1,
    gameId: 'game-1',
    kickoffAt: KICKOFF,
    playerId: 'espn:101',
    teamId: '25',
    displayName: 'Test Player',
    source: 'espn-nfl-injury',
    availabilityStatus: 'Questionable',
    observedAt: FIRST_TIME,
    ...overrides
  };
}

function transition(first, second, options = {}) {
  const baseline = updateNewsChangeState(null, [observation(first)], options);
  return updateNewsChangeState(baseline.state, [observation({ observedAt: NEXT_TIME, ...second })], options);
}

test('first observation creates a compact baseline but no change', () => {
  const secret = 'DO_NOT_STORE_THIS';
  const result = updateNewsChangeState(null, [observation({ rawArticle: secret, authorization: secret })]);
  const evaluation = result.evaluations[0];
  assert.equal(result.changed, true);
  assert.equal(Object.keys(result.state.records).length, 1);
  assert.equal(evaluation.status, 'baseline');
  assert.equal(evaluation.materiality, 'none');
  assert.equal(evaluation.requires_reanalysis, false);
  assert.equal(JSON.stringify(result.state).includes(secret), false);
});

test('an identical repeated status returns none', () => {
  const result = transition({ availabilityStatus: 'Questionable' }, { availabilityStatus: 'Questionable' });
  assert.equal(result.evaluations[0].status, 'unchanged');
  assert.equal(result.evaluations[0].materiality, 'none');
  assert.equal(Object.keys(result.state.records).length, 1);
});

test('questionable to doubtful and other material existing-context changes are meaningful', () => {
  const cases = [
    [{ availabilityStatus: 'Questionable' }, { availabilityStatus: 'Doubtful' }, 'availability'],
    [{ availabilityStatus: 'Healthy' }, { availabilityStatus: 'Questionable' }, 'availability'],
    [{ roleStatus: 'Starter' }, { roleStatus: 'Backup' }, 'role'],
    [{ gameStatus: 'Scheduled' }, { gameStatus: 'Delayed' }, 'game_status']
  ];
  for (const [first, second, type] of cases) {
    const evaluation = transition(first, second).evaluations[0];
    assert.equal(evaluation.materiality, 'meaningful', type);
    assert.ok(evaluation.change_types.includes(type), type);
  }
});

test('doubtful to out and a newly postponed game are critical', () => {
  const player = transition({ availabilityStatus: 'Doubtful' }, { availabilityStatus: 'Out' }).evaluations[0];
  const game = transition({ gameStatus: 'Scheduled' }, { gameStatus: 'Postponed' }).evaluations[0];
  assert.equal(player.materiality, 'critical');
  assert.equal(game.materiality, 'critical');
});

test('limited to full practice is a meaningful improvement', () => {
  const evaluation = transition(
    { practiceStatus: 'Limited participation' },
    { practiceStatus: 'Full participation' }
  ).evaluations[0];
  assert.equal(evaluation.materiality, 'meaningful');
  assert.deepEqual(evaluation.change_types, ['practice']);
  assert.match(evaluation.reason, /Limited.*Full/);
});

test('duplicate provider wording normalizes to one state and no duplicate change', () => {
  const limited = updateNewsChangeState(null, [observation({ practiceStatus: 'Limited participation' })]);
  const repeated = updateNewsChangeState(limited.state, [observation({ practiceStatus: 'LP', observedAt: NEXT_TIME })]);
  assert.equal(repeated.evaluations[0].materiality, 'none');
  assert.equal(Object.keys(repeated.state.records).length, 1);
  assert.equal(Object.values(repeated.state.records)[0].practice_status, 'limited');
});

test('a new NFL week creates a baseline instead of comparing unrelated weeks', () => {
  const first = updateNewsChangeState(null, [observation({ availabilityStatus: 'Questionable' })]);
  const nextWeek = updateNewsChangeState(first.state, [observation({
    week: 2,
    gameId: 'game-2',
    availabilityStatus: 'Out',
    observedAt: '2026-09-16T12:00:00.000Z',
    kickoffAt: '2026-09-17T20:20:00.000Z'
  })]);
  assert.equal(nextWeek.evaluations[0].status, 'baseline');
  assert.equal(nextWeek.evaluations[0].materiality, 'none');
  assert.equal(Object.keys(nextWeek.state.records).length, 2);
});

test('source failure does not fabricate a change or alter the previous state', async () => {
  let saved = updateNewsChangeState(null, [observation()]).state;
  const before = JSON.stringify(saved);
  let writes = 0;
  const store = createNewsChangeEvaluatorStore({
    read: async () => saved,
    write: async (next) => { saved = next; writes += 1; }
  });
  const result = await evaluateNewsChanges([observation({ availabilityStatus: 'Out', observedAt: NEXT_TIME })], {
    sourceAvailable: false,
    store
  });
  assert.equal(result.evaluations[0].status, 'source_unavailable');
  assert.equal(result.evaluations[0].materiality, 'none');
  assert.equal(result.evaluations[0].requires_reanalysis, false);
  assert.equal(JSON.stringify(saved), before);
  assert.equal(writes, 0);
});

test('a meaningful player change flags matching current lineup recommendations for reanalysis', () => {
  const analysis = {
    lineup: {
      current: { assignments: [{ playerId: 'espn:101' }] },
      recommended: { assignments: [{ playerId: 'espn:101' }] },
      recommendations: [{ action: 'start_sit', start: { playerId: 'espn:101' }, sit: { playerId: 'espn:202' }, lineupMoves: [] }]
    },
    projections: [{ playerId: 'espn:101', median: 15 }],
    waivers: { recommendations: [] }
  };
  const evaluation = transition(
    { availabilityStatus: 'Questionable' },
    { availabilityStatus: 'Doubtful' },
    { analysis }
  ).evaluations[0];
  assert.equal(evaluation.requires_reanalysis, true);
  assert.ok(evaluation.affected_recommendation_types.includes('start_sit'));
  assert.ok(evaluation.affected_recommendation_types.includes('lineup_confidence'));
  assert.match(evaluation.reason, /requires reanalysis/);
});

test('news evaluation remains read-only and never performs a fantasy transaction', async () => {
  let state = null;
  let transactionCalls = 0;
  const safeguards = { readOnly: true, transactionsPerformed: false };
  const analysis = {
    safeguards,
    lineup: { current: { assignments: [{ playerId: 'espn:101' }] }, recommended: { assignments: [] }, recommendations: [] },
    executeTransaction: () => { transactionCalls += 1; }
  };
  const store = createNewsChangeEvaluatorStore({ read: async () => state, write: async (next) => { state = next; } });
  await evaluateNewsChanges([observation()], { analysis, store });
  await evaluateNewsChanges([observation({ availabilityStatus: 'Out', observedAt: NEXT_TIME })], { analysis, store });
  assert.equal(transactionCalls, 0);
  assert.deepEqual(safeguards, { readOnly: true, transactionsPerformed: false });
});

test('news evaluation leaves projection math and projection values unchanged', () => {
  const roster = [{ playerId: 'espn:101', name: 'Test Player', position: 'RB', projection: 14 }];
  const options = { provenance: { source: 'test', retrievedAt: FIRST_TIME }, now: new Date(FIRST_TIME) };
  const before = projectRoster(roster, options);
  const input = structuredClone(roster);
  transition({ availabilityStatus: 'Questionable' }, { availabilityStatus: 'Doubtful' });
  const after = projectRoster(roster, options);
  assert.deepEqual(after, before);
  assert.deepEqual(roster, input);
});
