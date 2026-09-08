import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { projectRoster } from '../src/analytics/projections.js';
import {
  NEXT_GEN_LEARNING_MESSAGE,
  createNflverseNextGenStatsProvider,
  normalizeNflverseNextGenCsv,
  summarizeNflverseNextGenStats
} from '../src/providers/nflverse-next-gen-stats.js';

const BASE = ['season', 'season_type', 'week', 'player_display_name', 'player_position', 'team_abbr', 'player_gsis_id'];
const HEADERS = {
  passing: [...BASE, 'avg_time_to_throw', 'avg_completed_air_yards', 'avg_intended_air_yards', 'aggressiveness', 'attempts', 'completion_percentage', 'expected_completion_percentage', 'completion_percentage_above_expectation'],
  receiving: [...BASE, 'avg_cushion', 'avg_separation', 'avg_intended_air_yards', 'percent_share_of_intended_air_yards', 'receptions', 'targets', 'avg_yac', 'avg_expected_yac', 'avg_yac_above_expectation'],
  rushing: [...BASE, 'efficiency', 'percent_attempts_gte_eight_defenders', 'avg_time_to_los', 'rush_attempts', 'expected_rush_yards', 'rush_yards_over_expected', 'rush_yards_over_expected_per_att', 'rush_pct_over_expected']
};
const DEFAULTS = {
  passing: { avg_time_to_throw: 2.8, avg_completed_air_yards: 6.5, avg_intended_air_yards: 8, aggressiveness: 15, attempts: 500, completion_percentage: 65, expected_completion_percentage: 63, completion_percentage_above_expectation: 2 },
  receiving: { avg_cushion: 6.2, avg_separation: 3.1, avg_intended_air_yards: 10, percent_share_of_intended_air_yards: 25, receptions: 80, targets: 120, avg_yac: 5.2, avg_expected_yac: 4.8, avg_yac_above_expectation: 0.4 },
  rushing: { efficiency: 3.8, percent_attempts_gte_eight_defenders: 20, avg_time_to_los: 2.85, rush_attempts: 220, expected_rush_yards: 900, rush_yards_over_expected: 80, rush_yards_over_expected_per_att: 0.36, rush_pct_over_expected: 0.42 }
};

function csv(statType, rows) {
  const headers = HEADERS[statType];
  return [headers, ...rows.map((row) => headers.map((field) => {
    const value = Object.hasOwn(row, field) ? row[field] : DEFAULTS[statType][field];
    return value == null ? '' : value;
  }))].map((row) => row.join(',')).join('\n');
}

function row({ season = 2026, name, position, team, gsis, ...metrics }) {
  return { season, season_type: 'REG', week: 0, player_display_name: name, player_position: position, team_abbr: team, player_gsis_id: gsis, ...metrics };
}

function dataset(statType, rows, version = `${statType}-v1`) {
  return normalizeNflverseNextGenCsv(csv(statType, rows), { statType, sourceUrl: `fixture:${statType}`, retrievedAt: '2026-09-03T12:00:00Z', dataVersion: version });
}

function fixtureDatasets({ include2026 = true } = {}) {
  const seasons = include2026 ? [2025, 2026] : [2025];
  return {
    passing: dataset('passing', seasons.flatMap((season) => [
      row({ season, name: 'Pat Passer', position: 'QB', team: 'SF', gsis: '00-QB1', avg_time_to_throw: season === 2026 ? 2.45 : 2.8, avg_intended_air_yards: season === 2026 ? 10.2 : 8.1, completion_percentage_above_expectation: season === 2026 ? 4.2 : 1.1 }),
      row({ season, name: 'League Quarterback', position: 'QB', team: 'DAL', gsis: '00-QB2', avg_time_to_throw: 2.9, avg_intended_air_yards: 7.4, completion_percentage_above_expectation: -1 })
    ])),
    receiving: dataset('receiving', seasons.flatMap((season) => [
      row({ season, name: 'Alpha Wide', position: 'WR', team: 'SEA', gsis: '00-WR1', avg_separation: season === 2026 ? 3.9 : 3.2, avg_intended_air_yards: 13.2, avg_yac_above_expectation: 1.2 }),
      row({ season, name: 'League Receiver', position: 'WR', team: 'DAL', gsis: '00-WR2', avg_separation: 2.7, avg_intended_air_yards: 8.2, avg_yac_above_expectation: -0.4 }),
      row({ season, name: 'Beta Runner', position: 'RB', team: 'JAC', gsis: '00-RB1', targets: 55, avg_yac_above_expectation: 0.8 })
    ])),
    rushing: dataset('rushing', seasons.flatMap((season) => [
      row({ season, name: 'Beta Runner', position: 'RB', team: 'JAC', gsis: '00-RB1', efficiency: 3.2, percent_attempts_gte_eight_defenders: 29, rush_yards_over_expected_per_att: 0.7 }),
      row({ season, name: 'League Runner', position: 'RB', team: 'DAL', gsis: '00-RB2', efficiency: 4.4, percent_attempts_gte_eight_defenders: 15, rush_yards_over_expected_per_att: -0.2 }),
      row({ season, name: 'Pat Passer', position: 'QB', team: 'SF', gsis: '00-QB1', rush_yards_over_expected_per_att: 0.5 })
    ]))
  };
}

test('passing NGS CSV parses the selected raw metrics', () => {
  const result = dataset('passing', [row({ name: 'Pat Passer', position: 'QB', team: 'SF', gsis: '00-QB1', avg_time_to_throw: 2.51, avg_completed_air_yards: 7.2, avg_intended_air_yards: 9.4, aggressiveness: 18.3, expected_completion_percentage: 64.1, completion_percentage_above_expectation: 3.4 })]);
  assert.equal(result.rows[0].metrics.avgTimeToThrow, 2.51);
  assert.equal(result.rows[0].metrics.avgCompletedAirYards, 7.2);
  assert.equal(result.rows[0].metrics.avgIntendedAirYards, 9.4);
  assert.equal(result.rows[0].metrics.aggressiveness, 18.3);
  assert.equal(result.rows[0].metrics.expectedCompletionPercentage, 64.1);
  assert.equal(result.rows[0].metrics.completionPercentageAboveExpectation, 3.4);
});

test('receiving NGS CSV parses metrics and preserves a blank as null', () => {
  const result = dataset('receiving', [row({ name: 'Alpha Wide', position: 'WR', team: 'SEA', gsis: '00-WR1', avg_cushion: 7.1, avg_separation: 3.8, percent_share_of_intended_air_yards: 31.5, targets: 130, avg_yac: 5.9, avg_expected_yac: 4.7, avg_yac_above_expectation: null })]);
  assert.equal(result.rows[0].metrics.avgCushion, 7.1);
  assert.equal(result.rows[0].metrics.avgSeparation, 3.8);
  assert.equal(result.rows[0].metrics.percentShareOfIntendedAirYards, 31.5);
  assert.equal(result.rows[0].metrics.targets, 130);
  assert.equal(result.rows[0].metrics.avgYacAboveExpectation, null);
});

test('rushing NGS CSV parses efficiency, box, time, and expected-rushing fields', () => {
  const result = dataset('rushing', [row({ name: 'Beta Runner', position: 'RB', team: 'JAC', gsis: '00-RB1', efficiency: 3.45, percent_attempts_gte_eight_defenders: 27.2, avg_time_to_los: 2.63, expected_rush_yards: 940.5, rush_yards_over_expected: 112.5, rush_yards_over_expected_per_att: 0.51, rush_pct_over_expected: 0.46 })]);
  assert.equal(result.rows[0].team, 'JAX');
  assert.equal(result.rows[0].metrics.efficiency, 3.45);
  assert.equal(result.rows[0].metrics.percentAttemptsGteEightDefenders, 27.2);
  assert.equal(result.rows[0].metrics.avgTimeToLos, 2.63);
  assert.equal(result.rows[0].metrics.expectedRushYards, 940.5);
  assert.equal(result.rows[0].metrics.rushYardsOverExpectedPerAtt, 0.51);
  assert.equal(result.rows[0].metrics.rushPctOverExpected, 0.46);
});

test('players match by GSIS first or one exact normalized name and position, never an ambiguity', () => {
  const datasets = fixtureDatasets();
  const receiverRow = datasets.receiving.rows.find((item) => item.position === 'WR');
  datasets.receiving.rows.push({ ...receiverRow, playerName: 'Same Name', gsisId: '00-A', team: 'SF' });
  datasets.receiving.rows.push({ ...receiverRow, playerName: 'Same Name', gsisId: '00-B', team: 'SEA' });
  const result = summarizeNflverseNextGenStats(datasets, { season: 2026, currentWeek: 2, players: [
    { playerId: 'known', name: 'Wrong Name', position: 'QB', nflTeam: 'SF', gsisId: '00-QB1' },
    { playerId: 'exact', name: 'Alpha Wide', position: 'WR', nflTeam: 'SEA' },
    { playerId: 'team-disambiguated', name: 'Same Name', position: 'WR', nflTeam: 'SEA' },
    { playerId: 'ambiguous', name: 'Same Name', position: 'WR' }
  ] });
  assert.deepEqual(result.players.map((player) => player.resolvedBy), ['gsis_id', 'exact_name_position', 'exact_name_position_team', null]);
  assert.equal(result.players[3].issues[0].code, 'ambiguous_player_match');
});

test('only roster-relevant player outputs are produced and unrelated source rows stay filtered out', () => {
  const result = summarizeNflverseNextGenStats(fixtureDatasets(), { season: 2026, currentWeek: 2, players: [
    { playerId: 'rostered', name: 'Alpha Wide', position: 'WR', nflTeam: 'SEA' },
    { playerId: 'kicker', name: 'A Kicker', position: 'K', nflTeam: 'SF' },
    { playerId: 'defense', name: '49ers D/ST', position: 'D/ST', nflTeam: 'SF' }
  ] });
  assert.deepEqual(result.players.map((player) => player.requestedPlayerId), ['rostered']);
  assert.equal(result.players.some((player) => player.name === 'League Receiver'), false);
});

test('one dataset per stat type is cached and reused between league analyses', async () => {
  let calls = 0;
  const csvByType = {
    passing: csv('passing', [row({ season: 2025, name: 'Pat Passer', position: 'QB', team: 'SF', gsis: '00-QB1' })]),
    receiving: csv('receiving', [row({ season: 2025, name: 'Alpha Wide', position: 'WR', team: 'SEA', gsis: '00-WR1' }), row({ season: 2025, name: 'Beta Runner', position: 'RB', team: 'JAC', gsis: '00-RB1' })]),
    rushing: csv('rushing', [row({ season: 2025, name: 'Pat Passer', position: 'QB', team: 'SF', gsis: '00-QB1' }), row({ season: 2025, name: 'Beta Runner', position: 'RB', team: 'JAC', gsis: '00-RB1' })])
  };
  const provider = createNflverseNextGenStatsProvider({
    now: () => new Date('2026-09-03T12:00:00Z'),
    fetchImpl: async (url) => {
      calls += 1;
      const type = /ngs_(passing|receiving|rushing)\.csv\.gz/.exec(url)?.[1];
      return new Response(gzipSync(csvByType[type]), { status: 200, headers: { etag: `${type}-version` } });
    }
  });
  await provider.fetch({ season: 2026, currentWeek: 1, players: [
    { playerId: 'qb', name: 'Pat Passer', position: 'QB', gsisId: '00-QB1' },
    { playerId: 'rb', name: 'Beta Runner', position: 'RB', gsisId: '00-RB1' },
    { playerId: 'wr', name: 'Alpha Wide', position: 'WR', gsisId: '00-WR1' }
  ] });
  const secondLeague = await provider.fetch({ season: 2026, currentWeek: 1, players: [{ playerId: 'other-league', name: 'Alpha Wide', position: 'WR', gsisId: '00-WR1' }] });
  assert.equal(calls, 3);
  assert.equal(provider.cacheSize, 3);
  assert.deepEqual(secondLeague.cache.datasets.map((item) => item.status), ['memory_hit']);
  assert.match(secondLeague.cache.datasets[0].datasetKey, /^receiving:receiving-version$/);
});

test('missing 2026 rows show the exact Learning message and keep 2025 as reference', () => {
  const result = summarizeNflverseNextGenStats(fixtureDatasets({ include2026: false }), { season: 2026, currentWeek: 1, players: [{ playerId: 'qb', name: 'Pat Passer', position: 'QB', gsisId: '00-QB1' }] });
  const player = result.players[0];
  assert.equal(player.status, NEXT_GEN_LEARNING_MESSAGE);
  assert.equal(player.current, null);
  assert.equal(player.reference.label, '2025 reference');
  assert.equal(result.available, false);
  assert.equal(result.historicalReferenceAvailable, true);
});

test('current and prior-season values remain separate and compact', () => {
  const result = summarizeNflverseNextGenStats(fixtureDatasets(), { season: 2026, currentWeek: 2, players: [{ playerId: 'qb', name: 'Pat Passer', position: 'QB', gsisId: '00-QB1' }] });
  const player = result.players[0];
  assert.equal(player.current.label, '2026 current');
  assert.equal(player.reference.label, '2025 reference');
  assert.equal(player.current.metrics.find((metric) => metric.key === 'time_to_throw').values.avgTimeToThrow, 2.45);
  assert.equal(player.reference.metrics.find((metric) => metric.key === 'time_to_throw').values.avgTimeToThrow, 2.8);
  assert.ok(player.current.metrics.length >= 3 && player.current.metrics.length <= 5);
});

test('threshold descriptions are deterministic', () => {
  const datasets = fixtureDatasets();
  const options = { season: 2026, currentWeek: 2, players: [{ playerId: 'qb', name: 'Pat Passer', position: 'QB', gsisId: '00-QB1' }] };
  const first = summarizeNflverseNextGenStats(datasets, options);
  const second = summarizeNflverseNextGenStats(datasets, options);
  assert.deepEqual(first, second);
  assert.deepEqual(first.players[0].current.descriptions, [
    'Quick release relative to qualifying QBs',
    'Deeper target profile than qualifying QBs',
    'Completion rate above expectation'
  ]);
});

test('Next Gen context leaves projection output unchanged and remains read-only', () => {
  const roster = [{ playerId: 'qb', name: 'Pat Passer', position: 'QB', projection: 20 }];
  const originalRoster = structuredClone(roster);
  const projectionOptions = { now: new Date('2026-09-03T12:00:00Z'), provenance: { source: 'Fixture projection', retrievedAt: '2026-09-03T10:00:00Z' } };
  const before = projectRoster(roster, projectionOptions);
  const nextGen = summarizeNflverseNextGenStats(fixtureDatasets(), { season: 2026, currentWeek: 2, players: roster });
  const after = projectRoster(roster, projectionOptions);
  assert.deepEqual(after, before);
  assert.deepEqual(roster, originalRoster);
  assert.equal(nextGen.projectionsAdjusted, false);
  assert.deepEqual(nextGen.safeguards, { readOnly: true, transactionsPerformed: false });
});
