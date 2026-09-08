import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRoster } from '../src/analytics/projections.js';
import { extractEspnWeekResults } from '../src/adapters/espn.js';
import { extractSleeperWeekResults } from '../src/adapters/sleeper.js';
import { attachCompletedPostgameResults } from '../src/postgame-result-service.js';
import { createPregameSnapshotStore, scoringFingerprint } from '../src/pregame-decision-snapshots.js';

const CAPTURED_AT = '2026-09-09T18:00:00.000Z';
const KICKOFF = '2026-09-10T00:20:00.000Z';
const COMPLETED_AT = '2026-09-10T04:02:00.000Z';
const ATTACHED_AT = '2026-09-10T04:05:00.000Z';

function league({ id = 'league-a', platform = 'espn', rules = { passingYards: 0.04, passingTd: 4 } } = {}) {
  return { id, key: id, name: id, platform, season: 2026, currentWeek: 1, scoring: { rules } };
}

function snapshotRecord({
  leagueData = league(),
  playerId = `${leagueData.platform}:101`,
  gameId = 'game-1',
  projection = { median: 19.4, floor: 14.2, ceiling: 27.8 }
} = {}) {
  const recordId = [2026, 1, gameId, playerId, leagueData.id].map((value) => encodeURIComponent(String(value))).join('|');
  return {
    record_id: recordId,
    season: 2026,
    week: 1,
    nfl_game_id: gameId,
    kickoff: KICKOFF,
    player_id: playerId,
    player_name: 'Test Player',
    nfl_team: 'SF',
    opponent: 'LAR',
    position: 'QB',
    fantasy_league_id: leagueData.id,
    scoring_settings_id: scoringFingerprint(leagueData),
    projection,
    betting: { primary_total: 47.5, spread_orientation: 'home_team' },
    context: { injury_status: null, venue_type: 'outdoor' },
    lock_at: KICKOFF,
    captured_at: CAPTURED_AT,
    first_capture_at: CAPTURED_AT,
    latest_capture_at: CAPTURED_AT
  };
}

function memoryHarness(records, initialClock = ATTACHED_AT) {
  let state = {
    version: 1,
    updated_at: CAPTURED_AT,
    records: Object.fromEntries(records.map((record) => [record.record_id, record]))
  };
  let writes = 0;
  let clock = initialClock;
  const read = async () => state;
  const store = createPregameSnapshotStore({
    read,
    write: async (next) => { state = next; writes += 1; },
    now: () => new Date(clock)
  });
  return {
    read,
    store,
    state: () => state,
    writes: () => writes,
    setClock: (value) => { clock = value; }
  };
}

function finalContext({ completed = true, completedAt = COMPLETED_AT, gameId = 'game-1' } = {}) {
  return { season: 2026, week: 1, games: [{ id: gameId, status: { completed, completedAt } }] };
}

function processorOptions(harness, leagues, {
  context = finalContext(),
  resultFetcher = async ({ definition }) => ({
    results: [{ player_id: `${definition.platform}:101`, actual_fantasy_points: 18.4 }]
  }),
  warn = () => {}
} = {}) {
  const byKey = new Map(leagues.map((value) => [value.key, value]));
  return {
    snapshotReader: harness.read,
    leagueReader: async (key) => ({ data: byKey.get(key) }),
    leagueDefinitions: leagues.map((value) => ({ key: value.key, id: value.id, platform: value.platform })),
    gameContextFetcher: async () => context,
    leagueResultFetcher: resultFetcher,
    store: harness.store,
    warn
  };
}

test('a confirmed final game attaches a compact actual fantasy result', async () => {
  const leagueData = league();
  const record = snapshotRecord({ leagueData });
  const harness = memoryHarness([record]);
  const summary = await attachCompletedPostgameResults(processorOptions(harness, [leagueData]));
  const result = harness.state().records[record.record_id].result;

  assert.equal(summary.attached, 1);
  assert.deepEqual(result, {
    status: 'attached',
    actual_fantasy_points: 18.4,
    nfl_game_status: 'final',
    source: 'espn-fantasy-applied-total',
    completed_at: COMPLETED_AT,
    attached_at: ATTACHED_AT
  });
});

test('scheduled, delayed, in-progress, halftime, postponed, and unknown games stay untouched', async () => {
  for (const status of ['scheduled', 'delayed', 'in-progress', 'halftime', 'postponed', 'unknown']) {
    const leagueData = league();
    const record = snapshotRecord({ leagueData });
    const harness = memoryHarness([record]);
    const context = { season: 2026, week: 1, games: [{ id: 'game-1', status: { completed: status === 'unknown' ? null : false, state: status } }] };
    const summary = await attachCompletedPostgameResults(processorOptions(harness, [leagueData], { context }));
    assert.equal(summary.non_final, 1, status);
    assert.equal('result' in harness.state().records[record.record_id], false, status);
    assert.equal(harness.writes(), 0, status);
  }
});

test('attaching a result leaves every locked pregame field logically unchanged', async () => {
  const leagueData = league();
  const record = snapshotRecord({ leagueData });
  const before = JSON.stringify(record);
  const harness = memoryHarness([record]);
  await attachCompletedPostgameResults(processorOptions(harness, [leagueData]));
  const after = structuredClone(harness.state().records[record.record_id]);
  delete after.result;
  assert.equal(JSON.stringify(after), before);
});

test('the same NFL player receives each fantasy league own provider-scored actual', async () => {
  const leagueA = league({ id: 'league-a', rules: { passingTd: 4 } });
  const leagueB = league({ id: 'league-b', rules: { passingTd: 6 } });
  const recordA = snapshotRecord({ leagueData: leagueA });
  const recordB = snapshotRecord({ leagueData: leagueB });
  const harness = memoryHarness([recordA, recordB]);
  const totals = { 'league-a': 18.4, 'league-b': 22.9 };
  const resultFetcher = async ({ definition }) => ({
    results: [{ player_id: 'espn:101', actual_fantasy_points: totals[definition.id] }]
  });

  const summary = await attachCompletedPostgameResults(processorOptions(harness, [leagueA, leagueB], { resultFetcher }));
  assert.equal(summary.attached, 2);
  assert.equal(harness.state().records[recordA.record_id].result.actual_fantasy_points, 18.4);
  assert.equal(harness.state().records[recordB.record_id].result.actual_fantasy_points, 22.9);
});

test('existing provider-scored fields are used exactly and missing fields are not assumed to be zero', () => {
  const espn = extractEspnWeekResults({ teams: [{ roster: { entries: [{
    playerId: 101,
    playerPoolEntry: { player: { id: 101, stats: [{ scoringPeriodId: 1, statSourceId: 0, appliedTotal: 18.37 }] } }
  }] } }] }, 1);
  const sleeper = extractSleeperWeekResults([{ players_points: { 101: 22.9, 102: null, 103: 0 } }]);
  assert.deepEqual(espn, [{ player_id: 'espn:101', actual_fantasy_points: 18.37 }]);
  assert.deepEqual(sleeper, [
    { player_id: 'sleeper:101', actual_fantasy_points: 22.9 },
    { player_id: 'sleeper:103', actual_fantasy_points: 0 }
  ]);
});

test('duplicate or conflicting processing cannot rewrite a valid attached result', async () => {
  const leagueData = league();
  const record = snapshotRecord({ leagueData });
  const harness = memoryHarness([record]);
  let fetches = 0;
  const resultFetcher = async () => {
    fetches += 1;
    return { results: [{ player_id: 'espn:101', actual_fantasy_points: fetches === 1 ? 18.4 : 99 }] };
  };
  const options = processorOptions(harness, [leagueData], { resultFetcher });
  await attachCompletedPostgameResults(options);
  const afterFirst = JSON.stringify(harness.state());
  harness.setClock('2026-09-10T05:00:00.000Z');
  const second = await attachCompletedPostgameResults(options);

  assert.equal(second.already_attached, 1);
  assert.equal(fetches, 1);
  assert.equal(harness.writes(), 1);
  assert.equal(JSON.stringify(harness.state()), afterFirst);
});

test('ambiguous duplicate stable player IDs are returned unmatched and never guessed', async () => {
  const leagueData = league();
  const record = snapshotRecord({ leagueData });
  const harness = memoryHarness([record]);
  const resultFetcher = async () => ({ results: [
    { player_id: 'espn:101', actual_fantasy_points: 18.4 },
    { player_id: 'espn:101', actual_fantasy_points: 22.9 }
  ] });
  const summary = await attachCompletedPostgameResults(processorOptions(harness, [leagueData], { resultFetcher }));
  assert.equal(summary.unmatched, 1);
  assert.equal('result' in harness.state().records[record.record_id], false);
  assert.equal(harness.writes(), 0);
});

test('provider failure leaves the snapshot intact and logs no provider error details', async () => {
  const secret = 'SECRET_PROVIDER_DETAIL';
  const leagueData = league();
  const record = snapshotRecord({ leagueData });
  const harness = memoryHarness([record]);
  const before = JSON.stringify(harness.state());
  const warnings = [];
  const resultFetcher = async () => { throw Object.assign(new Error(secret), { code: 'UPSTREAM_FAILED' }); };
  const summary = await attachCompletedPostgameResults(processorOptions(harness, [leagueData], {
    resultFetcher,
    warn: (message) => warnings.push(message)
  }));
  assert.equal(summary.provider_failures, 1);
  assert.equal(JSON.stringify(harness.state()), before);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /UPSTREAM_FAILED/);
  assert.equal(warnings[0].includes(secret), false);
});

test('result attachment stores no credentials, authorization values, or untrusted result metadata', async () => {
  const secret = 'NEVER_STORE_THIS_SECRET';
  const leagueData = league();
  const record = snapshotRecord({ leagueData });
  const harness = memoryHarness([record]);
  const options = processorOptions(harness, [leagueData], {
    resultFetcher: async () => ({
      source: secret,
      authorization: `Bearer ${secret}`,
      results: [{ player_id: 'espn:101', actual_fantasy_points: 18.4, cookie: secret, api_key: secret }]
    })
  });
  options.credentials = { s2: secret, swid: secret, authorization: secret };
  await attachCompletedPostgameResults(options);
  const serialized = JSON.stringify(harness.state());
  assert.equal(serialized.includes(secret), false);
  assert.equal(/authorization|cookie|api_key/i.test(serialized), false);
});

test('postgame attachment does not change projection values or formulas', async () => {
  const leagueData = league();
  const record = snapshotRecord({ leagueData });
  const harness = memoryHarness([record]);
  const roster = [{ playerId: 'espn:101', name: 'Test QB', position: 'QB', nflTeam: 'SF', projection: 20 }];
  const projectionOptions = { provenance: { source: 'test', retrievedAt: CAPTURED_AT }, now: new Date(CAPTURED_AT) };
  const before = projectRoster(roster, projectionOptions);
  await attachCompletedPostgameResults(processorOptions(harness, [leagueData]));
  const after = projectRoster(roster, projectionOptions);
  assert.deepEqual(after, before);
  assert.deepEqual(harness.state().records[record.record_id].projection, record.projection);
});

test('postgame attachment remains read-only and never invokes a fantasy transaction', async () => {
  const leagueData = league();
  const record = snapshotRecord({ leagueData });
  const harness = memoryHarness([record]);
  const safeguards = { readOnly: true, transactionsPerformed: false };
  let transactionCalls = 0;
  const options = processorOptions(harness, [leagueData]);
  options.safeguards = safeguards;
  options.executeTransaction = () => { transactionCalls += 1; };
  await attachCompletedPostgameResults(options);
  assert.deepEqual(safeguards, { readOnly: true, transactionsPerformed: false });
  assert.equal(transactionCalls, 0);
});
