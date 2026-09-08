const CATEGORY_LABELS = Object.freeze({
  volumeOpportunity: 'Opportunity / volume',
  role: 'Role',
  scoringOpportunity: 'Scoring opportunity',
  efficiency: 'Efficiency',
  recentTrend: 'Recent workload trend',
  gameEnvironment: 'Game environment',
  matchup: 'Matchup',
  healthAvailability: 'Health'
});

const QUALITY_LABELS = Object.freeze({
  strongly_supported: 'Strongly supported',
  supported: 'Supported',
  mixed: 'Mixed evidence',
  projection_conflict: 'Projection conflict',
  insufficient_evidence: 'Insufficient evidence'
});

const SUPPORTS_RECOMMENDED = 'supports_recommended';
const SUPPORTS_ALTERNATIVE = 'supports_alternative';
const IMPORTANT_GROUPS = Object.freeze([
  'volumeOpportunity',
  'role',
  'scoringOpportunity',
  'recentTrend',
  'gameEnvironment',
  'matchup',
  'healthAvailability',
  'efficiency'
]);

/**
 * Explain existing lineup choices using the already-grouped Recommendation
 * Quality evidence. This layer never recalculates a projection or lineup.
 */
export function buildWeeklyIntelligence({
  league = null,
  lineup = null,
  recommendationQuality = null,
  priorAdjustedDecisions = null,
  newsChanges = []
} = {}) {
  const comparisons = Array.isArray(recommendationQuality?.comparisons)
    ? recommendationQuality.comparisons
    : [];
  const recommendations = Array.isArray(lineup?.recommendations)
    ? lineup.recommendations
    : [];
  const currentIds = assignmentIds(lineup?.current?.assignments);
  const recommendedIds = assignmentIds(lineup?.recommended?.assignments);
  const observations = [];
  const whyThisLineup = [];
  const priorByComparison = new Map((priorAdjustedDecisions?.decisions || [])
    .map((decision) => [text(decision?.comparisonId), decision])
    .filter(([comparisonId]) => comparisonId));

  for (const comparison of comparisons) {
    const decision = decisionFor(comparison, recommendations, currentIds, recommendedIds);
    const priorDecision = priorByComparison.get(text(comparison.comparisonId)) || null;
    const explanation = explainDecision(comparison, decision, priorDecision);
    const categories = unique([
      ...evidenceCategories(comparison),
      priorDecision?.evidenceGroups?.matchup?.status === 'available' || priorDecision?.evidenceGroups?.matchup?.status === 'mixed' ? 'matchup' : null
    ]);
    const quality = qualityLabel(comparison.supportClassification);
    const confidence = text(priorDecision?.confidence ?? comparison.confidence) || 'Uncertain';

    whyThisLineup.push({
      comparisonId: text(comparison.comparisonId),
      targetSlot: decision.targetSlot,
      targetSlotId: decision.targetSlotId,
      recommendedPlayerId: decision.recommended.playerId,
      alternativePlayerId: decision.alternative?.playerId || null,
      recommendedPlayer: decision.recommended,
      alternativePlayer: decision.alternative,
      explanation: explanation.sentences.join(' '),
      sentences: explanation.sentences,
      evidenceCategories: categories,
      supportClassification: text(comparison.supportClassification) || 'insufficient_evidence',
      confidence,
      qualityLabel: quality,
      baselineProbability: priorDecision?.baselineProbability ?? null,
      priorAdjustedProbability: priorDecision?.priorAdjustedProbability ?? null,
      matchupPrior: priorDecision?.evidenceGroups?.matchup || null
    });

    observations.push(decisionObservation(comparison, decision, quality, confidence, explanation.sentences.join(' ')));

    for (const warning of comparison.warnings || []) {
      const message = text(warning?.message);
      if (!message) continue;
      observations.push({
        id: `warning:${comparison.comparisonId || decision.recommended.playerId}:${warning.code || observations.length}`,
        kind: 'sustainability_warning',
        priority: 4,
        headline: warning.code === 'opportunity_without_recent_scoring' ? 'Workload is stronger than recent scoring' : 'Recent efficiency may be fragile',
        explanation: message,
        playerIds: unique([warning.playerId, decision.recommended.playerId]),
        evidenceCategories: warning.code === 'opportunity_without_recent_scoring' ? ['volumeOpportunity', 'recentTrend'] : ['efficiency', 'volumeOpportunity'],
        comparisonId: text(comparison.comparisonId),
        confidence
      });
    }
  }

  for (const event of normalizedNewsChanges(newsChanges, league)) observations.push(newsObservation(event));

  const uniqueObservations = deduplicateObservations(observations)
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
    .slice(0, 6)
    .map(({ priority: _priority, ...observation }) => observation);
  const keyUncertainty = buildKeyUncertainty(comparisons, whyThisLineup);

  return {
    model: 'weekly-intelligence-v1',
    decisionUse: 'explanation_only',
    observations: uniqueObservations,
    whyThisLineup: whyThisLineup.slice(0, 6),
    keyUncertainty,
    methodology: {
      anchor: 'The existing projection and legal optimizer choice remain the numerical anchor.',
      grouping: 'Correlated statistics are explained once inside their existing Recommendation Quality evidence group.',
      conflicts: 'Supporting and conflicting evidence are stated together; neither silently overrides the optimizer.',
      missing: 'Missing, unavailable, stale, and Learning inputs are neutral and are omitted.',
      news: 'Only supplied meaningful or critical events from the existing news-change evaluator are eligible.'
    },
    safeguards: { readOnly: true, transactionsPerformed: false },
    projectionsAdjusted: false,
    optimizerAdjusted: false
  };
}

function decisionFor(comparison, recommendations, currentIds, recommendedIds) {
  const qualityRecommended = publicPlayer(comparison.recommendedPlayer) || { playerId: 'unknown', name: 'Recommended player', position: null };
  const qualityAlternative = publicPlayer(comparison.alternativePlayer);
  const recommendation = recommendations.find((candidate) => {
    const sameSlot = comparison.targetSlotId && String(candidate?.targetSlotId) === String(comparison.targetSlotId);
    const samePlayers = String(candidate?.start?.playerId) === qualityRecommended.playerId
      && (!qualityAlternative || String(candidate?.sit?.playerId) === qualityAlternative.playerId);
    return sameSlot || samePlayers;
  });
  const recommended = publicPlayer(recommendation?.start || comparison.recommendedPlayer);
  const alternative = publicPlayer(recommendation?.sit || comparison.alternativePlayer);
  return {
    recommended,
    alternative,
    targetSlot: text(recommendation?.targetSlot ?? comparison.targetSlot),
    targetSlotId: text(recommendation?.targetSlotId ?? comparison.targetSlotId),
    projectionDifference: finiteNumber(comparison.projectionDifference ?? recommendation?.expectedGain),
    recommendedIsInRecommendedLineup: recommendedIds.has(recommended.playerId),
    alternativeIsInCurrentLineup: Boolean(alternative && currentIds.has(alternative.playerId)),
    isExplicitRecommendation: Boolean(recommendation)
  };
}

function explainDecision(comparison, decision, priorDecision = null) {
  const sentences = [decisionSentence(decision)];
  const matchup = priorDecision?.evidenceGroups?.matchup;
  const hasPriorMatchup = matchup && ['available', 'mixed'].includes(matchup.status) && text(matchup.summary);
  if (hasPriorMatchup) sentences.push(text(matchup.summary));
  const supporting = supportingGroups(comparison).filter((group) => !hasPriorMatchup || group !== 'matchup');
  const conflicting = conflictGroups(comparison).filter((group) => !hasPriorMatchup || group !== 'matchup');
  const supportSentence = combinedGroupSentence(comparison, decision, supporting, SUPPORTS_RECOMMENDED);
  if (supportSentence) sentences.push(supportSentence);
  const alternativeConflicts = conflicting.filter((group) => comparison.evidence?.[group]?.assessment === SUPPORTS_ALTERNATIVE);
  const mixedConflicts = conflicting.filter((group) => comparison.evidence?.[group]?.assessment === 'mixed');
  const conflictSentence = combinedGroupSentence(comparison, decision, alternativeConflicts, SUPPORTS_ALTERNATIVE);
  if (conflictSentence) sentences.push(`However, ${lowercaseFirst(conflictSentence)}`);
  else if (mixedConflicts.length) sentences.push(`However, ${mixedConflicts.map(categoryLabel).join(' and ')} point in both directions, which adds uncertainty.`);

  const warning = text(comparison.warnings?.[0]?.message);
  if (warning && sentences.length < 4) sentences.push(warning);
  const confidence = text(comparison.confidence) || 'Uncertain';
  const quality = qualityLabel(comparison.supportClassification);
  if (sentences.length < 4) sentences.push(`${quality} · ${confidence} confidence; this evidence explains the existing choice and does not change it.`);
  return { sentences: sentences.slice(0, 4) };
}

function decisionSentence(decision) {
  const gain = decision.projectionDifference == null ? '' : ` by ${formatPoints(decision.projectionDifference)}`;
  const slot = decision.targetSlot ? ` at ${decision.targetSlot}` : '';
  if (!decision.alternative) return `The recommended lineup starts ${decision.recommended.name}${slot}${gain}.`;
  if (decision.recommendedIsInRecommendedLineup && decision.alternativeIsInCurrentLineup) {
    return `The recommended lineup starts ${decision.recommended.name} over current starter ${decision.alternative.name}${slot}${gain}.`;
  }
  return `The existing projection favors ${decision.recommended.name} over ${decision.alternative.name}${slot}${gain}.`;
}

function decisionObservation(comparison, decision, quality, confidence, explanation) {
  return {
    id: `decision:${comparison.comparisonId || decision.targetSlotId || decision.recommended.playerId}`,
    kind: 'lineup_decision',
    priority: decision.isExplicitRecommendation ? 1 : comparison.supportClassification === 'projection_conflict' ? 3 : 4,
    headline: decision.alternative
      ? `Start ${decision.recommended.name} over ${decision.alternative.name}`
      : `Start ${decision.recommended.name}${decision.targetSlot ? ` at ${decision.targetSlot}` : ''}`,
    explanation,
    playerIds: unique([decision.recommended.playerId, decision.alternative?.playerId]),
    evidenceCategories: evidenceCategories(comparison),
    comparisonId: text(comparison.comparisonId),
    confidence,
    supportClassification: text(comparison.supportClassification) || 'insufficient_evidence'
  };
}

function groupObservation(comparison, decision, groups, priority, headline) {
  const uniqueGroups = unique(groups).filter((group) => CATEGORY_LABELS[group]);
  const hasAlternative = uniqueGroups.some((group) => comparison.evidence?.[group]?.assessment === SUPPORTS_ALTERNATIVE);
  const hasRecommended = uniqueGroups.some((group) => comparison.evidence?.[group]?.assessment === SUPPORTS_RECOMMENDED);
  const direction = hasAlternative ? SUPPORTS_ALTERNATIVE : hasRecommended ? SUPPORTS_RECOMMENDED : 'mixed';
  const directionalGroups = direction === 'mixed'
    ? uniqueGroups
    : uniqueGroups.filter((group) => comparison.evidence?.[group]?.assessment === direction);
  let explanation = direction === 'mixed'
    ? `${uniqueGroups.map(categoryLabel).join(' and ')} point in both directions, so this remains uncertain.`
    : combinedGroupSentence(comparison, decision, directionalGroups, direction)
      || `${directionalGroups.map(categoryLabel).join(' and ')} add context to this decision.`;
  const mixedGroups = uniqueGroups.filter((group) => comparison.evidence?.[group]?.assessment === 'mixed');
  if (direction !== 'mixed' && mixedGroups.length) explanation += ` ${mixedGroups.map(categoryLabel).join(' and ')} also point in both directions.`;
  return {
    id: `groups:${comparison.comparisonId || decision.recommended.playerId}:${uniqueGroups.join('+')}`,
    kind: direction === SUPPORTS_RECOMMENDED ? 'supporting_evidence' : 'conflicting_evidence',
    priority,
    headline,
    explanation,
    playerIds: unique([decision.recommended.playerId, decision.alternative?.playerId]),
    evidenceCategories: uniqueGroups,
    comparisonId: text(comparison.comparisonId),
    confidence: text(comparison.confidence) || 'Uncertain'
  };
}

function combinedGroupSentence(comparison, decision, groups, direction) {
  const usable = unique(groups).filter((group) => {
    const evidence = comparison.evidence?.[group];
    return evidence && (evidence.assessment === direction || evidence.assessment === 'mixed');
  });
  if (!usable.length) return null;
  const phrases = usable.slice(0, 3).map((group) => positionPhrase(group, decision.recommended.position, comparison.evidence?.[group]));
  if (direction === SUPPORTS_ALTERNATIVE && decision.alternative) {
    return `${decision.alternative.name} has the stronger ${joinPhrases(phrases)}, which conflicts with the projection choice.`;
  }
  return `${decision.recommended.name}'s ${joinPhrases(phrases)} support${phrases.length === 1 ? 's' : ''} the projection choice.`;
}

function positionPhrase(group, position, evidence) {
  const metrics = new Set((evidence?.facts || []).map((fact) => text(fact?.metric)).filter(Boolean));
  const normalizedPosition = String(position || '').toUpperCase();
  if (group === 'volumeOpportunity') {
    if (normalizedPosition === 'QB') return metrics.has('carries') ? 'pass attempts and rushing workload' : 'pass attempts';
    if (normalizedPosition === 'RB') return metrics.has('targets') ? 'carries and target workload' : 'carries';
    return 'target volume';
  }
  if (group === 'role') {
    if (normalizedPosition === 'QB') return 'offensive snap role';
    if (normalizedPosition === 'RB') return metrics.has('routes') || metrics.has('routeParticipation') ? 'snap and route role' : 'snap role';
    return metrics.has('routes') || metrics.has('routeParticipation') ? 'route participation and snap role' : 'receiving role';
  }
  if (group === 'scoringOpportunity') {
    if (normalizedPosition === 'QB') return 'red-zone passing and rushing opportunity';
    if (normalizedPosition === 'RB') return 'red-zone and goal-line work';
    return 'red-zone target role';
  }
  if (group === 'efficiency') {
    if (normalizedPosition === 'QB') return 'passing-efficiency context';
    if (normalizedPosition === 'RB') return 'rushing-efficiency context';
    return 'separation, YAC, and receiving-efficiency context';
  }
  if (group === 'recentTrend') return 'recent workload trend';
  if (group === 'gameEnvironment') return 'team tendency and scoring environment';
  if (group === 'matchup') return 'opponent matchup';
  if (group === 'healthAvailability') return 'health and availability';
  return categoryLabel(group).toLowerCase();
}

function supportingGroups(comparison) {
  const supplied = Array.isArray(comparison.supportingGroups) ? comparison.supportingGroups : [];
  return unique([...supplied, ...IMPORTANT_GROUPS.filter((group) => comparison.evidence?.[group]?.assessment === SUPPORTS_RECOMMENDED)]);
}

function conflictGroups(comparison) {
  const supplied = Array.isArray(comparison.conflictingGroups) ? comparison.conflictingGroups : [];
  return unique([...supplied, ...IMPORTANT_GROUPS.filter((group) => {
    const assessment = comparison.evidence?.[group]?.assessment;
    return assessment === SUPPORTS_ALTERNATIVE || assessment === 'mixed';
  })]);
}

function materialGroup(comparison, group) {
  const evidence = comparison.evidence?.[group];
  if (!evidence || !Array.isArray(evidence.facts) || !evidence.facts.length) return null;
  return [SUPPORTS_RECOMMENDED, SUPPORTS_ALTERNATIVE, 'mixed'].includes(evidence.assessment) ? group : null;
}

function materialContextGroups(comparison) {
  return ['gameEnvironment', 'matchup'].filter((group) => {
    const evidence = comparison.evidence?.[group];
    if (!evidence || !Array.isArray(evidence.facts) || !evidence.facts.length) return false;
    return [SUPPORTS_RECOMMENDED, SUPPORTS_ALTERNATIVE, 'mixed'].includes(evidence.assessment);
  });
}

function evidenceCategories(comparison) {
  return IMPORTANT_GROUPS.filter((group) => {
    const evidence = comparison.evidence?.[group];
    return evidence && Array.isArray(evidence.facts) && evidence.facts.length
      && !['insufficient', 'neutral'].includes(evidence.assessment);
  });
}

function normalizedNewsChanges(input, league) {
  const events = Array.isArray(input) ? input : Array.isArray(input?.evaluations) ? input.evaluations : [];
  return events.flatMap((event) => {
    const materiality = text(event?.materiality || event?.severity || event?.significance)
      || (event?.meaningful === true ? 'meaningful' : null);
    if (!['meaningful', 'critical'].includes(materiality)) return [];
    if (league?.season != null && event.season != null && Number(event.season) !== Number(league.season)) return [];
    if (league?.currentWeek != null && event.week != null && Number(event.week) !== Number(league.currentWeek)) return [];
    const summary = text(event.summary);
    const reason = text(event.reason);
    const explanation = unique([summary, reason]).join(' ');
    if (!explanation) return [];
    return [{
      ...event,
      materiality,
      explanation,
      entity: event.entity || {
        id: text(event.playerId || event.player_id || event.teamId || event.team_id),
        player_id: text(event.playerId || event.player_id),
        name: text(event.playerName || event.displayName || event.name)
      }
    }];
  });
}

function newsObservation(event) {
  const name = text(event.entity?.name) || 'Important roster news';
  return {
    id: `news:${event.nfl_game_id || event.entity?.id || name}:${event.materiality}`,
    kind: 'news',
    priority: event.materiality === 'critical' ? 0 : 2,
    headline: `${event.materiality === 'critical' ? 'Critical' : 'Meaningful'} update: ${name}`,
    explanation: text(event.explanation || event.reason),
    playerIds: unique([event.entity?.player_id]),
    evidenceCategories: ['healthAvailability'],
    comparisonId: null,
    confidence: null,
    materiality: event.materiality
  };
}

function buildKeyUncertainty(comparisons, decisions) {
  const index = comparisons.findIndex((comparison) => ['projection_conflict', 'mixed'].includes(comparison.supportClassification));
  if (index >= 0) {
    const decision = decisions[index];
    return {
      headline: comparisonUncertaintyHeadline(comparisons[index]),
      explanation: `The projection still anchors this ${decision.targetSlot || 'lineup'} choice, but current evidence does not point in one direction. Recheck material health, role, weather, or news changes before kickoff.`,
      playerIds: unique([decision.recommendedPlayerId, decision.alternativePlayerId]),
      comparisonId: decision.comparisonId
    };
  }
  const sparseIndex = comparisons.findIndex((comparison) => comparison.supportClassification === 'insufficient_evidence');
  if (sparseIndex >= 0) {
    const decision = decisions[sparseIndex];
    return {
      headline: 'Current evidence is limited',
      explanation: `The projection remains the anchor for ${decision.recommendedPlayer.name}, but there is not enough reliable current evidence to strengthen or challenge it.`,
      playerIds: unique([decision.recommendedPlayerId, decision.alternativePlayerId]),
      comparisonId: decision.comparisonId
    };
  }
  return null;
}

function comparisonUncertaintyHeadline(comparison) {
  return comparison.supportClassification === 'projection_conflict'
    ? 'Projection and underlying evidence conflict'
    : 'This remains a close, mixed-evidence call';
}

function deduplicateObservations(observations) {
  const seen = new Set();
  return observations.filter((observation) => {
    const key = [observation.kind, observation.comparisonId, observation.headline].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assignmentIds(assignments) {
  return new Set((assignments || []).map((assignment) => text(assignment?.playerId)).filter(Boolean));
}

function publicPlayer(value) {
  if (!value || typeof value !== 'object') return null;
  const playerId = text(value.playerId);
  if (!playerId) return null;
  return {
    playerId,
    name: text(value.name || value.player) || playerId,
    position: text(value.position)?.toUpperCase() || null
  };
}

function qualityLabel(value) {
  return QUALITY_LABELS[value] || QUALITY_LABELS.insufficient_evidence;
}

function categoryLabel(value) {
  return CATEGORY_LABELS[value] || splitCamel(value);
}

function joinPhrases(values) {
  const phrases = unique(values.filter(Boolean));
  if (phrases.length <= 1) return phrases[0] || 'current evidence';
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(', ')}, and ${phrases.at(-1)}`;
}

function splitCamel(value) {
  return String(value || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (letter) => letter.toUpperCase());
}

function lowercaseFirst(value) {
  return String(value || '').replace(/^./, (letter) => letter.toLowerCase());
}

function formatPoints(value) {
  const number = Number(value);
  return `${number.toFixed(1)} projected point${Math.abs(number) === 1 ? '' : 's'}`;
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value) {
  if (value == null) return null;
  const result = String(value).trim();
  return result || null;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}
