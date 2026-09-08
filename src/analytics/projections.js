/**
 * Explainable, deterministic fantasy-football projection heuristics.
 *
 * This module deliberately does not pretend that a single provider projection is
 * a full predictive model. It converts a point estimate into a coarse outcome
 * range, records every adjustment, and labels the quality of the inputs. The
 * returned probabilities are scenario heuristics, not calibrated odds.
 */

export const POSITION_VOLATILITY = Object.freeze({
  QB: 0.28,
  RB: 0.38,
  WR: 0.45,
  TE: 0.46,
  K: 0.38,
  'D/ST': 0.42,
  DL: 0.42,
  LB: 0.36,
  DB: 0.42,
  DEFAULT: 0.40
});

const ACTIVE_POSITION_ELIGIBILITY = Object.freeze({
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  K: ['K'],
  'D/ST': ['D/ST'],
  DEF: ['D/ST'],
  FLEX: ['RB', 'WR', 'TE'],
  'W/R/T': ['RB', 'WR', 'TE'],
  'RB/WR/TE': ['RB', 'WR', 'TE'],
  'WR/RB/TE': ['RB', 'WR', 'TE'],
  WRRBTE_FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  'W/R': ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  'WR/TE': ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  SUPERFLEX: ['QB', 'RB', 'WR', 'TE'],
  'Q/W/R/T': ['QB', 'RB', 'WR', 'TE'],
  OP: ['QB', 'RB', 'WR', 'TE'],
  DL: ['DL'],
  LB: ['LB'],
  DB: ['DB'],
  IDP_FLEX: ['DL', 'LB', 'DB']
});

const ESPN_SLOT_NAMES = Object.freeze({
  0: 'QB',
  2: 'RB',
  4: 'WR',
  6: 'TE',
  16: 'D/ST',
  17: 'K',
  20: 'BENCH',
  21: 'IR',
  23: 'FLEX'
});

const NON_STARTING_SLOTS = new Set(['BENCH', 'BN', 'IR', 'RESERVE', 'TAXI']);
const ALLOWED_OBJECTIVES = new Set(['mean', 'median', 'floor', 'ceiling']);

/**
 * Build a coarse player outcome distribution from a provider point projection.
 *
 * Supported projection inputs include `player.projection` as a number or an
 * object with `mean`, `points`, `value`, or `projectedPoints`. Explicit
 * situational changes can be supplied as `{ label, delta }` adjustments, where
 * delta is a decimal (0.10 means +10%). The combined adjustment is capped at
 * +/-60% so one weak signal cannot create an absurd recommendation.
 */
export function buildOutcomeProjection(player, options = {}) {
  if (!player || typeof player !== 'object') throw new TypeError('A player object is required');

  const playerId = String(player.playerId ?? player.id ?? 'unknown');
  const name = player.name || player.fullName || playerId;
  const position = normalizePosition(player.position ?? player.positions?.[0]);
  const baseline = projectionValue(player);
  const projectionMetadata = player.projection && typeof player.projection === 'object' ? player.projection : null;
  const provenance = mergeProvenance(
    player.projectionProvenance ?? projectionMetadata?.provenance ?? projectionMetadata ?? player.provenance,
    options.provenance
  );
  const freshness = describeFreshness(provenance?.retrievedAt, options);

  if (baseline == null) {
    return {
      playerId,
      name,
      position,
      available: false,
      baseline: null,
      mean: null,
      median: null,
      floor: null,
      ceiling: null,
      bustProbability: null,
      spikeProbability: null,
      thresholdProbabilities: [],
      confidence: confidenceFor({ available: false, freshness, provenance }),
      provenance,
      freshness,
      explanation: ['No numeric source projection was supplied, so no outcome range was invented.'],
      methodology: methodology(position, null)
    };
  }

  const status = normalizeStatus(player.injuryStatus ?? player.status ?? options.injuryStatus);
  const adjustments = normalizeAdjustments([
    ...(Array.isArray(player.projectionAdjustments) ? player.projectionAdjustments : []),
    ...(Array.isArray(player.adjustments) ? player.adjustments : []),
    ...(Array.isArray(options.adjustments) ? options.adjustments : [])
  ]);
  const requestedDelta = adjustments.reduce((total, adjustment) => total + adjustment.delta, 0);
  const appliedDelta = clamp(requestedDelta, -0.60, 0.60);
  const unavailable = ['OUT', 'IR', 'PUP', 'NFI', 'SUSPENDED', 'INACTIVE', 'NA'].includes(status);
  const mean = unavailable ? 0 : Math.max(0, baseline * (1 + appliedDelta));
  const baseVolatility = POSITION_VOLATILITY[position] ?? POSITION_VOLATILITY.DEFAULT;
  const statusVolatility = status === 'DOUBTFUL' ? 0.18 : status === 'QUESTIONABLE' ? 0.10 : 0;
  const requestedVolatility = finiteNumber(options.volatility ?? player.volatility);
  const coefficientOfVariation = clamp(requestedVolatility ?? baseVolatility + statusVolatility, 0.15, 0.80);
  const distribution = unavailable
    ? { median: 0, floor: 0, ceiling: 0, bustProbability: 1, spikeProbability: 0 }
    : logNormalHeuristic(mean, coefficientOfVariation);
  const thresholds = normalizeThresholds(options.thresholds ?? player.thresholds ?? [10, 15, 20]);
  const confidence = confidenceFor({
    available: true,
    freshness,
    provenance,
    status,
    sampleSize: finiteNumber(player.projection?.sampleSize ?? options.sampleSize),
    adjustments
  });

  const explanation = [`Started with a ${formatPoint(baseline)}-point source projection.`];
  if (adjustments.length) {
    explanation.push(...adjustments.map((adjustment) => `${adjustment.label}: ${formatPercent(adjustment.delta)}.`));
    if (adjustments.some((adjustment) => adjustment.capped)) explanation.push('An individual adjustment was capped at 50% to limit overreaction.');
    if (appliedDelta !== requestedDelta) explanation.push('The combined adjustment was capped at 60% to limit overreaction.');
  }
  if (unavailable) explanation.push(`${status} status sets the playable projection to zero.`);
  else if (status === 'QUESTIONABLE' || status === 'DOUBTFUL') explanation.push(`${status} status widens the range but does not double-count an injury discount in the source projection.`);
  explanation.push(`${position || 'Unknown-position'} volatility uses a ${formatPercent(coefficientOfVariation)} coefficient-of-variation heuristic.`);

  return {
    playerId,
    name,
    position,
    available: true,
    baseline: roundPoint(baseline),
    mean: roundPoint(mean),
    median: roundPoint(distribution.median),
    floor: roundPoint(distribution.floor),
    ceiling: roundPoint(distribution.ceiling),
    bustProbability: roundProbability(distribution.bustProbability),
    spikeProbability: roundProbability(distribution.spikeProbability),
    thresholdProbabilities: thresholds.map((threshold) => ({ threshold, probability: unavailable ? 0 : roundProbability(logNormalExceedance(mean, coefficientOfVariation, threshold)) })),
    confidence,
    provenance,
    freshness,
    adjustments: adjustments.map(({ label, delta, source }) => ({ label, delta, source })),
    explanation,
    methodology: methodology(position, coefficientOfVariation)
  };
}

/** Project every player while allowing per-player context keyed by platform ID. */
export function projectRoster(players, options = {}) {
  if (!Array.isArray(players)) throw new TypeError('players must be an array');
  const byPlayer = options.byPlayer ?? options.contextByPlayer ?? {};
  return players.map((player) => {
    const id = String(player.playerId ?? player.id ?? '');
    return buildOutcomeProjection(player, { ...options, ...(byPlayer[id] || {}) });
  });
}

/** Return whether a player can legally occupy a lineup slot. */
export function isEligibleForSlot(player, slot) {
  const positions = new Set(
    [player?.position, ...(Array.isArray(player?.positions) ? player.positions : [])]
      .map(normalizePosition)
      .filter(Boolean)
  );
  const normalized = normalizeOneSlot(slot, 0, new Map());
  if (!normalized || normalized.nonStarting) return false;
  if (Array.isArray(player?.eligibleSlots)) {
    const eligibleSlots = player.eligibleSlots.map((value) => normalizeSlotName(value));
    if (eligibleSlots.includes(normalizeSlotName(normalized.name)) || eligibleSlots.includes(normalizeSlotName(normalized.id))) return true;
  }
  return normalized.eligiblePositions.some((position) => positions.has(position));
}

/**
 * Compare the current starters with the best legal lineup.
 *
 * Input shape:
 *   recommendStartSit({ players, slots, currentLineup?, currentStarterIds?,
 *     objective?, minimumGain?, provenance?, now? })
 *
 * `currentLineup` entries need only contain `playerId`; slot names are accepted
 * for auditability but the selected starters are legally re-fit before comparing.
 */
export function recommendStartSit(input) {
  if (!input || typeof input !== 'object') throw new TypeError('A recommendation input object is required');
  if (!Array.isArray(input.players)) throw new TypeError('players must be an array');
  if (!Array.isArray(input.slots)) throw new TypeError('slots must be an array');

  const objective = input.objective ?? objectiveForRisk(input.riskProfile);
  if (!ALLOWED_OBJECTIVES.has(objective)) throw new RangeError(`Unsupported objective: ${objective}`);
  const slots = normalizeSlots(input.slots);
  if (!slots.length) throw new Error('At least one active lineup slot is required');
  if (slots.length > 18) throw new RangeError('At most 18 active lineup slots are supported');

  const projections = projectRoster(input.players, {
    provenance: input.provenance,
    now: input.now,
    staleAfterHours: input.staleAfterHours,
    thresholds: input.thresholds,
    byPlayer: input.byPlayer
  });
  const playersById = new Map(input.players.map((player) => [String(player.playerId ?? player.id), player]));
  const projectionsById = new Map(projections.map((projection) => [projection.playerId, projection]));
  const candidates = projections
    .filter((projection) => projection.available && projection[objective] != null)
    .map((projection) => ({
      player: playersById.get(projection.playerId),
      projection,
      value: projection[objective]
    }));

  const optimal = optimizeLegalAssignments(candidates, slots);
  const selectedIds = selectedStarterIds(input, input.players);
  const hasCurrentLineup = selectedIds.length > 0;
  const currentCandidates = candidates.filter((candidate) => selectedIds.includes(candidate.projection.playerId));
  const current = hasCurrentLineup ? optimizeLegalAssignments(currentCandidates, slots) : emptyLineup(slots);
  const warnings = [];
  if (!hasCurrentLineup) warnings.push('No current starters were supplied or inferable, so start/sit comparisons are unavailable.');
  if (hasCurrentLineup && current.assignments.length < Math.min(selectedIds.length, slots.length)) {
    warnings.push('One or more listed starters could not be placed in a legal active slot.');
  }
  if (optimal.assignments.length < slots.length) warnings.push('The supplied roster cannot fill every active lineup slot with a projected eligible player.');

  const gain = hasCurrentLineup ? optimal.total - current.total : null;
  const minimumGain = Math.max(0, finiteNumber(input.minimumGain ?? input.minimumGainPoints) ?? 1);
  const changes = hasCurrentLineup ? lineupChanges(current, optimal, projectionsById, objective) : [];
  const recommendations = gain != null && gain >= minimumGain
    ? buildRecommendations(changes, current, optimal, projectionsById, slots, objective)
    : [];
  if (gain != null && gain > 0 && gain < minimumGain) {
    warnings.push(`The best legal alternative gains less than the ${formatPoint(minimumGain)}-point materiality threshold; treat it as a toss-up.`);
  }

  const freshness = aggregateFreshness(projections);
  const provenance = normalizeProvenance(input.provenance) ?? aggregateProvenance(projections);
  return {
    generatedAt: validDate(input.now)?.toISOString() ?? new Date().toISOString(),
    objective,
    objectiveLabel: `${objective} outcome`,
    minimumGain: roundPoint(minimumGain),
    current: summarizeLineup(current, projectionsById, objective),
    recommended: summarizeLineup(optimal, projectionsById, objective),
    expectedGain: gain == null ? null : roundPoint(Math.max(0, gain)),
    recommendations,
    projections,
    warnings,
    provenance,
    freshness,
    methodology: {
      optimization: 'Maximum-value legal assignment across the complete lineup, not independent one-slot guesses.',
      materiality: `Changes below ${formatPoint(minimumGain)} projected points are withheld as close calls.`,
      comparisonProbability: 'Start-over-sit probability is a coarse independent-outcomes approximation based on each player’s mean and range; it is not calibrated.',
      limitation: 'Heuristic ranges and recommendations are decision support, not guarantees.'
    }
  };
}

function logNormalHeuristic(mean, coefficientOfVariation) {
  if (mean <= 0) return { median: 0, floor: 0, ceiling: 0, bustProbability: 0, spikeProbability: 0 };
  const sigmaSquared = Math.log(1 + coefficientOfVariation ** 2);
  const sigma = Math.sqrt(sigmaSquared);
  const mu = Math.log(mean) - sigmaSquared / 2;
  const quantile = (z) => Math.exp(mu + z * sigma);
  const bustThreshold = mean * 0.60;
  const spikeThreshold = mean * 1.40;
  return {
    median: quantile(0),
    floor: quantile(-0.841621),
    ceiling: quantile(0.841621),
    bustProbability: normalCdf((Math.log(bustThreshold) - mu) / sigma),
    spikeProbability: 1 - normalCdf((Math.log(spikeThreshold) - mu) / sigma)
  };
}

function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = sign * (1 - polynomial * Math.exp(-x * x));
  return (1 + erf) / 2;
}

function normalizeAdjustments(adjustments) {
  return adjustments.flatMap((adjustment, index) => {
    if (typeof adjustment === 'number' && Number.isFinite(adjustment)) {
      return [{ label: `Adjustment ${index + 1}`, delta: clamp(adjustment, -0.50, 0.50), source: null, capped: Math.abs(adjustment) > 0.50 }];
    }
    if (!adjustment || typeof adjustment !== 'object') return [];
    let delta = finiteNumber(adjustment.delta);
    if (delta == null && finiteNumber(adjustment.percent) != null) delta = adjustment.percent / 100;
    if (delta == null && finiteNumber(adjustment.multiplier) != null) delta = adjustment.multiplier - 1;
    if (delta == null) return [];
    const boundedDelta = clamp(delta, -0.50, 0.50);
    return [{
      label: String(adjustment.label ?? adjustment.reason ?? `Adjustment ${index + 1}`),
      delta: boundedDelta,
      source: adjustment.source == null ? null : String(adjustment.source),
      confidence: adjustment.confidence,
      capped: boundedDelta !== delta
    }];
  });
}

function confidenceFor({ available, freshness, provenance, status, sampleSize, adjustments = [] }) {
  if (!available) return {
    level: 'low',
    score: 0.10,
    meaning: 'Input-quality rating, not the probability that the projection is correct.',
    reasons: ['A numeric source projection is missing.']
  };
  let score = 0.65;
  const reasons = ['A numeric source projection is available.'];
  if (provenance?.source) {
    score += 0.05;
    reasons.push(`Projection source is identified as ${provenance.source}.`);
  } else {
    score -= 0.10;
    reasons.push('Projection source is not identified.');
  }
  if (freshness.status === 'fresh') {
    score += 0.10;
    reasons.push('Source data is within the fresh-data window.');
  } else if (freshness.status === 'stale') {
    score -= 0.20;
    reasons.push('Source data is stale.');
  } else if (freshness.status === 'unknown') {
    score -= 0.05;
    reasons.push('Source retrieval time is unknown.');
  }
  if (sampleSize >= 8) {
    score += 0.10;
    reasons.push('At least eight supporting samples were supplied.');
  } else if (sampleSize >= 3) {
    score += 0.05;
    reasons.push('At least three supporting samples were supplied.');
  }
  if (status === 'QUESTIONABLE') {
    score -= 0.10;
    reasons.push('Questionable availability increases uncertainty.');
  } else if (status === 'DOUBTFUL') {
    score -= 0.20;
    reasons.push('Doubtful availability materially increases uncertainty.');
  }
  if (adjustments.some((adjustment) => adjustment.confidence === 'low')) {
    score -= 0.05;
    reasons.push('At least one situational adjustment has low confidence.');
  }
  score = roundProbability(clamp(score, 0.10, 0.95));
  return {
    level: score >= 0.80 ? 'high' : score >= 0.60 ? 'medium' : 'low',
    score,
    meaning: 'Input-quality rating, not the probability that the projection is correct.',
    reasons
  };
}

function methodology(position, coefficientOfVariation) {
  return {
    model: 'position-volatility lognormal heuristic',
    precision: 'Points are rounded to 0.5 and probabilities to 5 percentage points.',
    range: 'Floor and ceiling are approximate 20th and 80th percentiles.',
    bust: 'Approximate chance of scoring below 60% of the adjusted mean.',
    spike: 'Approximate chance of scoring above 140% of the adjusted mean.',
    positionAssumption: coefficientOfVariation == null
      ? `${position || 'Unknown position'} would use an explicit position-level volatility prior once a projection is available.`
      : `${position || 'Unknown position'} uses a ${formatPercent(coefficientOfVariation)} coefficient-of-variation prior.`,
    limitation: 'This is an explainable scenario range, not a calibrated simulation or guarantee.'
  };
}

function projectionValue(player) {
  const projection = player.projection;
  const values = typeof projection === 'number'
    ? [projection]
    : [projection?.mean, projection?.points, projection?.value, projection?.projectedPoints, player.projectedPoints];
  for (const value of values) {
    const number = finiteNumber(value);
    if (number != null && number >= 0) return number;
  }
  return null;
}

function normalizeProvenance(value) {
  if (!value || typeof value !== 'object') return null;
  const source = value.source ?? value.provider ?? value.name;
  const retrievedAt = validDate(value.retrievedAt ?? value.updatedAt ?? value.asOf)?.toISOString() ?? null;
  const result = {
    source: source == null ? null : String(source),
    retrievedAt
  };
  if (value.modelVersion != null) result.modelVersion = String(value.modelVersion);
  if (value.sourceId != null) result.sourceId = String(value.sourceId);
  return result;
}

function mergeProvenance(primary, fallback) {
  const preferred = normalizeProvenance(primary);
  const defaultValue = normalizeProvenance(fallback);
  if (!preferred) return defaultValue;
  if (!defaultValue) return preferred;
  return {
    source: preferred.source ?? defaultValue.source,
    retrievedAt: preferred.retrievedAt ?? defaultValue.retrievedAt,
    ...(preferred.modelVersion != null || defaultValue.modelVersion != null
      ? { modelVersion: preferred.modelVersion ?? defaultValue.modelVersion }
      : {}),
    ...(preferred.sourceId != null || defaultValue.sourceId != null
      ? { sourceId: preferred.sourceId ?? defaultValue.sourceId }
      : {})
  };
}

function describeFreshness(retrievedAt, options) {
  const now = validDate(options.now) ?? new Date();
  const retrieved = validDate(retrievedAt);
  const staleAfterHours = Math.max(1, finiteNumber(options.staleAfterHours) ?? 24);
  if (!retrieved) return { status: 'unknown', retrievedAt: null, asOf: now.toISOString(), ageHours: null, staleAfterHours };
  const ageHours = Math.max(0, (now.getTime() - retrieved.getTime()) / 3_600_000);
  return {
    status: ageHours <= Math.min(6, staleAfterHours) ? 'fresh' : ageHours <= staleAfterHours ? 'aging' : 'stale',
    retrievedAt: retrieved.toISOString(),
    asOf: now.toISOString(),
    ageHours: Math.round(ageHours * 10) / 10,
    staleAfterHours
  };
}

function normalizeSlots(slots) {
  const counts = new Map();
  return slots.flatMap((slot, index) => {
    const count = typeof slot === 'object' && slot ? Math.max(1, Math.trunc(finiteNumber(slot.count) ?? 1)) : 1;
    return Array.from({ length: count }, (_, offset) => normalizeOneSlot(slot, index + offset, counts));
  }).filter((slot) => slot && !slot.nonStarting);
}

function normalizeOneSlot(slot, index, counts) {
  const rawName = typeof slot === 'string' || typeof slot === 'number'
    ? slot
    : slot?.name ?? slot?.slot ?? ESPN_SLOT_NAMES[slot?.slotId] ?? slot?.slotId;
  if (rawName == null) return null;
  const name = normalizeSlotName(rawName);
  const number = (counts.get(name) ?? 0) + 1;
  counts.set(name, number);
  const explicitId = typeof slot === 'object' && slot ? slot.id : null;
  const id = explicitId == null ? `${name}:${number}` : String(explicitId);
  const supplied = typeof slot === 'object' && slot && Array.isArray(slot.eligiblePositions)
    ? slot.eligiblePositions.map(normalizePosition).filter(Boolean)
    : null;
  const eligiblePositions = supplied?.length ? [...new Set(supplied)] : [...(ACTIVE_POSITION_ELIGIBILITY[name] || [normalizePosition(name)].filter(Boolean))];
  return { id, name, index, eligiblePositions, nonStarting: NON_STARTING_SLOTS.has(name) };
}

function optimizeLegalAssignments(candidates, slots) {
  let states = new Map([[0, { total: 0, assignments: [] }]]);
  for (const candidate of candidates) {
    const previous = states;
    const next = new Map(previous);
    for (const [mask, state] of previous) {
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
        if (mask & (1 << slotIndex)) continue;
        const slot = slots[slotIndex];
        if (!isEligibleForSlot(candidate.player, slot)) continue;
        const nextMask = mask | (1 << slotIndex);
        const proposed = {
          total: state.total + candidate.value,
          assignments: [...state.assignments, { slotId: slot.id, slot: slot.name, playerId: candidate.projection.playerId }]
        };
        const existing = next.get(nextMask);
        if (!existing || proposed.total > existing.total + 1e-9 || (Math.abs(proposed.total - existing.total) <= 1e-9 && assignmentKey(proposed) < assignmentKey(existing))) {
          next.set(nextMask, proposed);
        }
      }
    }
    states = next;
  }
  let best = { total: 0, assignments: [] };
  let bestFilled = 0;
  for (const state of states.values()) {
    const filled = state.assignments.length;
    if (filled > bestFilled || (filled === bestFilled && state.total > best.total + 1e-9)) {
      best = state;
      bestFilled = filled;
    }
  }
  return { ...best, complete: bestFilled === slots.length, slots: slots.length };
}

function selectedStarterIds(input, players) {
  const explicit = Array.isArray(input.currentStarterIds)
    ? input.currentStarterIds
    : Array.isArray(input.currentLineup)
      ? input.currentLineup.map((assignment) => assignment?.playerId ?? assignment?.id)
      : null;
  const ids = explicit ?? players.filter(isCurrentStarter).map((player) => player.playerId ?? player.id);
  return [...new Set(ids.filter((id) => id != null).map(String))];
}

function isCurrentStarter(player) {
  if (player?.isStarter === true || player?.starter === true || player?.active === true) return true;
  const slot = normalizeSlotName(player?.slot ?? player?.lineupSlot ?? '');
  return Boolean(slot) && !NON_STARTING_SLOTS.has(slot);
}

function lineupChanges(current, optimal, projectionsById, objective) {
  const currentIds = new Set(current.assignments.map((assignment) => assignment.playerId));
  const optimalIds = new Set(optimal.assignments.map((assignment) => assignment.playerId));
  const incoming = optimal.assignments
    .filter((assignment) => !currentIds.has(assignment.playerId))
    .map((assignment) => ({ assignment, projection: projectionsById.get(assignment.playerId) }))
    .sort((a, b) => b.projection[objective] - a.projection[objective]);
  const outgoing = current.assignments
    .filter((assignment) => !optimalIds.has(assignment.playerId))
    .map((assignment) => ({ assignment, projection: projectionsById.get(assignment.playerId) }));

  const pairs = [];
  for (const addition of incoming) {
    let bestIndex = outgoing.findIndex((removal) => removal.projection.position === addition.projection.position);
    if (bestIndex < 0) bestIndex = outgoing.findIndex((removal) => removal.assignment.slotId === addition.assignment.slotId);
    if (bestIndex < 0) bestIndex = 0;
    const removal = bestIndex >= 0 ? outgoing.splice(bestIndex, 1)[0] : null;
    pairs.push({ addition, removal });
  }
  return pairs;
}

function buildRecommendations(changes, current, optimal, projectionsById, slots, objective) {
  const lineupMoves = optimal.assignments
    .filter((assignment) => current.assignments.find((item) => item.slotId === assignment.slotId)?.playerId !== assignment.playerId)
    .map((assignment) => ({
      slotId: assignment.slotId,
      slot: assignment.slot,
      playerId: assignment.playerId,
      player: projectionsById.get(assignment.playerId)?.name
    }));
  return changes.map(({ addition, removal }) => {
    const start = addition.projection;
    const sit = removal?.projection || null;
    const gain = start[objective] - (sit?.[objective] || 0);
    const directSlot = slots.find((slot) => slot.id === (removal?.assignment.slotId || addition.assignment.slotId));
    const directSwap = directSlot ? isEligibleForSlot({ position: start.position }, directSlot) : false;
    const confidenceScore = sit ? Math.min(start.confidence.score, sit.confidence.score) : start.confidence.score;
    const overlap = sit ? start.floor <= sit.ceiling && sit.floor <= start.ceiling : false;
    const caveats = [];
    if (overlap) caveats.push('The players’ likely outcome ranges overlap, so this is a lean rather than a certainty.');
    if (start.freshness.status === 'stale' || sit?.freshness.status === 'stale') caveats.push('At least one input is stale and should be refreshed before lineup lock.');
    if (!directSwap) caveats.push('This improvement requires the listed full-lineup slot reconfiguration, not a direct same-slot swap.');
    return {
      action: sit ? 'start_sit' : 'fill_lineup',
      start: projectionSummary(start, objective),
      sit: sit ? projectionSummary(sit, objective) : null,
      targetSlot: addition.assignment.slot,
      targetSlotId: addition.assignment.slotId,
      expectedGain: roundPoint(gain),
      probabilityStartOutscoresSit: sit ? comparisonProbability(start, sit) : null,
      confidence: {
        level: confidenceScore >= 0.80 ? 'high' : confidenceScore >= 0.60 ? 'medium' : 'low',
        basis: 'Lower of the two player input-quality ratings; not a win probability.'
      },
      rationale: [
        sit ? `${start.name} has the stronger ${objective} case by about ${formatPoint(gain)} points.` : `${start.name} can fill an otherwise empty active slot for about ${formatPoint(gain)} ${objective} points.`,
        optimal.complete
          ? `${start.name} is legal in ${addition.assignment.slot}; the proposed complete lineup is legal.`
          : `${start.name} is legal in ${addition.assignment.slot}, but the supplied roster still leaves an active slot unfilled.`,
        sit ? `${start.name}'s approximate range is ${formatPoint(start.floor)}–${formatPoint(start.ceiling)}, versus ${formatPoint(sit.floor)}–${formatPoint(sit.ceiling)} for ${sit.name}.` : `${start.name}'s approximate range is ${formatPoint(start.floor)}–${formatPoint(start.ceiling)}.`
      ],
      caveats,
      whatCouldChange: [
        'Late injury or inactive news before lineup lock.',
        'A material role, usage, weather, or betting-market update.',
        'A newer provider projection that closes or reverses the gap.'
      ],
      lineupMoves
    };
  });
}

function comparisonProbability(left, right) {
  const leftSd = Math.max(0.5, (left.ceiling - left.floor) / 1.683242);
  const rightSd = Math.max(0.5, (right.ceiling - right.floor) / 1.683242);
  return roundProbability(normalCdf((left.mean - right.mean) / Math.sqrt(leftSd ** 2 + rightSd ** 2)));
}

function logNormalExceedance(mean, coefficientOfVariation, threshold) {
  if (mean <= 0) return 0;
  if (threshold <= 0) return 1;
  const sigmaSquared = Math.log(1 + coefficientOfVariation ** 2);
  const sigma = Math.sqrt(sigmaSquared);
  const mu = Math.log(mean) - sigmaSquared / 2;
  return 1 - normalCdf((Math.log(threshold) - mu) / sigma);
}

function normalizeThresholds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(Number).filter((value) => Number.isFinite(value) && value >= 0))].sort((a, b) => a - b).slice(0, 12);
}

function projectionSummary(projection, objective) {
  return {
    playerId: projection.playerId,
    name: projection.name,
    position: projection.position,
    objectiveValue: projection[objective],
    mean: projection.mean,
    floor: projection.floor,
    ceiling: projection.ceiling,
    confidence: projection.confidence.level,
    freshness: projection.freshness.status
  };
}

function summarizeLineup(lineup, projectionsById, objective) {
  return {
    complete: lineup.complete,
    total: roundPoint(lineup.total),
    assignments: lineup.assignments
      .map((assignment) => ({
        ...assignment,
        player: projectionsById.get(assignment.playerId)?.name ?? assignment.playerId,
        position: projectionsById.get(assignment.playerId)?.position ?? null,
        value: projectionsById.get(assignment.playerId)?.[objective] ?? null
      }))
      .sort((a, b) => a.slotId.localeCompare(b.slotId))
  };
}

function emptyLineup(slots) {
  return { total: 0, assignments: [], complete: false, slots: slots.length };
}

function aggregateFreshness(projections) {
  const known = projections.map((projection) => projection.freshness).filter((freshness) => freshness.retrievedAt);
  if (!known.length) return { status: 'unknown', oldestRetrievedAt: null, sourcesWithTimestamps: 0 };
  const rank = { fresh: 0, aging: 1, stale: 2, unknown: 3 };
  const worst = known.reduce((current, freshness) => rank[freshness.status] > rank[current.status] ? freshness : current);
  const oldest = known.reduce((current, freshness) => Date.parse(freshness.retrievedAt) < Date.parse(current.retrievedAt) ? freshness : current);
  return { status: worst.status, oldestRetrievedAt: oldest.retrievedAt, sourcesWithTimestamps: known.length };
}

function aggregateProvenance(projections) {
  const sources = [...new Set(projections.map((projection) => projection.provenance?.source).filter(Boolean))];
  if (!sources.length) return null;
  const retrieved = projections.map((projection) => projection.provenance?.retrievedAt).filter(Boolean).sort();
  return { source: sources.join(' + '), retrievedAt: retrieved[0] ?? null };
}

function objectiveForRisk(riskProfile) {
  if (riskProfile === 'safe' || riskProfile === 'floor') return 'floor';
  if (riskProfile === 'upside' || riskProfile === 'ceiling') return 'ceiling';
  return 'mean';
}

function normalizePosition(value) {
  if (value == null) return '';
  const normalized = String(value).trim().toUpperCase().replaceAll('DST', 'D/ST');
  return normalized === 'DEF' ? 'D/ST' : normalized;
}

function normalizeSlotName(value) {
  if (value == null) return '';
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  const numeric = ESPN_SLOT_NAMES[Number(trimmed)];
  return String(numeric ?? trimmed).trim().toUpperCase().replaceAll('-', '_').replaceAll(' ', '_').replaceAll('DST', 'D/ST');
}

function normalizeStatus(value) {
  const status = value == null ? '' : String(value).trim().toUpperCase().replaceAll(' ', '_').replaceAll('-', '_');
  return ({ O: 'OUT', Q: 'QUESTIONABLE', D: 'DOUBTFUL', INJURY_RESERVE: 'IR', INJURED_RESERVE: 'IR', RESERVE_IR: 'IR', RESERVE_PUP: 'PUP', RESERVE_NFI: 'NFI', SUSP: 'SUSPENDED', INA: 'INACTIVE' })[status] || status;
}

function finiteNumber(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validDate(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundPoint(value) {
  return Math.round((value + Number.EPSILON) * 2) / 2;
}

function roundProbability(value) {
  return Math.round(clamp(value, 0, 1) * 20) / 20;
}

function formatPoint(value) {
  return roundPoint(value).toFixed(1);
}

function formatPercent(value) {
  const rounded = Math.round(value * 100);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

function assignmentKey(lineup) {
  return lineup.assignments.map((assignment) => `${assignment.slotId}:${assignment.playerId}`).sort().join('|');
}
