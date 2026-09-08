import { readPregameDecisionSnapshots } from '../storage.js';

export const CALIBRATION_POSITIONS = Object.freeze(['QB', 'RB', 'WR', 'TE']);

/** Thresholds use unique player-games, not duplicate fantasy-league observations. */
export const CALIBRATION_READINESS_THRESHOLDS = Object.freeze({
  early_analysis: Object.freeze({
    min_unique_player_games_per_position: 20,
    min_nfl_weeks_per_position: 4
  }),
  calibration_candidate: Object.freeze({
    min_unique_player_games_per_position: 60,
    min_nfl_weeks_per_position: 8
  })
});

const STATUS_RANK = Object.freeze({ collecting: 0, early_analysis: 1, calibration_candidate: 2 });
const STATUS_MESSAGE = Object.freeze({
  collecting: 'Collecting — more completed 2026 games are required.',
  early_analysis: 'Early analysis — enough completed data to inspect patterns, not to apply production weights.',
  calibration_candidate: 'Calibration candidate — enough multi-week diversity to begin formal backtesting; no weights are applied.'
});
const RESULT_SOURCE_BY_PLATFORM = Object.freeze({
  espn: 'espn-fantasy-applied-total',
  sleeper: 'sleeper-league-matchup-points'
});

/** Read the current history file and return a machine-readable, season-isolated report. */
export async function readCalibrationReadiness({
  season = new Date().getFullYear(),
  read = readPregameDecisionSnapshots,
  thresholds = CALIBRATION_READINESS_THRESHOLDS
} = {}) {
  return evaluateCalibrationReadiness(await read(), { season, thresholds });
}

/** Pure readiness evaluation. It never changes historical records or projection values. */
export function evaluateCalibrationReadiness(input, {
  season = new Date().getFullYear(),
  thresholds = CALIBRATION_READINESS_THRESHOLDS
} = {}) {
  const selectedSeason = positiveInteger(season, 'season');
  validateThresholds(thresholds);
  const quality = {
    pending: 0,
    unmatched: 0,
    unavailable: 0,
    missing_projection: 0,
    missing_actual: 0,
    rejected_invalid: 0
  };
  const accumulators = Object.fromEntries(CALIBRATION_POSITIONS.map((position) => [position, createAccumulator()]));
  const total = createAccumulator();
  const records = historyRecords(input, quality);

  for (const record of records) {
    const recordSeason = integerOrNull(record?.season);
    if (recordSeason == null) { quality.rejected_invalid += 1; continue; }
    if (recordSeason !== selectedSeason) continue;

    const base = validatePregameRecord(record, selectedSeason);
    if (!base.valid) { quality.rejected_invalid += 1; continue; }
    if (!finiteNumber(record?.projection?.median)) { quality.missing_projection += 1; continue; }

    const resultState = classifyResult(record.result, base);
    if (resultState !== 'completed') {
      quality[resultState] += 1;
      continue;
    }

    addObservation(accumulators[base.position], base);
    addObservation(total, base);
  }

  const positions = Object.fromEntries(CALIBRATION_POSITIONS.map((position) => {
    const metrics = finalizeAccumulator(accumulators[position]);
    return [position, { ...metrics, status: statusForMetrics(metrics, thresholds) }];
  }));
  const status = CALIBRATION_POSITIONS
    .map((position) => positions[position].status)
    .reduce((lowest, value) => STATUS_RANK[value] < STATUS_RANK[lowest] ? value : lowest, 'calibration_candidate');

  return {
    season: selectedSeason,
    status,
    message: messageFor(status, selectedSeason),
    weights_applied: false,
    thresholds,
    totals: finalizeAccumulator(total),
    positions,
    data_quality: quality,
    deduplication: {
      league_specific_observation: 'season + week + nfl_game_id + player_id + fantasy_league_id',
      unique_player_game: 'season + week + nfl_game_id + player_id'
    }
  };
}

function historyRecords(input, quality) {
  if (input == null) return [];
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Number(input.version) !== 1
    || !input.records || typeof input.records !== 'object' || Array.isArray(input.records)) {
    quality.rejected_invalid += 1;
    return [];
  }
  return Object.values(input.records);
}

function validatePregameRecord(record, season) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { valid: false };
  const week = positiveIntegerOrNull(record.week);
  const gameId = textOrNull(record.nfl_game_id);
  const playerId = textOrNull(record.player_id);
  const leagueId = textOrNull(record.fantasy_league_id);
  const scoringSettingsId = textOrNull(record.scoring_settings_id);
  const position = String(record.position || '').trim().toUpperCase();
  const kickoff = timestampOrNull(record.kickoff);
  const lockAt = timestampOrNull(record.lock_at ?? record.kickoff);
  const capturedAt = timestampOrNull(record.captured_at);
  const latestCaptureAt = timestampOrNull(record.latest_capture_at ?? record.captured_at);
  const platform = scoringPlatform(scoringSettingsId);
  const expectedRecordId = week && gameId && playerId && leagueId
    ? [season, week, gameId, playerId, leagueId].map((value) => encodeURIComponent(String(value))).join('|')
    : null;
  const valid = Boolean(
    week && gameId && playerId && leagueId && platform
    && CALIBRATION_POSITIONS.includes(position)
    && playerId.startsWith(`${platform}:`) && expectedRecordId === record.record_id
    && kickoff != null && lockAt != null && capturedAt != null && latestCaptureAt != null
    && capturedAt < lockAt && capturedAt < kickoff
    && latestCaptureAt < lockAt && latestCaptureAt < kickoff && lockAt <= kickoff
  );
  return {
    valid,
    season,
    week,
    gameId,
    playerId,
    leagueId,
    position,
    platform,
    kickoff,
    lockAt
  };
}

function classifyResult(result, base) {
  if (result == null) return 'pending';
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'rejected_invalid';
  const status = String(result.status || '').trim().toLowerCase();
  const gameStatus = String(result.nfl_game_status || '').trim().toLowerCase();
  if (status === 'unmatched') return 'unmatched';
  if (status === 'unavailable') return 'unavailable';
  if (status === 'pending' || gameStatus !== 'final') return 'pending';
  if (status !== 'attached') return 'rejected_invalid';
  if (!finiteNumber(result.actual_fantasy_points)) return 'missing_actual';

  const attachedAt = timestampOrNull(result.attached_at);
  const completedAt = result.completed_at == null ? null : timestampOrNull(result.completed_at);
  const expectedSource = RESULT_SOURCE_BY_PLATFORM[base.platform];
  if (!attachedAt || attachedAt <= base.kickoff || result.source !== expectedSource
    || (result.completed_at != null && (!completedAt || completedAt <= base.kickoff))) return 'rejected_invalid';
  return 'completed';
}

function createAccumulator() {
  return {
    leagueSpecificObservations: 0,
    playerGames: new Set(),
    weeks: new Set(),
    players: new Set(),
    games: new Set()
  };
}

function addObservation(target, record) {
  target.leagueSpecificObservations += 1;
  target.playerGames.add(`${record.season}|${record.week}|${record.gameId}|${record.playerId}`);
  target.weeks.add(`${record.season}|${record.week}`);
  target.players.add(record.playerId);
  target.games.add(`${record.season}|${record.week}|${record.gameId}`);
}

function finalizeAccumulator(value) {
  const weeks = [...value.weeks].map((key) => Number(key.split('|')[1])).sort((left, right) => left - right);
  return {
    completed_league_observations: value.leagueSpecificObservations,
    unique_player_games: value.playerGames.size,
    nfl_weeks_represented: value.weeks.size,
    unique_players: value.players.size,
    unique_nfl_games: value.games.size,
    earliest_completed_week: weeks[0] ?? null,
    latest_completed_week: weeks.at(-1) ?? null
  };
}

function statusForMetrics(metrics, thresholds) {
  const candidate = thresholds.calibration_candidate;
  if (metrics.unique_player_games >= candidate.min_unique_player_games_per_position
    && metrics.nfl_weeks_represented >= candidate.min_nfl_weeks_per_position) return 'calibration_candidate';
  const early = thresholds.early_analysis;
  if (metrics.unique_player_games >= early.min_unique_player_games_per_position
    && metrics.nfl_weeks_represented >= early.min_nfl_weeks_per_position) return 'early_analysis';
  return 'collecting';
}

function validateThresholds(value) {
  for (const name of ['early_analysis', 'calibration_candidate']) {
    if (!positiveIntegerOrNull(value?.[name]?.min_unique_player_games_per_position)
      || !positiveIntegerOrNull(value?.[name]?.min_nfl_weeks_per_position)) {
      throw new TypeError(`Invalid ${name} readiness thresholds`);
    }
  }
}

function messageFor(status, season) {
  return STATUS_MESSAGE[status].replace('2026', String(season));
}

function scoringPlatform(value) {
  const match = /^(espn|sleeper):[a-f0-9]{16}$/i.exec(value || '');
  return match?.[1]?.toLowerCase() ?? null;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function integerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function positiveInteger(value, label) {
  const number = positiveIntegerOrNull(value);
  if (!number) throw new TypeError(`${label} must be a positive integer`);
  return number;
}

function timestampOrNull(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
