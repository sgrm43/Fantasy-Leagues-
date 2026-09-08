import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSleeperOpponentStatsUrl,
  createSleeperOpponentPositionProvider,
  fetchSleeperOpponentPosition,
  normalizeNflAbbreviation,
  normalizeSleeperOpponentPosition,
  selectOpponentHistoryWindow
} from '../src/providers/sleeper-opponent-position.js';

test('opponent history windows never include the current week', () => {
  assert.deepEqual(selectOpponentHistoryWindow(2026, 6), { season: 2026, weeks: [2, 3, 4, 5], basis: 'current-season completed games' });
  assert.deepEqual(selectOpponentHistoryWindow(2026, 1), { season: 2025, weeks: [14, 15, 16, 17], basis: 'prior-season historical baseline' });
});

test('weekly URL and explicit NFL aliases are stable', () => {
  assert.equal(buildSleeperOpponentStatsUrl(2026, 4), 'https://api.sleeper.com/stats/nfl/2026/4?season_type=regular');
  assert.equal(normalizeNflAbbreviation('WSH'), 'WAS');
  assert.equal(normalizeNflAbbreviation('JAC'), 'JAX');
});

test('normalizer joins exact player ids, uses weekly opponents, and builds a league baseline', () => {
  const input = sampleInput();
  const result = normalizeSleeperOpponentPosition(input);
  assert.equal(result.available, true);
  assert.equal(result.sample.includedGames, 3);
  assert.equal(result.sample.leagueDefenseGames, 18);
  assert.equal(result.sample.adequate, true);
  assert.equal(result.metrics.opportunity.valuePerGame, 18);
  assert.equal(result.metrics.opportunity.band, '20%+ above league');
  assert.equal(result.metrics.fantasyPoints.valuePerGame, 26);
  assert.equal(result.games[0].opponentOffense, 'SF');
  assert.ok(result.issues.some((issue) => issue.code === 'catalog_player_unresolved'));
});

test('per-player yardage bonuses are applied before position totals are summed', () => {
  const result = normalizeSleeperOpponentPosition(sampleInput());
  assert.equal(result.games[0].fantasyPoints, 26);
});

test('short samples remain descriptive without a strength label', () => {
  const input = sampleInput();
  input.weeks = [1, 2];
  delete input.weeklyStats[3];
  const result = normalizeSleeperOpponentPosition(input);
  assert.equal(result.sample.adequate, false);
  assert.equal(result.metrics.opportunity.band, 'insufficient sample');
  assert.equal(result.assessment.label, 'insufficient_sample');
});

test('ESPN mode keeps opportunity context but does not invent league fantasy points', () => {
  const result = normalizeSleeperOpponentPosition({ ...sampleInput(), rawScoringRules: null });
  assert.equal(result.metrics.opportunity.valuePerGame, 18);
  assert.equal(result.metrics.fantasyPoints.valuePerGame, null);
  assert.equal(result.scoring.supported, false);
});

test('missing weeks and stale sources stay visible instead of becoming zero games', () => {
  const input = sampleInput();
  input.weeks = [1, 2, 3, 4];
  input.missingWeeks = [4];
  input.sources.catalog.stale = true;
  const result = normalizeSleeperOpponentPosition(input);
  assert.equal(result.partial, true);
  assert.equal(result.stale, true);
  assert.equal(result.sample.includedGames, 3);
});

test('a grouped game without the requested opportunity metric is unavailable', () => {
  const input = sampleInput();
  for (const rows of Object.values(input.weeklyStats)) for (const row of rows) row.stats = { rec: 1 };
  const result = normalizeSleeperOpponentPosition(input);
  assert.equal(result.available, false);
  assert.equal(result.sample.adequate, false);
  assert.ok(result.missing.includes('metrics.opportunity'));
});

test('row-level historical position takes precedence over the current catalog position', () => {
  const input = sampleInput();
  for (const rows of Object.values(input.weeklyStats)) {
    for (const row of rows.filter((item) => ['a', 'b'].includes(item.player_id))) row.player.position = 'WR';
  }
  const result = normalizeSleeperOpponentPosition(input);
  assert.equal(result.available, false);
});

test('fetching tolerates one failed week and never replaces it with zero data', async () => {
  const input = sampleInput();
  const fetchImpl = async (url) => {
    if (url.includes('/4?')) return { ok: false, status: 503, json: async () => ({}) };
    if (url.includes('/players/nfl')) return { ok: true, status: 200, json: async () => input.catalog };
    const week = Number(/nfl\/2026\/(\d+)/.exec(url)?.[1]);
    return { ok: true, status: 200, json: async () => input.weeklyStats[week] || [] };
  };
  const result = await fetchSleeperOpponentPosition({ season: 2026, weeks: [1, 2, 3, 4], defense: { id: '26', abbreviation: 'SEA' }, position: 'RB', rawScoringRules: input.rawScoringRules, fetchImpl, now: () => new Date('2026-10-01T00:00:00Z') });
  assert.deepEqual(result.missingWeeks, [4]);
  assert.equal(result.sample.includedGames, 3);
  assert.equal(result.partial, true);
});

test('expired source cache is preserved as stale when refresh fails', async () => {
  const input = sampleInput();
  let fail = false;
  let now = new Date('2026-10-01T00:00:00Z');
  const fetchImpl = async (url) => {
    if (fail) throw new Error('offline');
    if (url.includes('/players/nfl')) return { ok: true, status: 200, json: async () => input.catalog };
    const week = Number(/nfl\/2026\/(\d+)/.exec(url)?.[1]);
    return { ok: true, status: 200, json: async () => input.weeklyStats[week] || [] };
  };
  const provider = createSleeperOpponentPositionProvider({ fetchImpl, now: () => now, cacheTtlMs: 1 });
  const options = { season: 2026, weeks: [1, 2, 3], defense: { abbreviation: 'SEA' }, position: 'RB', rawScoringRules: input.rawScoringRules };
  await provider.fetch(options);
  fail = true; now = new Date('2026-10-02T00:00:00Z');
  const result = await provider.fetch(options);
  assert.equal(result.stale, true);
  assert.equal(result.available, true);
});

function sampleInput() {
  const catalog = {
    a: { position: 'RB', team: 'SEA', full_name: 'Wrong Current Team' },
    b: { position: 'RB', team: 'SF' },
    wr: { position: 'WR', team: 'SF' }
  };
  for (let index = 0; index < 5; index++) catalog[`other${index}`] = { position: 'RB', team: `T${index}` };
  const weeklyStats = {};
  const otherDefenses = ['ARI', 'DAL', 'BUF', 'NYJ', 'PIT'];
  for (const week of [1, 2, 3]) {
    weeklyStats[week] = [
      row('a', week, 'SF', 'SEA', { rush_att: 10, rec_tgt: 2, rush_yd: 100 }),
      row('b', week, 'SF', 'SEA', { rush_att: 5, rec_tgt: 1, rush_yd: 100 }),
      row('wr', week, 'SF', 'SEA', { rec_tgt: 30, rec_yd: 300 }),
      row('unknown', week, 'SF', 'SEA', { rush_att: 99, rec_tgt: 99, rush_yd: 999 }),
      ...otherDefenses.map((defense, index) => row(`other${index}`, week, 'KC', defense, { rush_att: 8, rec_tgt: 2, rush_yd: 60 }))
    ];
  }
  const retrievedAt = '2026-09-20T00:00:00.000Z';
  return {
    season: 2026,
    weeks: [1, 2, 3],
    defense: { id: '26', abbreviation: 'SEA' },
    position: 'RB',
    catalog,
    weeklyStats,
    rawScoringRules: { rush_yd: 0.1, bonus_rush_yd_100: 3 },
    sources: {
      catalog: { retrievedAt, stale: false, status: 'ok' },
      weeklyStats: Object.fromEntries([1, 2, 3].map((week) => [week, { retrievedAt, stale: false, status: 'ok' }]))
    },
    missingWeeks: [],
    fetchIssues: []
  };
}

function row(playerId, week, team, opponent, stats) {
  return { player_id: playerId, week, team, opponent, player: { full_name: 'A misleading name' }, stats };
}
