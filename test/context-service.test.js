import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCoachingAnalysisPeriod, findNflHeadCoach, findPlayerGame, findPlayerOpponent, findPlayerTeam, resolvePlayerNflTeam } from '../src/context-service.js';

const context = { games: [{ id: 'g', teams: { home: { id: '25', abbreviation: 'SF' }, away: { id: '26', abbreviation: 'SEA' } } }] };

test('player game mapping uses durable NFL team id when available', () => {
  assert.equal(findPlayerGame({ nflTeamId: 25 }, context)?.id, 'g');
});

test('player game mapping falls back to normalized abbreviation', () => {
  assert.equal(findPlayerGame({ nflTeam: 'sea' }, context)?.id, 'g');
});

test('missing player team context stays unavailable', () => {
  assert.equal(findPlayerGame({ nflTeam: 'DAL' }, context), null);
});

test('player opponent mapping uses the durable team id first', () => {
  assert.equal(findPlayerOpponent({ nflTeamId: 25, nflTeam: 'SEA' }, context)?.abbreviation, 'SEA');
});

test('player opponent mapping falls back to abbreviation', () => {
  assert.equal(findPlayerOpponent({ nflTeam: 'SEA' }, context)?.abbreviation, 'SF');
});

test('player opponent mapping stays unavailable for a mismatched durable id', () => {
  assert.equal(findPlayerOpponent({ nflTeamId: 999, nflTeam: 'SF' }, context), null);
});

test('player team mapping uses aliases only when a durable id is absent', () => {
  const aliasContext = { games: [{ id: 'alias', teams: { home: { id: '1', abbreviation: 'WSH' }, away: { id: '2', abbreviation: 'DAL' } } }] };
  assert.equal(findPlayerTeam({ nflTeam: 'WAS' }, aliasContext)?.abbreviation, 'WSH');
  assert.equal(findPlayerTeam({ nflTeamId: 999, nflTeam: 'WAS' }, aliasContext), null);
});

test('head coach lookup normalizes team aliases', () => {
  const feed = { coaches: [{ name: 'Coach', team: { abbreviation: 'WSH' } }] };
  assert.equal(findNflHeadCoach(feed, 'WAS')?.name, 'Coach');
});

test('ESPN team id fallback keeps roster offenses visible during a bye', () => {
  assert.equal(resolvePlayerNflTeam({ nflTeamId: 25 }, { games: [] })?.abbreviation, 'SF');
});

test('offensive trend period starts at the latest independently tracked role', () => {
  const role = (name, startWeek) => ({ status: 'verified', role: name, label: name, name, period: { tenureId: `${name}:${startWeek}`, startWeek, firstSeenAt: `2026-09-${String(startWeek).padStart(2, '0')}T12:00:00Z` } });
  const period = deriveCoachingAnalysisPeriod({ roles: { headCoach: role('headCoach', 1), offensiveCoordinator: role('offensiveCoordinator', 4), offensivePlayCaller: role('offensivePlayCaller', 2) } }, 'offense');
  assert.equal(period.startWeek, 4);
  assert.equal(period.basisRoles.length, 3);
});

test('unverified defensive play caller is not used as a defensive-period boundary', () => {
  const period = deriveCoachingAnalysisPeriod({ roles: {
    headCoach: { status: 'verified', role: 'headCoach', label: 'Head coach', name: 'HC', period: { tenureId: 'hc', startWeek: 1, firstSeenAt: '2026-09-01T12:00:00Z' } },
    defensiveCoordinator: { status: 'verified', role: 'defensiveCoordinator', label: 'Defensive coordinator', name: 'DC', period: { tenureId: 'dc', startWeek: 3, firstSeenAt: '2026-09-15T12:00:00Z' } },
    defensivePlayCaller: { status: 'not_verified', role: 'defensivePlayCaller', period: null }
  } }, 'defense');
  assert.equal(period.startWeek, 3);
  assert.deepEqual(period.basisRoles.map((item) => item.role), ['headCoach', 'defensiveCoordinator']);
});
