const MAX_ACTIONS = 5;
const OUT_STATUSES = new Set(['OUT', 'O', 'INACTIVE', 'IR', 'INJURED_RESERVE', 'PUP', 'SUSPENDED']);
const MONITOR_STATUSES = new Set(['DOUBTFUL', 'D', 'QUESTIONABLE', 'Q', 'GAME_TIME_DECISION', 'GTD']);
const CLOSE_CLASSIFICATIONS = new Set(['projection_conflict', 'mixed']);
const LOW_CONFIDENCE = new Set(['low', 'uncertain']);

/**
 * Condense existing analysis into a short priority list. This function only
 * reads already-produced results; it never projects, optimizes, reranks, or
 * calls a fantasy platform.
 */
export function buildTopActionsToday({
  lineup = null,
  recommendationQuality = null,
  priorAdjustedDecisions = null,
  weeklyIntelligence = null,
  newsChanges = [],
  players = [],
  waivers = null,
  historicalOpponentPriors = null,
  maxActions = MAX_ACTIONS
} = {}) {
  const limit = Math.min(MAX_ACTIONS, Math.max(0, Math.trunc(number(maxActions) ?? MAX_ACTIONS)));
  const candidates = [];
  const seenPairs = new Set();
  const priorByComparison = new Map((priorAdjustedDecisions?.decisions || [])
    .map((decision) => [text(decision?.comparisonId), decision])
    .filter(([comparisonId]) => comparisonId));
  let order = 0;
  const add = (candidate) => {
    if (!candidate?.action || !candidate?.reason) return;
    candidates.push({ ...candidate, order: order += 1 });
  };

  addNewsActions(add, newsChanges, weeklyIntelligence);
  addAvailabilityActions(add, players, lineup);
  addLineupActions(add, lineup, recommendationQuality, priorByComparison, seenPairs);
  addIntelligenceActions(add, weeklyIntelligence, seenPairs);
  addWaiverAction(add, waivers, historicalOpponentPriors);

  if (lineupsMatch(lineup)) add({
    key: 'lineup:no-change',
    priority: 50,
    status: 'No action',
    action: 'No starting-lineup changes needed right now.',
    reason: 'The current starting lineup already matches the optimizer’s recommended lineup.',
    source: 'existing_lineup_optimizer',
    playerIds: []
  });

  const actions = mergeRelatedAvailability(mergeDuplicates(candidates))
    .sort((left, right) => left.priority - right.priority || left.order - right.order)
    .slice(0, limit)
    .map(({ priority: _priority, order: _order, key: _key, ...action }) => action);

  return {
    title: 'Top Actions Today',
    actions,
    maximumActions: limit,
    methodology: {
      source: 'Existing lineup, Recommendation Quality, Weekly Intelligence, actionable news, injury, and waiver outputs only.',
      priority: 'Availability emergencies, lineup changes, close calls, waiver actions, then important observations.',
      deduplication: 'One action per underlying news/player issue or lineup player pair.',
      limitation: 'This summary does not create or recalculate any recommendation.'
    },
    safeguards: { readOnly: true, transactionsPerformed: false },
    projectionsAdjusted: false,
    optimizerAdjusted: false,
    waiverRankingsAdjusted: false
  };
}

function addNewsActions(add, directNews, weeklyIntelligence) {
  const events = [
    ...(Array.isArray(directNews) ? directNews : []),
    ...(weeklyIntelligence?.observations || []).filter((event) => event?.kind === 'news')
  ];
  for (const event of events) {
    const materiality = token(event.materiality ?? event.severity ?? event.level);
    const actionable = event.requiresReanalysis === true || event.requires_reanalysis === true
      || event.meaningful === true || ['CRITICAL', 'MEANINGFUL'].includes(materiality);
    if (!actionable) continue;
    const playerId = text(event.playerId ?? event.player_id ?? event.playerIds?.[0]);
    const playerName = text(event.playerName ?? event.player_name) || nameFromHeadline(event.headline) || 'this player';
    const critical = materiality === 'CRITICAL';
    add({
      key: `availability:${playerId || normalize(playerName)}`,
      priority: critical ? 0 : 2,
      status: critical ? 'Act' : 'Monitor',
      action: `${critical ? 'Recheck' : 'Monitor'} ${playerName}`,
      reason: sentence(event.summary ?? event.reason ?? event.explanation)
        || 'An existing actionable news change could affect the current recommendation.',
      source: 'existing_news_monitor',
      playerIds: playerId ? [playerId] : []
    });
  }
}

function addAvailabilityActions(add, players, lineup) {
  const currentIds = new Set((lineup?.current?.assignments || []).map((assignment) => text(assignment.playerId)).filter(Boolean));
  for (const player of Array.isArray(players) ? players : []) {
    const playerId = text(player?.playerId ?? player?.id);
    if (!isCurrentStarter(player, playerId, currentIds)) continue;
    const status = injuryStatus(player);
    const unavailable = OUT_STATUSES.has(status);
    const uncertain = MONITOR_STATUSES.has(status);
    if (!unavailable && !uncertain) continue;
    const name = text(player.name) || 'Current starter';
    add({
      key: `availability:${playerId || normalize(name)}`,
      priority: unavailable ? 1 : status === 'DOUBTFUL' || status === 'D' ? 3 : 4,
      status: unavailable ? 'Act' : 'Monitor',
      action: `${unavailable ? 'Replace or recheck' : 'Monitor'} ${name}`,
      reason: unavailable
        ? `${name} is ${displayStatus(status)} in the existing injury context and should not remain an unattended starter.`
        : `${name} is ${displayStatus(status)}; recheck the existing lineup recommendation before kickoff.`,
      source: 'existing_injury_context',
      playerIds: playerId ? [playerId] : []
    });
  }
}

function addLineupActions(add, lineup, recommendationQuality, priorByComparison, seenPairs) {
  const qualityComparisons = Array.isArray(recommendationQuality?.comparisons)
    ? recommendationQuality.comparisons
    : [];
  for (const recommendation of lineup?.recommendations || []) {
    const recommendedId = text(recommendation?.start?.playerId);
    const alternativeId = text(recommendation?.sit?.playerId);
    const pair = pairKey(recommendedId, alternativeId);
    if (pair) seenPairs.add(pair);
    const quality = qualityComparisons.find((comparison) => comparisonMatches(comparison, recommendation));
    const prior = quality ? priorByComparison.get(text(quality.comparisonId)) : null;
    add(lineupAction(recommendation, quality, prior, pair));
  }

  // Recommendation Quality also contains explicit close calls withheld by the
  // optimizer's materiality threshold. Include only uncertain ones here.
  for (const comparison of qualityComparisons) {
    const recommendedId = text(comparison?.recommendedPlayer?.playerId);
    const alternativeId = text(comparison?.alternativePlayer?.playerId);
    const pair = pairKey(recommendedId, alternativeId);
    if (!pair || seenPairs.has(pair) || !isClose(comparison)) continue;
    seenPairs.add(pair);
    const recommended = comparison.recommendedPlayer;
    const alternative = comparison.alternativePlayer;
    if (!recommended || !alternative) continue;
    const prior = priorByComparison.get(text(comparison.comparisonId));
    add({
      key: `lineup:${pair}`,
      priority: 20,
      status: 'Close call',
      action: `Close call: ${name(recommended)} over ${name(alternative)}`,
      reason: closeReason(comparison.projectionDifference, comparison, prior),
      source: 'existing_recommendation_quality',
      playerIds: [recommendedId, alternativeId].filter(Boolean)
    });
  }
}

function lineupAction(recommendation, quality, prior, pair) {
  const recommended = recommendation?.start;
  if (!recommended) return null;
  const alternative = recommendation?.sit;
  const close = Boolean(alternative && (isClose(quality) || prior?.confidence === 'Low' || prior?.evidenceAgreement === 'mixed'));
  const gain = number(quality?.projectionDifference ?? recommendation.expectedGain);
  const action = alternative
    ? `${close ? 'Close call: ' : ''}Start ${name(recommended)} over ${name(alternative)}`
    : `Start ${name(recommended)} in ${text(recommendation.targetSlot) || 'the open lineup spot'}`;
  return {
    key: `lineup:${pair || text(recommendation.targetSlotId) || normalize(action)}`,
    priority: close ? 20 : 10,
    status: close ? 'Close call' : 'Act',
    action,
    reason: close
      ? closeReason(gain, quality, prior)
      : supportedReason(gain, quality, recommendation, prior),
    source: 'existing_lineup_optimizer',
    playerIds: [text(recommended.playerId), text(alternative?.playerId)].filter(Boolean)
  };
}

function addIntelligenceActions(add, weeklyIntelligence, seenPairs) {
  for (const observation of weeklyIntelligence?.observations || []) {
    if (!observation || ['news', 'lineup_decision'].includes(observation.kind)) {
      if (observation?.kind === 'lineup_decision') {
        const pair = pairKey(observation.playerIds?.[0], observation.playerIds?.[1]);
        if (pair && !seenPairs.has(pair)) {
          seenPairs.add(pair);
          const close = CLOSE_CLASSIFICATIONS.has(token(observation.supportClassification).toLowerCase())
            || LOW_CONFIDENCE.has(token(observation.confidence).toLowerCase());
          add({
            key: `lineup:${pair}`,
            priority: close ? 20 : 11,
            status: close ? 'Close call' : 'Act',
            action: `${close ? 'Close call: ' : ''}${text(observation.headline) || 'Review this lineup decision'}`,
            reason: sentence(observation.explanation) || 'Review the existing lineup explanation.',
            source: 'existing_weekly_intelligence',
            playerIds: uniqueText(observation.playerIds)
          });
        }
      }
      continue;
    }
    if (!['sustainability_warning', 'conflicting_evidence', 'role_change', 'workload_change'].includes(observation.kind)) continue;
    const close = observation.kind === 'conflicting_evidence';
    add({
      key: `observation:${text(observation.comparisonId) || uniqueText(observation.playerIds).sort().join('|') || normalize(observation.headline)}`,
      priority: close ? 21 : 40,
      status: close ? 'Close call' : 'Monitor',
      action: text(observation.headline) || 'Monitor this role change',
      reason: sentence(observation.explanation) || 'Weekly Intelligence identified a meaningful existing signal.',
      source: 'existing_weekly_intelligence',
      playerIds: uniqueText(observation.playerIds)
    });
  }
}

function addWaiverAction(add, waivers, historicalOpponentPriors) {
  const recommendations = Array.isArray(waivers?.recommendations) ? waivers.recommendations : [];
  const recommendation = recommendations.find((move) => Number(move?.rank) === 1) || recommendations[0];
  if (!recommendation?.add || !recommendation?.drop) return;
  const addName = name(recommendation.add);
  const dropName = name(recommendation.drop);
  const delta = number(recommendation.expectedWeeklyDelta);
  const addId = text(recommendation.add.playerId ?? recommendation.add.id);
  const opponentPrior = (historicalOpponentPriors?.players || []).find((player) => text(player?.requestedPlayerId) === addId);
  const matchupReason = ['available', 'mixed'].includes(String(opponentPrior?.matchupEvidence?.status || ''))
    ? ` ${sentence(opponentPrior.matchupEvidence.summary)}`
    : '';
  add({
    key: `waiver:${addId || normalize(addName)}:${text(recommendation.drop.playerId ?? recommendation.drop.id) || normalize(dropName)}`,
    priority: 30,
    status: 'Act',
    action: `Add ${addName}; drop ${dropName}`,
    reason: `${sentence(recommendation.reasons?.[0])
      || (delta == null ? 'This is the existing top-ranked waiver recommendation.' : `The existing waiver analysis estimates a +${delta.toFixed(1)} weekly-point upgrade.`)}${matchupReason}`,
    source: 'existing_waiver_ranking',
    playerIds: uniqueText([recommendation.add.playerId, recommendation.drop.playerId])
  });
}

function mergeDuplicates(candidates) {
  const merged = new Map();
  for (const candidate of candidates) {
    const existing = merged.get(candidate.key);
    if (!existing) { merged.set(candidate.key, candidate); continue; }
    const preferred = candidate.priority < existing.priority ? candidate : existing;
    const other = preferred === candidate ? existing : candidate;
    merged.set(candidate.key, {
      ...preferred,
      playerIds: uniqueText([...(preferred.playerIds || []), ...(other.playerIds || [])]),
      sources: uniqueText([preferred.source, ...(preferred.sources || []), other.source, ...(other.sources || [])])
    });
  }
  return [...merged.values()];
}

function mergeRelatedAvailability(candidates) {
  const remaining = [...candidates];
  for (let index = remaining.length - 1; index >= 0; index -= 1) {
    const availability = remaining[index];
    if (!availability.key.startsWith('availability:') || !availability.playerIds?.length) continue;
    const lineup = remaining.find((candidate) => candidate.key.startsWith('lineup:')
      && candidate.playerIds?.some((playerId) => availability.playerIds.includes(playerId)));
    if (!lineup) continue;
    lineup.priority = Math.min(lineup.priority, availability.priority);
    lineup.status = availability.status === 'Act' ? 'Act' : lineup.status;
    lineup.reason = `${availability.reason} ${lineup.reason}`;
    lineup.sources = uniqueText([lineup.source, ...(lineup.sources || []), availability.source, ...(availability.sources || [])]);
    remaining.splice(index, 1);
  }
  return remaining;
}

function lineupsMatch(lineup) {
  if (!lineup || (lineup.recommendations || []).length) return false;
  const current = lineup.current?.assignments;
  const recommended = lineup.recommended?.assignments;
  if (!Array.isArray(current) || !current.length || !Array.isArray(recommended) || current.length !== recommended.length) return false;
  const signature = (assignment) => `${text(assignment.slotId ?? assignment.slot)}|${text(assignment.playerId)}`;
  return current.map(signature).sort().every((value, index) => value === recommended.map(signature).sort()[index]);
}

function comparisonMatches(comparison, recommendation) {
  const samePlayers = text(comparison?.recommendedPlayer?.playerId) === text(recommendation?.start?.playerId)
    && text(comparison?.alternativePlayer?.playerId) === text(recommendation?.sit?.playerId);
  const sameSlot = text(comparison?.targetSlotId) && text(comparison.targetSlotId) === text(recommendation?.targetSlotId);
  return samePlayers || Boolean(sameSlot);
}

function isClose(quality) {
  const classification = String(quality?.supportClassification || '').toLowerCase();
  const confidence = String(quality?.confidence || '').toLowerCase();
  return CLOSE_CLASSIFICATIONS.has(classification) || LOW_CONFIDENCE.has(confidence);
}

function closeReason(gain, quality, prior = null) {
  const edge = gain == null ? 'The projection edge is narrow' : `The projection favors this choice by ${gain.toFixed(1)} points`;
  const classification = String(quality?.supportClassification || '').toLowerCase();
  const confidence = text(quality?.confidence) || 'Low';
  const conflict = classification === 'projection_conflict'
    ? 'but the existing evidence conflicts with that edge'
    : 'and the existing evidence is mixed';
  const probability = prior?.priorAdjustedProbability == null ? '' : ` Prior-adjusted outscore chance: ${Math.round(prior.priorAdjustedProbability * 100)}%.`;
  const matchup = prior?.evidenceGroups?.matchup?.summary ? ` ${sentence(prior.evidenceGroups.matchup.summary)}` : '';
  return `${edge}, ${conflict}. ${prior?.confidence || confidence} confidence.${probability}${matchup}`;
}

function supportedReason(gain, quality, recommendation, prior = null) {
  const rationale = sentence(quality?.reasons?.[0] ?? recommendation?.rationale?.[0]);
  const base = rationale || (gain != null
    ? `The existing optimizer shows a +${gain.toFixed(1)}-point edge.`
    : 'The existing legal-lineup optimizer recommends this move.');
  const probability = prior?.priorAdjustedProbability == null ? '' : ` Prior-adjusted outscore chance: ${Math.round(prior.priorAdjustedProbability * 100)}%.`;
  const matchup = prior?.evidenceGroups?.matchup?.summary ? ` ${sentence(prior.evidenceGroups.matchup.summary)}` : '';
  return `${base}${probability}${matchup}`;
}

function injuryStatus(player) {
  return token(player?.analysisInjury?.status
    ?? player?.analysisInjury?.designation?.abbreviation
    ?? player?.injuryStatus);
}

function isCurrentStarter(player, playerId, currentIds) {
  if (playerId && currentIds.has(playerId)) return true;
  if (currentIds.size) return false;
  if (player?.isStarter === true || player?.starter === true) return true;
  const slot = token(player?.slot ?? player?.lineupSlot);
  return Boolean(slot) && !['BENCH', 'BN', 'BE', 'IR', 'RESERVE', 'TAXI'].includes(slot);
}

function displayStatus(value) {
  if (value === 'O') return 'Out';
  if (value === 'D') return 'Doubtful';
  if (value === 'Q') return 'Questionable';
  return value.split('_').map((part) => part.charAt(0) + part.slice(1).toLowerCase()).join(' ');
}

function pairKey(left, right) {
  const values = [text(left), text(right)].filter(Boolean).sort();
  return values.length === 2 ? values.join('|') : null;
}

function name(player) {
  return text(player?.name ?? player?.player) || 'Unnamed player';
}

function nameFromHeadline(value) {
  const headline = text(value);
  if (!headline) return null;
  return headline.replace(/^(recheck|monitor|start|sit|bench)\s+/i, '').split(/\s+(?:was|is|over|because)\s+/i)[0] || null;
}

function uniqueText(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))];
}

function sentence(value) {
  const result = text(value);
  if (!result) return null;
  return /[.!?]$/.test(result) ? result : `${result}.`;
}

function normalize(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function token(value) {
  return String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function number(value) {
  const result = Number(value);
  return value != null && value !== '' && Number.isFinite(result) ? result : null;
}
