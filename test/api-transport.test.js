import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiRouter, handleApiRequest } from '../src/api-router.js';
import { config } from '../src/config.js';
import netlifyApi from '../netlify/functions/api.js';

function testRouter() {
  const calls = [];
  const router = createApiRouter({
    config: { leagues: [{ key: 'league' }] },
    safeConfig: () => ({ safe: true }),
    getLeagueStates: async () => ({ route: 'leagues' }),
    syncAll: async () => ({ route: 'sync-all' }),
    syncLeague: async (key) => ({ route: 'sync-one', key }),
    listSnapshots: async (key) => ({ route: 'snapshots', key }),
    buildWeeklyAnalysis: async (key, teamId, options) => ({ route: 'analysis', key, teamId, options }),
    buildLeagueBacktest: async (key) => ({ route: 'backtest', key }),
    readLeague: async () => ({
      retrievedAt: '2026-09-08T00:00:00.000Z',
      data: { platform: 'test', teams: [{ roster: [] }] }
    }),
    getNflInjuries: async () => ({ injuries: [], retrievedAt: '2026-09-08T00:00:00.000Z', stale: false }),
    evaluateTrade: (input) => { calls.push(input); return { route: 'trade' }; },
    summarizeSamples: (samples, rules, thresholds) => ({ route: 'project', samples, rules, thresholds })
  });
  return { router, calls };
}

test('transport-neutral router preserves the existing API route surface', async () => {
  const { router, calls } = testRouter();
  const cases = [
    ['GET', '/api/leagues', undefined, { route: 'leagues' }],
    ['POST', '/api/sync', undefined, { route: 'sync-all' }],
    ['POST', '/api/sync/league%20one', undefined, { route: 'sync-one', key: 'league one' }],
    ['GET', '/api/snapshots/league', undefined, { route: 'snapshots', key: 'league' }],
    ['GET', '/api/analysis/league?teamId=7&objective=ceiling', undefined, { route: 'analysis', key: 'league', teamId: '7', options: { objective: 'ceiling' } }],
    ['GET', '/api/backtest/league', undefined, { route: 'backtest', key: 'league' }],
    ['POST', '/api/project', { samples: [1, 2], rules: { points: 1 }, thresholds: [10] }, { route: 'project', samples: [1, 2], rules: { points: 1 }, thresholds: [10] }],
    ['POST', '/api/trade/league', { fromTeamId: '1', toTeamId: '2', givePlayerIds: ['a'], receivePlayerIds: ['b'] }, {
      route: 'trade',
      evidence: [{ source: 'ESPN NFL injury report', retrievedAt: '2026-09-08T00:00:00.000Z', stale: false }]
    }]
  ];

  for (const [method, pathname, body, expected] of cases) {
    const response = await router(new Request(`http://local.test${pathname}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }));
    assert.equal(response.status, 200, `${method} ${pathname}`);
    assert.deepEqual(await response.json(), expected, `${method} ${pathname}`);
  }
  assert.equal(calls.length, 1);
});

test('router returns Web Responses with existing JSON, cache, and error behavior', async () => {
  const health = await handleApiRequest(new Request('http://local.test/api/health'));
  assert.ok(health instanceof Response);
  assert.equal(health.status, 200);
  assert.match(health.headers.get('content-type'), /^application\/json/);
  assert.equal(health.headers.get('cache-control'), 'no-store');

  const missing = await handleApiRequest(new Request('http://local.test/api/missing'));
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Not found' });

  const malformed = await handleApiRequest(new Request('http://local.test/api/project', { method: 'POST', body: '{' }));
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'Request body must be valid JSON' });
});

test('Netlify Function normalizes the splat rewrite and delegates without starting a server', async () => {
  const response = await netlifyApi(new Request('https://fantasy-league-sgrm43.netlify.app/.netlify/functions/api/health'));
  assert.ok(response instanceof Response);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('league endpoint exposes all five registered leagues independently to the frontend', async () => {
  const states = config.leagues.map((definition) => ({
    definition,
    cache: { data: { key: definition.key, id: definition.id, name: definition.name } }
  }));
  const router = createApiRouter({ getLeagueStates: async () => states });
  const response = await router(new Request('http://local.test/api/leagues'));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.map((state) => state.definition.key), [
    'sleeper', 'champions', 'frontera', 'pistoleros', 'sundays'
  ]);
  assert.equal(new Set(payload.map((state) => state.definition.key)).size, 5);
  assert.equal(new Set(payload.map((state) => state.definition.id)).size, 5);
  assert.deepEqual(payload.at(-1).definition, {
    key: 'sundays',
    name: 'Sundays Are for DUI',
    platform: 'sleeper',
    id: '1400288398731649024',
    ownerTeam: 'sgrm43'
  });
});
