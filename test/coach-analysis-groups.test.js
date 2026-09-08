import test from 'node:test';
import assert from 'node:assert/strict';
import { groupOpponentDefenses, groupRosterNflOffenses } from '../src/analysis-service.js';

const context = {
  games: [
    { id: 'one', teams: { home: { id: '25', abbreviation: 'SF' }, away: { id: '14', abbreviation: 'LAR' } } },
    { id: 'two', teams: { home: { id: '6', abbreviation: 'DAL' }, away: { id: '21', abbreviation: 'PHI' } } }
  ]
};

test('multiple rostered players on one NFL team share one offense group', () => {
  const groups = groupRosterNflOffenses([
    { playerId: 'a', name: 'Runner', position: 'RB', nflTeamId: 25, slot: 'RB' },
    { playerId: 'b', name: 'Receiver', position: 'WR', nflTeamId: 25, slot: 'BENCH' },
    { playerId: 'c', name: 'Kicker', position: 'K', nflTeamId: 25, slot: 'K' }
  ], context);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].team.abbreviation, 'SF');
  assert.equal(groups[0].players.length, 2);
  assert.deepEqual(groups[0].players.map((player) => player.lineupStatus), ['starter', 'bench']);
});

test('weekly opponent defenses are deduplicated and keep all affected players', () => {
  const offenses = groupRosterNflOffenses([
    { playerId: 'a', name: 'Runner', position: 'RB', nflTeamId: 25, slot: 'RB' },
    { playerId: 'b', name: 'Receiver', position: 'WR', nflTeamId: 25, slot: 'WR' }
  ], context);
  const defenses = groupOpponentDefenses(offenses);
  assert.equal(defenses.length, 1);
  assert.equal(defenses[0].team.abbreviation, 'LAR');
  assert.deepEqual(defenses[0].positions, ['RB', 'WR']);
  assert.equal(defenses[0].affectedPlayers.length, 2);
});
