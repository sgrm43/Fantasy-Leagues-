import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ESPN_NFL_INJURIES_ENDPOINT,
  MAX_INJURY_CONTEXT_LENGTH,
  buildEspnNflInjuriesUrl,
  fetchNflInjuryContext,
  normalizeNflInjuries
} from '../src/providers/espn-nfl-injuries.js';

const fixture = JSON.parse(await readFile(
  new URL('./fixtures/espn-nfl-injuries.json', import.meta.url),
  'utf8'
));

test('injury URL points to the public ESPN NFL endpoint', () => {
  assert.equal(buildEspnNflInjuriesUrl(), ESPN_NFL_INJURIES_ENDPOINT);
});

test('normalizer flattens team reports and preserves player, injury and practice context', () => {
  const result = normalizeNflInjuries(fixture, {
    sourceUrl: 'https://site.api.espn.com/test-injuries',
    retrievedAt: '2026-09-02T17:05:00Z',
    now: '2026-09-02T17:10:00Z'
  });
  const injury = result.injuries[0];

  assert.equal(result.sourceUpdatedAt, '2026-09-02T17:00:00.000Z');
  assert.equal(result.stale, false);
  assert.equal(injury.playerId, '4429000');
  assert.equal(injury.name, 'Jordan Example');
  assert.deepEqual(injury.position, {
    id: '1',
    name: 'Wide Receiver',
    abbreviation: 'WR'
  });
  assert.deepEqual(injury.team, {
    id: '25',
    name: 'San Francisco 49ers',
    abbreviation: 'SF'
  });
  assert.equal(injury.status, 'Questionable');
  assert.equal(injury.designation.name, 'INJURY_STATUS_QUESTIONABLE');
  assert.deepEqual(injury.injury, {
    type: 'Strain',
    bodyPart: 'Hamstring',
    detail: 'Soreness',
    side: 'Right',
    returnAt: '2026-09-06T17:00:00.000Z',
    practiceStatus: 'Limited participation',
    fantasyStatus: { description: 'Questionable', abbreviation: 'Q' }
  });
  assert.equal(injury.shortComment, "Example was limited in Wednesday's practice.");
  assert.equal(injury.updatedAt, '2026-09-02T16:30:00.000Z');
  assert.deepEqual(injury.source, { id: '1', description: 'ESPN', state: 'published' });
  assert.equal(injury.sourceUrl, result.sourceUrl);
  assert.equal(injury.retrievedAt, result.retrievedAt);
  assert.equal(injury.stale, false);
});

test('long narrative is concise and never exceeds the 300 character storage cap', () => {
  const result = normalizeNflInjuries(fixture, {
    retrievedAt: '2026-09-02T17:05:00Z',
    now: '2026-09-02T17:10:00Z'
  });
  const context = result.injuries[0].context;

  assert.ok(context.endsWith('…'));
  assert.ok(Array.from(context).length <= MAX_INJURY_CONTEXT_LENGTH);
  assert.doesNotMatch(context, /\s{2,}/);
});

test('team grouping supplies team identity while unavailable fields remain null and are reported', () => {
  const result = normalizeNflInjuries(fixture, {
    retrievedAt: '2026-09-02T17:05:00Z',
    now: '2026-09-02T17:10:00Z'
  });
  const injury = result.injuries[1];

  assert.deepEqual(injury.team, { id: '2', name: 'Buffalo Bills', abbreviation: 'BUF' });
  assert.equal(injury.status, null);
  assert.equal(injury.updatedAt, null);
  assert.equal(injury.context, null);
  assert.deepEqual(injury.injury, {
    type: null,
    bodyPart: 'Ankle',
    detail: null,
    side: null,
    returnAt: null,
    practiceStatus: null,
    fantasyStatus: null
  });
  assert.ok(injury.missing.includes('status'));
  assert.ok(injury.missing.includes('updatedAt'));
  assert.ok(result.missing.includes('injuries.149142.status'));
  assert.ok(result.issues.some((issue) => issue.injuryId === '149142' && issue.code === 'status_unavailable'));
});

test('player identity can be recovered from an ESPN athlete link without a name join', () => {
  const payload = structuredClone(fixture);
  delete payload.injuries[0].injuries[0].athlete.id;
  payload.injuries[0].injuries[0].athlete.links = [{ href: 'https://www.espn.com/nfl/player/_/id/4431459/player-name' }];
  const result = normalizeNflInjuries(payload);
  assert.equal(result.injuries[0].playerId, '4431459');
});

test('missing list and timestamps are not fabricated', () => {
  const result = normalizeNflInjuries({}, {
    sourceUrl: '',
    retrievedAt: null,
    now: '2026-09-02T17:10:00Z'
  });

  assert.deepEqual(result.injuries, []);
  assert.equal(result.sourceUpdatedAt, null);
  assert.equal(result.sourceUrl, null);
  assert.equal(result.retrievedAt, null);
  assert.equal(result.stale, true);
  assert.ok(result.missing.includes('injuries'));
  assert.ok(result.missing.includes('sourceUpdatedAt'));
});

test('stale indicator is derived from retrieval age', () => {
  const result = normalizeNflInjuries({ timestamp: '2026-09-02T16:00:00Z', injuries: [] }, {
    retrievedAt: '2026-09-02T17:00:00Z',
    now: '2026-09-02T17:16:00Z'
  });
  assert.equal(result.stale, true);
});

test('fetcher supports injected fetch and makes one read-only JSON request', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => fixture };
  };

  const result = await fetchNflInjuryContext({
    fetchImpl,
    now: () => new Date('2026-09-02T17:05:00Z')
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ESPN_NFL_INJURIES_ENDPOINT);
  assert.equal(calls[0].options.headers.Accept, 'application/json');
  assert.equal(result.injuries.length, 2);
  assert.equal(result.retrievedAt, '2026-09-02T17:05:00.000Z');
  assert.equal(result.stale, false);
});

test('fetcher surfaces HTTP failures with source metadata', async () => {
  await assert.rejects(
    fetchNflInjuryContext({
      fetchImpl: async () => ({ ok: false, status: 503 })
    }),
    (error) => error.code === 'ESPN_NFL_INJURIES_HTTP'
      && error.status === 503
      && error.sourceUrl === ESPN_NFL_INJURIES_ENDPOINT
  );
});
