const ACTIVE = new Set(['QB', 'RB', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'SUPERFLEX', 'K', 'D/ST', 'DEF']);

export function analyzeRosterStrategy(team, league, { maxMoves = 6 } = {}) {
  if (!team?.roster || !league) throw new TypeError('A normalized team and league are required');
  const available = Array.isArray(league.availablePlayers) ? league.availablePlayers : [];
  const bench = team.roster.filter((player) => !isStarter(player) && !isProtectedReserve(player));
  const starters = team.roster.filter(isStarter);
  const positions = ['QB', 'RB', 'WR', 'TE', 'K', 'D/ST'];
  const positionGroups = positions.map((position) => summarizePosition(position, team.roster, starters, bench, available));
  const moves = [];
  for (const add of available) {
    const addValue = seasonValue(add);
    if (addValue == null || unavailable(add)) continue;
    const candidates = bench.filter((drop) => normalizePosition(drop.position) === normalizePosition(add.position) && seasonValue(drop) != null && !unavailable(drop));
    const drop = candidates.sort((a, b) => seasonValue(a) - seasonValue(b))[0];
    if (!drop) continue;
    const delta = round(addValue - seasonValue(drop));
    if (delta <= 5) continue;
    moves.push({ add: playerSummary(add), drop: playerSummary(drop), seasonProjectionDelta: delta, position: normalizePosition(add.position), reason: `${add.name} carries a ${delta}-point higher full-season source projection than ${drop.name}.`, caveat: 'Full-season projection is a broad roster-value signal, not a guarantee of remaining points or weekly startability.' });
  }
  const deduped = [...new Map(moves.sort((a, b) => b.seasonProjectionDelta - a.seasonProjectionDelta).map((move) => [`${move.add.playerId}:${move.drop.playerId}`, move])).values()].slice(0, maxMoves).map((move, index) => ({ rank: index + 1, ...move }));
  return {
    type: 'roster-strategy', scope: 'season-long source projection', readOnly: true, positionGroups, recommendations: deduped,
    strengths: positionGroups.filter((group) => group.depth === 'strong').map((group) => group.position),
    needs: positionGroups.filter((group) => group.depth === 'thin').map((group) => group.position),
    missing: ['Calibrated rest-of-season distributions', 'Playoff opponent schedule adjustment', 'Keeper and dynasty values'],
    caveats: ['Season projections are preserved from the platform and are not silently converted into precise rest-of-season forecasts.', 'Injury return timelines and future depth-chart changes may dominate this view.', 'No add/drop action is submitted.']
  };
}

function summarizePosition(position, roster, starters, bench, available) {
  const allAtPosition = roster.filter((player) => normalizePosition(player.position) === position);
  const startersAtPosition = starters.filter((player) => normalizePosition(player.position) === position);
  const benchAtPosition = bench.filter((player) => normalizePosition(player.position) === position);
  const bestAvailable = available.filter((player) => normalizePosition(player.position) === position && seasonValue(player) != null).sort((a, b) => seasonValue(b) - seasonValue(a))[0];
  const bestBench = benchAtPosition.filter((player) => seasonValue(player) != null).sort((a, b) => seasonValue(b) - seasonValue(a))[0];
  const depth = !allAtPosition.length ? 'thin' : benchAtPosition.length >= Math.max(1, startersAtPosition.length) ? 'strong' : benchAtPosition.length ? 'adequate' : 'thin';
  return { position, rostered: allAtPosition.length, starters: startersAtPosition.length, bench: benchAtPosition.length, depth, bestBench: bestBench ? playerSummary(bestBench) : null, bestAvailable: bestAvailable ? playerSummary(bestAvailable) : null };
}

function isStarter(player) { return ACTIVE.has(String(player.slot || '').trim().toUpperCase()); }
function isProtectedReserve(player) { return ['IR', 'TAXI', 'RESERVE'].includes(String(player.slot || '').trim().toUpperCase()); }
function unavailable(player) { return ['OUT', 'IR', 'INACTIVE', 'SUSPENDED'].includes(String(player.injuryStatus || '').toUpperCase()); }
function seasonValue(player) {
  if (player?.seasonProjection == null || player.seasonProjection === '') return null;
  const value = Number(player.seasonProjection);
  return Number.isFinite(value) ? value : null;
}
function normalizePosition(value) { const position = String(value || '').toUpperCase(); return ['DEF', 'DST'].includes(position) ? 'D/ST' : position; }
function playerSummary(player) { return { playerId: player.playerId, name: player.name, position: normalizePosition(player.position), weeklyProjection: Number.isFinite(Number(player.projection)) ? Number(player.projection) : null, seasonProjection: seasonValue(player), injuryStatus: player.injuryStatus || null }; }
function round(value) { return Math.round(value * 10) / 10; }
