import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_PLAYER_ELIGIBILITY_STATES,
  CURRENT_PLAYER_STATUS_NOT_VERIFIED,
  createCurrentPlayerEligibilityResolver,
  isCurrentPlayerRecommendationEligible,
  resolveCurrentPlayerEligibility
} from '../src/current-player-eligibility.js';

const player = (overrides = {}) => ({
  playerId: 'espn:1',
  platform: 'espn',
  platformPlayerId: '1',
  externalIds: { sleeper: '11', gsis: '00-0000001' },
  name: 'Test Player',
  ...overrides
});

test('supported states normalize and only verified active is recommendation eligible', () => {
  const expected = [
    ['active', true], ['inactive', false], ['practice squad', false], ['IR', false], ['PUP', false],
    ['suspended', false], ['UFA', false], ['released', false], ['retired', false], ['unknown', false]
  ];
  for (const [state, eligible] of expected) {
    const result = resolveCurrentPlayerEligibility(player({
      eligibility: { source: 'official-nfl', state, team: state === 'active' ? 'WAS' : null }
    }));
    assert.equal(result.recommendationEligible, eligible, state);
    assert.ok(CURRENT_PLAYER_ELIGIBILITY_STATES.includes(result.state));
  }
});

test('official evidence overrides ESPN and Sleeper evidence', () => {
  const resolver = createCurrentPlayerEligibilityResolver({
    sleeper: [{ playerId: 'sleeper:11', externalIds: { espn: '1' }, status: 'active', team: 'WAS' }],
    espn: [{ playerId: 'espn:1', status: 'active', team: 'WAS' }],
    official: [{ playerId: 'gsis:00-0000001', externalIds: { espn: '1', sleeper: '11' }, status: 'suspended' }]
  });
  const result = resolver.resolve(player());
  assert.equal(result.state, 'suspended');
  assert.equal(result.source, 'official');
  assert.equal(result.recommendationEligible, false);
});

test('ESPN evidence overrides conflicting Sleeper evidence', () => {
  const result = resolveCurrentPlayerEligibility(player(), {
    sleeper: [{ playerId: 'sleeper:11', status: 'retired' }],
    espn: [{ playerId: 'espn:1', status: 'active', nflTeamId: 28 }]
  });
  assert.equal(result.state, 'active');
  assert.equal(result.source, 'espn');
  assert.equal(result.recommendationEligible, true);
});

test('explicit unknown is ineligible and uses the exact user-facing message', () => {
  const result = resolveCurrentPlayerEligibility(player({
    eligibility: { source: 'official-nfl', state: 'unknown' }
  }));
  assert.equal(result.state, 'unknown');
  assert.equal(result.recommendationEligible, false);
  assert.equal(result.message, CURRENT_PLAYER_STATUS_NOT_VERIFIED);
  assert.equal(result.message, 'Current NFL status not verified');
});

test('absence of evidence is not guessed and preserves legacy fixture compatibility', () => {
  const legacy = player({ eligibility: undefined });
  const result = resolveCurrentPlayerEligibility(legacy);
  assert.equal(result.state, null);
  assert.equal(result.legacyCompatibility, true);
  assert.equal(result.recommendationEligible, true);
  assert.equal(isCurrentPlayerRecommendationEligible(legacy), true);
});

test('Austin Ekeler-style stale ACTIVE injury label with no team is not accepted as current eligibility', () => {
  const ekeler = {
    playerId: 'espn:3068267',
    name: 'Austin Ekeler',
    injuryStatus: 'ACTIVE',
    nflTeamId: null,
    seasonProjection: 207.83,
    eligibility: { source: 'espn-fantasy', state: 'active', team: null, stale: true }
  };
  const result = resolveCurrentPlayerEligibility(ekeler);
  assert.equal(result.state, 'unknown');
  assert.equal(result.recommendationEligible, false);
  assert.equal(result.message, 'Current NFL status not verified');
  assert.equal(result.reasonCode, 'stale_active_evidence');
});

test('authoritative unsigned status overrides a stale fantasy team assignment', () => {
  const resolver = createCurrentPlayerEligibilityResolver({
    espn: [{ playerId: 'espn:3068267', status: 'active', team: 'WAS', stale: true }],
    official: [{ playerId: 'espn:3068267', status: 'unsigned', observedAt: '2026-09-06T12:00:00Z' }]
  });
  const result = resolver.resolve({ playerId: 'espn:3068267', name: 'Austin Ekeler', nflTeamId: 28 });
  assert.equal(result.state, 'UFA');
  assert.equal(result.source, 'official');
  assert.equal(result.team, null);
  assert.equal(result.recommendationEligible, false);
});

test('non-official active status requires a current team and never infers UFA from absence', () => {
  const result = resolveCurrentPlayerEligibility(player(), {
    sleeper: [{ playerId: 'sleeper:11', active: true, team: null }]
  });
  assert.equal(result.state, 'unknown');
  assert.equal(result.reasonCode, 'active_team_not_verified');
  assert.notEqual(result.state, 'UFA');
});

test('explicit false active flag becomes unknown rather than guessing cut or retirement', () => {
  const result = resolveCurrentPlayerEligibility(player(), {
    sleeper: [{ playerId: 'sleeper:11', active: false, team: null }]
  });
  assert.equal(result.state, 'unknown');
  assert.equal(result.recommendationEligible, false);
  assert.equal(result.message, 'Current NFL status not verified');
});

test('durable-ID index and result cache reuse one resolution across fantasy leagues', () => {
  const resolver = createCurrentPlayerEligibilityResolver({
    official: [{
      playerId: 'gsis:00-0000001',
      externalIds: { espn: '1', sleeper: '11' },
      status: 'active',
      team: 'WAS'
    }]
  });
  const espnResult = resolver.resolve({ playerId: 'espn:1', fantasyLeagueId: 'league-a' });
  const sleeperResult = resolver.resolve({ playerId: 'sleeper:11', fantasyLeagueId: 'league-b' });
  assert.strictEqual(sleeperResult, espnResult);
  assert.equal(espnResult.recommendationEligible, true);
  assert.ok(resolver.indexSize >= 3);
  assert.ok(resolver.cacheSize >= 3);
});

test('same-authority undated conflicts remain unknown instead of being guessed', () => {
  const result = resolveCurrentPlayerEligibility(player(), {
    espn: [
      { playerId: 'espn:1', status: 'active', team: 'WAS' },
      { playerId: 'espn:1', status: 'cut' }
    ]
  });
  assert.equal(result.state, 'unknown');
  assert.equal(result.reasonCode, 'conflicting_equal_authority');
  assert.equal(result.recommendationEligible, false);
});

test('newer evidence wins within the same trust tier', () => {
  const result = resolveCurrentPlayerEligibility(player(), {
    espn: [
      { playerId: 'espn:1', status: 'active', team: 'WAS', observedAt: '2026-09-01T12:00:00Z' },
      { playerId: 'espn:1', status: 'cut', observedAt: '2026-09-06T12:00:00Z' }
    ]
  });
  assert.equal(result.state, 'cut');
  assert.equal(result.recommendationEligible, false);
});
