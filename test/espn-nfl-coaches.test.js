import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNflHeadCoaches, normalizeNflTeamAbbreviation } from '../src/providers/espn-nfl-coaches.js';

function page(rows, season = 2026) {
  return `<html><body><h2>${season} RECORD</h2><table>${rows.join('')}</table></body></html>`;
}

function row(index, abbreviation, team, coach = `Coach ${index}`) {
  return `<tr><td><a href="/nfl/coaches/_/id/${index}/${coach.toLowerCase().replaceAll(' ', '-')}">${coach}</a></td><td>${index}</td><td>--</td><td><a href="https://www.espn.com/nfl/team/_/name/${abbreviation}/${team.toLowerCase().replaceAll(' ', '-')}">${team}</a></td></tr>`;
}

test('coach parser requires and normalizes a complete 32-team table', () => {
  const abbreviations = ['ari', 'atl', 'bal', 'buf', 'car', 'chi', 'cin', 'cle', 'dal', 'den', 'det', 'gb', 'hou', 'ind', 'jax', 'kc', 'lv', 'lac', 'lar', 'mia', 'min', 'ne', 'no', 'nyg', 'nyj', 'phi', 'pit', 'sf', 'sea', 'tb', 'ten', 'wsh'];
  const rows = abbreviations.map((abbr, index) => row(index + 1, abbr, `${abbr.toUpperCase()} Team`, index === 0 ? 'O&#39;Brien &amp; Sons' : `Coach ${index + 1}`));
  const result = normalizeNflHeadCoaches(page(rows), { retrievedAt: '2026-09-02T12:00:00Z', now: '2026-09-02T12:00:00Z' });
  assert.equal(result.complete, true);
  assert.deepEqual(result.coveredRoles, ['headCoach']);
  assert.equal(result.coaches.length, 32);
  assert.equal(result.coaches[0].id, '1');
  assert.equal(result.coaches[0].name, "O'Brien & Sons");
  assert.equal(result.coaches.at(-1).team.abbreviation, 'WSH');
});

test('partial and duplicate coach tables are never marked complete', () => {
  const partial = normalizeNflHeadCoaches(page([row(1, 'chi', 'Chicago Bears'), row(2, 'chi', 'Chicago Bears', 'Other Coach')]), { retrievedAt: '2026-09-02T12:00:00Z', now: '2026-09-02T12:00:00Z' });
  assert.equal(partial.complete, false);
  assert.equal(partial.coaches.length, 1);
  assert.match(partial.issues.map((issue) => issue.code).join(' '), /coach_table_partial/);
  assert.match(partial.issues.map((issue) => issue.code).join(' '), /coach_table_duplicate_team/);
});

test('historical aliases normalize to current NFL abbreviations', () => {
  assert.equal(normalizeNflTeamAbbreviation('JAC'), 'JAX');
  assert.equal(normalizeNflTeamAbbreviation('WAS'), 'WSH');
  assert.equal(normalizeNflTeamAbbreviation('OAK'), 'LV');
});
