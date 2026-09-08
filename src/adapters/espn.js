const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';

export async function syncEspn(definition, credentials) {
  const season = new Date().getFullYear();
  const url = `${BASE}/seasons/${season}/segments/0/leagues/${definition.id}?view=mSettings&view=mTeam&view=mRoster&view=mMatchup`;
  const headers = credentials.s2 && credentials.swid ? { Cookie: `espn_s2=${credentials.s2}; SWID=${credentials.swid}` } : {};
  const playerUrl = `${BASE}/seasons/${season}/segments/0/leagues/${definition.id}?view=kona_player_info`;
  const playerFilter = { players: { limit: 500, filterStatus: { value: ['FREEAGENT', 'WAIVERS'] }, sortPercOwned: { sortPriority: 1, sortAsc: false } } };
  const [response, playerResponse] = await Promise.all([
    fetch(url, { headers, signal: AbortSignal.timeout(15_000) }),
    fetch(playerUrl, { headers: { ...headers, 'x-fantasy-filter': JSON.stringify(playerFilter) }, signal: AbortSignal.timeout(15_000) })
  ]);
  if (response.status === 401 || response.status === 403) {
    const error = new Error('ESPN authentication is required or the saved session has expired'); error.code = 'ESPN_AUTH'; throw error;
  }
  if (!response.ok) throw new Error(`ESPN returned HTTP ${response.status}`);
  const data = await response.json();
  const available = playerResponse.ok ? await playerResponse.json() : { players: [] };
  const dataIssues = playerResponse.ok ? [] : [{ code: 'upstream_partial_failure', source: 'ESPN free-agent pool', message: `ESPN free-agent data could not be refreshed (HTTP ${playerResponse.status}).` }];
  return normalizeEspn(definition, data, url, available.players || [], dataIssues);
}

/** Fetch exact-week, league-scored final player totals from the existing ESPN league API. */
export async function fetchEspnWeekResults(definition, credentials = {}, {
  season,
  week,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000
} = {}) {
  const normalizedSeason = positiveInteger(season, 'season');
  const normalizedWeek = positiveInteger(week, 'week');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const leagueId = String(definition?.id || '').trim();
  if (!leagueId) throw new TypeError('ESPN league id is required');
  const url = `${BASE}/seasons/${normalizedSeason}/segments/0/leagues/${encodeURIComponent(leagueId)}?scoringPeriodId=${normalizedWeek}&view=mRoster&view=mTeam`;
  const headers = credentials.s2 && credentials.swid ? { Cookie: `espn_s2=${credentials.s2}; SWID=${credentials.swid}` } : {};
  const timeoutSignal = globalThis.AbortSignal?.timeout?.(timeoutMs);
  const response = await fetchImpl(url, { headers, ...(timeoutSignal ? { signal: timeoutSignal } : {}) });
  if (response?.status === 401 || response?.status === 403) {
    const error = new Error('ESPN authentication is required or the saved session has expired');
    error.code = 'ESPN_AUTH';
    throw error;
  }
  if (!response?.ok) {
    const error = new Error(`ESPN returned HTTP ${response?.status ?? 'unknown'}`);
    error.code = 'ESPN_RESULTS_HTTP';
    throw error;
  }
  const data = await response.json();
  if (String(data?.id ?? leagueId) !== leagueId) {
    const error = new Error('ESPN returned a different league');
    error.code = 'ESPN_RESULTS_LEAGUE_MISMATCH';
    throw error;
  }
  return {
    source: 'espn-fantasy-applied-total',
    results: extractEspnWeekResults(data, normalizedWeek)
  };
}

export function extractEspnWeekResults(data, week) {
  const results = [];
  for (const team of Array.isArray(data?.teams) ? data.teams : []) {
    for (const entry of Array.isArray(team?.roster?.entries) ? team.roster.entries : []) {
      const player = entry?.playerPoolEntry?.player;
      const id = player?.id ?? entry?.playerId;
      const actualFantasyPoints = espnActual(player, Number(week));
      if (id == null || String(id).trim() === '' || actualFantasyPoints == null) continue;
      results.push({ player_id: `espn:${id}`, actual_fantasy_points: actualFantasyPoints });
    }
  }
  return results;
}

export function normalizeEspn(definition, data, source = 'ESPN Fantasy API', available = [], dataIssues = []) {
  const members = new Map((data.members || []).map((m) => [m.id, m]));
  const lineup = data.settings?.rosterSettings?.lineupSlotCounts || {};
  return {
    id: String(data.id || definition.id), key: definition.key, name: data.settings?.name || definition.name, platform: 'espn', season: data.seasonId,
    status: data.status?.currentMatchupPeriod ? 'in_season' : 'unknown', currentWeek: data.status?.currentMatchupPeriod || null,
    settings: { roster: Object.entries(lineup).filter(([, count]) => count > 0).map(([slotId, count]) => ({ slotId, count })), waiver: data.settings?.acquisitionSettings || {}, playoff: data.settings?.scheduleSettings || {} },
    scoring: normalizeEspnScoring(data.settings?.scoringSettings || {}),
    teams: (data.teams || []).map((team) => ({
      id: `espn:${team.id}`, platformId: String(team.id), name: team.name || `${team.location || ''} ${team.nickname || ''}`.trim() || `Team ${team.id}`,
      manager: (team.owners || []).map((id) => members.get(id)?.displayName).filter(Boolean).join(', ') || null,
      record: { wins: team.record?.overall?.wins || 0, losses: team.record?.overall?.losses || 0, ties: team.record?.overall?.ties || 0 },
      roster: (team.roster?.entries || []).map((entry) => normalizeEspnPlayer(entry.playerPoolEntry?.player, data.status?.currentMatchupPeriod, data.seasonId, espnSlot(entry.lineupSlotId), entry.lineupSlotId, entry.playerId))
    })),
    availablePlayers: available.map((entry) => ({ ...normalizeEspnPlayer(entry.player, data.status?.currentMatchupPeriod, data.seasonId, 'available', null, entry.id), availabilityStatus: entry.status || 'FREEAGENT', percentOwned: entry.player?.ownership?.percentOwned ?? null, percentStarted: entry.player?.ownership?.percentStarted ?? null })).filter((player) => player.name), dataIssues,
    matchups: (data.schedule || []).filter((m) => m.matchupPeriodId === data.status?.currentMatchupPeriod).flatMap((m) => [side(m, 'home'), side(m, 'away')].filter(Boolean)),
    provenance: { source, retrievedAt: new Date().toISOString() }
  };
}

function side(matchup, key) { const s = matchup[key]; return s?.teamId ? { matchupId: String(matchup.id), teamId: `espn:${s.teamId}`, points: s.totalPoints || 0 } : null; }

function normalizeEspnPlayer(player, week, season, slot, platformSlotId, fallbackId) {
  const id = player?.id || fallbackId;
  return { playerId: `espn:${id}`, platformPlayerId: String(id || ''), slot, platformSlotId: platformSlotId == null ? null : String(platformSlotId), name: player?.fullName || null, position: espnPosition(player?.defaultPositionId), nflTeamId: player?.proTeamId || null, injuryStatus: player?.injuryStatus || (player?.injured ? 'INJURED' : null), projection: espnProjection(player, week), actualPoints: espnActual(player, week), seasonProjection: espnSeasonProjection(player, season), outlook: player?.seasonOutlook || null };
}

const espnPosition = (id) => ({ 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' }[id] || '—');
const espnSlot = (id) => ({ 0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'D/ST', 17: 'K', 20: 'bench', 21: 'IR', 23: 'FLEX' }[id] || `slot ${id}`);
function espnProjection(player, week) {
  const row = (player?.stats || []).find((stat) => stat.scoringPeriodId === week && stat.statSourceId === 1);
  return row?.appliedTotal == null ? null : Math.round(row.appliedTotal * 100) / 100;
}
function espnActual(player, week) {
  const row = (player?.stats || []).find((stat) => stat.scoringPeriodId === week && stat.statSourceId === 0);
  return row?.appliedTotal == null ? null : Math.round(row.appliedTotal * 100) / 100;
}
function espnSeasonProjection(player, season) {
  const rows = (player?.stats || []).filter((stat) => stat.scoringPeriodId === 0 && stat.statSourceId === 1);
  const row = rows.find((stat) => Number(stat.seasonId) === Number(season) || String(stat.id || '').endsWith(String(season))) || rows.at(-1);
  return row?.appliedTotal == null ? null : Math.round(row.appliedTotal * 100) / 100;
}

function normalizeEspnScoring(settings) {
  const rules = {};
  for (const item of settings.scoringItems || []) rules[`stat:${item.statId}`] = item.points;
  return { rules, raw: settings };
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new TypeError(`${label} must be a positive integer`);
  return number;
}
