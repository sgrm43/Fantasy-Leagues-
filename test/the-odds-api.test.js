import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTheOddsApiProvider,
  fetchCurrentNflOdds,
  normalizeTheOddsApiEvents,
  parseOddsApiQuotaHeaders
} from '../src/providers/the-odds-api.js';

const NOW = '2026-09-03T19:00:00.000Z';

function event(bookmakers, overrides = {}) {
  return {
    id: 'event-1',
    sport_key: 'americanfootball_nfl',
    commence_time: '2026-09-10T00:20:00Z',
    home_team: 'San Francisco 49ers',
    away_team: 'Los Angeles Rams',
    bookmakers,
    ...overrides
  };
}

function bookmaker({ key = 'book-a', spread = -3, total = 45.5, updated = '2026-09-03T18:30:00Z' } = {}) {
  const markets = [];
  if (spread != null) markets.push({
    key: 'spreads',
    last_update: updated,
    outcomes: [
      { name: 'Los Angeles Rams', price: -110, point: -spread },
      { name: 'San Francisco 49ers', price: -110, point: spread }
    ]
  });
  if (total != null) markets.push({
    key: 'totals',
    last_update: updated,
    outcomes: [
      { name: 'Under', price: -105, point: total },
      { name: 'Over', price: -115, point: total }
    ]
  });
  return { key, title: key, last_update: updated, markets };
}

function response(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('spreads parse correctly and the request is limited to the required NFL markets', async () => {
  let requestedUrl;
  const result = await fetchCurrentNflOdds({
    apiKey: 'mock-key', now: () => new Date(NOW),
    fetchImpl: async (url) => { requestedUrl = new URL(url); return response([event([bookmaker({ spread: -2.5, total: null })])]); }
  });
  assert.equal(result.games[0].consensusSpread, -2.5);
  assert.deepEqual(result.games[0].spreadRange, { min: -2.5, max: -2.5 });
  assert.equal(result.games[0].consensusTotal, null);
  assert.equal(requestedUrl.pathname, '/v4/sports/americanfootball_nfl/odds');
  assert.equal(requestedUrl.searchParams.get('regions'), 'us');
  assert.equal(requestedUrl.searchParams.get('markets'), 'spreads,totals');
  assert.equal(requestedUrl.searchParams.get('oddsFormat'), 'american');
  assert.equal('bookmakers' in result.games[0], false);
});

test('totals parse correctly', () => {
  const result = normalizeTheOddsApiEvents([event([bookmaker({ spread: null, total: 47.5 })])], { retrievedAt: NOW });
  assert.equal(result.games[0].consensusTotal, 47.5);
  assert.deepEqual(result.games[0].totalRange, { min: 47.5, max: 47.5 });
  assert.equal(result.games[0].consensusSpread, null);
});

test('spread orientation is always from the home-team perspective', () => {
  const result = normalizeTheOddsApiEvents([event([bookmaker({ spread: 4, total: null })])], { retrievedAt: NOW });
  assert.equal(result.games[0].homeTeam, 'San Francisco 49ers');
  assert.equal(result.games[0].consensusSpread, 4);
});

test('median consensus and line ranges are deterministic', () => {
  const result = normalizeTheOddsApiEvents([event([
    bookmaker({ key: 'a', spread: -2.5, total: 44 }),
    bookmaker({ key: 'b', spread: -3, total: 45 }),
    bookmaker({ key: 'c', spread: -3.5, total: 46 })
  ])], { retrievedAt: NOW });
  assert.equal(result.games[0].consensusSpread, -3);
  assert.equal(result.games[0].consensusTotal, 45);
  assert.deepEqual(result.games[0].spreadRange, { min: -3.5, max: -2.5 });
  assert.deepEqual(result.games[0].totalRange, { min: 44, max: 46 });
  assert.equal(result.games[0].bookmakerCount, 3);
});

test('a malformed bookmaker is skipped', () => {
  const malformed = {
    key: 'bad',
    markets: [{ key: 'spreads', outcomes: [{ name: 'San Francisco 49ers', point: -8 }] }]
  };
  const result = normalizeTheOddsApiEvents([event([malformed, bookmaker({ key: 'good', spread: -3 })])], { retrievedAt: NOW });
  assert.equal(result.available, true);
  assert.equal(result.games[0].bookmakerCount, 1);
  assert.equal(result.games[0].consensusSpread, -3);
});

test('one bad bookmaker does not break an otherwise usable game', () => {
  const result = normalizeTheOddsApiEvents([event([
    null,
    { key: 'wrong-shape', markets: 'not-an-array' },
    bookmaker({ key: 'good', spread: -1.5, total: 43 })
  ])], { retrievedAt: NOW });
  assert.equal(result.status, 'available');
  assert.equal(result.games.length, 1);
  assert.equal(result.games[0].consensusSpread, -1.5);
  assert.equal(result.games[0].consensusTotal, 43);
});

test('a missing API key returns unavailable without making a request', async () => {
  let calls = 0;
  const result = await fetchCurrentNflOdds({ apiKey: '   ', now: () => new Date(NOW), fetchImpl: async () => { calls += 1; } });
  assert.equal(calls, 0);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'missing_api_key');
  assert.deepEqual(result.games, []);
});

test('provider errors and malformed responses return unavailable cleanly', async () => {
  const providerError = await fetchCurrentNflOdds({ apiKey: 'mock-key', now: () => new Date(NOW), fetchImpl: async () => response({ message: 'upstream detail' }, { status: 500 }) });
  const malformed = await fetchCurrentNflOdds({ apiKey: 'mock-key', now: () => new Date(NOW), fetchImpl: async () => response({ not: 'an event array' }) });
  assert.equal(providerError.reason, 'provider_error');
  assert.equal(malformed.reason, 'malformed_response');
  assert.deepEqual(providerError.games, []);
  assert.deepEqual(malformed.games, []);
});

test('quota exhaustion returns unavailable cleanly', async () => {
  const result = await fetchCurrentNflOdds({
    apiKey: 'mock-key', now: () => new Date(NOW),
    fetchImpl: async () => response({ message: 'quota' }, { status: 429, headers: { 'x-requests-remaining': '0', 'x-requests-used': '500' } })
  });
  assert.equal(result.reason, 'quota_exhausted');
  assert.equal(result.quota.requestsRemaining, 0);
  assert.equal(result.quota.requestsUsed, 500);
});

test('quota headers are parsed as provider metadata', () => {
  const quota = parseOddsApiQuotaHeaders(new Headers({
    'x-requests-remaining': '487',
    'x-requests-used': '13',
    'x-requests-last': '1'
  }));
  assert.deepEqual(quota, { requestsRemaining: 487, requestsUsed: 13, requestsLast: 1 });
});

test('the in-memory cache prevents duplicate fetches', async () => {
  let calls = 0;
  const provider = createTheOddsApiProvider({
    apiKey: 'mock-key', now: () => new Date(NOW),
    fetchImpl: async () => { calls += 1; return response([event([bookmaker()])]); }
  });
  const first = await provider.fetch();
  const second = await provider.fetch();
  assert.equal(calls, 1);
  assert.equal(provider.cacheSize, 1);
  assert.equal(first.cache.status, 'network');
  assert.equal(second.cache.status, 'memory_hit');
});

test('the API key never appears in returned errors or output', async () => {
  const secret = 'do-not-leak-this-key';
  const fromResponse = await fetchCurrentNflOdds({
    apiKey: secret, now: () => new Date(NOW),
    fetchImpl: async () => response({ message: `bad key ${secret}` }, { status: 401 })
  });
  const fromThrownError = await fetchCurrentNflOdds({
    apiKey: secret, now: () => new Date(NOW),
    fetchImpl: async () => { throw new Error(`request failed for apiKey=${secret}`); }
  });
  assert.equal(JSON.stringify(fromResponse).includes(secret), false);
  assert.equal(JSON.stringify(fromThrownError).includes(secret), false);
  assert.equal(fromResponse.issues[0].message, 'The Odds API request is temporarily unavailable.');
});
