import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SLEEPER_PLAYER_CATALOG_ENDPOINT,
  buildSleeperWeeklyStatsUrl,
  createSleeperHistoricalUsageProvider,
  fetchSleeperHistoricalUsage,
  normalizeSleeperGameLog,
  normalizeSleeperHistoricalUsage,
  resolveSleeperPlayers,
  summarizeSleeperUsage
} from '../src/providers/sleeper-historical-usage.js';

const fixture = JSON.parse(await readFile(
  new URL('./fixtures/sleeper-historical-usage.json', import.meta.url),
  'utf8'
));

test('weekly stats URL uses Sleeper public regular-season endpoint', () => {
  assert.equal(
    buildSleeperWeeklyStatsUrl({ season: 2026, week: 4 }),
    'https://api.sleeper.com/stats/nfl/2026/4?season_type=regular'
  );
});

test('player resolution uses Sleeper IDs or exact catalog ESPN IDs, never names', () => {
  const result = resolveSleeperPlayers([
    { playerId: 'sleeper:s1', platformPlayerId: 's1', name: 'Wrong Name Does Not Matter' },
    { playerId: 'espn:1002', platformPlayerId: '1002', name: 'Also Wrong' },
    { playerId: 'espn:9999', name: 'Name Only' },
    { playerId: 'unknown', name: 'Name Only' }
  ], fixture.catalog);

  assert.deepEqual(result.players.map((player) => player.platformPlayerId), ['s1', 's2']);
  assert.equal(result.players[1].resolvedBy, 'catalog_espn_id');
  assert.equal(result.players[1].gsisId, '00-0001002');
  assert.equal(result.players[1].name, 'Bravo Passer');
  assert.deepEqual(result.unresolved.map((player) => player.reason), [
    'espn_id_not_found',
    'durable_id_unavailable'
  ]);
});

test('an unqualified platformPlayerId is accepted as a Sleeper durable ID', () => {
  const result = resolveSleeperPlayers([{ platformPlayerId: 's1' }], fixture.catalog);
  assert.equal(result.players[0].platformPlayerId, 's1');
  assert.equal(result.players[0].resolvedBy, 'sleeper_player_id');
});

test('game-log normalizer preserves source usage and derives snap share only from supplied snaps', () => {
  const log = normalizeSleeperGameLog(fixture.weeks['3'][0], {
    season: 2026,
    week: 3,
    source: { url: 'https://api.sleeper.com/week-3', retrievedAt: '2026-09-29T12:00:00Z', stale: false }
  });

  assert.equal(log.snaps, 30);
  assert.equal(log.teamOffensiveSnaps, 60);
  assert.equal(log.snapShare, 0.5);
  assert.deepEqual(log.derived, ['snapShare']);
  assert.equal(log.targets, 3);
  assert.equal(log.receptions, 2);
  assert.equal(log.carries, 10);
  assert.equal(log.redZoneTargets, 1);
  assert.equal(log.redZoneCarries, 2);
  assert.equal(log.routes, null);
  assert.equal(log.fantasyPoints, 8);
  assert.equal(log.fantasyPointsFormat, 'ppr');
  assert.ok(log.missing.includes('routes'));
  assert.equal(log.source, 'https://api.sleeper.com/week-3');
});

test('historical normalizer returns selected players only and recency-weighted trends', () => {
  const result = normalizeSleeperHistoricalUsage({
    season: 2026,
    weeks: [3, 4, 5],
    players: [
      { playerId: 'sleeper:s1', platformPlayerId: 's1' },
      { playerId: 'espn:1002', platformPlayerId: '1002' }
    ],
    catalog: fixture.catalog,
    weeklyStats: { ...fixture.weeks, 5: [] },
    retrievedAt: '2026-10-06T12:00:00Z',
    now: '2026-10-06T12:05:00Z',
    recencyDecay: 0.5
  });
  const runner = result.players[0];

  assert.equal(result.players.length, 2);
  assert.deepEqual(runner.gameLogs.map((log) => log.week), [3, 4]);
  assert.deepEqual(runner.missingWeeks, [5]);
  assert.equal(runner.summary.sampleSize, 2);
  assert.equal(runner.summary.opportunity.targets.sampleSize, 2);
  assert.equal(runner.summary.opportunity.targets.weightedAverage, 5);
  assert.equal(runner.summary.opportunity.targets.changePerWeek, 3);
  assert.equal(runner.summary.opportunity.targets.direction, 'increasing');
  assert.equal(runner.summary.opportunity.routes.sampleSize, 1);
  assert.equal(runner.summary.opportunity.routes.direction, 'unavailable');
  assert.equal(runner.summary.trend.direction, 'increasing');
  assert.ok(runner.missing.includes('weeks.5.stats'));
  assert.ok(result.missing.includes('players.sleeper:s1.weeks.5.stats'));
  assert.equal(result.stale, false);
});

test('unavailable retrieval metadata is explicit and marked stale', () => {
  const result = normalizeSleeperHistoricalUsage({
    season: 2026,
    weeks: [3],
    players: [{ playerId: 'sleeper:s1' }],
    catalog: fixture.catalog,
    weeklyStats: { 3: fixture.weeks['3'] },
    retrievedAt: null,
    now: '2026-10-01T00:00:00Z'
  });

  assert.equal(result.retrievedAt, null);
  assert.equal(result.stale, true);
  assert.ok(result.missing.includes('sources.catalog.retrievedAt'));
  assert.ok(result.missing.includes('sources.weeklyStats.3.retrievedAt'));
  assert.ok(result.players[0].gameLogs[0].missing.includes('retrievedAt'));
});

test('missing values do not become zeroes in summaries', () => {
  const summary = summarizeSleeperUsage([
    { week: 1, targets: 4, routes: null },
    { week: 2, targets: null, routes: null },
    { week: 3, targets: 8, routes: null }
  ], { recencyDecay: 1 });

  assert.equal(summary.sampleSize, 3);
  assert.equal(summary.opportunity.targets.sampleSize, 2);
  assert.equal(summary.opportunity.targets.weightedAverage, 6);
  assert.equal(summary.opportunity.routes.sampleSize, 0);
  assert.equal(summary.opportunity.routes.weightedAverage, null);
  assert.equal(summary.opportunity.routes.direction, 'unavailable');
});

test('fetcher uses injected fetch, requested weeks, and records retrieval metadata', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === SLEEPER_PLAYER_CATALOG_ENDPOINT) {
      return { ok: true, status: 200, json: async () => fixture.catalog };
    }
    const week = /\/([0-9]+)\?/.exec(url)?.[1];
    return { ok: true, status: 200, json: async () => fixture.weeks[week] };
  };
  const result = await fetchSleeperHistoricalUsage({
    season: 2026,
    weeks: [3, 4],
    players: [{ playerId: 'espn:1001', platformPlayerId: '1001' }],
    fetchImpl,
    now: () => new Date('2026-10-06T12:00:00Z')
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, SLEEPER_PLAYER_CATALOG_ENDPOINT);
  assert.ok(calls.some((call) => call.url.endsWith('/2026/3?season_type=regular')));
  assert.ok(calls.some((call) => call.url.endsWith('/2026/4?season_type=regular')));
  assert.ok(calls.every((call) => call.options.headers.Accept === 'application/json'));
  assert.equal(result.players[0].platformPlayerId, 's1');
  assert.equal(result.players[0].gameLogs.length, 2);
  assert.equal(result.retrievedAt, '2026-10-06T12:00:00.000Z');
  assert.equal(result.stale, false);
});

test('provider memory cache avoids repeated catalog and weekly requests', async () => {
  let callCount = 0;
  const provider = createSleeperHistoricalUsageProvider({
    fetchImpl: async (url) => {
      callCount += 1;
      if (url === SLEEPER_PLAYER_CATALOG_ENDPOINT) return { ok: true, json: async () => fixture.catalog };
      return { ok: true, json: async () => fixture.weeks['3'] };
    },
    now: () => new Date('2026-09-29T12:00:00Z')
  });
  const input = { season: 2026, weeks: [3], players: [{ playerId: 'sleeper:s1' }] };

  await provider.fetch(input);
  await provider.fetch(input);

  assert.equal(callCount, 2);
  assert.equal(provider.cacheSize, 2);
  provider.clearCache();
  assert.equal(provider.cacheSize, 0);
});

test('fetcher reports HTTP failures with status and source URL', async () => {
  await assert.rejects(
    fetchSleeperHistoricalUsage({
      season: 2026,
      weeks: [3],
      players: [],
      fetchImpl: async (url) => url === SLEEPER_PLAYER_CATALOG_ENDPOINT
        ? { ok: true, json: async () => fixture.catalog }
        : { ok: false, status: 503 }
    }),
    (error) => error.code === 'SLEEPER_HISTORICAL_USAGE_HTTP'
      && error.status === 503
      && error.sourceUrl.includes('/2026/3')
  );
});
