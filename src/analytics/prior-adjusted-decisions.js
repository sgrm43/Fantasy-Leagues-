/**
 * Explainable Week 1 decision context around the existing projection-derived
 * outscore probability. This module is deliberately pure: it does not project,
 * optimize, fetch data, or perform a fantasy transaction.
 */

export const PRIOR_ADJUSTED_EVIDENCE_GROUPS = Object.freeze([
  'historicalArchetype',
  'currentOpportunityRole',
  'coachingSchemePrior',
  'matchup',
  'gameEnvironment',
  'healthAvailability',
  'efficiency',
  'mediaNewsLanguage'
]);

export const PROVISIONAL_PRIOR_MODEL_LIMITS = Object.freeze({
  model: 'provisional_prior_model',
  totalProbabilityShift: 0.15,
  internalProbabilityFloor: 0.01,
  currentSeasonRampGames: 8,
  historicalMaturityFloor: 0.4,
  currentMaturityFloor: 0.6,
  minimumHistoricalCohort: 10,
  groupLogOddsCaps: Object.freeze({
    historicalArchetype: 0.28,
    currentOpportunityRole: 0.32,
    coachingSchemePrior: 0.16,
    matchup: 0.16,
    gameEnvironment: 0.12,
    healthAvailability: 0.32,
    efficiency: 0.10,
    mediaNewsLanguage: 0.05
  })
});

const OPPORTUNITY_GROUPS = Object.freeze([
  'volumeOpportunity',
  'role',
  'scoringOpportunity',
  'recentTrend'
]);
const TRUST_MULTIPLIER = Object.freeze({
  official_primary: 1,
  official_secondary: 0.75,
  existing_provider: 0.5
});
const STRENGTH_MULTIPLIER = Object.freeze({ weak: 0.35, moderate: 0.65, strong: 1 });
const FAVORABLE_MEDIA = Object.freeze([
  phrase(/\bno restrictions?\b/i, 'no restrictions', 'strong'),
  phrase(/\bfull workload\b/i, 'full workload', 'strong'),
  phrase(/\bevery[- ]down\b/i, 'every-down', 'strong'),
  phrase(/\bwill start and (?:handle|receive) (?:the )?full workload\b/i, 'will start and handle the full workload', 'strong'),
  phrase(/\bwill be heavily involved\b/i, 'will be heavily involved', 'moderate'),
  phrase(/\blead back\b/i, 'lead back', 'moderate'),
  phrase(/\bfeatured\b/i, 'featured', 'moderate'),
  phrase(/\bexpanded role\b/i, 'expanded role', 'moderate'),
  phrase(/\bmore opportunities\b/i, 'more opportunities', 'weak'),
  phrase(/\b(?:named |the )?starter\b/i, 'starter', 'moderate'),
  phrase(/\bprimary (?:back|receiver|option|target)\b/i, 'primary', 'moderate')
]);
const LIMITING_MEDIA = Object.freeze([
  phrase(/\b(?:on a |under a )?pitch count\b/i, 'pitch count', 'strong'),
  phrase(/\b(?:on a |under a )?snap count\b/i, 'snap count', 'strong'),
  phrase(/\blimited workload\b/i, 'limited workload', 'strong'),
  phrase(/\blikely limited\b/i, 'likely limited', 'strong'),
  phrase(/\bease (?:him|her|them) in\b/i, 'ease in', 'moderate'),
  phrase(/\bgame[- ]time decision\b/i, 'game-time decision', 'moderate'),
  phrase(/\bcommittee\b/i, 'committee', 'moderate'),
  phrase(/\brotation\b/i, 'rotation', 'weak'),
  phrase(/\bsituational role\b/i, 'situational role', 'moderate'),
  phrase(/\bbackup\b/i, 'backup', 'moderate')
]);
const VAGUE_MEDIA = Object.freeze([
  phrase(/\b(?:we |i )?(?:want|hope|would like) to get (?:him|her|them) involved\b/i, 'get involved', 'neutral'),
  phrase(/\blook(?:ing)? to get (?:him|her|them) involved\b/i, 'get involved', 'neutral')
]);

/** Classify one already-trusted, already-gathered headline deterministically. */
export function classifyTrustedMediaLanguage(value) {
  const event = typeof value === 'string' ? { headline: value } : value;
  const headline = text(event?.headline ?? event?.text ?? event?.title);
  const trust = token(event?.trustLevel ?? event?.trust).toLowerCase();
  if (!headline) return mediaClassification('unavailable', null, null, trust, null);
  if (!(trust in TRUST_MULTIPLIER)) return mediaClassification('untrusted', null, null, trust, headline);
  if (event?.conflictStatus === 'conflicting_reports') {
    return mediaClassification('conflicting', null, null, trust, headline);
  }
  for (const candidate of VAGUE_MEDIA) {
    if (candidate.pattern.test(headline)) return mediaClassification('neutral', candidate.label, 'neutral', trust, headline);
  }
  for (const candidate of FAVORABLE_MEDIA) {
    if (candidate.pattern.test(headline)) return mediaClassification('favorable', candidate.label, candidate.strength, trust, headline);
  }
  for (const candidate of LIMITING_MEDIA) {
    if (candidate.pattern.test(headline)) return mediaClassification('limiting', candidate.label, candidate.strength, trust, headline);
  }
  return mediaClassification('neutral', null, 'neutral', trust, headline);
}

/** Build one prior-adjusted comparison without changing its source objects. */
export function buildPriorAdjustedDecision(input = {}) {
  const comparison = input.comparison ?? input.recommendationQualityComparison ?? {};
  const recommendation = input.recommendation ?? null;
  const recommendedPlayer = publicPlayer(
    comparison.recommendedPlayer ?? recommendation?.start ?? input.recommendedPlayer
  );
  const alternativePlayer = publicPlayer(
    comparison.alternativePlayer ?? recommendation?.sit ?? input.alternativePlayer
  );
  const season = positiveIntegerOrNull(input.season) ?? 2026;
  const week = positiveIntegerOrNull(input.currentWeek ?? input.week) ?? 1;
  const currentSeason = currentSeasonState(season, input.currentSeasonSample ?? input.currentSeasonEvidence);
  const maturity = evidenceMaturity(currentSeason.completedGames);
  const baselineProbability = firstProbability(
    input.baselineProbability,
    recommendation?.probabilityStartOutscoresSit,
    comparison.baselineProbability,
    comparison.probabilityStartOutscoresSit,
    comparison.probability_recommended_outscores
  );
  const evidence = comparison.evidence && typeof comparison.evidence === 'object'
    ? comparison.evidence
    : {};

  const groups = {
    historicalArchetype: historicalGroup(input.historicalPrior ?? comparison.historicalPrior, maturity),
    currentOpportunityRole: collapsedOpportunityGroup(evidence, maturity),
    coachingSchemePrior: coachingGroup(input.coachingPrior ?? comparison.coachingPrior, maturity),
    matchup: combinedMatchupGroup(
      input.matchupPrior ?? comparison.matchupPrior,
      evidence.matchup,
      maturity
    ),
    gameEnvironment: recommendationQualityGroup('gameEnvironment', evidence.gameEnvironment, maturity.context),
    healthAvailability: recommendationQualityGroup('healthAvailability', evidence.healthAvailability, maturity.context),
    efficiency: recommendationQualityGroup('efficiency', evidence.efficiency, maturity.current),
    mediaNewsLanguage: mediaGroup(input.mediaEvents ?? input.newsEvents, recommendedPlayer, alternativePlayer)
  };

  const updates = PRIOR_ADJUSTED_EVIDENCE_GROUPS.map((group) => groups[group]);
  const logOddsAdjustment = sum(updates.map((group) => group.appliedLogOddsAdjustment));
  const probabilityUpdate = applyProbabilityUpdate(baselineProbability, logOddsAdjustment);
  const agreement = evidenceAgreement(updates);
  const confidence = confidenceFor({ baselineProbability, updates, agreement });
  const favorableFactors = rankedFactors(updates, 1);
  const opposingFactors = rankedFactors(updates, -1);

  return {
    model: PROVISIONAL_PRIOR_MODEL_LIMITS.model,
    comparisonId: text(comparison.comparisonId ?? input.comparisonId),
    targetSlot: text(comparison.targetSlot ?? recommendation?.targetSlot ?? input.targetSlot),
    targetSlotId: text(comparison.targetSlotId ?? recommendation?.targetSlotId ?? input.targetSlotId),
    recommendedPlayer,
    alternativePlayer,
    baselineProbability,
    priorAdjustedProbability: probabilityUpdate.probability,
    probabilityShift: probabilityUpdate.shift,
    uncappedProbabilityShift: probabilityUpdate.uncappedShift,
    totalAdjustmentCapApplied: probabilityUpdate.capApplied,
    logOddsAdjustment: round(logOddsAdjustment, 4),
    evidenceAgreement: agreement.value,
    evidenceAgreementLabel: agreement.label,
    confidence,
    favorableFactors,
    opposingFactors,
    evidenceGroups: groups,
    historicalPrior: groups.historicalArchetype,
    currentSeason,
    maturity,
    outlookPlayerId: probabilityUpdate.probability == null
      ? null
      : probabilityUpdate.probability >= 0.5
        ? recommendedPlayer?.playerId ?? null
        : alternativePlayer?.playerId ?? null,
    methodology: {
      baseline: 'Existing projection-distribution outscore probability; it is retained unchanged.',
      update: 'Bounded provisional log-odds evidence updates, with at most one update per conceptual group.',
      maturity: 'Historical evidence gradually fades and verified current-season evidence grows as completed games accumulate.',
      limitation: 'This is a provisional prior model, not a learned or calibrated Bayesian model.'
    },
    safeguards: { readOnly: true, transactionsPerformed: false },
    projectionsAdjusted: false,
    optimizerAdjusted: false,
    calibrationApplied: false
  };
}

/** Map the existing Recommendation Quality comparisons into decision outputs. */
export function buildPriorAdjustedDecisionReport(input = {}) {
  const lineup = input.lineup ?? null;
  const recommendationQuality = input.recommendationQuality ?? null;
  const comparisons = Array.isArray(input.comparisons)
    ? input.comparisons
    : Array.isArray(recommendationQuality?.comparisons)
      ? recommendationQuality.comparisons
      : [];
  const recommendations = Array.isArray(lineup?.recommendations) ? lineup.recommendations : [];
  const decisions = comparisons.flatMap((comparison) => {
    const recommendation = findRecommendation(comparison, recommendations);
    const historicalPrior = indexed(input.historicalPriors, comparison);
    const coachingPrior = indexed(input.coachingPriors, comparison);
    const matchupPrior = indexed(input.matchupPriors, comparison);
    const decision = buildPriorAdjustedDecision({
      ...input,
      comparison,
      recommendation,
      historicalPrior,
      coachingPrior,
      matchupPrior
    });
    return decision.recommendedPlayer && decision.alternativePlayer ? [decision] : [];
  });
  const season = positiveIntegerOrNull(input.season) ?? 2026;
  const currentSeason = currentSeasonState(season, input.currentSeasonSample ?? input.currentSeasonEvidence);
  return {
    model: PROVISIONAL_PRIOR_MODEL_LIMITS.model,
    season,
    week: positiveIntegerOrNull(input.currentWeek ?? input.week) ?? 1,
    currentSeason,
    decisions,
    limits: PROVISIONAL_PRIOR_MODEL_LIMITS,
    methodology: {
      scope: 'Current roster and already-identified start/sit or waiver comparisons only.',
      oneUpdatePerGroup: true,
      automaticRetraining: false
    },
    safeguards: { readOnly: true, transactionsPerformed: false },
    projectionsAdjusted: false,
    optimizerAdjusted: false,
    calibrationApplied: false
  };
}

function historicalGroup(prior, maturity) {
  const cap = PROVISIONAL_PRIOR_MODEL_LIMITS.groupLogOddsCaps.historicalArchetype;
  const sampleSize = nonNegativeIntegerOrNull(prior?.sampleSize ?? prior?.sample_size ?? prior?.cohort?.sampleSize);
  if (!prior || prior.status === 'insufficient' || sampleSize == null || sampleSize < PROVISIONAL_PRIOR_MODEL_LIMITS.minimumHistoricalCohort) {
    return groupResult('historicalArchetype', {
      status: prior ? 'insufficient' : 'unavailable',
      direction: 'neutral',
      cap,
      summary: text(prior?.summary) || 'Historical cohort evidence is insufficient.',
      sampleSize,
      historical: true,
      cohort: safeObject(prior?.cohort),
      maturityMultiplier: maturity.historical
    });
  }
  const direction = normalizeDirection(prior.direction ?? prior.assessment ?? prior.outlook);
  const strength = normalizeStrength(prior.strength) ?? cohortStrength(sampleSize);
  return directionalGroup('historicalArchetype', {
    direction,
    strength,
    cap,
    explicitAdjustment: finiteNumber(prior.logOddsAdjustment ?? prior.log_odds_adjustment),
    maturityMultiplier: maturity.historical,
    summary: text(prior.summary ?? prior.label) || 'Historical player-archetype prior.',
    sampleSize,
    historical: true,
    cohort: safeObject(prior.cohort),
    selection: safeObject(prior.selection)
  });
}

function coachingGroup(prior, maturity) {
  const cap = PROVISIONAL_PRIOR_MODEL_LIMITS.groupLogOddsCaps.coachingSchemePrior;
  const verified = prior?.verified === true || prior?.status === 'verified';
  const historical = prior?.historical !== false;
  if (!verified || !historical) {
    return groupResult('coachingSchemePrior', {
      status: prior ? 'unverified' : 'unavailable',
      direction: 'neutral', cap,
      summary: 'Verified historical coaching evidence is unavailable.',
      historical: true,
      maturityMultiplier: maturity.historical
    });
  }
  return directionalGroup('coachingSchemePrior', {
    direction: normalizeDirection(prior.direction ?? prior.assessment ?? prior.outlook),
    strength: normalizeStrength(prior.strength) ?? 'weak',
    cap,
    explicitAdjustment: finiteNumber(prior.logOddsAdjustment ?? prior.log_odds_adjustment),
    maturityMultiplier: maturity.historical,
    summary: text(prior.summary ?? prior.label) || 'Verified coordinator or play-caller historical prior.',
    historical: true,
    periodId: text(prior.periodId ?? prior.period_id),
    priorTeam: text(prior.priorTeam ?? prior.prior_team)
  });
}

function collapsedOpportunityGroup(evidence, maturity) {
  const cap = PROVISIONAL_PRIOR_MODEL_LIMITS.groupLogOddsCaps.currentOpportunityRole;
  const sourceGroups = OPPORTUNITY_GROUPS
    .map((name) => ({ name, value: evidence[name] }))
    .filter((item) => item.value && typeof item.value === 'object');
  const directions = sourceGroups.map((item) => normalizeDirection(item.value.assessment)).filter((value) => value !== 'neutral');
  const supportsRecommended = directions.includes('supports_recommended');
  const supportsAlternative = directions.includes('supports_alternative');
  const explicitlyMixed = directions.includes('mixed');
  const direction = supportsRecommended && supportsAlternative || explicitlyMixed
    ? 'mixed'
    : supportsRecommended ? 'supports_recommended' : supportsAlternative ? 'supports_alternative' : 'neutral';
  if (direction === 'mixed') {
    return groupResult('currentOpportunityRole', {
      status: 'mixed', direction, cap,
      summary: 'Current opportunity and role evidence points in both directions.',
      sourceGroups: sourceGroups.map((item) => item.name),
      maturityMultiplier: maturity.current
    });
  }
  return directionalGroup('currentOpportunityRole', {
    direction,
    strength: 'moderate',
    cap,
    maturityMultiplier: maturity.current,
    summary: sourceGroups.find((item) => normalizeDirection(item.value.assessment) === direction)?.value?.summary
      || 'Current opportunity and role evidence.',
    sourceGroups: sourceGroups.map((item) => item.name),
    sourceMetricCount: sum(sourceGroups.map((item) => Array.isArray(item.value?.facts) ? item.value.facts.length : 0))
  });
}

function recommendationQualityGroup(group, evidence, maturityMultiplier) {
  const cap = PROVISIONAL_PRIOR_MODEL_LIMITS.groupLogOddsCaps[group];
  return directionalGroup(group, {
    direction: normalizeDirection(evidence?.assessment),
    strength: normalizeStrength(evidence?.strength) ?? 'moderate',
    cap,
    maturityMultiplier,
    summary: text(evidence?.summary) || `${displayGroup(group)} evidence is unavailable.`,
    sourceMetricCount: Array.isArray(evidence?.facts) ? evidence.facts.length : 0
  });
}

/**
 * Historical defense, player-style response, and the existing opponent-position
 * comparison all occupy one Matchup group. Agreement can strengthen that one
 * bounded update; disagreement stays explicit and contributes no stacked vote.
 */
function combinedMatchupGroup(prior, currentEvidence, maturity) {
  const cap = PROVISIONAL_PRIOR_MODEL_LIMITS.groupLogOddsCaps.matchup;
  const maturityMultiplier = prior?.historical === false ? maturity.context : prior ? maturity.historical : maturity.context;
  const sources = [
    prior && typeof prior === 'object' ? {
      key: 'historical_opponent_prior',
      direction: normalizeDirection(prior.direction ?? prior.assessment),
      strength: normalizeStrength(prior.strength ?? prior.sampleStrength),
      summary: text(prior.summary ?? prior.explanation),
      historical: prior.historical !== false
    } : null,
    currentEvidence && typeof currentEvidence === 'object' ? {
      key: 'opponent_position_context',
      direction: normalizeDirection(currentEvidence.assessment),
      strength: normalizeStrength(currentEvidence.strength),
      summary: text(currentEvidence.summary),
      historical: currentEvidence.historical === true
    } : null
  ].filter(Boolean);
  const directional = sources.filter((source) => source.direction !== 'neutral');
  const directions = new Set(directional.map((source) => source.direction));
  const mixed = directions.has('mixed')
    || directions.has('supports_recommended') && directions.has('supports_alternative');
  const details = safeObject(prior?.details ?? prior);
  if (mixed) {
    return groupResult('matchup', {
      status: 'mixed', direction: 'mixed', cap,
      summary: text(prior?.conflictSummary) || 'Historical defense and player-style matchup evidence point in different directions.',
      sourceGroups: sources.map((source) => source.key),
      sourceMetricCount: sources.length,
      maturityMultiplier,
      details,
      countedAsOneGroup: true
    });
  }
  const selected = directional[0];
  if (!selected) {
    return groupResult('matchup', {
      status: sources.length ? 'neutral' : 'unavailable', direction: 'neutral', cap,
      summary: text(prior?.summary ?? currentEvidence?.summary) || 'Matchup evidence is unavailable.',
      sourceGroups: sources.map((source) => source.key),
      sourceMetricCount: sources.length,
      maturityMultiplier,
      details,
      countedAsOneGroup: true
    });
  }
  const rankedStrength = directional
    .map((source) => source.strength)
    .filter(Boolean)
    .sort((left, right) => (STRENGTH_MULTIPLIER[right] ?? 0) - (STRENGTH_MULTIPLIER[left] ?? 0))[0]
    || 'weak';
  return directionalGroup('matchup', {
    direction: selected.direction,
    strength: rankedStrength,
    cap,
    maturityMultiplier,
    summary: text(prior?.summary) || selected.summary || 'Historical opponent matchup prior.',
    sourceGroups: sources.map((source) => source.key),
    sourceMetricCount: sources.length,
    details,
    countedAsOneGroup: true
  });
}

function mediaGroup(events, recommendedPlayer, alternativePlayer) {
  const cap = PROVISIONAL_PRIOR_MODEL_LIMITS.groupLogOddsCaps.mediaNewsLanguage;
  const recommendedId = recommendedPlayer?.playerId;
  const alternativeId = alternativePlayer?.playerId;
  const usable = (Array.isArray(events) ? events : []).flatMap((event) => {
    const playerId = eventPlayerId(event);
    if (!playerId || ![recommendedId, alternativeId].includes(playerId)) return [];
    const classified = classifyTrustedMediaLanguage(event);
    if (!['favorable', 'limiting'].includes(classified.classification)) return [];
    const supportsPlayer = classified.classification === 'favorable';
    const supportsRecommended = playerId === recommendedId ? supportsPlayer : !supportsPlayer;
    const sign = supportsRecommended ? 1 : -1;
    const magnitude = cap * (STRENGTH_MULTIPLIER[classified.strength] ?? 0)
      * (TRUST_MULTIPLIER[classified.trust] ?? 0);
    return [{ event, classified, sign, magnitude }];
  });
  const directions = new Set(usable.map((item) => item.sign));
  if (directions.size > 1) {
    return groupResult('mediaNewsLanguage', {
      status: 'mixed', direction: 'mixed', cap,
      summary: 'Trusted media language points in both directions and is not used as an adjustment.',
      evidence: usable.map(publicMediaEvidence),
      maturityMultiplier: 1
    });
  }
  if (!usable.length) {
    return groupResult('mediaNewsLanguage', {
      status: 'neutral', direction: 'neutral', cap,
      summary: 'No specific trusted workload phrase supports an adjustment.',
      evidence: [], maturityMultiplier: 1
    });
  }
  const strongest = [...usable].sort((left, right) => right.magnitude - left.magnitude
    || String(left.classified.matchedPhrase).localeCompare(String(right.classified.matchedPhrase)))[0];
  const direction = strongest.sign > 0 ? 'supports_recommended' : 'supports_alternative';
  return groupResult('mediaNewsLanguage', {
    status: 'available', direction, cap,
    strength: strongest.classified.strength,
    rawLogOddsAdjustment: strongest.sign * strongest.magnitude,
    appliedLogOddsAdjustment: strongest.sign * Math.min(cap, strongest.magnitude),
    summary: `Weak media-language hint: “${strongest.classified.matchedPhrase}”.`,
    evidence: usable.map(publicMediaEvidence),
    maturityMultiplier: 1
  });
}

function directionalGroup(group, options) {
  if (!['supports_recommended', 'supports_alternative'].includes(options.direction)) {
    return groupResult(group, {
      ...options,
      status: options.direction === 'mixed' ? 'mixed' : 'neutral',
      rawLogOddsAdjustment: 0,
      appliedLogOddsAdjustment: 0
    });
  }
  const sign = options.direction === 'supports_recommended' ? 1 : -1;
  const strengthMultiplier = STRENGTH_MULTIPLIER[options.strength] ?? STRENGTH_MULTIPLIER.weak;
  const rawMagnitude = options.explicitAdjustment == null
    ? options.cap * strengthMultiplier
    : Math.abs(options.explicitAdjustment);
  const boundedMagnitude = Math.min(options.cap, rawMagnitude) * (options.maturityMultiplier ?? 1);
  return groupResult(group, {
    ...options,
    status: 'available',
    rawLogOddsAdjustment: sign * rawMagnitude,
    appliedLogOddsAdjustment: sign * boundedMagnitude
  });
}

function groupResult(group, options = {}) {
  return {
    group,
    label: displayGroup(group),
    status: options.status ?? 'neutral',
    direction: options.direction ?? 'neutral',
    strength: options.strength ?? null,
    logOddsCap: options.cap ?? PROVISIONAL_PRIOR_MODEL_LIMITS.groupLogOddsCaps[group],
    rawLogOddsAdjustment: round(options.rawLogOddsAdjustment ?? 0, 4),
    appliedLogOddsAdjustment: round(options.appliedLogOddsAdjustment ?? 0, 4),
    maturityMultiplier: round(options.maturityMultiplier ?? 1, 3),
    summary: text(options.summary),
    ...(options.sampleSize == null ? {} : { sampleSize: options.sampleSize }),
    ...(options.historical == null ? {} : { historical: options.historical }),
    ...(options.cohort == null ? {} : { cohort: options.cohort }),
    ...(options.selection == null ? {} : { selection: options.selection }),
    ...(options.periodId == null ? {} : { periodId: options.periodId }),
    ...(options.priorTeam == null ? {} : { priorTeam: options.priorTeam }),
    ...(options.sourceGroups == null ? {} : { sourceGroups: options.sourceGroups }),
    ...(options.sourceMetricCount == null ? {} : { sourceMetricCount: options.sourceMetricCount }),
    ...(options.evidence == null ? {} : { evidence: options.evidence }),
    ...(options.details == null ? {} : { details: options.details }),
    ...(options.countedAsOneGroup == null ? {} : { countedAsOneGroup: options.countedAsOneGroup })
  };
}

function applyProbabilityUpdate(baseline, logOddsAdjustment) {
  if (baseline == null) return { probability: null, shift: null, uncappedShift: null, capApplied: false };
  const floor = PROVISIONAL_PRIOR_MODEL_LIMITS.internalProbabilityFloor;
  const anchor = clamp(baseline, floor, 1 - floor);
  const updatedAnchor = logistic(logit(anchor) + logOddsAdjustment);
  const uncappedShift = updatedAnchor - anchor;
  const boundedShift = clamp(
    uncappedShift,
    -PROVISIONAL_PRIOR_MODEL_LIMITS.totalProbabilityShift,
    PROVISIONAL_PRIOR_MODEL_LIMITS.totalProbabilityShift
  );
  const probability = clamp(baseline + boundedShift, 0, 1);
  return {
    probability: round(probability, 3),
    shift: round(probability - baseline, 3),
    uncappedShift: round(uncappedShift, 3),
    capApplied: Math.abs(uncappedShift - boundedShift) > 1e-9
  };
}

function evidenceMaturity(completedGames) {
  const progress = clamp(completedGames / PROVISIONAL_PRIOR_MODEL_LIMITS.currentSeasonRampGames, 0, 1);
  return {
    completedCurrentSeasonGames: completedGames,
    phase: completedGames === 0 ? 'week_1_prior' : progress < 1 ? 'blending' : 'current_season_mature',
    historical: round(1 - ((1 - PROVISIONAL_PRIOR_MODEL_LIMITS.historicalMaturityFloor) * progress), 3),
    current: round(PROVISIONAL_PRIOR_MODEL_LIMITS.currentMaturityFloor
      + ((1 - PROVISIONAL_PRIOR_MODEL_LIMITS.currentMaturityFloor) * progress), 3),
    context: 1
  };
}

function currentSeasonState(season, sample) {
  const completedGames = nonNegativeIntegerOrNull(
    sample?.completedGames ?? sample?.completed_games ?? sample?.games ?? sample?.sampleGames
  ) ?? 0;
  const learning = completedGames === 0;
  return {
    season,
    completedGames,
    status: learning ? 'learning' : 'developing',
    label: learning
      ? `Learning — no completed ${season} games yet`
      : `${season} current-season evidence: ${completedGames} completed game${completedGames === 1 ? '' : 's'}`,
    historicalPriorUsedAsCurrentEvidence: false
  };
}

function evidenceAgreement(groups) {
  const directions = groups.map((group) => Math.sign(group.appliedLogOddsAdjustment)).filter(Boolean);
  const mixed = groups.some((group) => group.status === 'mixed');
  const favorable = directions.some((value) => value > 0);
  const opposing = directions.some((value) => value < 0);
  if (mixed || favorable && opposing) return { value: 'mixed', label: 'Mixed evidence' };
  if (favorable) return { value: 'supports_projection', label: 'Evidence supports the projection' };
  if (opposing) return { value: 'opposes_projection', label: 'Evidence works against the projection' };
  return { value: 'neutral', label: 'No material evidence adjustment' };
}

function confidenceFor({ baselineProbability, updates, agreement }) {
  if (baselineProbability == null) return 'Uncertain';
  const effective = updates.filter((group) => group.appliedLogOddsAdjustment !== 0);
  if (!effective.length) return 'Low';
  if (agreement.value === 'mixed') return 'Low';
  const objective = effective.filter((group) => group.group !== 'mediaNewsLanguage');
  return objective.length >= 2 ? 'Moderate' : 'Low';
}

function rankedFactors(groups, sign) {
  return groups
    .filter((group) => Math.sign(group.appliedLogOddsAdjustment) === sign)
    .sort((left, right) => Math.abs(right.appliedLogOddsAdjustment) - Math.abs(left.appliedLogOddsAdjustment)
      || left.group.localeCompare(right.group))
    .slice(0, 3)
    .map((group) => ({ group: group.group, label: group.label, summary: group.summary }));
}

function findRecommendation(comparison, recommendations) {
  return recommendations.find((candidate) => {
    const sameSlot = text(comparison?.targetSlotId)
      && text(comparison.targetSlotId) === text(candidate?.targetSlotId);
    const samePlayers = text(comparison?.recommendedPlayer?.playerId) === text(candidate?.start?.playerId)
      && text(comparison?.alternativePlayer?.playerId) === text(candidate?.sit?.playerId);
    return samePlayers || Boolean(sameSlot);
  }) ?? null;
}

function indexed(collection, comparison) {
  if (!collection) return null;
  const keys = [
    text(comparison?.comparisonId),
    text(comparison?.recommendedPlayer?.playerId)
  ].filter(Boolean);
  for (const key of keys) {
    const value = collection instanceof Map ? collection.get(key) : collection[key];
    if (value) return value;
  }
  return null;
}

function normalizeDirection(value) {
  const normalized = token(value).toLowerCase();
  if (['supports_recommended', 'recommended', 'favorable', 'positive', 'up'].includes(normalized)) return 'supports_recommended';
  if (['supports_alternative', 'alternative', 'unfavorable', 'negative', 'down'].includes(normalized)) return 'supports_alternative';
  if (['mixed', 'conflicting', 'conflict'].includes(normalized)) return 'mixed';
  return 'neutral';
}

function normalizeStrength(value) {
  const normalized = token(value).toLowerCase();
  return normalized in STRENGTH_MULTIPLIER ? normalized : null;
}

function cohortStrength(sampleSize) {
  if (sampleSize >= 50) return 'strong';
  if (sampleSize >= 25) return 'moderate';
  return 'weak';
}

function publicPlayer(value) {
  if (!value || typeof value !== 'object') return null;
  const playerId = text(value.playerId ?? value.player_id ?? value.id);
  if (!playerId) return null;
  return {
    playerId,
    name: text(value.name ?? value.playerName) || playerId,
    position: token(value.position).toUpperCase() || null
  };
}

function eventPlayerId(event) {
  return text(event?.playerId ?? event?.player_id ?? event?.player?.playerId
    ?? event?.player?.id ?? event?.entity?.player_id);
}

function publicMediaEvidence(item) {
  return {
    playerId: eventPlayerId(item.event),
    classification: item.classified.classification,
    matchedPhrase: item.classified.matchedPhrase,
    source: text(item.event?.source),
    trust: item.classified.trust
  };
}

function mediaClassification(classification, matchedPhrase, strength, trust, headline) {
  return {
    classification,
    matchedPhrase,
    strength,
    trust: trust || null,
    headline: headline || null,
    eligibleForAdjustment: ['favorable', 'limiting'].includes(classification)
  };
}

function phrase(pattern, label, strength) { return Object.freeze({ pattern, label, strength }); }
function displayGroup(group) {
  return ({
    historicalArchetype: 'Historical player archetype',
    currentOpportunityRole: 'Current opportunity / role',
    coachingSchemePrior: 'Coaching / scheme prior',
    matchup: 'Matchup',
    gameEnvironment: 'Game environment',
    healthAvailability: 'Health / availability',
    efficiency: 'Efficiency',
    mediaNewsLanguage: 'Media / news language'
  })[group] || group;
}
function safeObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : null; }
function firstProbability(...values) { for (const value of values) { const result = probability(value); if (result != null) return result; } return null; }
function probability(value) { const number = finiteNumber(value); return number != null && number >= 0 && number <= 1 ? number : null; }
function finiteNumber(value) { if (value == null || value === '') return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function positiveIntegerOrNull(value) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : null; }
function nonNegativeIntegerOrNull(value) { const number = Number(value); return Number.isInteger(number) && number >= 0 ? number : null; }
function token(value) { return String(value ?? '').trim().replace(/[\s-]+/g, '_'); }
function text(value) { const result = String(value ?? '').trim(); return result || null; }
function sum(values) { return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0); }
function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }
function logit(value) { return Math.log(value / (1 - value)); }
function logistic(value) { return 1 / (1 + Math.exp(-value)); }
function round(value, precision = 3) { const factor = 10 ** precision; return Math.round((value + Number.EPSILON) * factor) / factor; }
