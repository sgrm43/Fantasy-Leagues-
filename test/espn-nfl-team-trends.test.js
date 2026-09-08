import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateNflTeamTrends, fetchNflTeamTrends, normalizeNflTeamGameSummary } from '../src/providers/espn-nfl-team-trends.js';

const payload = {
  header: { id: 'game1', season: { year: 2025, type: 2 }, week: { number: 18 }, competitions: [{ id: 'game1', date: '2026-01-03T20:00:00Z', status: { type: { completed: true, state: 'post' } }, competitors: [{ homeAway: 'home', score: '24', team: { id: '1', abbreviation: 'AAA', displayName: 'A Team' } }, { homeAway: 'away', score: '17', team: { id: '2', abbreviation: 'BBB', displayName: 'B Team' } }] }] },
  boxscore: { teams: [{ team: { id: '1', abbreviation: 'AAA' }, statistics: [
    { name: 'completionAttempts', displayValue: '22/34' }, { name: 'rushingAttempts', value: 26 }, { name: 'totalOffensivePlays', value: 63 }, { name: 'totalDrives', value: 10 }, { name: 'possessionTime', displayValue: '31:20' }, { name: 'firstDowns', value: 21 }, { name: 'totalYards', value: 390 }, { name: 'netPassingYards', value: 260 }, { name: 'rushingYards', value: 130 }, { name: 'turnovers', value: 1 }
  ] }] }
};

test('team boxscore normalizer preserves descriptive rates without inventing coach context', () => {
  const game = normalizeNflTeamGameSummary(payload, { teamId: '1', retrievedAt: '2026-01-04T00:00:00Z' });
  assert.equal(game.metrics.passAttempts, 34); assert.equal(game.metrics.rushAttempts, 26); assert.equal(game.metrics.passAttemptRate, 0.567); assert.equal(game.context.headCoach, null); assert.ok(game.missing.includes('context.headCoach'));
});

test('team trend aggregator reports sample size and limitations', () => {
  const game = normalizeNflTeamGameSummary(payload, { teamId: '1', retrievedAt: '2026-01-04T00:00:00Z' });
  const trend = aggregateNflTeamTrends([game], { teamId: '1', window: 4, generatedAt: '2026-01-04T00:00:00Z' });
  assert.equal(trend.available, true); assert.equal(trend.window.includedGames, 1); assert.equal(trend.metrics.pointsPerGame.value, 24); assert.match(trend.limitations.join(' '), /do not prove why/i);
});

test('team trend fetch never searches before the current coach start week', async () => {
  const requestedWeeks = [];
  const fetchImpl = async (url) => {
    requestedWeeks.push(Number(new URL(url).searchParams.get('week')));
    return { ok: true, json: async () => ({ events: [] }) };
  };
  const result = await fetchNflTeamTrends({ season: 2026, beforeWeek: 5, fromWeek: 3, teamAbbreviation: 'CHI', window: 4, fetchImpl, now: () => new Date('2026-10-01T12:00:00Z') });
  assert.deepEqual(requestedWeeks, [4, 3]);
  assert.equal(result.requested.fromWeek, 3);
  assert.equal(result.available, false);
});
