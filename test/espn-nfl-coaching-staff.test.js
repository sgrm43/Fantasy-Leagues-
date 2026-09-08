import test from 'node:test';
import assert from 'node:assert/strict';
import { findCachedNflCoachingStaff, getCachedNflCoachingStaff } from '../src/providers/espn-nfl-coaching-staff.js';

test('cached staff source maps verified offense and defense roles by team alias', () => {
  const feed = getCachedNflCoachingStaff({ now: () => new Date('2026-09-03T00:00:00Z') });
  const chicago = findCachedNflCoachingStaff(feed, 'chi');
  const washington = findCachedNflCoachingStaff(feed, 'WAS');
  assert.equal(feed.teams.length, 32);
  assert.equal(chicago.roles.offensiveCoordinator, 'Press Taylor');
  assert.equal(chicago.roles.offensivePlayCaller, 'Ben Johnson');
  assert.equal(chicago.roles.defensiveCoordinator, 'Dennis Allen');
  assert.equal(washington.roles.headCoach, 'Dan Quinn');
});

test('defensive play caller remains explicitly unverified', () => {
  const feed = getCachedNflCoachingStaff({ now: () => new Date('2026-09-03T00:00:00Z') });
  assert.equal(feed.coveredRoles.includes('defensivePlayCaller'), false);
  assert.equal(findCachedNflCoachingStaff(feed, 'SF').roles.defensivePlayCaller, null);
});

test('old static staff data becomes stale instead of staying current forever', () => {
  const feed = getCachedNflCoachingStaff({ now: () => new Date('2026-10-01T00:00:00Z') });
  assert.equal(feed.stale, true);
  assert.equal(feed.issues[0].code, 'staff_cache_stale');
});
