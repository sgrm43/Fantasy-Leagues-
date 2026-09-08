const API = 'https://api.sleeper.app/v1';
const PROJECTIONS = 'https://api.sleeper.com/projections/nfl';
import { scoreSleeperProjection } from '../scoring.js';

async function get(path) {
  const response = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Sleeper returned HTTP ${response.status}`);
  return response.json();
}

async function getAbsolute(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Sleeper projections returned HTTP ${response.status}`);
  return response.json();
}

export async function syncSleeper(definition) {
  const league = await get(`/league/${definition.id}`);
  const currentWeek = league.settings?.leg || 1;
  const [rosters, users, matchupResult, playersResult, projectionResult, seasonProjectionResult] = await Promise.all([
    get(`/league/${definition.id}/rosters`), get(`/league/${definition.id}/users`),
    optional(get(`/league/${definition.id}/matchups/${currentWeek}`), 'Current matchups'), optional(get('/players/nfl'), 'NFL player catalog'),
    optional(getAbsolute(`${PROJECTIONS}/${league.season}/${currentWeek}?season_type=regular`), 'Weekly projections'),
    optional(getAbsolute(`${PROJECTIONS}/${league.season}?season_type=regular`), 'Full-season projections')
  ]);
  const matchups = matchupResult.data || [];
  const players = playersResult.data || {};
  const projections = projectionResult.data || [];
  const seasonProjections = seasonProjectionResult.data || [];
  const dataIssues = [matchupResult, playersResult, projectionResult, seasonProjectionResult].map((result) => result.issue).filter(Boolean);
  const matchupsByRoster = new Map(matchups.map((matchup) => [String(matchup.roster_id), matchup]));
  const usersById = new Map(users.map((user) => [user.user_id, user]));
  const projectionsById = new Map(projections.map((row) => [String(row.player_id), row]));
  const seasonProjectionsById = new Map(seasonProjections.map((row) => [String(row.player_id), row]));
  const normalizePlayer = (id, slot = 'available', actualPoints = null) => {
    const projection = projectionsById.get(String(id));
    const scored = projection ? scoreSleeperProjection(projection.stats, league.scoring_settings || {}) : null;
    const seasonProjection = seasonProjectionsById.get(String(id));
    const seasonScored = seasonProjection ? scoreSleeperProjection(seasonProjection.stats, league.scoring_settings || {}) : null;
    return { playerId: `sleeper:${id}`, platformPlayerId: String(id), name: players[id]?.full_name || (players[id]?.first_name ? `${players[id].first_name} ${players[id].last_name}` : `${id} D/ST`), position: players[id]?.position || (String(id).length <= 3 ? 'D/ST' : '—'), nflTeam: players[id]?.team || (String(id).length <= 3 ? id : null), injuryStatus: players[id]?.injury_status || null, externalIds: { espn: players[id]?.espn_id || null, yahoo: players[id]?.yahoo_id || null }, projection: scored?.total ?? null, projectionBreakdown: scored?.breakdown || [], projectionUpdatedAt: projection?.updated_at || projection?.last_modified || null, actualPoints: Number.isFinite(Number(actualPoints)) ? Number(actualPoints) : null, seasonProjection: seasonScored?.total ?? null, seasonProjectionUpdatedAt: seasonProjection?.updated_at || seasonProjection?.last_modified || null, slot };
  };
  const teams = rosters.map((roster) => ({
    id: `sleeper:${roster.roster_id}`, platformId: String(roster.roster_id), name: usersById.get(roster.owner_id)?.metadata?.team_name || usersById.get(roster.owner_id)?.display_name || `Team ${roster.roster_id}`,
    manager: usersById.get(roster.owner_id)?.display_name || null, record: { wins: roster.settings?.wins || 0, losses: roster.settings?.losses || 0, ties: roster.settings?.ties || 0 },
    roster: (roster.players || []).map((id) => {
      const starterIndex = (roster.starters || []).indexOf(id);
      const slot = starterIndex >= 0 ? league.roster_positions?.[starterIndex] || 'starter' : (roster.reserve || []).includes(id) ? 'IR' : (roster.taxi || []).includes(id) ? 'taxi' : 'bench';
      return normalizePlayer(id, slot, matchupsByRoster.get(String(roster.roster_id))?.players_points?.[id]);
    })
  }));
  const owned = new Set(rosters.flatMap((roster) => roster.players || []).map(String));
  const candidateIds = [...new Set([...projections, ...seasonProjections].map((row) => String(row.player_id)))];
  const remainingWeeks = Math.max(1, 19 - Number(currentWeek || 1));
  const availablePlayers = candidateIds.filter((id) => !owned.has(id) && players[id]?.active !== false)
    .map((id) => normalizePlayer(id)).filter((player) => (player.projection != null || player.seasonProjection != null) && ['QB', 'RB', 'WR', 'TE', 'K', 'D/ST'].includes(player.position))
    .sort((a, b) => Math.max(Number(b.projection || 0), Number(b.seasonProjection || 0) / remainingWeeks) - Math.max(Number(a.projection || 0), Number(a.seasonProjection || 0) / remainingWeeks)).slice(0, 400);
  return {
    id: definition.id, key: definition.key, name: league.name || definition.name, platform: 'sleeper', season: league.season,
    status: league.status, currentWeek,
    settings: { roster: league.roster_positions || [], waiver: pick(league.settings, ['waiver_type', 'waiver_budget', 'waiver_clear_days']), playoff: pick(league.settings, ['playoff_week_start', 'playoff_teams']) },
    scoring: normalizeSleeperScoring(league.scoring_settings || {}),
    teams, availablePlayers, dataIssues,
    matchups: matchups.map((m) => ({ matchupId: String(m.matchup_id), teamId: `sleeper:${m.roster_id}`, points: m.points || 0, starters: m.starters || [] })),
    provenance: { source: `${API}/league/${definition.id}`, retrievedAt: new Date().toISOString() }
  };
}

/** Fetch exact-week league-scored player totals from the existing Sleeper matchup API. */
export async function fetchSleeperWeekResults(definition, {
  week,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000
} = {}) {
  const normalizedWeek = positiveInteger(week, 'week');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const leagueId = String(definition?.id || '').trim();
  if (!leagueId) throw new TypeError('Sleeper league id is required');
  const timeoutSignal = globalThis.AbortSignal?.timeout?.(timeoutMs);
  const response = await fetchImpl(`${API}/league/${encodeURIComponent(leagueId)}/matchups/${normalizedWeek}`, {
    ...(timeoutSignal ? { signal: timeoutSignal } : {})
  });
  if (!response?.ok) {
    const error = new Error(`Sleeper returned HTTP ${response?.status ?? 'unknown'}`);
    error.code = 'SLEEPER_RESULTS_HTTP';
    throw error;
  }
  return {
    source: 'sleeper-league-matchup-points',
    results: extractSleeperWeekResults(await response.json())
  };
}

export function extractSleeperWeekResults(matchups) {
  const results = [];
  for (const matchup of Array.isArray(matchups) ? matchups : []) {
    const points = matchup?.players_points;
    if (!points || typeof points !== 'object' || Array.isArray(points)) continue;
    for (const playerId of Object.keys(points)) {
      const value = points[playerId];
      if (value == null || String(value).trim() === '') continue;
      const actualFantasyPoints = Number(value);
      if (!Number.isFinite(actualFantasyPoints)) continue;
      results.push({ player_id: `sleeper:${playerId}`, actual_fantasy_points: actualFantasyPoints });
    }
  }
  return results;
}

export function normalizeSleeperScoring(settings) {
  const map = { pass_yd: 'passYards', pass_td: 'passTd', pass_int: 'interceptions', rush_yd: 'rushYards', rush_td: 'rushTd', rec: 'receptions', rec_yd: 'receivingYards', rec_td: 'receivingTd', fum_lost: 'fumblesLost' };
  const rules = {};
  for (const [key, value] of Object.entries(settings)) rules[map[key] || key] = value;
  return { rules, raw: settings };
}

const pick = (object = {}, keys) => Object.fromEntries(keys.filter((key) => object[key] != null).map((key) => [key, object[key]]));
async function optional(promise, label) {
  try { return { data: await promise, issue: null }; }
  catch (error) { return { data: null, issue: { code: 'upstream_partial_failure', source: label, message: `${label} could not be refreshed: ${error.message}` } }; }
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new TypeError(`${label} must be a positive integer`);
  return number;
}
