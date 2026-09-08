import { fetchEspnWeekResults } from './adapters/espn.js';
import { fetchSleeperWeekResults } from './adapters/sleeper.js';
import { config } from './config.js';
import { fetchNflScoreboardContext } from './providers/espn-nfl-scoreboard.js';
import { pregameSnapshotStore, scoringFingerprint } from './pregame-decision-snapshots.js';
import { readLeague, readPregameDecisionSnapshots } from './storage.js';

const RESULT_SOURCE_BY_PLATFORM = Object.freeze({
  espn: 'espn-fantasy-applied-total',
  sleeper: 'sleeper-league-matchup-points'
});

/**
 * One-shot, read-only provider processing for eligible snapshots. This function
 * is intentionally not scheduled; callers decide when to invoke it.
 */
export async function attachCompletedPostgameResults({
  season,
  week,
  snapshotReader = readPregameDecisionSnapshots,
  leagueReader = readLeague,
  leagueDefinitions = config.leagues,
  credentials = config.espn,
  gameContextFetcher = fetchNflScoreboardContext,
  leagueResultFetcher = fetchLeagueWeekResults,
  store = pregameSnapshotStore,
  warn = console.warn
} = {}) {
  const summary = emptySummary();
  try {
    const state = await snapshotReader();
    const records = Object.values(state?.records || {}).filter((record) => matchesRequestedPeriod(record, season, week));
    summary.processed = records.length;
    const pending = [];
    for (const record of records) {
      if (hasValidAttachedResult(record?.result)) summary.already_attached += 1;
      else pending.push(record);
    }
    if (!pending.length) return summary;

    const completed = [];
    for (const group of grouped(pending, (record) => `${record.season}|${record.week}`).values()) {
      let context;
      try {
        context = await gameContextFetcher({ season: Number(group[0].season), week: Number(group[0].week) });
      } catch (error) {
        summary.provider_failures += group.length;
        safeWarn(warn, 'Postgame final-status check failed', error);
        continue;
      }
      if ((context?.season != null && Number(context.season) !== Number(group[0].season))
        || (context?.week != null && Number(context.week) !== Number(group[0].week))) {
        summary.unavailable += group.length;
        continue;
      }
      const gamesById = grouped(context?.games || [], (game) => String(game?.id ?? ''));
      for (const record of group) {
        const games = gamesById.get(String(record.nfl_game_id)) || [];
        if (games.length > 1) { summary.unmatched += 1; continue; }
        if (games.length !== 1) { summary.unavailable += 1; continue; }
        const game = games[0];
        if (game?.status?.completed !== true) { summary.non_final += 1; continue; }
        completed.push({ record, completedAt: explicitCompletionTime(game) });
      }
    }
    if (!completed.length) return summary;

    const candidates = [];
    for (const group of grouped(completed, ({ record }) => `${record.fantasy_league_id}|${record.season}|${record.week}`).values()) {
      const first = group[0].record;
      const definitions = (Array.isArray(leagueDefinitions) ? leagueDefinitions : [])
        .filter((definition) => String(definition?.id) === String(first.fantasy_league_id));
      if (definitions.length !== 1) {
        summary.unmatched += group.length;
        continue;
      }
      const definition = definitions[0];
      const source = RESULT_SOURCE_BY_PLATFORM[String(definition.platform || '').toLowerCase()];
      if (!source) { summary.unavailable += group.length; continue; }

      let league;
      try {
        const cached = await leagueReader(definition.key);
        league = cached?.data ?? cached;
      } catch (error) {
        summary.provider_failures += group.length;
        safeWarn(warn, 'Postgame league scoring check failed', error);
        continue;
      }
      if (!validLeagueScoringContext(league, definition, first)) {
        summary.unavailable += group.length;
        continue;
      }
      const settingsId = scoringFingerprint(league);

      let payload;
      try {
        payload = await leagueResultFetcher({
          definition,
          credentials,
          season: Number(first.season),
          week: Number(first.week)
        });
      } catch (error) {
        summary.provider_failures += group.length;
        safeWarn(warn, 'Postgame fantasy-result fetch failed', error);
        continue;
      }
      const results = Array.isArray(payload?.results) ? payload.results : null;
      if (!results) { summary.unavailable += group.length; continue; }
      const resultsByPlayer = grouped(results.filter(validProviderResult), (result) => String(result.player_id));

      for (const item of group) {
        const record = item.record;
        if (String(record.scoring_settings_id) !== settingsId) { summary.unavailable += 1; continue; }
        const matches = resultsByPlayer.get(String(record.player_id)) || [];
        if (matches.length > 1) { summary.unmatched += 1; continue; }
        if (matches.length !== 1) { summary.unavailable += 1; continue; }
        candidates.push({
          season: Number(record.season),
          week: Number(record.week),
          nfl_game_id: String(record.nfl_game_id),
          player_id: String(record.player_id),
          fantasy_league_id: String(record.fantasy_league_id),
          scoring_settings_id: settingsId,
          game_completed: true,
          nfl_game_status: 'final',
          actual_fantasy_points: Number(matches[0].actual_fantasy_points),
          source,
          completed_at: item.completedAt
        });
      }
    }

    if (!candidates.length) return summary;
    try {
      const update = await store.attachResults(candidates);
      summary.attached += Number(update?.attached || 0);
      summary.already_attached += Number(update?.alreadyAttached || 0);
      summary.unavailable += Number(update?.skipped || 0);
    } catch (error) {
      summary.storage_failures += candidates.length;
      safeWarn(warn, 'Postgame snapshot storage failed', error);
    }
    return summary;
  } catch (error) {
    summary.storage_failures += 1;
    safeWarn(warn, 'Postgame snapshot processing failed', error);
    return summary;
  }
}

export async function fetchLeagueWeekResults({ definition, credentials, season, week } = {}) {
  if (definition?.platform === 'espn') return fetchEspnWeekResults(definition, credentials, { season, week });
  if (definition?.platform === 'sleeper') return fetchSleeperWeekResults(definition, { week });
  const error = new Error('Unsupported fantasy provider');
  error.code = 'UNSUPPORTED_FANTASY_PROVIDER';
  throw error;
}

function emptySummary() {
  return {
    processed: 0,
    attached: 0,
    already_attached: 0,
    non_final: 0,
    unmatched: 0,
    unavailable: 0,
    provider_failures: 0,
    storage_failures: 0
  };
}

function matchesRequestedPeriod(record, season, week) {
  if (!record || typeof record !== 'object') return false;
  if (season != null && Number(record.season) !== Number(season)) return false;
  if (week != null && Number(record.week) !== Number(week)) return false;
  return true;
}

function hasValidAttachedResult(result) {
  return result?.status === 'attached'
    && result?.nfl_game_status === 'final'
    && result?.actual_fantasy_points != null
    && Number.isFinite(Number(result.actual_fantasy_points))
    && validIso(result?.attached_at) != null;
}

function validLeagueScoringContext(league, definition, record) {
  return league && typeof league === 'object'
    && String(league.id) === String(record.fantasy_league_id)
    && String(league.platform) === String(definition.platform)
    && Number(league.season) === Number(record.season)
    && league.scoring?.rules && typeof league.scoring.rules === 'object' && !Array.isArray(league.scoring.rules);
}

function validProviderResult(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.player_id == null || String(result.player_id).trim() === '') return false;
  if (result.actual_fantasy_points == null || String(result.actual_fantasy_points).trim() === '') return false;
  return Number.isFinite(Number(result.actual_fantasy_points));
}

function explicitCompletionTime(game) {
  return validIso(game?.status?.completedAt ?? game?.completedAt);
}

function grouped(values, keyFor) {
  const groups = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const key = keyFor(value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
}

function validIso(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeWarn(warn, message, error) {
  const rawCode = String(error?.code || '').trim().toUpperCase();
  const code = /^[A-Z][A-Z0-9_]{0,31}$/.test(rawCode) ? rawCode : null;
  try { warn(`${message}${code ? ` (${code})` : ''}; locked pregame data was left unchanged.`); } catch {}
}
