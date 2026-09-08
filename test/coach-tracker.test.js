import test from 'node:test';
import assert from 'node:assert/strict';
import { updateCoachRoleTrackerState, updateCoachTrackerState } from '../src/coach-tracker.js';

const first = { season: 2026, week: 1, teamAbbreviation: 'CHI', coachId: '10', coachName: 'Current Coach', observedAt: '2026-09-02T12:00:00Z' };

test('coach tracker begins with the first observed week and keeps the same tenure', () => {
  const started = updateCoachTrackerState(null, first);
  const repeated = updateCoachTrackerState(started.state, { ...first, week: 4, observedAt: '2026-09-24T12:00:00Z' });
  assert.equal(started.period.startWeek, 1);
  assert.equal(repeated.period.startWeek, 1);
  assert.equal(repeated.period.lastSeenWeek, 4);
  assert.equal(repeated.changed, false);
});

test('a different coach opens a new period instead of inheriting old weeks', () => {
  const started = updateCoachTrackerState(null, first);
  const changed = updateCoachTrackerState(started.state, { ...first, week: 5, coachId: '11', coachName: 'New Coach', observedAt: '2026-10-01T12:00:00Z' });
  const periods = changed.state.teams['2026:CHI'].periods;
  assert.equal(changed.changed, true);
  assert.equal(changed.previousCoach, 'Current Coach');
  assert.equal(periods[0].endWeek, 4);
  assert.equal(periods[1].startWeek, 5);
  assert.notEqual(periods[0].tenureId, periods[1].tenureId);
});

test('adding a coach id to the same name does not create a false change', () => {
  const nameOnly = updateCoachTrackerState(null, { ...first, coachId: null });
  const identified = updateCoachTrackerState(nameOnly.state, { ...first, week: 2, observedAt: '2026-09-10T12:00:00Z' });
  assert.equal(identified.changed, false);
  assert.equal(identified.period.coachId, '10');
  assert.equal(identified.state.teams['2026:CHI'].periods.length, 1);
});

test('first observation in midseason does not claim earlier weeks', () => {
  const result = updateCoachTrackerState(null, { ...first, week: 8, observedAt: '2026-10-22T12:00:00Z' });
  assert.equal(result.period.startWeek, 8);
  assert.equal(result.period.firstSeenAt, '2026-10-22T12:00:00.000Z');
});

test('an older observation cannot replace newer tracker state', () => {
  const started = updateCoachTrackerState(null, first);
  const latest = updateCoachTrackerState(started.state, { ...first, week: 6, observedAt: '2026-10-08T12:00:00Z' });
  const older = updateCoachTrackerState(latest.state, { ...first, week: 3, coachId: '99', coachName: 'Stale Coach', observedAt: '2026-09-17T12:00:00Z' });
  assert.equal(older.ignored, true);
  assert.equal(older.period.coachName, 'Current Coach');
});

test('version 1 migration preserves the existing head-coach period and tenure id', () => {
  const legacyPeriod = updateCoachTrackerState(null, first).period;
  const legacy = { version: 1, updatedAt: first.observedAt, teams: { '2026:CHI': { season: 2026, teamAbbreviation: 'CHI', periods: [legacyPeriod] } } };
  const updated = updateCoachRoleTrackerState(legacy, { season: 2026, week: 1, teamAbbreviation: 'CHI', role: 'offensiveCoordinator', coachName: 'OC One', observedAt: '2026-09-02T13:00:00Z' });
  assert.equal(updated.state.teams['2026:CHI'].periods[0].tenureId, legacyPeriod.tenureId);
  assert.equal(updated.state.teams['2026:CHI'].roleChecks.headCoach.tenureId, legacyPeriod.tenureId);
});

test('a coordinator change resets only that role period', () => {
  const head = updateCoachTrackerState(null, first);
  const oc = updateCoachRoleTrackerState(head.state, { season: 2026, week: 1, teamAbbreviation: 'CHI', role: 'offensiveCoordinator', coachName: 'OC One', observedAt: '2026-09-02T13:00:00Z' });
  const dc = updateCoachRoleTrackerState(oc.state, { season: 2026, week: 1, teamAbbreviation: 'CHI', role: 'defensiveCoordinator', coachName: 'DC One', observedAt: '2026-09-02T13:00:00Z' });
  const changed = updateCoachRoleTrackerState(dc.state, { season: 2026, week: 5, teamAbbreviation: 'CHI', role: 'offensiveCoordinator', coachName: 'OC Two', observedAt: '2026-10-01T13:00:00Z' });
  const entry = changed.state.teams['2026:CHI'];
  assert.equal(entry.periods.length, 1);
  assert.equal(entry.rolePeriods.offensiveCoordinator.length, 2);
  assert.equal(entry.rolePeriods.defensiveCoordinator.length, 1);
  assert.equal(entry.rolePeriods.offensiveCoordinator[0].endWeek, 4);
});

test('Not verified is cached without inventing or closing a role period', () => {
  const missing = updateCoachRoleTrackerState(null, { season: 2026, week: 1, teamAbbreviation: 'CHI', role: 'defensivePlayCaller', status: 'not_verified', observedAt: '2026-09-02T13:00:00Z', reasonCode: 'source_does_not_cover_role' });
  assert.equal(missing.period, null);
  assert.equal(missing.state.teams['2026:CHI'].rolePeriods.defensivePlayCaller.length, 0);
  assert.equal(missing.state.teams['2026:CHI'].roleChecks.defensivePlayCaller.status, 'not_verified');
});

test('an older same-week role observation is ignored', () => {
  const latest = updateCoachRoleTrackerState(null, { season: 2026, week: 1, teamAbbreviation: 'CHI', role: 'offensivePlayCaller', coachName: 'Caller One', observedAt: '2026-09-02T13:00:00Z' });
  const older = updateCoachRoleTrackerState(latest.state, { season: 2026, week: 1, teamAbbreviation: 'CHI', role: 'offensivePlayCaller', coachName: 'Caller Two', observedAt: '2026-09-02T12:00:00Z' });
  assert.equal(older.ignored, true);
  assert.equal(older.lastKnownPeriod.coachName, 'Caller One');
});
