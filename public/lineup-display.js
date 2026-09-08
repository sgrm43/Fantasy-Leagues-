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

const POSITION_ELIGIBILITY = Object.freeze({
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

const NON_STARTING_CATEGORIES = Object.freeze({
  BENCH: Object.freeze({ key: 'bench', label: 'Bench' }),
  BN: Object.freeze({ key: 'bench', label: 'Bench' }),
  IR: Object.freeze({ key: 'ir', label: 'IR' }),
  RESERVE: Object.freeze({ key: 'reserve', label: 'Reserve' }),
  RES: Object.freeze({ key: 'reserve', label: 'Reserve' }),
  TAXI: Object.freeze({ key: 'taxi', label: 'Taxi' })
});

/**
 * Convert current roster truth and the existing optimizer result into a compact,
 * read-only presentation model. No projection or lineup choice is recalculated.
 */
export function buildLineupDisplayModel({ league, team, analysis } = {}) {
  const roster = Array.isArray(team?.roster) ? team.roster : [];
  const lineup = analysis?.lineup || null;
  const slots = expandLeagueRosterSlots(league?.settings?.roster, roster);
  const activeSlots = slots.filter((slot) => slot.category === 'active');
  const projectionsById = new Map((analysis?.projections || lineup?.projections || []).map((projection) => [id(projection.playerId), projection]));
  const contextById = buildPlayerContext(analysis?.coachTracker);
  const qualityByStartId = new Map((analysis?.recommendationQuality?.comparisons || []).map((comparison) => [id(comparison.recommendedPlayer?.playerId), comparison]));
  const recommendationByStartId = new Map((lineup?.recommendations || []).map((recommendation) => [id(recommendation.start?.playerId), recommendation]));
  const playersById = new Map(roster.map((player) => [id(player.playerId), player]));

  const currentRows = buildCurrentRows({ activeSlots, roster, assignments: lineup?.current?.assignments || [], projectionsById, contextById });
  const recommendedRows = buildRecommendedRows({ activeSlots, assignments: lineup?.recommended?.assignments || [], playersById, projectionsById, contextById });
  const currentByPlayer = rowsByPlayer(currentRows);
  const recommendedByPlayer = rowsByPlayer(recommendedRows);
  const currentBySlot = new Map(currentRows.map((row) => [row.slotId, row]));
  const recommendedStarterIds = new Set(recommendedRows.map((row) => row.player?.playerId).filter(Boolean));

  for (const row of recommendedRows) {
    row.movement = recommendedMovement(row, {
      currentByPlayer,
      currentBySlot,
      recommendation: row.player ? recommendationByStartId.get(row.player.playerId) : null,
      quality: row.player ? qualityByStartId.get(row.player.playerId) : null
    });
  }
  for (const row of currentRows) row.movement = currentMovement(row, recommendedByPlayer, recommendationByStartId);

  const categorized = categorizeRoster({ roster, activeSlots, currentRows });
  const benchPlayers = categorized.bench.map((player) => playerView(player, projectionsById, contextById, lineup?.objective));
  benchPlayers.sort(benchSort);
  const qualityAlternativeIds = new Set((analysis?.recommendationQuality?.comparisons || []).map((comparison) => id(comparison.alternativePlayer?.playerId)).filter(Boolean));
  benchPlayers.forEach((player, index) => {
    player.slotLabel = `BN${index + 1}`;
    player.movement = recommendedStarterIds.has(player.playerId)
      ? { type: 'moves_into_lineup', label: 'Moves into recommended lineup', projectedGain: recommendationByStartId.get(player.playerId)?.expectedGain ?? qualityByStartId.get(player.playerId)?.projectionDifference ?? null, quality: qualityLabel(qualityByStartId.get(player.playerId)) }
      : null;
    player.badges = qualityAlternativeIds.has(player.playerId) ? ['Top alternative'] : [];
  });

  const supportedGroups = configuredNonStartingGroups(slots, categorized);
  const reserves = supportedGroups.filter((group) => group.key !== 'bench').map((group) => ({
    key: group.key,
    label: group.label,
    players: (categorized[group.key] || []).map((player, index) => ({
      ...playerView(player, projectionsById, contextById, lineup?.objective),
      slotLabel: `${group.label}${(categorized[group.key] || []).length > 1 ? index + 1 : ''}`,
      movement: null,
      badges: []
    }))
  }));

  const currentIds = new Set(currentRows.map((row) => row.player?.playerId).filter(Boolean));
  const incoming = recommendedRows.filter((row) => row.player && !currentIds.has(row.player.playerId));
  const objective = lineup?.objective || analysis?.decisionMode?.objective || 'mean';
  const modeLabel = analysis?.decisionMode?.label || objectiveLabel(objective);
  const summary = lineupSummary({ lineup, incoming, modeLabel });

  return {
    objective,
    modeLabel,
    summary,
    current: { label: 'Current Starting Lineup', slots: currentRows },
    recommended: { label: 'Recommended Starting Lineup', slots: recommendedRows },
    bench: { label: 'Bench', players: benchPlayers },
    reserves,
    sectionOrder: ['current', 'recommended', 'bench', ...reserves.map((group) => group.key)],
    safeguards: { readOnly: true, transactionsPerformed: false },
    projectionsAdjusted: false,
    optimizerAdjusted: false
  };
}

/** Expand the provider's configured slots in its original order. */
export function expandLeagueRosterSlots(configured, roster = []) {
  const source = Array.isArray(configured) && configured.length
    ? configured
    : roster.filter((player) => !nonStartingCategory(playerSlot(player))).map((player) => player.slot || player.position);
  const counts = new Map();
  const expanded = [];
  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
    const descriptor = source[sourceIndex];
    const count = descriptor && typeof descriptor === 'object' ? Math.max(1, Math.trunc(finiteNumber(descriptor.count) ?? 1)) : 1;
    const name = normalizeSlotName(descriptor && typeof descriptor === 'object' ? descriptor.name ?? descriptor.slot ?? descriptor.slotId : descriptor);
    if (!name) continue;
    for (let offset = 0; offset < count; offset += 1) {
      const occurrence = (counts.get(name) || 0) + 1;
      counts.set(name, occurrence);
      const category = nonStartingCategory(name);
      const explicitId = descriptor && typeof descriptor === 'object' ? descriptor.id : null;
      expanded.push({
        slotId: explicitId == null ? `${name}:${occurrence}` : String(explicitId),
        slot: name,
        sourceIndex,
        occurrence,
        category: category?.key || 'active',
        categoryLabel: category?.label || null,
        eligiblePositions: category ? [] : eligiblePositions(name)
      });
    }
  }
  const totals = new Map(expanded.filter((slot) => slot.category === 'active').map((slot) => [slot.slot, (expanded.filter((candidate) => candidate.category === 'active' && candidate.slot === slot.slot).length)]));
  return expanded.map((slot) => ({
    ...slot,
    displayLabel: slot.category === 'active' && totals.get(slot.slot) > 1 ? `${displaySlotName(slot.slot)}${slot.occurrence}` : displaySlotName(slot.slot)
  }));
}

export function sortBenchPlayers(players, projections = []) {
  const projectionsById = new Map((projections || []).map((projection) => [id(projection.playerId), projection]));
  return [...(players || [])].sort((left, right) => benchSort(
    { ...left, projection: projectionsById.get(id(left.playerId)) || left.projection || null },
    { ...right, projection: projectionsById.get(id(right.playerId)) || right.projection || null }
  ));
}

function buildCurrentRows({ activeSlots, roster, assignments, projectionsById, contextById }) {
  const currentCandidates = roster.filter((player) => !nonStartingCategory(playerSlot(player)));
  const used = new Set();
  const assigned = new Map();

  // Platform slot names are current lineup truth. Repeated names are assigned in
  // stable roster order because providers do not expose RB1/RB2 identity.
  for (const slot of activeSlots) {
    const exact = currentCandidates.find((player) => !used.has(id(player.playerId)) && normalizeSlotName(player.slot) === slot.slot && eligible(player, slot));
    if (exact) { assigned.set(slot.slotId, { player: exact, source: 'platform_slot' }); used.add(id(exact.playerId)); }
  }

  // Reuse the optimizer's deterministic legal fit only for unresolved slots.
  for (const slot of activeSlots) {
    if (assigned.has(slot.slotId)) continue;
    const optimizerAssignment = assignments.find((item) => String(item.slotId) === slot.slotId && !used.has(id(item.playerId)));
    const player = optimizerAssignment && roster.find((candidate) => id(candidate.playerId) === id(optimizerAssignment.playerId));
    if (player && eligible(player, slot)) { assigned.set(slot.slotId, { player, source: 'optimizer_legal_fit' }); used.add(id(player.playerId)); }
  }

  for (const slot of activeSlots) {
    if (assigned.has(slot.slotId)) continue;
    const fallback = currentCandidates.find((player) => !used.has(id(player.playerId)) && eligible(player, slot));
    if (fallback) { assigned.set(slot.slotId, { player: fallback, source: 'deterministic_legal_fallback' }); used.add(id(fallback.playerId)); }
  }

  return activeSlots.map((slot) => slotRow(slot, assigned.get(slot.slotId)?.player || null, projectionsById, contextById, null, assigned.get(slot.slotId)?.source || 'unfilled'));
}

function buildRecommendedRows({ activeSlots, assignments, playersById, projectionsById, contextById }) {
  const remaining = [...assignments];
  return activeSlots.map((slot) => {
    const index = remaining.findIndex((assignment) => String(assignment.slotId) === slot.slotId);
    const assignment = index >= 0 ? remaining.splice(index, 1)[0] : null;
    const player = assignment ? playersById.get(id(assignment.playerId)) || null : null;
    return slotRow(slot, player, projectionsById, contextById, null, assignment ? 'existing_optimizer' : 'unfilled');
  });
}

function slotRow(slot, player, projectionsById, contextById, movement, assignmentSource) {
  return {
    slotId: slot.slotId,
    slot: slot.slot,
    slotLabel: slot.displayLabel,
    occurrence: slot.occurrence,
    assignmentSource,
    player: player ? playerView(player, projectionsById, contextById) : null,
    movement
  };
}

function playerView(player, projectionsById, contextById, objective = 'mean') {
  const playerId = id(player.playerId);
  const projection = projectionsById.get(playerId) || null;
  const context = contextById.get(playerId) || {};
  const value = finiteNumber(projection?.[objective]) ?? finiteNumber(projection?.median) ?? finiteNumber(player.projection);
  return {
    playerId,
    name: player.name || player.fullName || player.platformPlayerId || playerId,
    position: normalizePosition(player.position),
    nflTeam: context.team || player.nflTeam || null,
    opponent: context.opponent || null,
    injuryStatus: visibleInjuryStatus(player.injuryStatus),
    projection: projection ? {
      value,
      median: finiteNumber(projection.median),
      objective,
      label: projectionLabel(objective)
    } : player.projection == null ? null : {
      value: finiteNumber(player.projection),
      median: null,
      objective: 'source',
      label: 'source pts'
    },
    slot: player.slot || null,
    slotLabel: player.slot || player.position || 'Player',
    movement: null,
    badges: []
  };
}

function recommendedMovement(row, { currentByPlayer, currentBySlot, recommendation, quality }) {
  if (!row.player) return null;
  const previous = currentByPlayer.get(row.player.playerId);
  if (previous?.slotId === row.slotId) return null;
  const currentOccupant = currentBySlot.get(row.slotId)?.player || null;
  let label;
  let type;
  if (previous) {
    type = 'moves_slots';
    label = `Move ${row.player.name} from ${previous.slotLabel}`;
  } else if (currentOccupant) {
    type = 'start_over';
    label = `Start ${row.player.name} instead of ${currentOccupant.name}`;
  } else {
    type = 'moves_into_lineup';
    label = `Move ${row.player.name} into lineup`;
  }
  return {
    type,
    label,
    projectedGain: recommendation?.expectedGain ?? quality?.projectionDifference ?? null,
    quality: qualityLabel(quality)
  };
}

function currentMovement(row, recommendedByPlayer, recommendationByStartId) {
  if (!row.player) return null;
  const next = recommendedByPlayer.get(row.player.playerId);
  if (!next) {
    const replacement = [...recommendationByStartId.values()].find((recommendation) => id(recommendation.sit?.playerId) === row.player.playerId);
    return { type: 'moves_to_bench', label: replacement ? `Recommended: start ${replacement.start.name}` : 'Moves to recommended bench', projectedGain: replacement?.expectedGain ?? null, quality: null };
  }
  if (next.slotId !== row.slotId) return { type: 'moves_slots', label: `Recommended at ${next.slotLabel}`, projectedGain: null, quality: null };
  return null;
}

function categorizeRoster({ roster, activeSlots, currentRows }) {
  const result = { active: [], bench: [], ir: [], reserve: [], taxi: [], other: [] };
  const activeIds = new Set(currentRows.map((row) => row.player?.playerId).filter(Boolean));
  const activeNames = new Set(activeSlots.map((slot) => slot.slot));
  for (const player of roster) {
    const playerId = id(player.playerId);
    if (activeIds.has(playerId)) { result.active.push(player); continue; }
    const category = nonStartingCategory(playerSlot(player));
    if (category) { result[category.key].push(player); continue; }
    if (activeNames.has(normalizeSlotName(player.slot))) result.active.push(player);
    else result.other.push(player);
  }
  return result;
}

function configuredNonStartingGroups(slots, categorized) {
  const groups = [];
  const seen = new Set();
  for (const slot of slots) {
    if (slot.category === 'active' || seen.has(slot.category)) continue;
    seen.add(slot.category);
    groups.push({ key: slot.category, label: slot.categoryLabel });
  }
  for (const fallback of [
    { key: 'bench', label: 'Bench' },
    { key: 'ir', label: 'IR' },
    { key: 'reserve', label: 'Reserve' },
    { key: 'taxi', label: 'Taxi' },
    { key: 'other', label: 'Other' }
  ]) {
    if ((categorized[fallback.key] || []).length && !seen.has(fallback.key)) {
      seen.add(fallback.key);
      groups.push(fallback);
    }
  }
  return groups;
}

function buildPlayerContext(tracker) {
  const context = new Map();
  for (const group of tracker?.offenses || []) {
    for (const player of group.players || []) context.set(id(player.playerId), {
      team: group.team?.abbreviation || null,
      opponent: group.opponent?.abbreviation || null
    });
  }
  return context;
}

function lineupSummary({ lineup, incoming, modeLabel }) {
  if (!lineup) return { changeCount: null, expectedGain: null, text: 'Recommended lineup is unavailable.', gainText: null };
  const changeCount = incoming.length;
  const expectedGain = finiteNumber(lineup.expectedGain);
  const text = changeCount
    ? `${changeCount} recommended change${changeCount === 1 ? '' : 's'}`
    : `Current lineup already matches the ${String(modeLabel).toLowerCase()} recommendation`;
  return {
    changeCount,
    expectedGain,
    text,
    gainText: changeCount && expectedGain != null ? `Projected gain: +${expectedGain.toFixed(1)} ${projectionLabel(lineup.objective)}` : null
  };
}

function qualityLabel(quality) {
  if (!quality) return null;
  const labels = {
    strongly_supported: 'Strong support',
    supported: 'Supported',
    mixed: 'Mixed evidence',
    projection_conflict: 'Projection conflict',
    insufficient_evidence: 'Insufficient evidence'
  };
  const classification = labels[quality.supportClassification] || null;
  const confidence = ['High', 'Moderate', 'Low', 'Uncertain'].includes(quality.confidence) ? quality.confidence : null;
  if (!classification && !confidence) return null;
  return {
    classification: quality.supportClassification || null,
    confidence,
    text: [classification, confidence ? `${confidence} confidence` : null].filter(Boolean).join(' · '),
    tone: quality.supportClassification === 'projection_conflict' || quality.supportClassification === 'mixed' || confidence === 'Low' ? 'caution' : quality.supportClassification === 'supported' || quality.supportClassification === 'strongly_supported' ? 'support' : 'neutral'
  };
}

function rowsByPlayer(rows) {
  return new Map(rows.filter((row) => row.player).map((row) => [row.player.playerId, row]));
}

function benchSort(left, right) {
  const leftMedian = finiteNumber(left.projection?.median);
  const rightMedian = finiteNumber(right.projection?.median);
  if (leftMedian != null || rightMedian != null) {
    if (leftMedian == null) return 1;
    if (rightMedian == null) return -1;
    if (leftMedian !== rightMedian) return rightMedian - leftMedian;
  }
  return String(left.position || '').localeCompare(String(right.position || ''))
    || String(left.name || '').localeCompare(String(right.name || ''))
    || id(left.playerId).localeCompare(id(right.playerId));
}

function eligible(player, slot) {
  const position = normalizePosition(player.position);
  return slot.eligiblePositions.includes(position);
}

function eligiblePositions(slotName) {
  return [...(POSITION_ELIGIBILITY[slotName] || [normalizePosition(slotName)].filter(Boolean))];
}

function playerSlot(player) {
  return player?.platformSlotId != null ? normalizeSlotName(player.platformSlotId) : normalizeSlotName(player?.slot);
}

function nonStartingCategory(value) {
  return NON_STARTING_CATEGORIES[normalizeSlotName(value)] || null;
}

function normalizeSlotName(value) {
  if (value == null) return '';
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  const numeric = ESPN_SLOT_NAMES[Number(trimmed)];
  return String(numeric ?? trimmed).trim().toUpperCase().replaceAll('-', '_').replaceAll(' ', '_').replaceAll('DST', 'D/ST');
}

function normalizePosition(value) {
  const normalized = String(value || '').trim().toUpperCase().replaceAll('DST', 'D/ST');
  return normalized === 'DEF' ? 'D/ST' : normalized;
}

function displaySlotName(value) {
  return String(value || '').replaceAll('_', ' ');
}

function objectiveLabel(value) {
  return value === 'floor' ? 'Safer floor' : value === 'ceiling' ? 'Higher upside' : 'Best average';
}

function projectionLabel(value) {
  return value === 'floor' ? 'floor pts' : value === 'ceiling' ? 'ceiling pts' : value === 'median' ? 'median pts' : 'average pts';
}

function visibleInjuryStatus(value) {
  const status = String(value || '').trim().toUpperCase();
  return !status || ['ACTIVE', 'HEALTHY'].includes(status) ? null : status;
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function id(value) {
  return value == null ? '' : String(value);
}
