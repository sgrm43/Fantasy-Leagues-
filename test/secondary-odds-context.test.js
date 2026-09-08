import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareOddsLine,
  espnHomePerspectiveSpread,
  findPlayerGame,
  getNflContext,
  mergeSecondaryOddsContext
} from '../src/context-service.js';
import { situationalContext } from '../src/analysis-service.js';
import { projectRoster } from '../src/analytics/projections.js';

const RETRIEVED_AT = '2026-09-03T19:00:00.000Z';
const KICKOFF = '2026-09-10T00:20:00.000Z';
const PRIMARY_ODDS = Object.freeze({
  provider: { id: '58', name: 'ESPN BET' },
  details: 'SF -3.5',
  spread: -3.5,
  total: 47.5,
  favoriteTeamId: '25',
  home: { favorite: true, underdog: false, moneyLine: -165, spreadPrice: -110 },
  away: { favorite: false, underdog: true, moneyLine: 140, spreadPrice: -110 }
});

function primaryContext({ odds = PRIMARY_ODDS, safeguards } = {}) {
  const missingOdds = odds == null;
  return {
    provider: 'espn', season: 2026, week: 1, seasonType: 2, sourceUrl: 'https://example.test/espn',
    retrievedAt: RETRIEVED_AT, stale: false,
    games: [{
      id: 'game-1', kickoff: KICKOFF, indoor: true,
      teams: {
        home: { id: '25', name: 'San Francisco 49ers', abbreviation: 'SF' },
        away: { id: '14', name: 'Los Angeles Rams', abbreviation: 'LAR' }
      },
      odds,
      retrievedAt: RETRIEVED_AT,
      stale: false,
      missing: missingOdds ? ['odds'] : [],
      issues: missingOdds ? [{ code: 'odds_unavailable', field: 'odds', message: 'Primary odds unavailable.' }] : []
    }],
    missing: missingOdds ? ['games.game-1.odds'] : [],
    issues: missingOdds ? [{ code: 'odds_unavailable', field: 'odds', gameId: 'game-1', message: 'Primary odds unavailable.' }] : [],
    ...(safeguards ? { safeguards } : {})
  };
}

function secondaryResult({ spread = -3, total = 48, games, available = true } = {}) {
  return {
    provider: 'the-odds-api-v4', available, status: available ? 'available' : 'unavailable',
    reason: available ? null : 'provider_error', retrievedAt: RETRIEVED_AT,
    games: games || (available ? [{
      eventId: 'odds-1', homeTeam: 'San Francisco 49ers', awayTeam: 'Los Angeles Rams', kickoffTime: KICKOFF,
      consensusSpread: spread, consensusTotal: total, bookmakerCount: 4,
      spreadRange: spread == null ? null : { min: spread - 0.5, max: spread + 0.5 },
      totalRange: total == null ? null : { min: total - 0.5, max: total + 0.5 },
      latestBookmakerUpdate: '2026-09-03T18:55:00.000Z'
    }] : []),
    quota: { requestsRemaining: 499, requestsUsed: 1, requestsLast: 1 }
  };
}

test('both sources retain ESPN lines and attach compact secondary context', () => {
  const merged = mergeSecondaryOddsContext(primaryContext(), secondaryResult());
  const odds = merged.games[0].odds;
  assert.equal(odds.provider.name, 'ESPN BET');
  assert.equal(odds.details, 'SF -3.5');
  assert.equal(odds.spread, -3.5);
  assert.equal(odds.total, 47.5);
  assert.equal(odds.secondary.source, 'the-odds-api-v4');
  assert.equal(odds.secondary.bookmakerCount, 4);
  assert.deepEqual(odds.lineSources, { spread: 'espn', total: 'espn' });
  assert.equal(odds.integration.primaryRemainsAuthoritative, true);
  assert.equal(JSON.stringify(merged).includes('requestsRemaining'), false);
});

test('close lines are confirmed at the inclusive thresholds', () => {
  const merged = mergeSecondaryOddsContext(primaryContext(), secondaryResult({ spread: -3, total: 48.5 }));
  assert.equal(merged.games[0].odds.comparison.status, 'confirmed');
  assert.deepEqual(compareOddsLine(47.5, 48.5, 'total'), { status: 'confirmed', difference: 1, primary: 47.5, secondary: 48.5 });
  assert.deepEqual(compareOddsLine(-3.5, -3, 'spread'), { status: 'confirmed', difference: 0.5, primary: -3.5, secondary: -3 });
  assert.equal(compareOddsLine(47.5, 49.5, 'total').status, 'minor_difference');
  assert.equal(compareOddsLine(-3.5, -4.5, 'spread').status, 'minor_difference');
});

test('large line differences are marked as disagreement', () => {
  const merged = mergeSecondaryOddsContext(primaryContext(), secondaryResult({ spread: -1.5, total: 51 }));
  const comparison = merged.games[0].odds.comparison;
  assert.equal(comparison.status, 'disagreement');
  assert.equal(comparison.spread.status, 'disagreement');
  assert.equal(comparison.total.status, 'disagreement');
});

test('secondary lines become a clearly identified fallback when ESPN odds are unavailable', () => {
  const merged = mergeSecondaryOddsContext(primaryContext({ odds: null }), secondaryResult({ spread: -3, total: 48 }));
  const game = merged.games[0];
  assert.equal(game.odds.provider.name, 'The Odds API consensus');
  assert.equal(game.odds.details, 'The Odds API consensus: SF -3');
  assert.equal(game.odds.spread, -3);
  assert.equal(game.odds.total, 48);
  assert.deepEqual(game.odds.lineSources, { spread: 'the-odds-api-v4', total: 'the-odds-api-v4' });
  assert.equal(game.odds.integration.mode, 'fallback');
  assert.equal(game.odds.comparison.status, null);
  assert.deepEqual(game.missing, []);
  assert.deepEqual(game.issues, []);
  assert.deepEqual(merged.missing, []);
  assert.deepEqual(merged.issues, []);
});

test('an unavailable secondary provider leaves current ESPN behavior unchanged', () => {
  const primary = primaryContext();
  assert.strictEqual(mergeSecondaryOddsContext(primary, secondaryResult({ available: false })), primary);
});

test('both betting sources unavailable preserve a clean null', () => {
  const primary = primaryContext({ odds: null });
  const merged = mergeSecondaryOddsContext(primary, secondaryResult({ available: false }));
  assert.strictEqual(merged, primary);
  assert.equal(merged.games[0].odds, null);
  assert.deepEqual(merged.games[0].missing, ['odds']);
});

test('one cached context reuses a single secondary fetch across multiple roster players', async () => {
  let scoreboardCalls = 0;
  let secondaryCalls = 0;
  const fresh = { ...primaryContext(), season: 2097, week: 7, retrievedAt: '2097-09-03T19:00:00.000Z' };
  const options = {
    scoreboardFetcher: async () => { scoreboardCalls += 1; return structuredClone(fresh); },
    secondaryOddsFetcher: async () => { secondaryCalls += 1; return secondaryResult(); }
  };
  const first = await getNflContext(2097, 7, options);
  const second = await getNflContext(2097, 7, options);
  assert.equal(findPlayerGame({ playerId: 'qb', nflTeamId: 25 }, first)?.id, 'game-1');
  assert.equal(findPlayerGame({ playerId: 'wr', nflTeam: 'SF' }, first)?.id, 'game-1');
  assert.equal(findPlayerGame({ playerId: 'rb', nflTeamId: 14 }, second)?.id, 'game-1');
  assert.equal(scoreboardCalls, 1);
  assert.equal(secondaryCalls, 1);
});

test('ESPN away-favorite spread is compared from the home perspective', () => {
  const awayFavorite = {
    ...PRIMARY_ODDS,
    details: 'LAR -2.5', spread: -2.5, favoriteTeamId: '14',
    home: { ...PRIMARY_ODDS.home, favorite: false, underdog: true },
    away: { ...PRIMARY_ODDS.away, favorite: true, underdog: false }
  };
  const primary = primaryContext({ odds: awayFavorite });
  const merged = mergeSecondaryOddsContext(primary, secondaryResult({ spread: 2.5, total: 47.5 }));
  assert.equal(espnHomePerspectiveSpread(primary.games[0]), 2.5);
  assert.equal(merged.games[0].odds.spread, -2.5);
  assert.equal(merged.games[0].odds.primary.homeSpread, 2.5);
  assert.equal(merged.games[0].odds.comparison.spread.status, 'confirmed');
});

test('missing keys and secondary API failures cannot break ESPN context', async () => {
  const primary = primaryContext();
  assert.strictEqual(mergeSecondaryOddsContext(primary, { available: false, reason: 'missing_api_key', games: [] }), primary);
  const result = await getNflContext(2098, 8, {
    force: true,
    scoreboardFetcher: async () => structuredClone(primary),
    secondaryOddsFetcher: async () => { throw new Error('secondary failed'); }
  });
  assert.deepEqual(result, primary);
  assert.equal(result.stale, false);
});

test('secondary odds context leaves projection values unchanged', () => {
  const player = { playerId: 'p1', name: 'Quarterback', position: 'QB', nflTeamId: 25, projection: 20, injuryStatus: null };
  const primary = primaryContext();
  const merged = mergeSecondaryOddsContext(primary, secondaryResult({ spread: -7, total: 55 }));
  const options = { provenance: { source: 'test', retrievedAt: RETRIEVED_AT }, now: new Date(RETRIEVED_AT) };
  const before = projectRoster([player], { ...options, byPlayer: { p1: situationalContext(player, primary) } });
  const after = projectRoster([player], { ...options, byPlayer: { p1: situationalContext(player, merged) } });
  assert.deepEqual(after, before);
});

test('read-only safeguards survive secondary context merging', () => {
  const safeguards = { readOnly: true, transactionsPerformed: false };
  const primary = primaryContext({ safeguards });
  const merged = mergeSecondaryOddsContext(primary, secondaryResult());
  assert.deepEqual(merged.safeguards, safeguards);
  assert.equal(merged.games[0].odds.integration.weighted, false);
});
