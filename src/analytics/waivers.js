const BENCH_SLOTS = new Set(['BENCH', 'BN', 'BE']);
const RESERVE_SLOTS = new Set(['IR', 'IR+', 'RESERVE', 'RES', 'TAXI']);
const UNAVAILABLE_STATUSES = new Set([
  'OUT', 'O', 'IR', 'IR_R', 'IR_NFI', 'INJURED', 'INJURED_RESERVE',
  'PUP', 'NFI', 'SUSPENDED', 'SUSP', 'EXEMPT'
]);
const UNCERTAIN_STATUSES = new Set(['QUESTIONABLE', 'Q', 'DOUBTFUL', 'D', 'GAME_TIME_DECISION', 'GTD']);

export const WEEKLY_SCOPE = Object.freeze({
  scope: 'weekly',
  scopeLabel: 'Weekly only — no rest-of-season inputs supplied',
  restOfSeasonIncluded: false
});

/**
 * Return the one-week projection represented by a normalized player.
 * Adapters currently emit a number, while analytics callers may provide
 * a distribution object with a mean. Missing projections remain missing;
 * they are never silently converted to zero.
 */
export function weeklyProjection(player) {
  const projection = player?.projection;
  if (Number.isFinite(Number(projection)) && projection !== null && projection !== '') return Number(projection);
  if (!projection || typeof projection !== 'object') return null;
  for (const key of ['mean', 'expected', 'points', 'projectedPoints']) {
    if (Number.isFinite(Number(projection[key])) && projection[key] !== null && projection[key] !== '') return Number(projection[key]);
  }
  return null;
}

/** A missing or unrecognized roster slot is protected rather than guessed. */
export function isCurrentStarter(player) {
  if (player?.isStarter === true || player?.starter === true) return true;
  if (player?.isStarter === false || player?.starter === false) return false;
  const slot = normalizeToken(player?.slot);
  if (!slot) return true;
  return !BENCH_SLOTS.has(slot) && !RESERVE_SLOTS.has(slot) && slot !== 'AVAILABLE' && slot !== 'FREEAGENT' && slot !== 'WAIVERS';
}

/**
 * Rank waiver alternatives. Supports either
 *   rankAddDropPairs(roster, availablePlayers, options)
 * or
 *   rankAddDropPairs({ roster, availablePlayers, ...options }).
 */
export function rankAddDropPairs(rosterOrInput, availableOrOptions = [], maybeOptions = {}) {
  const { roster, availablePlayers, options } = resolveInputs(rosterOrInput, availableOrOptions, maybeOptions);
  const minimumDelta = finiteOption(options.minimumDelta, 0);
  const maximum = Math.max(0, Math.floor(finiteOption(options.maxRecommendations, 10)));
  const allowStarterDrops = options.allowStarterDrops === true;
  const allowReserveDrops = options.allowReserveDrops === true;
  const allowInjuredDrops = options.allowInjuredDrops === true;
  const includeUnavailableAdds = options.includeUnavailableAdds === true;
  const allowCrossPosition = options.allowCrossPosition !== false;
  const preferSamePosition = options.preferSamePosition !== false;

  const rosterIds = new Set(roster.map(stablePlayerId).filter(Boolean));
  const starters = roster.filter(isCurrentStarter);
  const drops = roster.filter((player) => {
    const slot = normalizeToken(player?.slot);
    if (!allowStarterDrops && isCurrentStarter(player)) return false;
    if (!allowReserveDrops && RESERVE_SLOTS.has(slot)) return false;
    if (!allowInjuredDrops && isUnavailable(player?.injuryStatus)) return false;
    return weeklyProjection(player) !== null;
  });

  const seenAdds = new Set();
  const moves = [];
  for (const add of availablePlayers) {
    const addId = stablePlayerId(add);
    if (addId && (rosterIds.has(addId) || seenAdds.has(addId))) continue;
    if (addId) seenAdds.add(addId);

    const addProjection = weeklyProjection(add);
    if (addProjection === null) continue;
    if (!includeUnavailableAdds && isUnavailable(add?.injuryStatus)) continue;

    const samePositionDrops = drops.filter((drop) => positionsOverlap(add, drop));
    const samePositionDrop = weakest(samePositionDrops);
    const anyPositionDrop = weakest(drops);
    let drop = null;

    if (preferSamePosition && samePositionDrop) {
      const sameDelta = addProjection - weeklyProjection(samePositionDrop);
      if (sameDelta > minimumDelta) drop = samePositionDrop;
    }
    if (!drop && allowCrossPosition && anyPositionDrop) {
      const crossDelta = addProjection - weeklyProjection(anyPositionDrop);
      if (crossDelta > minimumDelta) drop = anyPositionDrop;
    }
    if (!drop && !preferSamePosition && samePositionDrop) drop = samePositionDrop;
    if (!drop) continue;

    const dropProjection = weeklyProjection(drop);
    const expectedWeeklyDelta = round(addProjection - dropProjection);
    if (expectedWeeklyDelta <= minimumDelta) continue;
    const samePosition = positionsOverlap(add, drop);
    const estimatedLineupDelta = estimateLineupDelta(add, addProjection, starters);
    const urgency = waiverUrgency(expectedWeeklyDelta, add?.percentOwned, add?.injuryStatus);
    const reasons = buildReasons({ add, drop, addProjection, dropProjection, expectedWeeklyDelta, estimatedLineupDelta, samePosition });
    const caveats = buildMoveCaveats({ add, drop, samePosition, estimatedLineupDelta, allowStarterDrops });

    moves.push({
      rank: 0,
      ...WEEKLY_SCOPE,
      add,
      drop,
      addProjection: round(addProjection),
      dropProjection: round(dropProjection),
      expectedWeeklyDelta,
      estimatedLineupDelta,
      urgency,
      positionFit: samePosition ? 'same-position' : 'cross-position',
      reasons,
      caveats
    });
  }

  return moves
    .sort((a, b) => b.expectedWeeklyDelta - a.expectedWeeklyDelta
      || Number(b.positionFit === 'same-position') - Number(a.positionFit === 'same-position')
      || ownedPercent(b.add) - ownedPercent(a.add)
      || displayName(a.add).localeCompare(displayName(b.add)))
    .slice(0, maximum)
    .map((move, index) => ({ ...move, rank: index + 1 }));
}

/**
 * Build the read-only waiver report from a normalized team and league.
 * Supports createWaiverReport(team, league, options) and a single object
 * containing { team, league } or { roster, availablePlayers }.
 */
export function createWaiverReport(teamOrInput, leagueOrOptions = {}, maybeOptions = {}) {
  const { roster, availablePlayers, options } = resolveReportInputs(teamOrInput, leagueOrOptions, maybeOptions);
  const recommendations = rankAddDropPairs(roster, availablePlayers, options);
  const protectedStarters = roster.filter(isCurrentStarter);
  const protectedReservePlayers = options.allowReserveDrops === true
    ? []
    : roster.filter((player) => RESERVE_SLOTS.has(normalizeToken(player?.slot)));
  const protectedInjuredPlayers = options.allowInjuredDrops === true
    ? []
    : roster.filter((player) => !isCurrentStarter(player) && isUnavailable(player?.injuryStatus));

  return {
    type: 'waiver-add-drop',
    readOnly: true,
    ...WEEKLY_SCOPE,
    recommendations,
    inputs: {
      rosterPlayers: roster.length,
      availablePlayers: availablePlayers.length,
      playersWithWeeklyProjections: [...roster, ...availablePlayers].filter((player) => weeklyProjection(player) !== null).length
    },
    protections: {
      starters: protectedStarters,
      reservePlayers: protectedReservePlayers,
      injuredBenchPlayers: protectedInjuredPlayers
    },
    caveats: [
      'Recommendations compare supplied weekly projections only; no rest-of-season or playoff value is estimated.',
      'Expected weekly delta is the add projection minus the drop projection. It is not guaranteed starting-lineup gain.',
      'Recheck injuries, roles, kickoff times, waiver rules, and roster limits before acting.',
      'This report is read-only and does not submit roster transactions.'
    ]
  };
}

export function analyzeWaivers(teamOrInput, leagueOrOptions = {}, maybeOptions = {}) {
  return createWaiverReport(teamOrInput, leagueOrOptions, maybeOptions);
}

export const rankWaiverMoves = rankAddDropPairs;
export const generateWaiverReport = createWaiverReport;

export function waiverUrgency(expectedWeeklyDelta, percentOwned, injuryStatus) {
  const delta = Number(expectedWeeklyDelta);
  const owned = ownedPercent({ percentOwned });
  let urgency = delta >= 5 ? 3 : delta >= 2 ? 2 : 1;
  if (delta >= 1 && owned >= 65) urgency = Math.max(urgency, 3);
  else if (delta >= 0.5 && owned >= 35) urgency = Math.max(urgency, 2);
  if (isUncertain(injuryStatus)) urgency = Math.max(1, urgency - 1);
  return ['low', 'medium', 'high'][urgency - 1];
}

function resolveInputs(rosterOrInput, availableOrOptions, maybeOptions) {
  if (Array.isArray(rosterOrInput)) {
    return {
      roster: rosterOrInput,
      availablePlayers: Array.isArray(availableOrOptions) ? availableOrOptions : [],
      options: maybeOptions && typeof maybeOptions === 'object' ? maybeOptions : {}
    };
  }
  const input = rosterOrInput && typeof rosterOrInput === 'object' ? rosterOrInput : {};
  const secondIsLeague = Array.isArray(availableOrOptions?.availablePlayers);
  const suppliedOptions = Array.isArray(availableOrOptions) || secondIsLeague ? maybeOptions : availableOrOptions;
  return {
    roster: Array.isArray(input.roster) ? input.roster : Array.isArray(input.team?.roster) ? input.team.roster : [],
    availablePlayers: Array.isArray(input.availablePlayers) ? input.availablePlayers
      : Array.isArray(input.league?.availablePlayers) ? input.league.availablePlayers
        : secondIsLeague ? availableOrOptions.availablePlayers : [],
    options: { ...input.options, ...topLevelOptions(input), ...(suppliedOptions && typeof suppliedOptions === 'object' ? suppliedOptions : {}) }
  };
}

function resolveReportInputs(teamOrInput, leagueOrOptions, maybeOptions) {
  if (Array.isArray(teamOrInput)) return resolveInputs(teamOrInput, Array.isArray(leagueOrOptions) ? leagueOrOptions : [], maybeOptions);
  const first = teamOrInput && typeof teamOrInput === 'object' ? teamOrInput : {};
  if (first.team || first.league || first.availablePlayers) {
    const roster = Array.isArray(first.roster) ? first.roster : first.team?.roster || [];
    const availablePlayers = first.availablePlayers || first.league?.availablePlayers || [];
    const secondOptions = leagueOrOptions && !leagueOrOptions.availablePlayers ? leagueOrOptions : {};
    return { roster, availablePlayers, options: { ...first.options, ...topLevelOptions(first), ...secondOptions, ...maybeOptions } };
  }
  return {
    roster: Array.isArray(first.roster) ? first.roster : [],
    availablePlayers: Array.isArray(leagueOrOptions?.availablePlayers) ? leagueOrOptions.availablePlayers : [],
    options: maybeOptions && typeof maybeOptions === 'object' ? maybeOptions : {}
  };
}

function topLevelOptions(input) {
  const keys = ['minimumDelta', 'maxRecommendations', 'allowStarterDrops', 'allowReserveDrops', 'allowInjuredDrops', 'includeUnavailableAdds', 'allowCrossPosition', 'preferSamePosition'];
  return Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
}

function weakest(players) {
  return [...players].sort((a, b) => weeklyProjection(a) - weeklyProjection(b)
    || ownedPercent(a) - ownedPercent(b)
    || displayName(a).localeCompare(displayName(b)))[0] || null;
}

function estimateLineupDelta(add, addProjection, starters) {
  const comparable = starters.filter((starter) => positionsOverlap(add, starter)).map(weeklyProjection).filter((value) => value !== null);
  if (!comparable.length) return null;
  return round(Math.max(0, addProjection - Math.min(...comparable)));
}

function buildReasons({ add, drop, addProjection, dropProjection, expectedWeeklyDelta, estimatedLineupDelta, samePosition }) {
  const reasons = [
    `${displayName(add)} projects for ${round(addProjection)} points versus ${round(dropProjection)} for ${displayName(drop)} this week (net +${expectedWeeklyDelta}).`
  ];
  if (samePosition) reasons.push(`This is a direct ${displayPosition(add)} bench upgrade, preserving the roster's positional mix.`);
  else reasons.push(`The move shifts bench depth from ${displayPosition(drop)} to ${displayPosition(add)}.`);
  if (estimatedLineupDelta > 0) reasons.push(`If lineup eligibility permits, the add projects ${estimatedLineupDelta} points above the lowest comparable current starter.`);
  else reasons.push('Based on supplied slots, this primarily improves weekly bench depth rather than the current starting projection.');
  const owned = ownedPercent(add);
  if (owned >= 65) reasons.push(`${round(owned)}% rostered indicates strong waiver competition and raises urgency.`);
  else if (owned >= 35) reasons.push(`${round(owned)}% rostered suggests the player may not remain available.`);
  return reasons;
}

function buildMoveCaveats({ add, drop, samePosition, estimatedLineupDelta, allowStarterDrops }) {
  const caveats = ['Weekly scope only: no rest-of-season or playoff value was supplied or estimated.'];
  if (!samePosition) caveats.push('This cross-position move changes roster depth; verify lineup requirements and bye-week coverage.');
  if (estimatedLineupDelta === null) caveats.push('Starting-lineup impact cannot be estimated from the supplied slots and position eligibility.');
  if (isUncertain(add?.injuryStatus)) caveats.push(`${displayName(add)} is listed ${formatStatus(add.injuryStatus)}; confirm active status before making a claim.`);
  if (isUncertain(drop?.injuryStatus) || isUnavailable(drop?.injuryStatus)) caveats.push(`${displayName(drop)} has an injury designation; weekly-only data cannot measure stash or return value.`);
  if (add?.percentOwned == null) caveats.push('Percent-rostered data is unavailable, so claim competition is uncertain.');
  if (allowStarterDrops && isCurrentStarter(drop)) caveats.push('Starter-drop protection was overridden; confirm the resulting lineup remains legal.');
  return caveats;
}

function positionsOverlap(left, right) {
  const a = positions(left);
  const b = new Set(positions(right));
  return a.some((position) => b.has(position));
}

function positions(player) {
  const raw = Array.isArray(player?.eligiblePositions) ? player.eligiblePositions
    : Array.isArray(player?.positions) ? player.positions
      : [player?.position];
  return raw.map(normalizePosition).filter(Boolean);
}

function normalizePosition(value) {
  const position = normalizeToken(value).replaceAll(' ', '');
  if (position === 'DST' || position === 'DEF') return 'D/ST';
  return position;
}

function normalizeToken(value) {
  return String(value ?? '').trim().toUpperCase().replaceAll('-', '_');
}

function isUnavailable(status) {
  return UNAVAILABLE_STATUSES.has(normalizeToken(status));
}

function isUncertain(status) {
  return UNCERTAIN_STATUSES.has(normalizeToken(status));
}

function ownedPercent(player) {
  const value = Number(player?.percentOwned);
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : -1;
}

function stablePlayerId(player) {
  const id = player?.playerId ?? player?.id ?? player?.platformPlayerId;
  return id == null || id === '' ? null : String(id);
}

function displayName(player) {
  return player?.name || stablePlayerId(player) || 'Unknown player';
}

function displayPosition(player) {
  return positions(player).join('/') || 'unknown-position';
}

function formatStatus(status) {
  return String(status || 'unknown').toLowerCase().replaceAll('_', ' ');
}

function finiteOption(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}
