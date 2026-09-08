import { createHash } from 'node:crypto';
import { espnHomePerspectiveSpread, findPlayerGame, findPlayerOpponent, resolvePlayerNflTeam } from './context-service.js';
import { readPregameDecisionSnapshots, savePregameDecisionSnapshots } from './storage.js';

export const PREGAME_SNAPSHOT_VERSION = 1;
const SNAPSHOT_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);
const POSTGAME_RESULT_SOURCES = new Set(['espn-fantasy-applied-total', 'sleeper-league-matchup-points']);

/** Build a compact, explicitly allowlisted snapshot candidate for each relevant roster player. */
export function buildPregameSnapshotCandidates({
  analysis,
  league,
  roster = [],
  nflContext,
  coachTracker = analysis?.coachTracker,
  weatherContext = analysis?.weatherContext,
  nextGenContext = analysis?.nextGenContext
} = {}) {
  const season = positiveIntegerOrNull(league?.season ?? analysis?.league?.season);
  const week = positiveIntegerOrNull(league?.currentWeek ?? analysis?.league?.week);
  const fantasyLeagueId = textOrNull(league?.id ?? analysis?.league?.id ?? analysis?.league?.key);
  if (!season || !week || !fantasyLeagueId || !Array.isArray(roster)) return [];

  const projectionByPlayer = new Map((analysis?.projections || []).map((projection) => [String(projection.playerId), projection]));
  const weatherByGame = new Map((weatherContext?.games || []).map((game) => [String(game.gameId), game]));
  const nextGenByPlayer = new Map((nextGenContext?.players || []).map((player) => [String(player.requestedPlayerId), player]));
  const scoringSettingsId = scoringFingerprint(league);
  const candidates = [];

  for (const player of roster) {
    const position = String(player?.position || '').trim().toUpperCase();
    if (!SNAPSHOT_POSITIONS.has(position)) continue;
    const playerId = textOrNull(player?.playerId ?? player?.id);
    const projection = playerId ? projectionByPlayer.get(playerId) : null;
    if (!playerId || !projection || projection.available === false) continue;
    const game = findPlayerGame(player, nflContext);
    if (!game?.id || !validIso(game.kickoff)) continue;
    const team = resolvePlayerNflTeam(player, nflContext);
    const opponent = findPlayerOpponent(player, nflContext);
    const offense = findOffenseGroup(coachTracker, team?.abbreviation, playerId);
    const weather = weatherByGame.get(String(game.id)) || null;
    const candidate = sanitizeCandidate({
      season,
      week,
      nfl_game_id: game.id,
      kickoff: game.kickoff,
      player_id: playerId,
      player_name: player.name,
      nfl_team: team?.abbreviation,
      opponent: opponent?.abbreviation,
      position,
      fantasy_league_id: fantasyLeagueId,
      scoring_settings_id: scoringSettingsId,
      projection: { median: projection.median, floor: projection.floor, ceiling: projection.ceiling },
      prediction: predictionSnapshot(projection),
      betting: bettingSnapshot(game),
      context: {
        injury_status: player.injuryStatus,
        venue_type: venueType(game, weather),
        weather_flags: weather?.flags,
        coaching: coachingSnapshot(offense),
        next_gen: nextGenSnapshot(nextGenByPlayer.get(playerId)),
        nflverse: nflverseSnapshot(offense?.teamTrend?.nflverse)
      }
    });
    if (candidate) candidates.push(candidate);
  }
  return candidates.sort((left, right) => left.record_id.localeCompare(right.record_id));
}

/**
 * Build compact, leakage-safe lineup decision records that reference the player
 * snapshots above instead of copying their projections or eventual results.
 */
export function buildPregameDecisionCandidates(input = {}, recordCandidates = buildPregameSnapshotCandidates(input)) {
  const { analysis, league } = input;
  const season = positiveIntegerOrNull(league?.season ?? analysis?.league?.season);
  const week = positiveIntegerOrNull(league?.currentWeek ?? analysis?.league?.week);
  const fantasyLeagueId = textOrNull(league?.id ?? analysis?.league?.id ?? analysis?.league?.key);
  const scoringSettingsId = scoringFingerprint(league);
  const lineup = analysis?.lineup;
  if (!season || !week || !fantasyLeagueId || !lineup || typeof lineup !== 'object') return [];

  const recordsByPlayer = new Map((recordCandidates || []).map((record) => [String(record.player_id), record]));
  const qualityByPair = new Map((analysis?.recommendationQuality?.comparisons || []).map((comparison) => [
    decisionPairKey(comparison?.recommendedPlayer?.playerId, comparison?.alternativePlayer?.playerId), comparison
  ]));
  const decisions = [];

  for (const recommendation of lineup.recommendations || []) {
    const recommendedId = textOrNull(recommendation?.start?.playerId);
    const alternativeId = textOrNull(recommendation?.sit?.playerId);
    if (!recommendedId || !alternativeId) continue;
    const recommended = recordsByPlayer.get(recommendedId);
    const alternative = recordsByPlayer.get(alternativeId);
    if (!recommended || !alternative) continue;
    const quality = qualityByPair.get(decisionPairKey(recommendedId, alternativeId));
    decisions.push({
      season,
      week,
      fantasy_league_id: fantasyLeagueId,
      scoring_settings_id: scoringSettingsId,
      type: 'start_sit',
      recommended_player_record_id: recommended.record_id,
      alternative_player_record_id: alternative.record_id,
      recommended_player_id: recommendedId,
      alternative_player_id: alternativeId,
      current_player_id: alternativeId,
      actual_user_started_player_id: null,
      probability_recommended_outscores: probabilityOrNull(recommendation.probabilityStartOutscoresSit),
      expected_gain: finiteNumber(recommendation.expectedGain),
      confidence_label: textOrNull(quality?.confidence ?? recommendation?.confidence?.level),
      support_classification: textOrNull(quality?.supportClassification),
      objective: textOrNull(lineup.objective),
      target_slot_id: textOrNull(recommendation.targetSlotId),
      lock_at: earliestIso(recommended.kickoff, alternative.kickoff)
    });
  }

  // A withheld one-for-one close call is an explicit decision to keep the
  // user's current starter. It is gradeable only because the alternative was
  // fixed before either player's kickoff.
  if (!(lineup.recommendations || []).length && finiteNumber(lineup.expectedGain) != null
    && finiteNumber(lineup.expectedGain) >= 0 && finiteNumber(lineup.expectedGain) < (finiteNumber(lineup.minimumGain) ?? 0)) {
    const currentIds = new Set((lineup.current?.assignments || []).map((assignment) => String(assignment.playerId)));
    const optimalIds = new Set((lineup.recommended?.assignments || []).map((assignment) => String(assignment.playerId)));
    const kept = (lineup.current?.assignments || []).filter((assignment) => !optimalIds.has(String(assignment.playerId)));
    const alternativeAssignments = (lineup.recommended?.assignments || []).filter((assignment) => !currentIds.has(String(assignment.playerId)));
    if (kept.length === 1 && alternativeAssignments.length === 1) {
      const recommendedId = textOrNull(kept[0].playerId);
      const alternativeId = textOrNull(alternativeAssignments[0].playerId);
      const recommended = recordsByPlayer.get(recommendedId);
      const alternative = recordsByPlayer.get(alternativeId);
      const quality = qualityByPair.get(decisionPairKey(alternativeId, recommendedId));
      const projectionsById = new Map((lineup.projections || []).map((projection) => [String(projection.playerId), projection]));
      if (recommended && alternative) decisions.push({
        season,
        week,
        fantasy_league_id: fantasyLeagueId,
        scoring_settings_id: scoringSettingsId,
        type: 'agreement',
        recommended_player_record_id: recommended.record_id,
        alternative_player_record_id: alternative.record_id,
        recommended_player_id: recommendedId,
        alternative_player_id: alternativeId,
        current_player_id: recommendedId,
        actual_user_started_player_id: null,
        probability_recommended_outscores: comparisonProbability(projectionsById.get(recommendedId), projectionsById.get(alternativeId)),
        expected_gain: roundPoint(-finiteNumber(lineup.expectedGain)),
        confidence_label: textOrNull(quality?.confidence),
        support_classification: textOrNull(quality?.supportClassification),
        objective: textOrNull(lineup.objective),
        target_slot_id: textOrNull(kept[0].slotId),
        lock_at: earliestIso(recommended.kickoff, alternative.kickoff)
      });
    }
  }

  return decisions.map(sanitizeDecisionCandidate).filter(Boolean)
    .sort((left, right) => left.decision_id.localeCompare(right.decision_id));
}

/**
 * Pure pregame upsert. The stored kickoff is also honored so a later schedule
 * value cannot reopen a record that has already locked.
 */
export function updatePregameSnapshotState(input, candidates, { capturedAt } = {}) {
  const captured = validIso(capturedAt);
  if (!captured) throw new TypeError('capturedAt must be a valid timestamp');
  const current = normalizeState(input);
  const records = { ...current.records };
  const decisions = { ...(current.decisions || {}) };
  const recordCandidates = Array.isArray(candidates) ? candidates : Array.isArray(candidates?.records) ? candidates.records : [];
  const decisionCandidates = !Array.isArray(candidates) && Array.isArray(candidates?.decisions) ? candidates.decisions : [];
  let created = 0;
  let updated = 0;
  let skipped = 0;
  let decisionsCreated = 0;
  let decisionsUpdated = 0;
  let decisionsSkipped = 0;

  for (const raw of recordCandidates) {
    const candidate = sanitizeCandidate(raw);
    if (!candidate) { skipped += 1; continue; }
    const incomingKickoff = Date.parse(candidate.kickoff);
    const existing = records[candidate.record_id];
    const storedKickoff = existing ? Date.parse(existing.kickoff) : incomingKickoff;
    const storedLock = existing ? Date.parse(existing.lock_at ?? existing.kickoff) : incomingKickoff;
    const latestCapture = existing ? Date.parse(existing.latest_capture_at ?? existing.captured_at) : null;
    if (!Number.isFinite(storedKickoff) || !Number.isFinite(storedLock) || (existing && !Number.isFinite(latestCapture))) { skipped += 1; continue; }
    const lockAt = Math.min(incomingKickoff, storedKickoff, storedLock);
    const captureTime = Date.parse(captured);
    if (captureTime >= lockAt || (existing && captureTime <= latestCapture)) { skipped += 1; continue; }

    const firstCapture = existing?.first_capture_at || existing?.captured_at || captured;
    records[candidate.record_id] = {
      ...candidate,
      lock_at: new Date(lockAt).toISOString(),
      captured_at: captured,
      first_capture_at: firstCapture,
      latest_capture_at: captured
    };
    if (existing) updated += 1;
    else created += 1;
  }

  for (const raw of decisionCandidates) {
    const candidate = sanitizeDecisionCandidate(raw);
    if (!candidate) { decisionsSkipped += 1; continue; }
    const recommendedRecord = records[candidate.recommended_player_record_id];
    const alternativeRecord = records[candidate.alternative_player_record_id];
    if (!decisionReferencesMatch(candidate, recommendedRecord, alternativeRecord)) { decisionsSkipped += 1; continue; }
    const existing = decisions[candidate.decision_id];
    const incomingLock = Date.parse(candidate.lock_at);
    const storedLock = existing ? Date.parse(existing.lock_at) : incomingLock;
    const referencedLock = Math.min(
      Date.parse(recommendedRecord.lock_at ?? recommendedRecord.kickoff),
      Date.parse(alternativeRecord.lock_at ?? alternativeRecord.kickoff)
    );
    const latestCapture = existing ? Date.parse(existing.latest_capture_at ?? existing.captured_at) : null;
    if (!Number.isFinite(incomingLock) || !Number.isFinite(storedLock) || !Number.isFinite(referencedLock)
      || (existing && !Number.isFinite(latestCapture))) {
      decisionsSkipped += 1;
      continue;
    }
    const lockAt = Math.min(incomingLock, storedLock, referencedLock);
    const captureTime = Date.parse(captured);
    if (captureTime >= lockAt || (existing && captureTime <= latestCapture)) { decisionsSkipped += 1; continue; }
    const firstCapture = existing?.first_capture_at || existing?.captured_at || captured;
    decisions[candidate.decision_id] = {
      ...candidate,
      lock_at: new Date(lockAt).toISOString(),
      captured_at: captured,
      first_capture_at: firstCapture,
      latest_capture_at: captured
    };
    if (existing) decisionsUpdated += 1;
    else decisionsCreated += 1;
  }

  const changed = created + updated + decisionsCreated + decisionsUpdated > 0;
  const decisionCounts = { decisionsCreated, decisionsUpdated, decisionsSkipped };
  if (!changed) return { state: current, changed: false, created, updated, skipped, ...decisionCounts };
  return {
    state: {
      version: PREGAME_SNAPSHOT_VERSION,
      updated_at: captured,
      records: Object.fromEntries(Object.entries(records).sort(([left], [right]) => left.localeCompare(right))),
      decisions: Object.fromEntries(Object.entries(decisions).sort(([left], [right]) => left.localeCompare(right)))
    },
    changed: true,
    created,
    updated,
    skipped,
    ...decisionCounts
  };
}

/** Attach only a compact final result; every existing pregame field is retained unchanged. */
export function attachPostgameResultState(input, candidates, { attachedAt } = {}) {
  const attached = validIso(attachedAt);
  if (!attached) throw new TypeError('attachedAt must be a valid timestamp');
  const current = normalizeState(input);
  const records = { ...current.records };
  let added = 0;
  let alreadyAttached = 0;
  let skipped = 0;

  for (const raw of Array.isArray(candidates) ? candidates : []) {
    const candidate = sanitizeResultCandidate(raw);
    if (!candidate) { skipped += 1; continue; }
    const existing = records[candidate.record_id];
    if (!resultIdentityMatches(existing, candidate)) { skipped += 1; continue; }
    if (validAttachedResult(existing.result)) { alreadyAttached += 1; continue; }

    const lockTime = Date.parse(existing.lock_at ?? existing.kickoff);
    if (!Number.isFinite(lockTime) || Date.parse(attached) < lockTime) { skipped += 1; continue; }
    records[candidate.record_id] = {
      ...existing,
      result: {
        status: 'attached',
        actual_fantasy_points: candidate.actual_fantasy_points,
        nfl_game_status: 'final',
        source: candidate.source,
        completed_at: candidate.completed_at,
        attached_at: attached
      }
    };
    added += 1;
  }

  if (!added) return { state: current, changed: false, attached: 0, alreadyAttached, skipped };
  return {
    state: {
      ...current,
      updated_at: attached,
      records: Object.fromEntries(Object.entries(records).sort(([left], [right]) => left.localeCompare(right)))
    },
    changed: true,
    attached: added,
    alreadyAttached,
    skipped
  };
}

/** Serialize each read-modify-write cycle so concurrent league analyses cannot lose records. */
export function createPregameSnapshotStore({
  read = readPregameDecisionSnapshots,
  write = savePregameDecisionSnapshots,
  now = () => new Date()
} = {}) {
  let queue = Promise.resolve();
  const enqueue = (operation) => {
    const job = queue.then(operation);
    queue = job.then(() => undefined, () => undefined);
    return job;
  };
  return {
    capture(candidates) {
      return enqueue(async () => {
        const capturedAt = validIso(now());
        if (!capturedAt) throw Object.assign(new Error('Invalid snapshot clock'), { code: 'INVALID_TIME' });
        const update = updatePregameSnapshotState(await read(), candidates, { capturedAt });
        if (update.changed) await write(update.state);
        return { ...update, capturedAt, stored: update.changed };
      });
    },
    attachResults(candidates) {
      return enqueue(async () => {
        const attachedAt = validIso(now());
        if (!attachedAt) throw Object.assign(new Error('Invalid snapshot clock'), { code: 'INVALID_TIME' });
        const update = attachPostgameResultState(await read(), candidates, { attachedAt });
        if (update.changed) await write(update.state);
        return { ...update, attachedAt, stored: update.changed };
      });
    }
  };
}

export const pregameSnapshotStore = createPregameSnapshotStore();

/** Snapshot failures are local-only and can never fail or mutate live analysis. */
export async function safelyCapturePregameDecisionSnapshots(input, {
  store = pregameSnapshotStore,
  warn = console.warn
} = {}) {
  try {
    const records = buildPregameSnapshotCandidates(input);
    if (!records.length) return { stored: false, changed: false, created: 0, updated: 0, skipped: 0 };
    const decisions = buildPregameDecisionCandidates(input, records);
    return await store.capture({ records, decisions });
  } catch (error) {
    const code = safeErrorCode(error?.code);
    try { warn(`Pregame snapshot storage failed${code ? ` (${code})` : ''}; fantasy analysis continued.`); } catch {}
    return { stored: false, changed: false, created: 0, updated: 0, skipped: 0, error: 'snapshot_storage_unavailable' };
  }
}

function sanitizeCandidate(raw) {
  const season = positiveIntegerOrNull(raw?.season);
  const week = positiveIntegerOrNull(raw?.week);
  const gameId = textOrNull(raw?.nfl_game_id);
  const kickoff = validIso(raw?.kickoff);
  const playerId = textOrNull(raw?.player_id);
  const leagueId = textOrNull(raw?.fantasy_league_id);
  const position = String(raw?.position || '').trim().toUpperCase();
  const median = finiteNumber(raw?.projection?.median);
  const floor = finiteNumber(raw?.projection?.floor);
  const ceiling = finiteNumber(raw?.projection?.ceiling);
  if (!season || !week || !gameId || !kickoff || !playerId || !leagueId || !SNAPSHOT_POSITIONS.has(position) || median == null || floor == null || ceiling == null) return null;
  const recordId = snapshotRecordId({ season, week, gameId, playerId, leagueId });
  return {
    record_id: recordId,
    season,
    week,
    nfl_game_id: gameId,
    kickoff,
    player_id: playerId,
    player_name: textOrNull(raw.player_name),
    nfl_team: textOrNull(raw.nfl_team),
    opponent: textOrNull(raw.opponent),
    position,
    fantasy_league_id: leagueId,
    scoring_settings_id: textOrNull(raw.scoring_settings_id),
    projection: { median, floor, ceiling },
    prediction: sanitizePrediction(raw.prediction),
    betting: sanitizeBetting(raw.betting),
    context: sanitizeContext(raw.context)
  };
}

function predictionSnapshot(projection) {
  const mean = finiteNumber(projection?.mean);
  const bustProbability = probabilityOrNull(projection?.bustProbability);
  const spikeProbability = probabilityOrNull(projection?.spikeProbability);
  const thresholdProbabilities = sanitizeThresholdProbabilities(projection?.thresholdProbabilities);
  if (mean == null && bustProbability == null && spikeProbability == null && !thresholdProbabilities.length) return null;
  return {
    mean,
    bust_probability: bustProbability,
    spike_probability: spikeProbability,
    bust_threshold: mean == null ? null : roundPoint(mean * 0.60),
    spike_threshold: mean == null ? null : roundPoint(mean * 1.40),
    threshold_probabilities: thresholdProbabilities,
    definition_version: 'range-heuristic-v1'
  };
}

function sanitizePrediction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const mean = finiteNumber(raw.mean);
  const bustProbability = probabilityOrNull(raw.bust_probability);
  const spikeProbability = probabilityOrNull(raw.spike_probability);
  const bustThreshold = finiteNumber(raw.bust_threshold);
  const spikeThreshold = finiteNumber(raw.spike_threshold);
  const thresholdProbabilities = sanitizeThresholdProbabilities(raw.threshold_probabilities);
  if (mean == null && bustProbability == null && spikeProbability == null && !thresholdProbabilities.length) return null;
  return {
    mean,
    bust_probability: bustProbability,
    spike_probability: spikeProbability,
    bust_threshold: bustThreshold,
    spike_threshold: spikeThreshold,
    threshold_probabilities: thresholdProbabilities,
    definition_version: textOrNull(raw.definition_version)
  };
}

function sanitizeThresholdProbabilities(values) {
  const byThreshold = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const threshold = finiteNumber(value?.threshold);
    const probability = probabilityOrNull(value?.probability);
    if (threshold == null || threshold < 0 || probability == null) continue;
    byThreshold.set(threshold, { threshold, probability });
  }
  return [...byThreshold.values()].sort((left, right) => left.threshold - right.threshold).slice(0, 12);
}

function sanitizeDecisionCandidate(raw) {
  const season = positiveIntegerOrNull(raw?.season);
  const week = positiveIntegerOrNull(raw?.week);
  const leagueId = textOrNull(raw?.fantasy_league_id);
  const scoringSettingsId = textOrNull(raw?.scoring_settings_id);
  const type = ['start_sit', 'agreement'].includes(raw?.type) ? raw.type : null;
  const recommendedRecordId = textOrNull(raw?.recommended_player_record_id);
  const alternativeRecordId = textOrNull(raw?.alternative_player_record_id);
  const recommendedPlayerId = textOrNull(raw?.recommended_player_id);
  const alternativePlayerId = textOrNull(raw?.alternative_player_id);
  const lockAt = validIso(raw?.lock_at);
  if (!season || !week || !leagueId || !scoringSettingsId || !type || !recommendedRecordId || !alternativeRecordId
    || !recommendedPlayerId || !alternativePlayerId || recommendedPlayerId === alternativePlayerId || !lockAt) return null;
  const targetSlotId = textOrNull(raw.target_slot_id);
  return {
    decision_id: decisionRecordId({ season, week, leagueId, type, recommendedPlayerId, alternativePlayerId, targetSlotId }),
    season,
    week,
    fantasy_league_id: leagueId,
    scoring_settings_id: scoringSettingsId,
    type,
    recommended_player_record_id: recommendedRecordId,
    alternative_player_record_id: alternativeRecordId,
    recommended_player_id: recommendedPlayerId,
    alternative_player_id: alternativePlayerId,
    current_player_id: textOrNull(raw.current_player_id),
    actual_user_started_player_id: textOrNull(raw.actual_user_started_player_id),
    probability_recommended_outscores: probabilityOrNull(raw.probability_recommended_outscores),
    expected_gain: finiteNumber(raw.expected_gain),
    confidence_label: textOrNull(raw.confidence_label),
    support_classification: textOrNull(raw.support_classification),
    objective: textOrNull(raw.objective),
    target_slot_id: targetSlotId,
    lock_at: lockAt
  };
}

function snapshotRecordId({ season, week, gameId, playerId, leagueId }) {
  return [season, week, gameId, playerId, leagueId].map((value) => encodeURIComponent(String(value))).join('|');
}

function decisionRecordId({ season, week, leagueId, type, recommendedPlayerId, alternativePlayerId, targetSlotId }) {
  return [season, week, 'decision', leagueId, type, recommendedPlayerId, alternativePlayerId, targetSlotId || 'comparison']
    .map((value) => encodeURIComponent(String(value))).join('|');
}

function decisionPairKey(recommendedPlayerId, alternativePlayerId) {
  return `${textOrNull(recommendedPlayerId) || ''}|${textOrNull(alternativePlayerId) || ''}`;
}

function decisionReferencesMatch(decision, recommended, alternative) {
  const matches = (record, playerId) => record
    && Number(record.season) === decision.season
    && Number(record.week) === decision.week
    && String(record.fantasy_league_id) === decision.fantasy_league_id
    && String(record.scoring_settings_id) === decision.scoring_settings_id
    && String(record.player_id) === playerId;
  return matches(recommended, decision.recommended_player_id)
    && matches(alternative, decision.alternative_player_id);
}

function earliestIso(...values) {
  const times = values.map(validIso).filter(Boolean).map((value) => Date.parse(value));
  return times.length === values.length ? new Date(Math.min(...times)).toISOString() : null;
}

function comparisonProbability(left, right) {
  const leftMean = finiteNumber(left?.mean);
  const rightMean = finiteNumber(right?.mean);
  const leftFloor = finiteNumber(left?.floor);
  const leftCeiling = finiteNumber(left?.ceiling);
  const rightFloor = finiteNumber(right?.floor);
  const rightCeiling = finiteNumber(right?.ceiling);
  if ([leftMean, rightMean, leftFloor, leftCeiling, rightFloor, rightCeiling].some((value) => value == null)) return null;
  const leftSd = Math.max(0.5, (leftCeiling - leftFloor) / 1.683242);
  const rightSd = Math.max(0.5, (rightCeiling - rightFloor) / 1.683242);
  return roundProbability(normalCdf((leftMean - rightMean) / Math.sqrt(leftSd ** 2 + rightSd ** 2)));
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return (1 + sign * (1 - polynomial * Math.exp(-x * x))) / 2;
}

function bettingSnapshot(game) {
  const odds = game?.odds;
  const explicitPrimary = odds?.primary && typeof odds.primary === 'object' ? odds.primary : null;
  const totalSource = odds?.lineSources?.total;
  const spreadSource = odds?.lineSources?.spread;
  const primaryTotal = explicitPrimary
    ? finiteNumber(explicitPrimary.total)
    : totalSource == null || totalSource === 'espn' ? finiteNumber(odds?.total) : null;
  const primarySpread = explicitPrimary
    ? finiteNumber(explicitPrimary.homeSpread)
    : spreadSource == null || spreadSource === 'espn' ? espnHomePerspectiveSpread(game) : null;
  const secondaryTotal = finiteNumber(odds?.secondary?.total);
  const secondarySpread = finiteNumber(odds?.secondary?.homeSpread);
  return {
    primary_total: primaryTotal,
    primary_home_spread: primarySpread,
    primary_source: primaryTotal != null || primarySpread != null ? 'espn' : null,
    secondary_consensus_total: secondaryTotal,
    secondary_home_spread: secondarySpread,
    secondary_source: secondaryTotal != null || secondarySpread != null ? 'the-odds-api-v4' : null,
    bookmaker_count: nonNegativeIntegerOrNull(odds?.secondary?.bookmakerCount),
    provider_comparison_status: textOrNull(odds?.comparison?.status),
    spread_orientation: 'home_team'
  };
}

function sanitizeBetting(raw) {
  return {
    primary_total: finiteNumber(raw?.primary_total),
    primary_home_spread: finiteNumber(raw?.primary_home_spread),
    primary_source: textOrNull(raw?.primary_source),
    secondary_consensus_total: finiteNumber(raw?.secondary_consensus_total),
    secondary_home_spread: finiteNumber(raw?.secondary_home_spread),
    secondary_source: textOrNull(raw?.secondary_source),
    bookmaker_count: nonNegativeIntegerOrNull(raw?.bookmaker_count),
    provider_comparison_status: textOrNull(raw?.provider_comparison_status),
    spread_orientation: 'home_team'
  };
}

function sanitizeContext(raw) {
  const coaching = raw?.coaching && typeof raw.coaching === 'object' ? {
    offense_period_id: textOrNull(raw.coaching.offense_period_id),
    head_coach_period_id: textOrNull(raw.coaching.head_coach_period_id),
    period_start_week: positiveIntegerOrNull(raw.coaching.period_start_week),
    role_period_ids: compactRolePeriods(raw.coaching.role_period_ids)
  } : null;
  const nextGen = raw?.next_gen && typeof raw.next_gen === 'object' ? {
    status: textOrNull(raw.next_gen.status),
    learning: booleanOrNull(raw.next_gen.learning),
    current_season: positiveIntegerOrNull(raw.next_gen.current_season),
    current_sample: compactSamples(raw.next_gen.current_sample),
    reference_season: positiveIntegerOrNull(raw.next_gen.reference_season),
    reference_sample: compactSamples(raw.next_gen.reference_sample)
  } : null;
  const nflverse = raw?.nflverse && typeof raw.nflverse === 'object' ? {
    status: textOrNull(raw.nflverse.status),
    season: positiveIntegerOrNull(raw.nflverse.season),
    sample_games: nonNegativeIntegerOrNull(raw.nflverse.sample_games),
    period_id: textOrNull(raw.nflverse.period_id),
    data_version: textOrNull(raw.nflverse.data_version),
    recent_change_status: textOrNull(raw.nflverse.recent_change_status)
  } : null;
  return {
    injury_status: textOrNull(raw?.injury_status),
    venue_type: textOrNull(raw?.venue_type) || 'unknown',
    weather_flags: compactTextList(raw?.weather_flags),
    coaching,
    next_gen: nextGen,
    nflverse
  };
}

function coachingSnapshot(offense) {
  if (!offense) return null;
  return {
    offense_period_id: offense.analysisPeriod?.tenureId,
    head_coach_period_id: offense.coachingContext?.tenure?.tenureId,
    period_start_week: offense.analysisPeriod?.startWeek,
    role_period_ids: (offense.analysisPeriod?.basisRoles || []).map((role) => ({ role: role.role, tenure_id: role.tenureId }))
  };
}

function nextGenSnapshot(player) {
  if (!player) return null;
  return {
    status: player.status,
    learning: player.learning,
    current_season: player.current?.season,
    current_sample: sampleRows(player.current?.sample),
    reference_season: player.reference?.season,
    reference_sample: sampleRows(player.reference?.sample)
  };
}

function nflverseSnapshot(value) {
  if (!value) return null;
  return {
    status: value.available ? 'available' : value.learning ? 'learning' : 'unavailable',
    season: value.season,
    sample_games: value.window?.includedGames,
    period_id: value.period?.tenureId,
    data_version: value.dataVersion,
    recent_change_status: value.recentChange?.available ? value.recentChange.label : 'not_available'
  };
}

function sampleRows(sample) {
  return Object.entries(sample || {}).map(([type, value]) => ({ type, week: value?.week, basis: value?.basis }));
}

function compactSamples(values) {
  return (Array.isArray(values) ? values : []).flatMap((value) => {
    const type = textOrNull(value?.type);
    const week = nonNegativeIntegerOrNull(value?.week);
    if (!type || week == null) return [];
    return [{ type, week, basis: textOrNull(value?.basis) }];
  }).sort((left, right) => left.type.localeCompare(right.type));
}

function compactRolePeriods(values) {
  return (Array.isArray(values) ? values : []).flatMap((value) => {
    const role = textOrNull(value?.role);
    const tenureId = textOrNull(value?.tenure_id);
    return role && tenureId ? [{ role, tenure_id: tenureId }] : [];
  }).sort((left, right) => left.role.localeCompare(right.role));
}

function findOffenseGroup(coachTracker, team, playerId) {
  const normalizedTeam = String(team || '').toUpperCase();
  return (coachTracker?.offenses || []).find((group) => String(group?.team?.abbreviation || '').toUpperCase() === normalizedTeam
    && (group.players || []).some((player) => String(player.playerId) === playerId)) || null;
}

function venueType(game, weather) {
  const roofType = textOrNull(weather?.venue?.roofType);
  if (roofType && roofType !== 'unknown') return roofType;
  if (game?.indoor === true || game?.venue?.indoor === true) return 'indoor';
  if (game?.indoor === false || game?.venue?.indoor === false) return 'outdoor';
  return 'unknown';
}

export function scoringFingerprint(league) {
  const rules = league?.scoring?.rules && typeof league.scoring.rules === 'object' ? league.scoring.rules : {};
  const canonical = JSON.stringify(Object.entries(rules).sort(([left], [right]) => left.localeCompare(right)));
  return `${textOrNull(league?.platform) || 'fantasy'}:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

function sanitizeResultCandidate(raw) {
  const season = positiveIntegerOrNull(raw?.season);
  const week = positiveIntegerOrNull(raw?.week);
  const gameId = textOrNull(raw?.nfl_game_id);
  const playerId = textOrNull(raw?.player_id);
  const leagueId = textOrNull(raw?.fantasy_league_id);
  const scoringSettingsId = textOrNull(raw?.scoring_settings_id);
  const actualFantasyPoints = finiteNumber(raw?.actual_fantasy_points);
  const source = textOrNull(raw?.source);
  const completedAt = raw?.completed_at == null ? null : validIso(raw.completed_at);
  if (!season || !week || !gameId || !playerId || !leagueId || !scoringSettingsId || actualFantasyPoints == null
    || raw?.game_completed !== true || String(raw?.nfl_game_status || '').toLowerCase() !== 'final'
    || !POSTGAME_RESULT_SOURCES.has(source) || (raw?.completed_at != null && !completedAt)) return null;
  return {
    record_id: snapshotRecordId({ season, week, gameId, playerId, leagueId }),
    season,
    week,
    nfl_game_id: gameId,
    player_id: playerId,
    fantasy_league_id: leagueId,
    scoring_settings_id: scoringSettingsId,
    actual_fantasy_points: actualFantasyPoints,
    source,
    completed_at: completedAt
  };
}

function resultIdentityMatches(record, candidate) {
  return record && String(record.record_id) === candidate.record_id
    && Number(record.season) === candidate.season
    && Number(record.week) === candidate.week
    && String(record.nfl_game_id) === candidate.nfl_game_id
    && String(record.player_id) === candidate.player_id
    && String(record.fantasy_league_id) === candidate.fantasy_league_id
    && String(record.scoring_settings_id) === candidate.scoring_settings_id;
}

function validAttachedResult(result) {
  return result?.status === 'attached'
    && result?.nfl_game_status === 'final'
    && finiteNumber(result?.actual_fantasy_points) != null
    && POSTGAME_RESULT_SOURCES.has(textOrNull(result?.source))
    && validIso(result?.attached_at) != null;
}

function normalizeState(input) {
  if (input == null) return { version: PREGAME_SNAPSHOT_VERSION, updated_at: null, records: {}, decisions: {} };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Number(input.version) !== PREGAME_SNAPSHOT_VERSION || !input.records || typeof input.records !== 'object' || Array.isArray(input.records)) {
    throw Object.assign(new Error('Pregame snapshot history has an unsupported shape'), { code: 'INVALID_SNAPSHOT_FILE' });
  }
  if (input.decisions != null && (!input.decisions || typeof input.decisions !== 'object' || Array.isArray(input.decisions))) {
    throw Object.assign(new Error('Pregame snapshot decisions have an unsupported shape'), { code: 'INVALID_SNAPSHOT_FILE' });
  }
  return input.decisions ? input : { ...input, decisions: {} };
}

function compactTextList(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(textOrNull).filter(Boolean))].slice(0, 12);
}

function safeErrorCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : null;
}

function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeIntegerOrNull(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function finiteNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function probabilityOrNull(value) {
  const number = finiteNumber(value);
  return number != null && number >= 0 && number <= 1 ? number : null;
}

function roundProbability(value) {
  return Math.round(value * 1_000) / 1_000;
}

function roundPoint(value) {
  return Math.round(value * 10) / 10;
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function textOrNull(value) {
  const text = value == null ? '' : String(value).trim();
  return text || null;
}

function validIso(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
