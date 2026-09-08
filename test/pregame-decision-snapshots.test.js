import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRoster } from '../src/analytics/projections.js';
import {
  buildPregameDecisionCandidates,
  buildPregameSnapshotCandidates,
  createPregameSnapshotStore,
  safelyCapturePregameDecisionSnapshots,
  updatePregameSnapshotState
} from '../src/pregame-decision-snapshots.js';

const FIRST_CAPTURE = '2026-09-09T18:00:00.000Z';
const LATEST_CAPTURE = '2026-09-09T22:00:00.000Z';
const KICKOFF = '2026-09-10T00:20:00.000Z';

function snapshotInput({ leagueId = 'league-a', qbMedian = 19.4 } = {}) {
  const league = {
    id: leagueId,
    key: leagueId,
    platform: 'espn',
    season: 2026,
    currentWeek: 1,
    scoring: { rules: { passingYards: 0.04, passingTd: 4 } }
  };
  const roster = [
    { playerId: 'qb-1', name: 'Test Quarterback', position: 'QB', nflTeamId: 25, nflTeam: 'SF', injuryStatus: 'QUESTIONABLE', projection: 20 },
    { playerId: 'wr-1', name: 'Test Receiver', position: 'WR', nflTeamId: 25, nflTeam: 'SF', injuryStatus: null, projection: 14 },
    { playerId: 'k-1', name: 'Test Kicker', position: 'K', nflTeamId: 25, nflTeam: 'SF', projection: 8 },
    { playerId: 'rb-no-game', name: 'Bye Week Back', position: 'RB', nflTeamId: 6, nflTeam: 'DAL', projection: 12 }
  ];
  const nflContext = {
    games: [{
      id: 'game-1', kickoff: KICKOFF, indoor: false,
      teams: {
        home: { id: '25', name: 'San Francisco 49ers', abbreviation: 'SF' },
        away: { id: '14', name: 'Los Angeles Rams', abbreviation: 'LAR' }
      },
      venue: { id: 'venue-1', name: 'Test Stadium', indoor: false },
      odds: {
        provider: { id: '58', name: 'ESPN BET' }, details: 'SF -3.5', spread: -3.5, total: 47.5, favoriteTeamId: '25',
        lineSources: { spread: 'espn', total: 'espn' },
        primary: { source: 'espn', spread: -3.5, homeSpread: -3.5, total: 47.5 },
        secondary: { source: 'the-odds-api-v4', homeSpread: -3, total: 48, bookmakerCount: 4 },
        comparison: { status: 'confirmed' }
      }
    }]
  };
  const coachTracker = {
    offenses: [{
      team: { abbreviation: 'SF' },
      players: [{ playerId: 'qb-1' }, { playerId: 'wr-1' }],
      analysisPeriod: {
        tenureId: 'offense-period-1', startWeek: 1,
        basisRoles: [{ role: 'headCoach', tenureId: 'head-role-1' }, { role: 'offensiveCoordinator', tenureId: 'oc-role-1' }]
      },
      coachingContext: { tenure: { tenureId: 'head-period-1' } },
      teamTrend: { nflverse: { available: false, learning: true, season: 2026, window: { includedGames: 0 }, period: { tenureId: 'offense-period-1' }, dataVersion: 'pbp-v1', recentChange: { available: false } } }
    }]
  };
  const weatherContext = { games: [{ gameId: 'game-1', venue: { roofType: 'outdoor' }, flags: ['High wind', 'Rain'] }] };
  const nextGenContext = { players: [
    { requestedPlayerId: 'qb-1', status: 'Learning — no 2026 Next Gen Stats sample yet', learning: true, current: null, reference: { season: 2025, sample: { passing: { week: 0, basis: 'regular-season summary' } } } },
    { requestedPlayerId: 'wr-1', status: 'Learning — no 2026 Next Gen Stats sample yet', learning: true, current: null, reference: null }
  ] };
  const analysis = {
    league: { id: leagueId, key: leagueId, season: 2026, week: 1, platform: 'espn' },
    projections: [
      { playerId: 'qb-1', name: 'Test Quarterback', position: 'QB', available: true, median: qbMedian, floor: 14.2, ceiling: 27.8 },
      { playerId: 'wr-1', name: 'Test Receiver', position: 'WR', available: true, median: 13.1, floor: 7.4, ceiling: 22.6 },
      { playerId: 'k-1', name: 'Test Kicker', position: 'K', available: true, median: 7.8, floor: 5, ceiling: 11 },
      { playerId: 'rb-no-game', name: 'Bye Week Back', position: 'RB', available: true, median: 11.2, floor: 7, ceiling: 17 }
    ],
    lineup: { projectedGain: 0 },
    safeguards: { readOnly: true, transactionsPerformed: false },
    coachTracker,
    weatherContext,
    nextGenContext
  };
  return { analysis, league, roster, nflContext, coachTracker, weatherContext, nextGenContext };
}

function candidates(input = snapshotInput()) {
  return buildPregameSnapshotCandidates(input);
}

test('snapshot records are created only for matched roster-relevant players before kickoff', () => {
  const built = candidates();
  const result = updatePregameSnapshotState(null, built, { capturedAt: FIRST_CAPTURE });
  assert.equal(built.length, 2);
  assert.equal(result.created, 2);
  assert.equal(Object.keys(result.state.records).length, 2);
  const record = Object.values(result.state.records).find((value) => value.player_id === 'qb-1');
  assert.equal(record.season, 2026);
  assert.equal(record.week, 1);
  assert.equal(record.nfl_game_id, 'game-1');
  assert.equal(record.kickoff, KICKOFF);
  assert.equal(record.nfl_team, 'SF');
  assert.equal(record.opponent, 'LAR');
  assert.deepEqual(record.projection, { median: 19.4, floor: 14.2, ceiling: 27.8 });
  assert.equal(record.captured_at, FIRST_CAPTURE);
  assert.equal(record.first_capture_at, FIRST_CAPTURE);
  assert.equal(record.latest_capture_at, FIRST_CAPTURE);
  assert.equal('actual' in record, false);
});

test('a snapshot cannot be created at or after kickoff', () => {
  const built = candidates();
  const atKickoff = updatePregameSnapshotState(null, built, { capturedAt: KICKOFF });
  const afterKickoff = updatePregameSnapshotState(null, built, { capturedAt: '2026-09-10T00:21:00.000Z' });
  assert.equal(atKickoff.changed, false);
  assert.equal(afterKickoff.changed, false);
  assert.deepEqual(atKickoff.state.records, {});
  assert.deepEqual(afterKickoff.state.records, {});
});

test('an existing snapshot stays immutable after its stored kickoff', () => {
  const originalCandidate = candidates()[0];
  const original = updatePregameSnapshotState(null, [originalCandidate], { capturedAt: FIRST_CAPTURE });
  const rescheduled = {
    ...originalCandidate,
    kickoff: '2026-09-12T00:20:00.000Z',
    projection: { ...originalCandidate.projection, median: 20.1 }
  };
  const beforeOriginalKickoff = updatePregameSnapshotState(original.state, [rescheduled], { capturedAt: '2026-09-09T20:00:00.000Z' });
  const attempted = updatePregameSnapshotState(beforeOriginalKickoff.state, [{
    ...rescheduled,
    projection: { median: 99, floor: 98, ceiling: 100 }
  }], { capturedAt: '2026-09-10T00:21:00.000Z' });
  const record = Object.values(attempted.state.records)[0];
  assert.equal(beforeOriginalKickoff.changed, true);
  assert.equal(attempted.changed, false);
  assert.deepEqual(attempted.state, beforeOriginalKickoff.state);
  assert.equal(record.kickoff, '2026-09-12T00:20:00.000Z');
  assert.equal(record.lock_at, KICKOFF);
  assert.equal(record.projection.median, 20.1);
});

test('repeated pre-kickoff analysis updates one record and preserves its first capture', () => {
  const firstCandidate = candidates()[0];
  const first = updatePregameSnapshotState(null, [firstCandidate], { capturedAt: FIRST_CAPTURE });
  const newerCandidate = {
    ...firstCandidate,
    projection: { ...firstCandidate.projection, median: 21.3 },
    betting: { ...firstCandidate.betting, secondary_consensus_total: 49 }
  };
  const second = updatePregameSnapshotState(first.state, [newerCandidate], { capturedAt: LATEST_CAPTURE });
  const records = Object.values(second.state.records);
  assert.equal(records.length, 1);
  assert.equal(second.updated, 1);
  assert.equal(records[0].projection.median, 21.3);
  assert.equal(records[0].betting.secondary_consensus_total, 49);
  assert.equal(records[0].first_capture_at, FIRST_CAPTURE);
  assert.equal(records[0].latest_capture_at, LATEST_CAPTURE);
  assert.equal(records[0].captured_at, LATEST_CAPTURE);
});

test('the same player projection remains separate for each fantasy league', () => {
  const leagueA = candidates(snapshotInput({ leagueId: 'league-a', qbMedian: 19.4 }))[0];
  const leagueB = candidates(snapshotInput({ leagueId: 'league-b', qbMedian: 23.7 }))[0];
  const result = updatePregameSnapshotState(null, [leagueA, leagueB], { capturedAt: FIRST_CAPTURE });
  const records = Object.values(result.state.records);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.fantasy_league_id).sort(), ['league-a', 'league-b']);
  assert.deepEqual(records.map((record) => record.projection.median).sort((a, b) => a - b), [19.4, 23.7]);
});

test('betting context is stored exactly as it existed before kickoff', () => {
  const record = candidates()[0];
  assert.deepEqual(record.betting, {
    primary_total: 47.5,
    primary_home_spread: -3.5,
    primary_source: 'espn',
    secondary_consensus_total: 48,
    secondary_home_spread: -3,
    secondary_source: 'the-odds-api-v4',
    bookmaker_count: 4,
    provider_comparison_status: 'confirmed',
    spread_orientation: 'home_team'
  });
});

test('probability definitions are locked beside projections without changing projection values', () => {
  const input = snapshotInput();
  Object.assign(input.analysis.projections[0], {
    mean: 20,
    bustProbability: 0.18,
    spikeProbability: 0.22,
    thresholdProbabilities: [{ threshold: 20, probability: 0.48 }]
  });
  const record = candidates(input)[0];
  assert.deepEqual(record.projection, { median: 19.4, floor: 14.2, ceiling: 27.8 });
  assert.deepEqual(record.prediction, {
    mean: 20,
    bust_probability: 0.18,
    spike_probability: 0.22,
    bust_threshold: 12,
    spike_threshold: 28,
    threshold_probabilities: [{ threshold: 20, probability: 0.48 }],
    definition_version: 'range-heuristic-v1'
  });
});

test('pregame lineup decisions reuse player snapshots and do not infer the user final starter', () => {
  const input = snapshotInput();
  input.analysis.lineup = {
    objective: 'median',
    minimumGain: 0.8,
    expectedGain: 6.3,
    recommendations: [{
      start: { playerId: 'qb-1' },
      sit: { playerId: 'wr-1' },
      targetSlotId: 'flex-1',
      expectedGain: 6.3,
      probabilityStartOutscoresSit: 0.72,
      confidence: { level: 'medium' }
    }]
  };
  input.analysis.recommendationQuality = {
    comparisons: [{
      recommendedPlayer: { playerId: 'qb-1' },
      alternativePlayer: { playerId: 'wr-1' },
      confidence: 'Moderate',
      supportClassification: 'supported'
    }]
  };
  const records = candidates(input);
  const decisions = buildPregameDecisionCandidates(input, records);
  const result = updatePregameSnapshotState(null, { records, decisions }, { capturedAt: FIRST_CAPTURE });
  const decision = Object.values(result.state.decisions)[0];

  assert.equal(result.decisionsCreated, 1);
  assert.equal(decision.type, 'start_sit');
  assert.equal(decision.recommended_player_record_id, records.find((record) => record.player_id === 'qb-1').record_id);
  assert.equal(decision.alternative_player_record_id, records.find((record) => record.player_id === 'wr-1').record_id);
  assert.equal(decision.actual_user_started_player_id, null);
  assert.equal(decision.probability_recommended_outscores, 0.72);
  assert.equal(decision.confidence_label, 'Moderate');
  assert.equal(decision.lock_at, KICKOFF);
});

test('credentials and provider payload metadata are excluded by the storage allowlist', () => {
  const secret = 'NEVER_STORE_THIS_SECRET';
  const input = snapshotInput();
  input.analysis.apiKey = secret;
  input.analysis.authorization = `Bearer ${secret}`;
  input.league.cookies = secret;
  input.roster[0].privateCredential = secret;
  input.nflContext.games[0].odds.apiKey = secret;
  input.nflContext.games[0].odds.quota = { secret, requestsRemaining: 10 };
  input.weatherContext.games[0].authorization = secret;
  const result = updatePregameSnapshotState(null, candidates(input), { capturedAt: FIRST_CAPTURE });
  const serialized = JSON.stringify(result.state);
  assert.equal(serialized.includes(secret), false);
  assert.equal(/apiKey|cookies|authorization|quota/i.test(serialized), false);
});

test('a storage failure is swallowed and cannot break or expose details from analysis', async () => {
  const secret = 'SECRET_ERROR_DETAIL';
  const input = snapshotInput();
  const originalAnalysis = structuredClone(input.analysis);
  const warnings = [];
  const store = createPregameSnapshotStore({
    read: async () => null,
    write: async () => { throw Object.assign(new Error(`disk failed: ${secret}`), { code: 'EACCES' }); },
    now: () => new Date(FIRST_CAPTURE)
  });
  const result = await safelyCapturePregameDecisionSnapshots(input, { store, warn: (message) => warnings.push(message) });
  assert.equal(result.stored, false);
  assert.equal(result.error, 'snapshot_storage_unavailable');
  assert.deepEqual(input.analysis, originalAnalysis);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /EACCES/);
  assert.equal(warnings[0].includes(secret), false);
});

test('capturing snapshots does not change any projection values', async () => {
  const input = snapshotInput();
  const rosterBefore = structuredClone(input.roster);
  const projectionOptions = { provenance: { source: 'test', retrievedAt: FIRST_CAPTURE }, now: new Date(FIRST_CAPTURE) };
  const before = projectRoster(input.roster, projectionOptions);
  let state = null;
  const store = createPregameSnapshotStore({ read: async () => state, write: async (next) => { state = next; }, now: () => new Date(FIRST_CAPTURE) });
  await safelyCapturePregameDecisionSnapshots(input, { store, warn: () => {} });
  const after = projectRoster(input.roster, projectionOptions);
  assert.deepEqual(after, before);
  assert.deepEqual(input.roster, rosterBefore);
});

test('read-only fantasy safeguards remain intact after a successful capture', async () => {
  const input = snapshotInput();
  const originalAnalysis = structuredClone(input.analysis);
  let state = null;
  const store = createPregameSnapshotStore({ read: async () => state, write: async (next) => { state = next; }, now: () => new Date(FIRST_CAPTURE) });
  const result = await safelyCapturePregameDecisionSnapshots(input, { store, warn: () => {} });
  assert.equal(result.stored, true);
  assert.deepEqual(input.analysis, originalAnalysis);
  assert.deepEqual(input.analysis.safeguards, { readOnly: true, transactionsPerformed: false });
});
