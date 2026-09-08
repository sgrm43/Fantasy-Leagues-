import { buildOutcomeProjection, recommendStartSit } from './projections.js';

const NON_STARTERS = new Set(['BENCH', 'BN', 'IR', 'TAXI', 'RESERVE']);

export function evaluateTrade({ league, fromTeamId, toTeamId, givePlayerIds = [], receivePlayerIds = [], provenance, now } = {}) {
  if (!league?.teams) throw new TypeError('A normalized league is required');
  const from = league.teams.find((team) => team.id === fromTeamId);
  const to = league.teams.find((team) => team.id === toTeamId);
  if (!from || !to || from.id === to.id) throw new Error('Two different valid teams are required');
  const give = selectPlayers(from.roster, givePlayerIds, 'give');
  const receive = selectPlayers(to.roster, receivePlayerIds, 'receive');
  if (!give.length || !receive.length) throw new Error('Select at least one player from each team');
  const fromAfter = exchange(from.roster, give, receive);
  const toAfter = exchange(to.roster, receive, give);
  const fromResult = compareTeam(from, fromAfter, { provenance, now, incoming: receive, outgoing: give });
  const toResult = compareTeam(to, toAfter, { provenance, now, incoming: give, outgoing: receive });
  return {
    type: 'trade-analysis', generatedAt: validDate(now) || new Date().toISOString(), readOnly: true,
    trade: { fromTeam: { id: from.id, name: from.name }, toTeam: { id: to.id, name: to.name }, give: give.map(summary), receive: receive.map(summary) },
    sides: { from: fromResult, to: toResult },
    verdict: verdict(fromResult, toResult),
    caveats: [
      'Current-week impact and a broad full-season source-projection signal are shown separately.',
      'Full-season source projections are not precise rest-of-season forecasts and do not include playoff schedule, keeper cost, or dynasty value.',
      'Improvement probabilities are coarse scenario heuristics, not calibrated odds.',
      'This analysis is read-only and never submits or accepts a trade.'
    ]
  };
}

function compareTeam(team, afterRoster, { provenance, now, incoming, outgoing }) {
  const slots = team.roster.filter(isStarter).map((player) => player.slot);
  const before = recommendStartSit({ players: team.roster, slots, provenance, now, minimumGain: 0 });
  const after = recommendStartSit({ players: afterRoster, slots, provenance, now, minimumGain: 0 });
  const lineupDelta = round(after.recommended.total - before.recommended.total);
  const beforeStarters = new Set(before.recommended.assignments.map((assignment) => assignment.playerId));
  const afterStarters = new Set(after.recommended.assignments.map((assignment) => assignment.playerId));
  const beforeDepth = depthScore(team.roster, beforeStarters);
  const afterDepth = depthScore(afterRoster, afterStarters);
  const seasonSignal = compareSeasonSignal(team.roster, afterRoster, slots, provenance, now);
  return {
    team: { id: team.id, name: team.name },
    currentOptimalPoints: before.recommended.total, postTradeOptimalPoints: after.recommended.total, expectedLineupDelta: lineupDelta,
    currentDepthScore: beforeDepth, postTradeDepthScore: afterDepth, depthDelta: round(afterDepth - beforeDepth),
    seasonSignal,
    probabilityImproves: improvementProbability(lineupDelta, incoming, outgoing, provenance, now),
    incoming: incoming.map(summary), outgoing: outgoing.map(summary),
    bestLineupAfter: after.recommended.assignments,
    explanation: explain(lineupDelta, afterDepth - beforeDepth),
    missing: ['Calibrated rest-of-season distribution', 'Playoff schedule value', 'Player-specific injury return distribution']
  };
}

function compareSeasonSignal(beforeRoster, afterRoster, slots, provenance, now) {
  const beforePlayers = beforeRoster.map(withSeasonProjection);
  const afterPlayers = afterRoster.map(withSeasonProjection);
  const before = recommendStartSit({ players: beforePlayers, slots, provenance: { ...provenance, source: `${provenance?.source || 'Platform'} full-season source projection` }, now, minimumGain: 0 });
  const after = recommendStartSit({ players: afterPlayers, slots, provenance: { ...provenance, source: `${provenance?.source || 'Platform'} full-season source projection` }, now, minimumGain: 0 });
  const beforeAvailable = beforePlayers.filter((player) => numericProjection(player) != null).length;
  const afterAvailable = afterPlayers.filter((player) => numericProjection(player) != null).length;
  const complete = before.recommended.complete && after.recommended.complete;
  const fullDepthCoverage = beforeAvailable === beforeRoster.length && afterAvailable === afterRoster.length;
  const beforeStarters = new Set(before.recommended.assignments.map((assignment) => assignment.playerId));
  const afterStarters = new Set(after.recommended.assignments.map((assignment) => assignment.playerId));
  return {
    available: complete,
    expectedLineupDelta: complete ? round(after.recommended.total - before.recommended.total) : null,
    depthDelta: complete && fullDepthCoverage ? round(depthScore(afterPlayers, afterStarters) - depthScore(beforePlayers, beforeStarters)) : null,
    coverage: { before: beforeAvailable, after: afterAvailable, beforeRoster: beforeRoster.length, afterRoster: afterRoster.length, completeLineups: complete, completeDepth: fullDepthCoverage },
    basis: 'Full-season platform source projections used as a broad roster-value signal; not a calibrated rest-of-season forecast.'
  };
}

function improvementProbability(lineupDelta, incoming, outgoing, provenance, now) {
  const changed = [...incoming, ...outgoing].map((player) => buildOutcomeProjection(player, { provenance, now })).filter((item) => item.available);
  if (!changed.length) return null;
  const variance = changed.reduce((sum, item) => { const sd = Math.max(.5, (item.ceiling - item.floor) / 1.683242); return sum + sd * sd; }, 0);
  const probability = normalCdf(lineupDelta / Math.sqrt(variance));
  return Math.round(probability * 20) / 20;
}

function depthScore(roster, optimizedStarterIds) {
  return round(roster.filter((player) => !optimizedStarterIds.has(String(player.playerId)) && numericProjection(player) != null).sort((a, b) => numericProjection(b) - numericProjection(a)).slice(0, 5).reduce((sum, player) => sum + numericProjection(player), 0));
}

function exchange(roster, outgoing, incoming) {
  const removed = new Set(outgoing.map((player) => player.playerId));
  return [...roster.filter((player) => !removed.has(player.playerId)), ...incoming.map((player) => ({ ...player, slot: 'bench' }))];
}

function withSeasonProjection(player) {
  return { ...player, projection: seasonValue(player) };
}

function selectPlayers(roster, ids, label) {
  const wanted = new Set(ids.map(String));
  const selected = roster.filter((player) => wanted.has(String(player.playerId)));
  if (selected.length !== wanted.size) throw new Error(`One or more ${label} players are not on the selected team`);
  return selected;
}

function isStarter(player) { const slot = String(player.slot || '').trim().toUpperCase(); return slot && !NON_STARTERS.has(slot); }
function numericProjection(player) { const value = typeof player.projection === 'object' ? player.projection?.mean : player.projection; if (value == null || value === '') return null; return Number.isFinite(Number(value)) ? Number(value) : null; }
function seasonValue(player) { if (player?.seasonProjection == null || player.seasonProjection === '') return null; const value = Number(player.seasonProjection); return Number.isFinite(value) ? value : null; }
function summary(player) { return { playerId: player.playerId, name: player.name, position: player.position, projection: numericProjection(player) }; }
function explain(lineup, depth) { if (lineup > .5) return `Starting-lineup expectation improves by ${lineup.toFixed(1)} points this week.`; if (lineup < -.5) return `Starting-lineup expectation declines by ${Math.abs(lineup).toFixed(1)} points this week.`; if (depth > .5) return 'Starting expectation is similar, but projected bench depth improves.'; if (depth < -.5) return 'Starting expectation is similar, but projected bench depth declines.'; return 'No material current-week lineup or bench advantage is supported.'; }
function verdict(from, to) { if (from.expectedLineupDelta > .5 && to.expectedLineupDelta > .5) return 'Both teams improve their current-week lineup fit.'; if (from.expectedLineupDelta > .5) return `${from.team.name} gains more immediate lineup value.`; if (to.expectedLineupDelta > .5) return `${to.team.name} gains more immediate lineup value.`; return 'No clear current-week lineup winner; long-term inputs are required before judging the full trade.'; }
function round(value) { return Math.round(value * 10) / 10; }
function validDate(value) { if (!value) return null; const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function normalCdf(value) { const sign = value < 0 ? -1 : 1; const x = Math.abs(value) / Math.sqrt(2); const t = 1 / (1 + .3275911 * x); const erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-x * x)); return (1 + erf) / 2; }
