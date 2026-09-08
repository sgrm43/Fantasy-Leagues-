import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildEspnNflScoreboardUrl,
  fetchNflScoreboardContext,
  normalizeNflScoreboard
} from '../src/providers/espn-nfl-scoreboard.js';

const fixture = JSON.parse(await readFile(
  new URL('./fixtures/espn-nfl-scoreboard.json', import.meta.url),
  'utf8'
));

test('scoreboard URL includes the requested season and week', () => {
  const url = new URL(buildEspnNflScoreboardUrl({ season: 2026, week: 7 }));
  assert.equal(url.origin, 'https://site.api.espn.com');
  assert.equal(url.searchParams.get('dates'), '2026');
  assert.equal(url.searchParams.get('seasontype'), '2');
  assert.equal(url.searchParams.get('week'), '7');
});

test('normalizer preserves available teams, kickoff, venue, weather and odds', () => {
  const result = normalizeNflScoreboard(fixture, {
    season: 2026,
    week: 7,
    sourceUrl: 'https://site.api.espn.com/test-scoreboard',
    retrievedAt: '2026-10-18T12:00:00Z',
    now: '2026-10-18T12:05:00Z'
  });
  const game = result.games[0];

  assert.equal(result.stale, false);
  assert.equal(game.teams.away.name, 'Seattle Seahawks');
  assert.equal(game.teams.home.abbreviation, 'SF');
  assert.equal(game.kickoff, '2026-10-18T20:25:00.000Z');
  assert.deepEqual(game.venue, {
    id: '4738',
    name: "Levi's Stadium",
    city: 'Santa Clara',
    state: 'CA',
    country: 'USA',
    indoor: false
  });
  assert.equal(game.indoor, false);
  assert.equal(game.weather.temperatureF, 68);
  assert.equal(game.weather.summary, '68 degrees, partly cloudy');
  assert.equal(game.odds.spread, -3.5);
  assert.equal(game.odds.total, 47.5);
  assert.equal(game.odds.favoriteTeamId, '25');
  assert.equal(game.sourceUrl, result.sourceUrl);
  assert.deepEqual(game.missing, []);
});

test('unavailable context stays null and is reported instead of being invented', () => {
  const result = normalizeNflScoreboard(fixture, {
    season: 2026,
    week: 7,
    retrievedAt: '2026-10-18T12:00:00Z',
    now: '2026-10-18T12:05:00Z'
  });
  const game = result.games[1];

  assert.equal(game.indoor, null);
  assert.equal(game.weather, null);
  assert.equal(game.odds, null);
  assert.ok(game.missing.includes('venue.indoor'));
  assert.ok(game.missing.includes('weather'));
  assert.ok(game.missing.includes('odds'));
  assert.ok(game.issues.some((issue) => issue.code === 'weather_unavailable'));
  assert.ok(result.missing.includes('games.401772902.weather'));
  assert.ok(result.issues.some((issue) => issue.gameId === '401772902' && issue.code === 'odds_unavailable'));
});

test('stale indicator is derived from retrieval age', () => {
  const result = normalizeNflScoreboard({ season: { year: 2026 }, week: { number: 7 }, events: [] }, {
    retrievedAt: '2026-10-18T12:00:00Z',
    now: '2026-10-18T12:16:00Z'
  });
  assert.equal(result.stale, true);
});

test('invalid timestamps and missing metadata remain null and are flagged', () => {
  const result = normalizeNflScoreboard({ events: [{ competitions: [{}] }] }, {
    season: null,
    week: null,
    sourceUrl: '',
    retrievedAt: null,
    now: '2026-10-18T12:00:00Z'
  });

  assert.equal(result.season, null);
  assert.equal(result.week, null);
  assert.equal(result.retrievedAt, null);
  assert.equal(result.stale, true);
  assert.equal(result.games[0].kickoff, null);
  assert.ok(result.missing.includes('season'));
  assert.ok(result.missing.includes('games.unknown.kickoff'));
});

test('fetcher supports injected fetch and performs no extra requests', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => fixture };
  };

  const result = await fetchNflScoreboardContext({
    season: 2026,
    week: 7,
    fetchImpl,
    now: () => new Date('2026-10-18T12:00:00Z')
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /dates=2026/);
  assert.match(calls[0].url, /week=7/);
  assert.equal(calls[0].options.headers.Accept, 'application/json');
  assert.equal(result.games.length, 2);
  assert.equal(result.retrievedAt, '2026-10-18T12:00:00.000Z');
  assert.equal(result.stale, false);
});

test('fetcher surfaces HTTP failures with source metadata', async () => {
  await assert.rejects(
    fetchNflScoreboardContext({
      season: 2026,
      week: 7,
      fetchImpl: async () => ({ ok: false, status: 503 })
    }),
    (error) => error.code === 'ESPN_NFL_SCOREBOARD_HTTP'
      && error.status === 503
      && error.sourceUrl.includes('week=7')
  );
});
