import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createNflverseTeamTendencyProvider, normalizeNflversePbpCsv, summarizeNflverseTeamTendencies } from '../src/providers/nflverse-team-tendencies.js';

const HEADER = ['game_id', 'game_date', 'season_type', 'week', 'posteam', 'play_id', 'drive', 'qtr', 'down', 'yardline_100', 'game_seconds_remaining', 'play_type', 'qb_dropback', 'rush_attempt', 'qb_kneel', 'qb_spike', 'two_point_attempt', 'vegas_wp', 'wp'];

function fixtureCsv() {
  const rows = [HEADER];
  addTeamGame(rows, { gameId: '2026_01_LAR_SF', date: '2026-09-10', week: 1, team: 'SF', drive: 1, firstPlayId: 1, passes: 6 });
  addTeamGame(rows, { gameId: '2026_01_LAR_SF', date: '2026-09-10', week: 1, team: 'LA', drive: 2, firstPlayId: 101, passes: 4 });
  addTeamGame(rows, { gameId: '2026_02_SF_LAR', date: '2026-09-17', week: 2, team: 'SF', drive: 1, firstPlayId: 1, passes: 8 });
  addTeamGame(rows, { gameId: '2026_02_SF_LAR', date: '2026-09-17', week: 2, team: 'LA', drive: 2, firstPlayId: 101, passes: 5 });
  return rows.map((row) => row.join(',')).join('\n');
}

function addTeamGame(rows, { gameId, date, week, team, drive, firstPlayId, passes }) {
  for (let index = 0; index < 10; index += 1) {
    const dropback = index < passes ? 1 : 0;
    rows.push([gameId, date, 'REG', week, team, firstPlayId + index, drive, 3, index % 3 + 1, index >= 6 ? 15 : 50, 1800 - index * 25, dropback ? 'pass' : 'run', dropback, dropback ? 0 : 1, 0, 0, 0, 0.5, 0.5]);
  }
}

test('nflverse CSV is parsed into compact team-game tendency counts', async () => {
  const dataset = await normalizeNflversePbpCsv(fixtureCsv(), { season: 2026, sourceUrl: 'fixture', retrievedAt: '2026-09-18T12:00:00Z', dataVersion: 'v1' });
  const game = dataset.games.find((item) => item.team === 'SF' && item.week === 1);
  assert.equal(dataset.games.length, 4);
  assert.equal(game.plays, 10);
  assert.equal(game.dropbacks, 6);
  assert.equal(game.rushes, 4);
  assert.equal(game.redZone.plays, 4);
  assert.equal(game.pace.intervals, 9);
});

test('only requested teams and games inside the verified period are returned', async () => {
  const dataset = await normalizeNflversePbpCsv(fixtureCsv(), { season: 2026, retrievedAt: '2026-09-18T12:00:00Z', dataVersion: 'v1' });
  const result = summarizeNflverseTeamTendencies(dataset, { season: 2026, currentWeek: 3, teams: ['SF'], periods: { SF: { startWeek: 2, firstSeenAt: '2026-09-15T12:00:00Z' } } });
  assert.deepEqual(result.teams.map((team) => team.team), ['SF']);
  assert.equal(result.teams[0].window.includedGames, 1);
  assert.equal(result.teams[0].metrics.overallPassRate.value, 0.8);
  assert.equal(result.teams[0].metrics.overallRunRate.value, 0.2);
});

test('tendency labels and weekly changes are deterministic', async () => {
  const dataset = await normalizeNflversePbpCsv(fixtureCsv(), { season: 2026, retrievedAt: '2026-09-18T12:00:00Z', dataVersion: 'v1' });
  const options = { season: 2026, currentWeek: 3, teams: ['SF'], periods: { SF: { startWeek: 1, firstSeenAt: '2026-09-01T12:00:00Z' } } };
  const first = summarizeNflverseTeamTendencies(dataset, options);
  const second = summarizeNflverseTeamTendencies(dataset, options);
  assert.deepEqual(first, second);
  assert.equal(first.teams[0].metrics.neutralPassRate.label, 'Pass-heavy in neutral situations');
  assert.equal(first.teams[0].recentChange.label, 'Passing more in the latest week');
});

test('one downloaded nflverse dataset is reused for different roster teams', async () => {
  let calls = 0;
  const provider = createNflverseTeamTendencyProvider({
    now: () => new Date('2026-09-18T12:00:00Z'),
    fetchImpl: async () => { calls += 1; return new Response(gzipSync(fixtureCsv()), { status: 200, headers: { etag: 'fixture-v1' } }); }
  });
  const sf = await provider.fetch({ season: 2026, currentWeek: 3, teams: ['SF'] });
  const lar = await provider.fetch({ season: 2026, currentWeek: 3, teams: ['LAR'] });
  assert.equal(calls, 1);
  assert.deepEqual(sf.teams.map((team) => team.team), ['SF']);
  assert.deepEqual(lar.teams.map((team) => team.team), ['LAR']);
  assert.equal(lar.cache.status, 'memory_hit');
});
