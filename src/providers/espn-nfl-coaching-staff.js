import { normalizeNflTeamAbbreviation } from './espn-nfl-coaches.js';

export const ESPN_2026_COACHING_STAFF_SOURCE = 'https://g.espncdn.com/s/ffldraftkit/26/NFLDK2026_CS_ClayProjections2026.pdf';
export const ESPN_2026_COACHING_STAFF_UPDATED_AT = '2026-09-02T18:47:17.000Z';
export const COACHING_STAFF_FRESH_MS = 7 * 24 * 60 * 60_000;

const STAFF = Object.freeze([
  ['ARI', 'Mike LaFleur', 'Nathaniel Hackett', 'Mike LaFleur', 'Nick Rallis'],
  ['ATL', 'Kevin Stefanski', 'Tommy Rees', 'Tommy Rees', 'Jeff Ulbrich'],
  ['BAL', 'Jesse Minter', 'Declan Doyle', 'Declan Doyle', 'Anthony Weaver'],
  ['BUF', 'Joe Brady', 'Pete Carmichael Jr.', 'Joe Brady', 'Jim Leonhard'],
  ['CAR', 'Dave Canales', 'Brad Idzik', 'Brad Idzik', 'Ejiro Evero'],
  ['CHI', 'Ben Johnson', 'Press Taylor', 'Ben Johnson', 'Dennis Allen'],
  ['CIN', 'Zac Taylor', 'Dan Pitcher', 'Zac Taylor', 'Al Golden'],
  ['CLE', 'Todd Monken', 'Travis Switzer', 'Todd Monken', 'Mike Rutenberg'],
  ['DAL', 'Brian Schottenheimer', 'Klayton Adams', 'Brian Schottenheimer', 'Christian Parker'],
  ['DEN', 'Sean Payton', 'Davis Webb', 'Davis Webb', 'Vance Joseph'],
  ['DET', 'Dan Campbell', 'Drew Petzing', 'Drew Petzing', 'Kelvin Sheppard'],
  ['GB', 'Matt LaFleur', 'Adam Stenavich', 'Matt LaFleur', 'Jonathan Gannon'],
  ['HOU', 'DeMeco Ryans', 'Nick Caley', 'Nick Caley', 'Matt Burke'],
  ['IND', 'Shane Steichen', 'Jim Bob Cooter', 'Shane Steichen', 'Lou Anarumo'],
  ['JAX', 'Liam Coen', 'Grant Udinski', 'Liam Coen', 'Anthony Campanile'],
  ['KC', 'Andy Reid', 'Eric Bieniemy', 'Andy Reid', 'Steve Spagnuolo'],
  ['LAC', 'Jim Harbaugh', 'Mike McDaniel', 'Mike McDaniel', "Chris O'Leary"],
  ['LAR', 'Sean McVay', 'Nate Scheelhaase', 'Sean McVay', 'Chris Shula'],
  ['LV', 'Klint Kubiak', 'Andrew Janocko', 'Klint Kubiak', 'Rob Leonard'],
  ['MIA', 'Jeff Hafley', 'Bobby Slowik', 'Bobby Slowik', 'Sean Duggan'],
  ['MIN', "Kevin O'Connell", 'Wes Phillips', "Kevin O'Connell", 'Brian Flores'],
  ['NE', 'Mike Vrabel', 'Josh McDaniels', 'Josh McDaniels', 'Zak Kuhr'],
  ['NO', 'Kellen Moore', 'Doug Nussmeier', 'Kellen Moore', 'Brandon Staley'],
  ['NYG', 'John Harbaugh', 'Matt Nagy', 'Matt Nagy', 'Dennard Wilson'],
  ['NYJ', 'Aaron Glenn', 'Frank Reich', 'Frank Reich', 'Brian Duker'],
  ['PHI', 'Nick Sirianni', 'Sean Mannion', 'Sean Mannion', 'Vic Fangio'],
  ['PIT', 'Mike McCarthy', 'Brian Angelichio', 'Mike McCarthy', 'Patrick Graham'],
  ['SEA', 'Mike Macdonald', 'Brian Fleury', 'Brian Fleury', 'Aden Durde'],
  ['SF', 'Kyle Shanahan', 'Klay Kubiak', 'Kyle Shanahan', 'Raheem Morris'],
  ['TB', 'Todd Bowles', 'Zac Robinson', 'Zac Robinson', 'Todd Bowles'],
  ['TEN', 'Robert Saleh', 'Brian Daboll', 'Brian Daboll', 'Gus Bradley'],
  ['WSH', 'Dan Quinn', 'David Blough', 'David Blough', 'Daronte Jones']
]);

/**
 * Return the verified staff table already extracted from ESPN's current 2026
 * projection guide. No network request is repeated for this cached source.
 */
export function getCachedNflCoachingStaff({ season = 2026, now = () => new Date() } = {}) {
  const checkedDate = resolveNow(now);
  const checkedAt = checkedDate.toISOString();
  if (Number(season) !== 2026) {
    return { provider: 'espn', season: Number(season), complete: false, teams: [], coveredRoles: [], sourceUrl: ESPN_2026_COACHING_STAFF_SOURCE, sourceUpdatedAt: ESPN_2026_COACHING_STAFF_UPDATED_AT, checkedAt, stale: true, issues: [{ code: 'staff_season_not_cached', message: `No verified coaching-staff cache is available for ${season}.` }] };
  }
  const expiresAt = new Date(Date.parse(ESPN_2026_COACHING_STAFF_UPDATED_AT) + COACHING_STAFF_FRESH_MS).toISOString();
  const stale = checkedDate.getTime() > Date.parse(expiresAt);
  return {
    provider: 'espn', season: 2026, complete: true,
    coveredRoles: ['headCoach', 'offensiveCoordinator', 'offensivePlayCaller', 'defensiveCoordinator'],
    teams: STAFF.map(([abbreviation, headCoach, offensiveCoordinator, offensivePlayCaller, defensiveCoordinator]) => ({
      team: { abbreviation: normalizeNflTeamAbbreviation(abbreviation) },
      roles: { headCoach, offensiveCoordinator, offensivePlayCaller, defensiveCoordinator, defensivePlayCaller: null }
    })),
    sourceUrl: ESPN_2026_COACHING_STAFF_SOURCE,
    sourceUpdatedAt: ESPN_2026_COACHING_STAFF_UPDATED_AT,
    expiresAt,
    checkedAt,
    stale,
    issues: stale ? [{ code: 'staff_cache_stale', message: 'The cached coaching-staff source is older than seven days and must be reverified before its roles are shown as current.' }] : [],
    limitations: ['ESPN lists an offensive play caller but does not list a defensive play caller in this source. Missing defensive play callers remain Not verified.', 'Cached staff roles are treated as current for seven days after the source update; older data is marked stale instead of guessed.']
  };
}

export function findCachedNflCoachingStaff(feed, teamAbbreviation) {
  const team = normalizeNflTeamAbbreviation(teamAbbreviation);
  return team ? feed?.teams?.find((entry) => normalizeNflTeamAbbreviation(entry.team?.abbreviation) === team) || null : null;
}

function resolveNow(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('now must resolve to a valid date');
  return date;
}
