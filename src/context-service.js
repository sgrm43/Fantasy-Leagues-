import { fetchNflScoreboardContext } from './providers/espn-nfl-scoreboard.js';
import { fetchNflInjuryContext } from './providers/espn-nfl-injuries.js';
import { createSleeperHistoricalUsageProvider } from './providers/sleeper-historical-usage.js';
import { fetchNflTeamTrends } from './providers/espn-nfl-team-trends.js';
import { createSleeperOpponentPositionProvider, selectOpponentHistoryWindow } from './providers/sleeper-opponent-position.js';
import { fetchNflHeadCoaches, normalizeNflTeamAbbreviation } from './providers/espn-nfl-coaches.js';
import { findCachedNflCoachingStaff, getCachedNflCoachingStaff } from './providers/espn-nfl-coaching-staff.js';
import { createNflverseTeamTendencyProvider } from './providers/nflverse-team-tendencies.js';
import { createNflverseNextGenStatsProvider, NEXT_GEN_LEARNING_MESSAGE } from './providers/nflverse-next-gen-stats.js';
import { createNwsGameWeatherProvider } from './providers/nws-nfl-weather.js';
import { createTheOddsApiProvider } from './providers/the-odds-api.js';
import { COACHING_ROLES, getTrackedCoachRole, getTrackedHeadCoach, observeCoachRoles, observeHeadCoaches } from './coach-tracker.js';

const cache = new Map();
let injuryCache = null;
const usageProvider = createSleeperHistoricalUsageProvider();
const opponentProvider = createSleeperOpponentPositionProvider();
const nflverseProvider = createNflverseTeamTendencyProvider();
const nflverseNextGenProvider = createNflverseNextGenStatsProvider();
const nwsWeatherProvider = createNwsGameWeatherProvider();
const secondaryOddsProvider = createTheOddsApiProvider();
const trendCache = new Map();
let coachCache = null;
let coachPending = null;
const coachObservationCache = new Map();
const staffCache = new Map();
const staffObservationCache = new Map();
const MAX_AGE_MS = 15 * 60_000;
const COACH_CACHE_AGE_MS = 60 * 60_000;
const ROLE_LABELS = Object.freeze({
  headCoach: 'Head coach',
  offensiveCoordinator: 'Offensive coordinator',
  offensivePlayCaller: 'Offensive play caller',
  defensiveCoordinator: 'Defensive coordinator',
  defensivePlayCaller: 'Defensive play caller'
});
const ESPN_TEAM_IDS = Object.freeze({
  1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN',
  11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ',
  21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WSH', 29: 'CAR', 30: 'JAX',
  33: 'BAL', 34: 'HOU'
});
export const ODDS_COMPARISON_THRESHOLDS = Object.freeze({
  total: Object.freeze({ confirmedMax: 1, minorDifferenceMax: 3 }),
  spread: Object.freeze({ confirmedMax: 0.5, minorDifferenceMax: 1.5 })
});
const ODDS_STATUS_PRIORITY = Object.freeze({ confirmed: 0, minor_difference: 1, disagreement: 2 });
const ODDS_MATCH_WINDOW_MS = 24 * 60 * 60_000;

export async function getNflContext(season, week, {
  force = false,
  scoreboardFetcher = fetchNflScoreboardContext,
  secondaryOddsFetcher = (options) => secondaryOddsProvider.fetch(options)
} = {}) {
  const key = `${season}:${week}`;
  const saved = cache.get(key);
  if (!force && saved && Date.now() - Date.parse(saved.retrievedAt) < MAX_AGE_MS) return saved;
  try {
    const primaryContext = await scoreboardFetcher({ season: Number(season), week: Number(week) });
    const context = await mergeAvailableSecondaryOdds(primaryContext, secondaryOddsFetcher, { season, week });
    cache.set(key, context);
    return context;
  } catch (error) {
    if (saved) return { ...saved, stale: true, issues: [...saved.issues, { code: 'refresh_failed', field: 'context', message: error.message }] };
    return { provider: 'espn', season: Number(season), week: Number(week), games: [], retrievedAt: null, stale: true, missing: ['games'], issues: [{ code: 'context_unavailable', field: 'games', message: error.message }] };
  }
}

/**
 * Add independently sourced line context without changing ESPN's priority or
 * feeding betting data into any projection calculation.
 */
export function mergeSecondaryOddsContext(context, secondaryResult) {
  if (!Array.isArray(context?.games) || secondaryResult?.available !== true || !Array.isArray(secondaryResult.games)) return context;
  let changed = false;
  const games = context.games.map((game) => {
    const secondaryGame = findExactSecondaryOddsGame(game, secondaryResult.games);
    if (!secondaryGame) return game;
    const merged = mergeGameOdds(game, secondaryGame, secondaryResult.retrievedAt);
    if (merged !== game) changed = true;
    return merged;
  });
  if (!changed) return context;
  return reconcileContextOddsTracking({ ...context, games });
}

/** Convert ESPN's favorite-oriented line to a home-team-oriented line. */
export function espnHomePerspectiveSpread(game) {
  const spread = finiteOddsNumber(game?.odds?.spread);
  if (spread == null) return null;
  if (spread === 0) return 0;
  const favoriteTeamId = idText(game?.odds?.favoriteTeamId);
  const homeTeamId = idText(game?.teams?.home?.id);
  const awayTeamId = idText(game?.teams?.away?.id);
  if (!favoriteTeamId || !homeTeamId || !awayTeamId || homeTeamId === awayTeamId) return null;
  if (favoriteTeamId === homeTeamId) return cleanOddsNumber(-Math.abs(spread));
  if (favoriteTeamId === awayTeamId) return cleanOddsNumber(Math.abs(spread));
  return null;
}

/** Apply the documented absolute-difference bands without weighting either line. */
export function compareOddsLine(primaryValue, secondaryValue, market) {
  const primary = finiteOddsNumber(primaryValue);
  const secondary = finiteOddsNumber(secondaryValue);
  const thresholds = ODDS_COMPARISON_THRESHOLDS[market];
  if (primary == null || secondary == null || !thresholds) return null;
  const difference = cleanOddsNumber(Math.abs(primary - secondary));
  const status = difference <= thresholds.confirmedMax
    ? 'confirmed'
    : difference <= thresholds.minorDifferenceMax
      ? 'minor_difference'
      : 'disagreement';
  return { status, difference, primary, secondary };
}

async function mergeAvailableSecondaryOdds(context, secondaryOddsFetcher, request) {
  if (!Array.isArray(context?.games) || !context.games.length) return context;
  try {
    const secondary = await secondaryOddsFetcher({ season: Number(request.season), week: Number(request.week) });
    return mergeSecondaryOddsContext(context, secondary);
  } catch {
    return context;
  }
}

function findExactSecondaryOddsGame(game, secondaryGames) {
  const home = normalizeOddsTeamName(game?.teams?.home?.name);
  const away = normalizeOddsTeamName(game?.teams?.away?.name);
  const kickoff = Date.parse(game?.kickoff);
  if (!home || !away || !Number.isFinite(kickoff)) return null;
  const matches = secondaryGames.filter((candidate) => {
    if (normalizeOddsTeamName(candidate?.homeTeam) !== home || normalizeOddsTeamName(candidate?.awayTeam) !== away) return false;
    const secondaryKickoff = Date.parse(candidate?.kickoffTime);
    return Number.isFinite(secondaryKickoff) && Math.abs(secondaryKickoff - kickoff) <= ODDS_MATCH_WINDOW_MS;
  });
  return matches.length === 1 ? matches[0] : null;
}

function mergeGameOdds(game, secondaryGame, secondaryRetrievedAt) {
  const original = game?.odds && typeof game.odds === 'object' ? game.odds : null;
  const primarySpread = finiteOddsNumber(original?.spread);
  const primaryHomeSpread = espnHomePerspectiveSpread(game);
  const primaryTotal = finiteOddsNumber(original?.total);
  const secondarySpread = finiteOddsNumber(secondaryGame?.consensusSpread);
  const secondaryTotal = finiteOddsNumber(secondaryGame?.consensusTotal);
  if (secondarySpread == null && secondaryTotal == null) return game;

  const returnedSpread = primarySpread ?? secondarySpread;
  const returnedTotal = primaryTotal ?? secondaryTotal;
  const hasPrimaryLine = primarySpread != null || primaryTotal != null;
  const fallbackUsed = (primarySpread == null && secondarySpread != null) || (primaryTotal == null && secondaryTotal != null);
  const spreadComparison = compareOddsLine(primaryHomeSpread, secondarySpread, 'spread');
  const totalComparison = compareOddsLine(primaryTotal, secondaryTotal, 'total');
  const comparisonStatus = overallOddsStatus([spreadComparison?.status, totalComparison?.status]);
  const secondary = {
    source: 'the-odds-api-v4',
    eventId: idText(secondaryGame.eventId),
    homeTeam: secondaryGame.homeTeam || null,
    awayTeam: secondaryGame.awayTeam || null,
    kickoffTime: validIso(secondaryGame.kickoffTime),
    homeSpread: secondarySpread,
    total: secondaryTotal,
    bookmakerCount: nonNegativeIntegerOrNull(secondaryGame.bookmakerCount),
    spreadRange: finiteRangeOrNull(secondaryGame.spreadRange),
    totalRange: finiteRangeOrNull(secondaryGame.totalRange),
    sourceUpdatedAt: validIso(secondaryGame.latestBookmakerUpdate),
    retrievedAt: validIso(secondaryRetrievedAt)
  };
  const primary = original ? {
    source: 'espn',
    spread: primarySpread,
    homeSpread: primaryHomeSpread,
    total: primaryTotal,
    details: original.details || null,
    provider: original.provider || null,
    retrievedAt: validIso(game.retrievedAt)
  } : null;
  const provider = hasPrimaryLine
    ? original.provider
    : { id: null, name: 'The Odds API consensus' };
  const details = hasPrimaryLine && original.details
    ? original.details
    : secondaryOddsDetails(game, secondarySpread);
  const odds = {
    ...(original || {}),
    provider,
    details,
    spread: returnedSpread,
    total: returnedTotal,
    favoriteTeamId: primarySpread != null
      ? original.favoriteTeamId
      : secondaryFavoriteTeamId(game, secondarySpread),
    home: original?.home || null,
    away: original?.away || null,
    lineSources: {
      spread: primarySpread != null ? 'espn' : secondarySpread != null ? 'the-odds-api-v4' : null,
      total: primaryTotal != null ? 'espn' : secondaryTotal != null ? 'the-odds-api-v4' : null
    },
    primary,
    secondary,
    comparison: {
      status: comparisonStatus,
      spread: spreadComparison,
      total: totalComparison
    },
    integration: {
      mode: fallbackUsed ? (hasPrimaryLine ? 'partial_fallback' : 'fallback') : 'confirmation',
      primaryRemainsAuthoritative: hasPrimaryLine,
      weighted: false
    }
  };
  return reconcileGameOddsTracking({ ...game, odds });
}

function overallOddsStatus(statuses) {
  const valid = statuses.filter((status) => status in ODDS_STATUS_PRIORITY);
  return valid.length ? valid.sort((a, b) => ODDS_STATUS_PRIORITY[b] - ODDS_STATUS_PRIORITY[a])[0] : null;
}

function secondaryOddsDetails(game, homeSpread) {
  if (homeSpread == null) return 'The Odds API consensus';
  if (homeSpread === 0) return 'The Odds API consensus: pick\'em';
  const favorite = homeSpread < 0 ? game?.teams?.home : game?.teams?.away;
  const name = favorite?.abbreviation || favorite?.name || (homeSpread < 0 ? 'Home' : 'Away');
  return `The Odds API consensus: ${name} -${Math.abs(homeSpread)}`;
}

function secondaryFavoriteTeamId(game, homeSpread) {
  if (homeSpread == null || homeSpread === 0) return null;
  return idText(homeSpread < 0 ? game?.teams?.home?.id : game?.teams?.away?.id);
}

function reconcileGameOddsTracking(game) {
  const recoveredFields = new Set();
  if (game.odds) recoveredFields.add('odds');
  if (finiteOddsNumber(game.odds?.spread) != null) recoveredFields.add('odds.spread');
  if (finiteOddsNumber(game.odds?.total) != null) recoveredFields.add('odds.total');
  const recoveredCodes = new Set([
    ...(recoveredFields.has('odds') ? ['odds_unavailable'] : []),
    ...(recoveredFields.has('odds.spread') ? ['spread_unavailable'] : []),
    ...(recoveredFields.has('odds.total') ? ['total_unavailable'] : [])
  ]);
  return {
    ...game,
    missing: Array.isArray(game.missing) ? game.missing.filter((field) => !recoveredFields.has(field)) : game.missing,
    issues: Array.isArray(game.issues) ? game.issues.filter((issue) => !recoveredCodes.has(issue?.code)) : game.issues
  };
}

function reconcileContextOddsTracking(context) {
  const gamesById = new Map(context.games.map((game) => [idText(game.id) || 'unknown', game]));
  const missing = Array.isArray(context.missing) ? context.missing.filter((field) => {
    const match = /^games\.([^.]+)\.(odds(?:\.(?:spread|total))?)$/.exec(field);
    if (!match) return true;
    const game = gamesById.get(match[1]);
    if (!game) return true;
    return match[2] === 'odds'
      ? !game.odds
      : match[2] === 'odds.spread'
        ? finiteOddsNumber(game.odds?.spread) == null
        : finiteOddsNumber(game.odds?.total) == null;
  }) : context.missing;
  const issues = Array.isArray(context.issues) ? context.issues.filter((issue) => {
    const game = gamesById.get(idText(issue?.gameId) || 'unknown');
    if (!game) return true;
    if (issue.code === 'odds_unavailable') return !game.odds;
    if (issue.code === 'spread_unavailable') return finiteOddsNumber(game.odds?.spread) == null;
    if (issue.code === 'total_unavailable') return finiteOddsNumber(game.odds?.total) == null;
    return true;
  }) : context.issues;
  return { ...context, missing, issues };
}

function normalizeOddsTeamName(value) {
  const text = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return text || null;
}

function finiteOddsNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanOddsNumber(value) {
  const rounded = Math.round(Number(value) * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function finiteRangeOrNull(range) {
  const min = finiteOddsNumber(range?.min);
  const max = finiteOddsNumber(range?.max);
  return min == null || max == null ? null : { min, max };
}

function nonNegativeIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function validIso(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function idText(value) {
  return value == null || String(value).trim() === '' ? null : String(value).trim();
}

/** Resolve official weather only for the already-deduplicated roster games. */
export async function getNwsWeatherContext(season, week, games) {
  try {
    return await nwsWeatherProvider.fetch({ season, week, games });
  } catch (error) {
    return {
      provider: 'nws', available: false, season: Number(season), week: Number(week), games: [], retrievedAt: null, stale: true,
      issues: [{ code: 'nws_unavailable', message: error.message }], decisionUse: 'descriptive_only', projectionsAdjusted: false,
      safeguards: { readOnly: true, transactionsPerformed: false }
    };
  }
}

export async function getNflInjuries({ force = false } = {}) {
  if (!force && injuryCache && Date.now() - Date.parse(injuryCache.retrievedAt) < MAX_AGE_MS) return injuryCache;
  try {
    injuryCache = await fetchNflInjuryContext(); return injuryCache;
  } catch (error) {
    if (injuryCache) return { ...injuryCache, stale: true, issues: [...injuryCache.issues, { code: 'refresh_failed', field: 'injuries', message: error.message }] };
    return { provider: 'espn', injuries: [], retrievedAt: null, stale: true, missing: ['injuries'], issues: [{ code: 'injuries_unavailable', field: 'injuries', message: error.message }] };
  }
}

export async function getHistoricalUsage(season, currentWeek, players) {
  const numericSeason = Number(season); const numericWeek = Number(currentWeek);
  const historySeason = numericWeek <= 1 ? numericSeason - 1 : numericSeason;
  const weeks = numericWeek <= 1 ? [12, 13, 14, 15, 16, 17, 18] : Array.from({ length: Math.min(8, numericWeek - 1) }, (_, index) => numericWeek - Math.min(8, numericWeek - 1) + index);
  try {
    return await usageProvider.fetch({ season: historySeason, weeks, players });
  } catch (error) {
    return { provider: 'sleeper', season: historySeason, requestedWeeks: weeks, players: [], unresolvedPlayers: players.map((player) => ({ requestedPlayerId: player.playerId, reason: 'provider_unavailable' })), retrievedAt: null, stale: true, missing: ['gameLogs'], issues: [{ code: 'usage_unavailable', message: error.message }] };
  }
}

export async function getNflHeadCoaches({ force = false } = {}) {
  const fresh = coachCache && Date.now() - Date.parse(coachCache.retrievedAt) < COACH_CACHE_AGE_MS;
  if (!force && fresh) return coachCache;
  if (!force && coachPending) return coachPending;
  coachPending = (async () => {
    try {
      coachCache = await fetchNflHeadCoaches();
      return coachCache;
    } catch (error) {
      if (coachCache) {
        return { ...coachCache, stale: true, issues: [...coachCache.issues, { code: 'coach_refresh_failed', field: 'coaches', message: error.message }] };
      }
      return { provider: 'espn', season: null, complete: false, coaches: [], sourceUrl: 'https://www.espn.com/nfl/coaches', retrievedAt: null, stale: true, missing: ['coaches'], issues: [{ code: 'coaches_unavailable', field: 'coaches', message: error.message }], limitations: ['Current head-coach identity is unavailable and is not guessed.'] };
    } finally {
      coachPending = null;
    }
  })();
  return coachPending;
}

/** Return the one verified staff source already cached for this season. */
export function getNflCoachingStaff(season) {
  const key = Number(season);
  if (!staffCache.has(key)) staffCache.set(key, getCachedNflCoachingStaff({ season: key }));
  return staffCache.get(key);
}

export function findNflHeadCoach(coachFeed, teamAbbreviation) {
  const team = normalizeNflTeamAbbreviation(teamAbbreviation);
  return team ? coachFeed?.coaches?.find((coach) => normalizeNflTeamAbbreviation(coach.team?.abbreviation) === team) || null : null;
}

export async function getNflCoachingContext(season, currentWeek, { teamAbbreviation, coachFeed, staffFeed } = {}) {
  const normalizedSeason = Number(season);
  const normalizedWeek = Number(currentWeek);
  const team = normalizeNflTeamAbbreviation(teamAbbreviation);
  if (!team) return unavailableCoachingContext(normalizedSeason, normalizedWeek, null, coachFeed, 'team_unavailable', 'The player\'s NFL team could not be identified.');
  const feed = coachFeed || await getNflHeadCoaches();
  const verifiedStaffFeed = staffFeed || getNflCoachingStaff(normalizedSeason);
  const feedUsable = feed?.complete === true && feed?.stale !== true && Number(feed.season) === normalizedSeason;
  const listed = feedUsable ? findNflHeadCoach(feed, team) : null;

  if (listed) {
    try {
      const trackedRows = await observeVerifiedCoachFeed(feed, normalizedSeason, normalizedWeek);
      const tracked = trackedRows.find((row) => row.teamAbbreviation === team);
      if (!tracked) throw new Error(`${team}'s verified coach could not be recorded.`);
      await observeVerifiedStaffFeed(verifiedStaffFeed, normalizedSeason, normalizedWeek, team, listed.name);
      const roles = await readRoleViews(normalizedSeason, team);
      return {
        provider: feed.provider,
        available: true,
        season: normalizedSeason,
        week: normalizedWeek,
        team: listed.team,
        headCoach: { id: listed.id || null, name: listed.name, role: 'Head coach' },
        tenure: tracked.period,
        roles,
        changeDetected: tracked.changed,
        previousHeadCoach: tracked.previousCoach,
        trackerStatus: normalizedWeek <= tracked.period.startWeek ? 'learning' : 'tracking',
        sourceUrl: feed.sourceUrl,
        retrievedAt: feed.retrievedAt,
        stale: false,
        issues: [],
        limitations: [...(feed.limitations || []), ...(verifiedStaffFeed?.limitations || [])]
      };
    } catch (error) {
      const saved = await safeTrackedCoach(normalizedSeason, team);
      if (saved) return trackedFallback(saved, normalizedWeek, feed, error.message, await readRoleViews(normalizedSeason, team, { stale: true }));
      return unavailableCoachingContext(normalizedSeason, normalizedWeek, team, feed, 'coach_tracker_unavailable', error.message, await readRoleViews(normalizedSeason, team, { stale: true }));
    }
  }

  const saved = await safeTrackedCoach(normalizedSeason, team);
  if (saved) return trackedFallback(saved, normalizedWeek, feed, coachFeedIssue(feed, normalizedSeason, team), await readRoleViews(normalizedSeason, team, { stale: true }));
  return unavailableCoachingContext(normalizedSeason, normalizedWeek, team, feed, 'coach_not_confirmed', coachFeedIssue(feed, normalizedSeason, team), await readRoleViews(normalizedSeason, team, { stale: true }));
}

/**
 * Build a conservative period for descriptive statistics. Each underlying role
 * keeps its own history; this window begins at the latest verified role change.
 */
export function deriveCoachingAnalysisPeriod(coachingContext, side = 'offense') {
  const roleNames = side === 'defense'
    ? ['headCoach', 'defensiveCoordinator', 'defensivePlayCaller']
    : ['headCoach', 'offensiveCoordinator', 'offensivePlayCaller'];
  const basis = roleNames.map((role) => coachingContext?.roles?.[role]).filter((role) => role?.status === 'verified' && role.period);
  if (!basis.length) return null;
  const startWeek = Math.max(...basis.map((role) => Number(role.period.startWeek || 1)));
  const firstSeenAt = latestIso(basis.map((role) => role.period.firstSeenAt));
  return {
    tenureId: basis.map((role) => `${role.role}:${role.period.tenureId}`).join('|'),
    startWeek,
    firstSeenAt,
    boundaryConfidence: 'latest-first-observed-role-boundary',
    side,
    basisRoles: basis.map((role) => ({ role: role.role, label: role.label, name: role.name, tenureId: role.period.tenureId, startWeek: role.period.startWeek, firstSeenAt: role.period.firstSeenAt }))
  };
}

export async function getNflTeamTrend(season, currentWeek, { teamId, teamAbbreviation, tenure } = {}) {
  if (!teamId && !teamAbbreviation) return null;
  const sourceSeason = Number(season);
  const normalizedCurrentWeek = Number(currentWeek);
  const startWeek = Math.max(1, Number(tenure?.startWeek || normalizedCurrentWeek));
  if (normalizedCurrentWeek <= startWeek) return learningTeamTrend(sourceSeason, normalizedCurrentWeek, { teamId, teamAbbreviation, tenure });
  const key = `${sourceSeason}:${normalizedCurrentWeek}:${teamId || teamAbbreviation}:${tenure?.tenureId || startWeek}`;
  const saved = trendCache.get(key);
  if (saved && Date.now() - Date.parse(saved.generatedAt) < 6 * 60 * 60_000) return saved;
  try {
    const options = { season: sourceSeason, teamId, teamAbbreviation, window: Math.min(18, normalizedCurrentWeek - startWeek), beforeWeek: normalizedCurrentWeek, fromWeek: startWeek, observedAfter: tenure?.firstSeenAt || null };
    const trend = await fetchNflTeamTrends(options);
    const tracked = { ...trend, stale: false, tracker: { seasonOnly: true, tenureId: tenure?.tenureId || null, startWeek, observedAfter: tenure?.firstSeenAt || null, throughWeek: normalizedCurrentWeek - 1, boundaryConfidence: tenure?.boundaryConfidence || 'first-observed-not-official-effective-time', basisRoles: tenure?.basisRoles || [] } };
    trendCache.set(key, tracked); return tracked;
  } catch (error) {
    if (saved) return { ...saved, stale: true, issues: [...saved.issues, { code: 'trend_refresh_failed', message: error.message }] };
    return { available: false, learning: false, stale: true, team: { id: teamId || null, abbreviation: teamAbbreviation || null }, generatedAt: new Date().toISOString(), games: [], metrics: {}, tracker: { seasonOnly: true, tenureId: tenure?.tenureId || null, startWeek, observedAfter: tenure?.firstSeenAt || null, throughWeek: normalizedCurrentWeek - 1, basisRoles: tenure?.basisRoles || [] }, missing: ['games'], issues: [{ code: 'trend_unavailable', message: error.message }] };
  }
}

/** Fetch the league-wide nflverse file once, then return only requested teams. */
export async function getNflverseTeamTendencies(season, currentWeek, { teams = [], periods = {} } = {}) {
  try {
    return await nflverseProvider.fetch({ season, currentWeek, teams, periods });
  } catch (error) {
    return {
      provider: 'nflverse', model: 'roster-relevant-offensive-tendencies', available: false,
      season: Number(season), currentWeek: Number(currentWeek), teams: teams.map((team) => ({ team: normalizeNflTeamAbbreviation(team?.abbreviation || team), available: false, learning: true, metrics: {}, weekly: [], recentChange: { available: false, label: 'Not enough weekly data' }, issues: [{ code: 'nflverse_unavailable', message: error.message }] })),
      cache: { datasetKey: null, dataVersion: null, status: 'failed' }, sourceUrl: null, retrievedAt: null, stale: true,
      issues: [{ code: 'nflverse_unavailable', message: error.message }], limitations: ['No nflverse tendency is guessed when the source cannot be loaded.']
    };
  }
}

/** Fetch each all-season NGS stat family once, then return only selected roster players. */
export async function getNflverseNextGenStats(season, currentWeek, players = []) {
  try {
    return await nflverseNextGenProvider.fetch({ season, currentWeek, players });
  } catch (error) {
    const selected = players.filter((player) => ['QB', 'RB', 'WR', 'TE'].includes(String(player?.position || '').toUpperCase()));
    return {
      provider: 'nflverse', model: 'roster-relevant-next-gen-stats', season: Number(season), currentWeek: Number(currentWeek),
      available: false, historicalReferenceAvailable: false,
      players: selected.map((player) => ({
        requestedPlayerId: player.requestedPlayerId || player.playerId,
        name: player.name || null,
        position: String(player.position).toUpperCase(),
        nflTeam: normalizeNflTeamAbbreviation(player.nflTeam),
        playerGsisId: player.gsisId || null,
        resolvedBy: player.gsisId ? 'gsis_id' : null,
        available: false,
        learning: true,
        status: Number(season) === 2026 ? NEXT_GEN_LEARNING_MESSAGE : `Learning — no ${season} Next Gen Stats sample yet`,
        current: null,
        reference: null,
        issues: [{ code: 'nflverse_ngs_unavailable', message: error.message }]
      })),
      cache: { datasets: [] }, sourceUrls: [], retrievedAt: null, stale: true,
      issues: [{ code: 'nflverse_ngs_unavailable', message: error.message }], decisionUse: 'descriptive_only', projectionsAdjusted: false,
      safeguards: { readOnly: true, transactionsPerformed: false },
      limitations: ['No Next Gen metric is guessed when nflverse cannot be loaded.']
    };
  }
}

export async function getOpponentPositionContext(season, currentWeek, { defense, position, rawScoringRules = null, period = null } = {}) {
  const selectedWindow = selectOpponentHistoryWindow(season, currentWeek);
  const currentSeasonPeriod = Number(selectedWindow.season) === Number(season) && period;
  const weeks = currentSeasonPeriod ? selectedWindow.weeks.filter((week) => week >= Number(period.startWeek || 1)) : selectedWindow.weeks;
  const window = { ...selectedWindow, weeks };
  const attribution = {
    toCurrentStaff: Boolean(currentSeasonPeriod && weeks.length),
    periodId: currentSeasonPeriod ? period.tenureId || null : null,
    startWeek: currentSeasonPeriod ? period.startWeek || null : null,
    basisRoles: currentSeasonPeriod ? period.basisRoles || [] : [],
    note: selectedWindow.basis === 'prior-season historical baseline'
      ? 'Historical team-defense baseline; it is not attributed to the current defensive staff.'
      : currentSeasonPeriod ? 'Filtered to the current verified defensive-staff period.' : 'Current-season team-defense context; staff attribution is not available.'
  };
  if (!weeks.length) return learningOpponentPositionContext(season, currentWeek, { defense, position, window, attribution });
  try {
    const result = await opponentProvider.fetch({ season: window.season, weeks: window.weeks, defense, position, rawScoringRules });
    return { ...result, window, attribution };
  } catch (error) {
    return {
      provider: 'sleeper', model: 'recent-opponent-position-allowance', available: false, partial: true, stale: true,
      season: window.season, requestedWeeks: window.weeks, window, attribution, defense: defense || null, position: position || null,
      sample: { requestedGames: window.weeks.length, includedGames: 0, leagueDefenseGames: 0, adequate: false }, metrics: {}, decisionUse: 'context_only', retrievedAt: null,
      missing: ['games'], issues: [{ code: 'opponent_context_unavailable', message: error.message }], limitations: ['Opponent context is unavailable and is not replaced with a guess.']
    };
  }
}

export function findPlayerGame(player, context) {
  const teamId = player.nflTeamId == null ? null : String(player.nflTeamId);
  const abbreviation = normalizeNflTeamAbbreviation(player.nflTeam);
  return context?.games?.find((game) => [game.teams?.home, game.teams?.away].some((team) =>
    team && (teamId ? String(team.id) === teamId : abbreviation && normalizeNflTeamAbbreviation(team.abbreviation) === abbreviation)
  )) || null;
}

export function findPlayerOpponent(player, context) {
  const game = findPlayerGame(player, context); const ownTeam = findPlayerTeam(player, context);
  if (!game || !ownTeam) return null;
  const teams = [game.teams?.home, game.teams?.away].filter(Boolean);
  return teams.find((team) => team !== ownTeam) || null;
}

export function findPlayerTeam(player, context) {
  const game = findPlayerGame(player, context);
  if (!game) return null;
  const teamId = player.nflTeamId == null ? null : String(player.nflTeamId);
  const abbreviation = normalizeNflTeamAbbreviation(player.nflTeam);
  return [game.teams?.home, game.teams?.away].filter(Boolean).find((team) =>
    teamId ? String(team.id) === teamId : abbreviation && normalizeNflTeamAbbreviation(team.abbreviation) === abbreviation
  ) || null;
}

/** Resolve an NFL team even during byes or when the scoreboard is unavailable. */
export function resolvePlayerNflTeam(player, context) {
  const matched = findPlayerTeam(player, context);
  if (matched) return { ...matched, abbreviation: normalizeNflTeamAbbreviation(matched.abbreviation) };
  const abbreviation = normalizeNflTeamAbbreviation(player?.nflTeam || ESPN_TEAM_IDS[Number(player?.nflTeamId)]);
  return abbreviation ? { id: player?.nflTeamId == null ? null : String(player.nflTeamId), abbreviation, name: null } : null;
}

function learningTeamTrend(season, currentWeek, { teamId, teamAbbreviation, tenure }) {
  return {
    provider: 'espn', available: false, learning: true, stale: false, generatedAt: new Date().toISOString(),
    team: { id: teamId || null, abbreviation: normalizeNflTeamAbbreviation(teamAbbreviation) },
    window: { requestedGames: 0, includedGames: 0, newestGameAt: null, oldestGameAt: null }, games: [], metrics: {},
    tracker: { seasonOnly: true, tenureId: tenure?.tenureId || null, startWeek: tenure?.startWeek || currentWeek, observedAfter: tenure?.firstSeenAt || null, throughWeek: Number(currentWeek) - 1, boundaryConfidence: tenure?.boundaryConfidence || 'first-observed-not-official-effective-time', basisRoles: tenure?.basisRoles || [] },
    missing: ['completedCurrentSeasonGames'], issues: [{ code: 'coach_trend_learning', field: 'games', message: `No completed ${season} games have been observed in this coaching period yet.` }],
    limitations: ['No prior-season team results are assigned to the current coach.', 'Team outcomes do not prove who called each play or why it happened.']
  };
}

function learningOpponentPositionContext(season, currentWeek, { defense, position, window, attribution }) {
  return {
    provider: 'sleeper', model: 'recent-opponent-position-allowance', available: false, learning: true, partial: false, stale: false,
    season: Number(season), currentWeek: Number(currentWeek), requestedWeeks: [], window, attribution, defense: defense || null, position: position || null,
    sample: { requestedGames: 0, includedGames: 0, leagueDefenseGames: 0, adequate: false }, metrics: {}, decisionUse: 'context_only', retrievedAt: null,
    missing: ['completedCurrentPeriodGames'], issues: [{ code: 'defensive_period_learning', message: 'No completed games fall inside the current verified defensive-staff period yet.' }],
    limitations: ['Older games are not assigned to a newly observed defensive coordinator or play caller.', 'This context is descriptive and is not used as a projection adjustment.']
  };
}

async function safeTrackedCoach(season, team) { try { return await getTrackedHeadCoach(season, team); } catch { return null; } }

function trackedFallback(saved, currentWeek, feed, reason, roles = emptyRoleViews()) {
  return {
    provider: 'local coach tracker', available: true, season: saved.season, week: currentWeek,
    team: { name: null, abbreviation: saved.teamAbbreviation, sourceUrl: saved.sourceUrl || null },
    headCoach: { id: saved.coachId || null, name: saved.coachName, role: 'Head coach' }, tenure: saved,
    roles,
    changeDetected: false, previousHeadCoach: null, trackerStatus: currentWeek <= saved.startWeek ? 'learning' : 'tracking',
    sourceUrl: saved.sourceUrl || feed?.sourceUrl || null, retrievedAt: saved.lastSeenAt || null, stale: true,
    issues: [{ code: 'using_last_tracked_coach', field: 'headCoach', message: reason }],
    limitations: ['The current ESPN coach list could not be verified, so the last locally observed coach is shown as stale.']
  };
}

function unavailableCoachingContext(season, week, team, feed, code, message, roles = emptyRoleViews()) {
  return { provider: feed?.provider || 'espn', available: false, season, week, team: team ? { abbreviation: team } : null, headCoach: null, tenure: null, roles, trackerStatus: 'unavailable', sourceUrl: feed?.sourceUrl || null, retrievedAt: feed?.retrievedAt || null, stale: Boolean(feed?.stale), issues: [{ code, field: 'headCoach', message }], limitations: ['Head-coach identity is not guessed when the current source cannot be verified.'] };
}

function coachFeedIssue(feed, season, team) {
  if (!feed?.complete) return 'The current coach table was incomplete, so it was not allowed to change the tracker.';
  if (feed?.stale) return 'The current coach table is stale, so it was not allowed to change the tracker.';
  if (Number(feed?.season) !== Number(season)) return `The coach table covers ${feed?.season || 'an unknown season'}, not ${season}.`;
  return `${team}'s current head coach was not found in the verified table.`;
}

function observeVerifiedCoachFeed(feed, season, week) {
  const key = `${season}:${week}:${feed.retrievedAt}`;
  if (coachObservationCache.has(key)) return coachObservationCache.get(key);
  const observations = feed.coaches.map((coach) => ({
    season,
    week,
    teamAbbreviation: coach.team.abbreviation,
    coachId: coach.id,
    coachName: coach.name,
    observedAt: feed.retrievedAt,
    sourceUrl: feed.sourceUrl,
    sourceKey: 'espn-current-head-coaches',
    sourceUpdatedAt: feed.retrievedAt,
    expiresAt: addMilliseconds(feed.retrievedAt, 24 * 60 * 60_000)
  }));
  const pending = observeHeadCoaches(observations).catch((error) => { coachObservationCache.delete(key); throw error; });
  coachObservationCache.set(key, pending);
  if (coachObservationCache.size > 4) coachObservationCache.delete(coachObservationCache.keys().next().value);
  return pending;
}

async function observeVerifiedStaffFeed(feed, season, week, team, verifiedHeadCoachName) {
  const listed = findCachedNflCoachingStaff(feed, team);
  const usable = feed?.complete === true && feed?.stale !== true && Number(feed.season) === Number(season) && listed
    && normalizePersonName(listed.roles?.headCoach) === normalizePersonName(verifiedHeadCoachName);
  if (!usable) return null;
  const sourceKey = `espn-${season}-current-coaching-staffs`;
  const sourceUpdatedAt = feed.sourceUpdatedAt || feed.checkedAt;
  const key = `${season}:${team}:${sourceKey}:${sourceUpdatedAt}`;
  if (staffObservationCache.has(key)) return staffObservationCache.get(key);
  const current = await Promise.all(COACHING_ROLES.filter((role) => role !== 'headCoach').map((role) => getTrackedCoachRole(season, team, role)));
  const alreadyCached = current.every((tracked) => tracked?.check?.sourceKey === sourceKey && tracked.check.sourceUpdatedAt === sourceUpdatedAt);
  if (alreadyCached) return current;
  const observations = ['offensiveCoordinator', 'offensivePlayCaller', 'defensiveCoordinator'].map((role) => ({
    season, week, teamAbbreviation: team, role, status: 'verified', coachName: listed.roles[role],
    observedAt: sourceUpdatedAt, sourceUpdatedAt, expiresAt: feed.expiresAt, sourceUrl: feed.sourceUrl, sourceKey
  }));
  observations.push({
    season, week, teamAbbreviation: team, role: 'defensivePlayCaller', status: 'not_verified',
    observedAt: sourceUpdatedAt, sourceUpdatedAt, expiresAt: feed.expiresAt, sourceUrl: feed.sourceUrl, sourceKey, reasonCode: 'source_does_not_cover_role'
  });
  const pending = observeCoachRoles(observations).catch((error) => { staffObservationCache.delete(key); throw error; });
  staffObservationCache.set(key, pending);
  return pending;
}

async function readRoleViews(season, team, { stale = false } = {}) {
  const tracked = await Promise.all(COACHING_ROLES.map((role) => getTrackedCoachRole(season, team, role)));
  return Object.fromEntries(COACHING_ROLES.map((role, index) => [role, roleView(role, tracked[index], stale)]));
}

function roleView(role, tracked, stale) {
  const verified = !stale && tracked?.status === 'verified' && tracked.period;
  return {
    role,
    label: ROLE_LABELS[role],
    status: verified ? 'verified' : 'not_verified',
    name: verified ? tracked.period.coachName : 'Not verified',
    period: verified ? tracked.period : null,
    lastKnownPeriod: tracked?.lastKnownPeriod || null,
    checkedAt: tracked?.check?.checkedAt || null,
    sourceUrl: tracked?.check?.sourceUrl || tracked?.lastKnownPeriod?.sourceUrl || null,
    reasonCode: stale ? 'current_source_unavailable' : tracked?.check?.reasonCode || (verified ? null : 'role_not_verified')
  };
}

function emptyRoleViews() {
  return Object.fromEntries(COACHING_ROLES.map((role) => [role, roleView(role, null, false)]));
}

function latestIso(values) {
  const times = values.filter(Boolean).map((value) => Date.parse(value)).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

function normalizePersonName(value) {
  return String(value || '').normalize('NFKD').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function addMilliseconds(value, milliseconds) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time + milliseconds).toISOString() : null;
}
