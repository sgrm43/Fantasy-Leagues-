import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRoster } from '../src/analytics/projections.js';
import { createNewsChangeEvaluatorStore } from '../src/news-change-evaluator.js';
import {
  createEspnNewsAdapter,
  createSleeperNewsAdapter,
  createOfficialNflNewsAdapter,
  createOfficialTeamReportNewsAdapter,
  createOfficialTeamTransactionNewsAdapter,
  createOfficialTeamNewsAdapter,
  createUnsupportedNewsAdapter,
  normalizeNewsEvent
} from '../src/news-sources/source-adapters.js';
import {
  reconcileNewsEvents,
  runNewsSourceCycle,
  buildRosterNewsScope
} from '../src/news-sources/news-source-cycle.js';

const SEASON = 2026;
const WEEK = 1;
const GAME_ID = '2026_01_SF_LAR';
const PLAYER_ID = 'gsis:00-0030001';
const OTHER_PLAYER_ID = 'gsis:00-0030002';
const TEAM_ID = 'nfl-team:SF';
const PUBLISHED_AT = '2026-09-09T12:00:00.000Z';
const NEXT_PUBLISHED_AT = '2026-09-09T13:00:00.000Z';
const OBSERVED_AT = '2026-09-09T13:05:00.000Z';
const KICKOFF_AT = '2026-09-10T20:20:00.000Z';
const NOW = new Date(OBSERVED_AT);

const ROSTER_PLAYER = Object.freeze({
  playerId: PLAYER_ID,
  name: 'Roster Player',
  position: 'RB',
  nflTeam: 'SF',
  platform: 'espn',
  platformPlayerId: '101',
  externalIds: Object.freeze({ espn: '101', sleeper: '501', gsis: '00-0030001' })
});

const SCOPE = buildRosterNewsScope({
  season: SEASON,
  week: WEEK,
  gameId: GAME_ID,
  kickoffAt: KICKOFF_AT,
  rosterPlayers: [ROSTER_PLAYER],
  opponentTeams: [{ id: 'nfl-team:LAR', abbreviation: 'LAR' }]
});

function newsEvent(overrides = {}) {
  return {
    eventId: 'source:event-1',
    source: 'secondary-feed',
    sourceType: 'secondary',
    publishedAt: PUBLISHED_AT,
    observedAt: OBSERVED_AT,
    season: SEASON,
    week: WEEK,
    gameId: GAME_ID,
    kickoffAt: KICKOFF_AT,
    team: { id: TEAM_ID, name: 'San Francisco 49ers', abbreviation: 'SF' },
    player: { id: PLAYER_ID, name: 'Roster Player' },
    playerId: PLAYER_ID,
    normalizedEventType: 'availability',
    normalizedStatus: 'questionable',
    availabilityStatus: 'questionable',
    practiceStatus: null,
    roleStatus: null,
    gameStatus: null,
    headline: 'Roster Player is questionable',
    sourceUrl: 'https://example.test/news/1',
    sourceReference: 'event-1',
    trust: 'existing_provider',
    trustLevel: 'existing_provider',
    authorityPriority: 5,
    affectedPlayerIds: [PLAYER_ID],
    ...overrides
  };
}

function rawEvent(overrides = {}) {
  const normalized = newsEvent(overrides);
  return {
    ...normalized,
    id: normalized.sourceReference,
    eventType: normalized.normalizedEventType,
    status: normalized.normalizedStatus
  };
}

function staticAdapter({
  id = 'static-adapter',
  sourceType = 'secondary',
  events = [],
  status = 'ok',
  issueCode,
  error
} = {}) {
  return {
    id,
    sourceType,
    async collect() {
      if (error) throw error;
      return {
        status,
        observedAt: OBSERVED_AT,
        fromCache: false,
        events,
        ...(issueCode ? { issueCode } : {})
      };
    }
  };
}

function memoryEvaluatorStore() {
  let state = null;
  return {
    store: createNewsChangeEvaluatorStore({
      read: async () => state,
      write: async (next) => { state = next; }
    }),
    state: () => state
  };
}

function relevantAnalysis() {
  return {
    safeguards: { readOnly: true, transactionsPerformed: false },
    lineup: {
      current: { assignments: [{ playerId: PLAYER_ID }] },
      recommended: { assignments: [{ playerId: OTHER_PLAYER_ID }] },
      recommendations: [{
        action: 'start_sit',
        start: { playerId: PLAYER_ID },
        sit: { playerId: OTHER_PLAYER_ID },
        lineupMoves: []
      }]
    },
    waivers: {
      recommendations: [{
        add: { playerId: OTHER_PLAYER_ID },
        drop: { playerId: 'gsis:00-0030003' }
      }]
    },
    projections: [{ playerId: PLAYER_ID, median: 14 }]
  };
}

async function runCycle(events, options = {}) {
  return runNewsSourceCycle({
    adapters: [staticAdapter({ events })],
    scope: SCOPE,
    now: () => NOW,
    ...options
  });
}

test('all source adapters produce the common normalized event shape', async () => {
  const adapters = [
    createEspnNewsAdapter({
      load: async () => [rawEvent({ playerId: '101', player: { id: '101', name: 'Roster Player' } })],
      now: () => NOW
    }),
    createSleeperNewsAdapter({
      load: async () => [rawEvent({ sleeperPlayerId: '501' })],
      now: () => NOW
    }),
    createOfficialNflNewsAdapter({ load: async () => [rawEvent()], now: () => NOW }),
    createOfficialTeamReportNewsAdapter({ load: async () => [rawEvent()], now: () => NOW }),
    createOfficialTeamTransactionNewsAdapter({ load: async () => [rawEvent()], now: () => NOW }),
    createOfficialTeamNewsAdapter({ load: async () => [rawEvent()], now: () => NOW })
  ];
  const requiredFields = [
    'source', 'sourceType', 'publishedAt', 'observedAt', 'team', 'player', 'playerId',
    'normalizedEventType', 'normalizedStatus', 'practiceStatus', 'headline',
    'sourceUrl', 'sourceReference', 'trustLevel'
  ];

  for (const adapter of adapters) {
    const result = await adapter.collect(SCOPE);
    assert.equal(result.status, 'ok', adapter.id);
    assert.equal(result.events.length, 1, adapter.id);
    for (const field of requiredFields) {
      assert.equal(Object.hasOwn(result.events[0], field), true, `${adapter.id}: ${field}`);
    }
  }

  const direct = normalizeNewsEvent(rawEvent(), {
    source: 'fixture', sourceType: 'existing_provider', trust: 'existing_provider', observedAt: OBSERVED_AT
  });
  assert.ok(direct);
  for (const field of requiredFields) assert.equal(Object.hasOwn(direct, field), true, `normalizeNewsEvent: ${field}`);
});

test('an official NFL or team designation outranks conflicting existing-provider information', () => {
  const official = newsEvent({
    source: 'official-nfl', sourceType: 'official_nfl', trust: 'official_primary', trustLevel: 'official_primary', authorityPriority: 1,
    normalizedStatus: 'out', availabilityStatus: 'out', headline: 'Official injury status: out'
  });
  const provider = newsEvent({
    eventId: 'source:event-2', source: 'espn-nfl-injury', sourceType: 'espn', trust: 'existing_provider', trustLevel: 'existing_provider', authorityPriority: 5,
    normalizedStatus: 'active', availabilityStatus: 'active', headline: 'Provider expects player to play', sourceReference: 'event-2'
  });
  const result = reconcileNewsEvents([provider, official]);
  assert.equal(result.length, 1);
  assert.equal(result[0].availabilityStatus, 'out');
  assert.equal(result[0].normalizedStatus, 'out');
  assert.equal(result[0].conflictStatus, 'resolved_by_authority');
  assert.equal(result[0].source, 'official-nfl');
});

test('semantic duplicates merge into one canonical event', () => {
  const result = reconcileNewsEvents([
    newsEvent({ source: 'espn-nfl-injury', sourceType: 'espn', sourceReference: 'espn-1' }),
    newsEvent({
      source: 'official-team-report', sourceType: 'official_team_report',
      trust: 'official_primary', trustLevel: 'official_primary', authorityPriority: 1, sourceReference: 'team-1'
    })
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].normalizedStatus, 'questionable');
  assert.equal(result[0].provenance.length, 2);
});

test('merged cross-source news retains safe provenance for every supporting report', () => {
  const result = reconcileNewsEvents([
    newsEvent({ source: 'espn-nfl-injury', sourceType: 'espn', sourceReference: 'espn-1', sourceUrl: 'https://espn.test/injury/1' }),
    newsEvent({
      source: 'official-team-report', sourceType: 'official_team_report',
      trust: 'official_primary', trustLevel: 'official_primary', authorityPriority: 1,
      sourceReference: 'team-1', sourceUrl: 'https://team.test/report/1'
    })
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].provenance.map((item) => item.source).sort(), ['espn-nfl-injury', 'official-team-report']);
  assert.deepEqual(result[0].provenance.map((item) => item.sourceReference).sort(), ['espn-1', 'team-1']);
  assert.equal(result[0].provenance.every((item) => item.sourceUrl?.startsWith('https://')), true);
});

test('an unsupported or paid candidate source is skipped cleanly', async () => {
  const unsupported = createUnsupportedNewsAdapter({
    id: 'paid-news-api',
    sourceType: 'paid_api',
    now: () => NOW
  });
  const result = await runNewsSourceCycle({ adapters: [unsupported], scope: SCOPE, now: () => NOW });
  assert.equal(result.sourceHealth[0].status, 'source_not_supported');
  assert.equal(result.sourceHealth[0].issueCode, 'SOURCE_NOT_SUPPORTED');
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.observations, []);
  assert.deepEqual(result.evaluation.evaluations, []);
});

test('one source failure does not stop other sources in the shared cycle', async () => {
  let failedCalls = 0;
  let adapterNow = NOW;
  const failed = createOfficialTeamNewsAdapter({
    load: async () => {
      failedCalls += 1;
      throw Object.assign(new Error('unsafe upstream detail'), {
        code: 'RATE_LIMITED', status: 429, retryAfterMs: 60_000
      });
    },
    now: () => adapterNow,
    ttlMs: 1
  });
  const working = staticAdapter({
    id: 'espn-nfl-injury',
    sourceType: 'espn',
    events: [newsEvent({ source: 'espn-nfl-injury', sourceType: 'espn' })]
  });
  const result = await runNewsSourceCycle({ adapters: [failed, working], scope: SCOPE, now: () => NOW });
  adapterNow = new Date(NOW.getTime() + 30_000);
  const cachedFailure = await runNewsSourceCycle({ adapters: [failed, working], scope: SCOPE, now: () => adapterNow });
  assert.equal(result.events.length, 1);
  assert.equal(result.sourceHealth.find((item) => item.source === failed.id)?.status, 'rate_limited');
  assert.equal(result.sourceHealth.find((item) => item.source === working.id)?.status, 'ok');
  assert.equal(cachedFailure.sourceHealth.find((item) => item.source === failed.id)?.fromCache, true);
  assert.equal(failedCalls, 1);
  assert.equal(JSON.stringify(result.sourceHealth).includes('unsafe upstream detail'), false);
});

test('official and non-official conflicts resolve deterministically regardless of input order', () => {
  const official = newsEvent({
    source: 'official-team-report', sourceType: 'official_team_report',
    trust: 'official_primary', trustLevel: 'official_primary', authorityPriority: 1,
    normalizedStatus: 'out', availabilityStatus: 'out', sourceReference: 'official-out'
  });
  const provider = newsEvent({
    source: 'sleeper', sourceType: 'sleeper', trust: 'existing_provider', trustLevel: 'existing_provider', authorityPriority: 5,
    normalizedStatus: 'questionable', availabilityStatus: 'questionable', sourceReference: 'provider-questionable'
  });
  const forward = reconcileNewsEvents([official, provider]);
  const reverse = reconcileNewsEvents([provider, official]);
  assert.deepEqual(reverse, forward);
  assert.equal(forward[0].normalizedStatus, 'out');
  assert.equal(forward[0].conflictStatus, 'resolved_by_authority');

  const splitOfficialReport = reconcileNewsEvents([newsEvent({
    source: 'official-team-report', sourceType: 'official_team_report',
    trust: 'official_primary', trustLevel: 'official_primary', authorityPriority: 1,
    normalizedStatus: 'questionable', availabilityStatus: 'questionable', practiceStatus: 'limited'
  })]);
  assert.equal(splitOfficialReport.find((event) => event.normalizedEventType === 'availability')?.authorityPriority, 1);
  assert.equal(splitOfficialReport.find((event) => event.normalizedEventType === 'practice')?.authorityPriority, 2);
});

test('an unresolved same-authority conflict is retained as conflicting_reports', async () => {
  const conflict = [
    newsEvent({
      source: 'official-nfl', sourceType: 'official_nfl', trust: 'official_primary', trustLevel: 'official_primary',
      authorityPriority: 1, normalizedStatus: 'out', availabilityStatus: 'out', sourceReference: 'official-out'
    }),
    newsEvent({
      source: 'official-team-report', sourceType: 'official_team_report', trust: 'official_primary', trustLevel: 'official_primary',
      authorityPriority: 1, normalizedStatus: 'questionable', availabilityStatus: 'questionable', sourceReference: 'official-questionable'
    })
  ];
  const result = await runCycle(conflict);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].normalizedStatus, 'conflicting_reports');
  assert.equal(result.events[0].conflictStatus, 'conflicting_reports');
  assert.equal(result.events[0].availabilityStatus, null);
  assert.deepEqual(result.observations, []);
});

test('duplicate reports produce only one actionable notice', async () => {
  const memory = memoryEvaluatorStore();
  const analysis = relevantAnalysis();
  await runCycle([newsEvent({ normalizedStatus: 'active', availabilityStatus: 'active' })], {
    analysis,
    evaluatorStore: memory.store
  });
  const officialOut = newsEvent({
    source: 'official-team-report', sourceType: 'official_team_report',
    trust: 'official_primary', trustLevel: 'official_primary', authorityPriority: 1,
    normalizedStatus: 'out', availabilityStatus: 'out', sourceReference: 'official-out'
  });
  const providerOut = newsEvent({
    source: 'espn-nfl-injury', sourceType: 'espn', trust: 'existing_provider', trustLevel: 'existing_provider', authorityPriority: 5,
    normalizedStatus: 'out', availabilityStatus: 'out', sourceReference: 'espn-out'
  });
  const result = await runCycle([officialOut, providerOut], {
    analysis,
    evaluatorStore: memory.store,
    now: () => new Date('2026-09-09T14:00:00.000Z')
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.observations.length, 1);
  assert.equal(result.evaluation.evaluations.length, 1);
  assert.equal(result.actionable.length, 1);
});

test('a source failure never becomes a false player status change', async () => {
  const memory = memoryEvaluatorStore();
  await runCycle([newsEvent({ normalizedStatus: 'questionable', availabilityStatus: 'questionable' })], {
    evaluatorStore: memory.store
  });
  const before = JSON.stringify(memory.state());
  const failed = staticAdapter({
    id: 'broken-official-nfl',
    sourceType: 'official_nfl',
    error: Object.assign(new Error('upstream unavailable'), { code: 'ECONNRESET' })
  });
  const result = await runNewsSourceCycle({
    adapters: [failed], scope: SCOPE, evaluatorStore: memory.store,
    now: () => new Date('2026-09-09T14:00:00.000Z')
  });
  assert.equal(result.sourceHealth[0].status, 'unavailable');
  assert.deepEqual(result.observations, []);
  assert.deepEqual(result.evaluation.evaluations, []);
  assert.deepEqual(result.actionable, []);
  assert.equal(JSON.stringify(memory.state()), before);
});

test('the existing exact recommendation filtering remains unchanged', async () => {
  const memory = memoryEvaluatorStore();
  const analysis = relevantAnalysis();
  await runCycle([newsEvent({ normalizedStatus: 'questionable', availabilityStatus: 'questionable' })], {
    analysis,
    evaluatorStore: memory.store
  });
  const result = await runCycle([newsEvent({
    normalizedStatus: 'doubtful', availabilityStatus: 'doubtful',
    publishedAt: NEXT_PUBLISHED_AT, observedAt: NEXT_PUBLISHED_AT
  })], { analysis, evaluatorStore: memory.store, now: () => new Date('2026-09-09T14:00:00.000Z') });
  const evaluation = result.evaluation.evaluations[0];
  assert.equal(evaluation.requires_reanalysis, true);
  assert.deepEqual(evaluation.affected_recommendation_types, [
    'lineup_confidence', 'player_availability', 'start_sit'
  ]);
  assert.equal(evaluation.affected_recommendation_types.includes('waiver_priority'), false);
});

test('the source cycle remains read-only and performs no fantasy transaction', async () => {
  const memory = memoryEvaluatorStore();
  const analysis = relevantAnalysis();
  let transactionCalls = 0;
  analysis.executeTransaction = () => { transactionCalls += 1; };
  await runCycle([newsEvent({ normalizedStatus: 'questionable', availabilityStatus: 'questionable' })], {
    analysis,
    evaluatorStore: memory.store
  });
  await runCycle([newsEvent({ normalizedStatus: 'out', availabilityStatus: 'out', publishedAt: NEXT_PUBLISHED_AT })], {
    analysis,
    evaluatorStore: memory.store,
    now: () => new Date('2026-09-09T14:00:00.000Z')
  });
  assert.equal(transactionCalls, 0);
  assert.deepEqual(analysis.safeguards, { readOnly: true, transactionsPerformed: false });
});

test('the source cycle leaves projection inputs and values unchanged', async () => {
  const roster = [{
    playerId: PLAYER_ID,
    name: 'Roster Player',
    position: 'RB',
    projection: 14,
    injuryStatus: 'Questionable'
  }];
  const options = { provenance: { source: 'test', retrievedAt: OBSERVED_AT }, now: NOW };
  const inputBefore = structuredClone(roster);
  const projectionsBefore = projectRoster(roster, options);
  const memory = memoryEvaluatorStore();
  await runCycle([newsEvent({ normalizedStatus: 'out', availabilityStatus: 'out' })], {
    analysis: relevantAnalysis(),
    evaluatorStore: memory.store
  });
  const projectionsAfter = projectRoster(roster, options);
  assert.deepEqual(projectionsAfter, projectionsBefore);
  assert.deepEqual(roster, inputBefore);
});
