import { config } from './config.js';
import { readLeague } from './storage.js';
import { deriveCoachingAnalysisPeriod, findPlayerGame, findPlayerOpponent, getHistoricalUsage, getNflCoachingContext, getNflCoachingStaff, getNflContext, getNflHeadCoaches, getNflInjuries, getNflTeamTrend, getNflverseNextGenStats, getNflverseTeamTendencies, getNwsWeatherContext, getOpponentPositionContext, resolvePlayerNflTeam } from './context-service.js';
import { projectRoster, recommendStartSit } from './analytics/projections.js';
import { buildRecommendationQualityReport } from './analytics/recommendation-quality.js';
import { buildWeeklyIntelligence } from './analytics/weekly-intelligence.js';
import { buildTopActionsToday } from './analytics/top-actions-today.js';
import { createWaiverReport } from './analytics/waivers.js';
import { analyzeRosterStrategy } from './analytics/roster-strategy.js';
import { buildHistoricalMatchupComparisonEvidence, buildHistoricalOpponentPriors } from './analytics/historical-opponent-priors.js';
import { buildPriorAdjustedDecisionReport } from './analytics/prior-adjusted-decisions.js';
import { isCurrentPlayerRecommendationEligible } from './current-player-eligibility.js';
import { safelyCapturePregameDecisionSnapshots } from './pregame-decision-snapshots.js';

const NON_STARTERS = new Set(['BENCH', 'BN', 'IR', 'TAXI', 'AVAILABLE', 'RESERVE']);
const WEATHER_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'D/ST', 'DEF']);

export async function buildWeeklyAnalysis(key, requestedTeamId, options = {}) {
  const definition = config.leagues.find((item) => item.key === key);
  if (!definition) throw Object.assign(new Error(`Unknown league: ${key}`), { status: 404 });
  const objective = normalizeObjective(options.objective);
  const envelope = await readLeague(key);
  if (!envelope) throw Object.assign(new Error('Sync this league before requesting analysis'), { status: 409 });
  const league = envelope.data;
  const team = requestedTeamId ? league.teams.find((item) => item.id === requestedTeamId) : findOwnerTeam(league.teams, definition.ownerTeam);
  if (!team) throw Object.assign(new Error('Your team could not be identified in this league'), { status: 404 });
  const leagueStale = Date.now() - Date.parse(envelope.retrievedAt) > config.cacheTtlMs;
  const projectionSource = league.platform === 'sleeper' ? 'Sleeper weekly stat projection scored with league rules' : 'ESPN Fantasy weekly projection';
  const trendPlayer = [...team.roster].filter((player) => !isNonStarter(player) && ['QB', 'RB', 'WR', 'TE'].includes(player.position) && (player.nflTeamId || player.nflTeam)).sort((a, b) => Number(b.projection || 0) - Number(a.projection || 0))[0];
  const [context, injuryContext, usageContext, coachFeed, staffFeed] = await Promise.all([
    getNflContext(league.season, league.currentWeek), getNflInjuries(), getHistoricalUsage(league.season, league.currentWeek, team.roster), getNflHeadCoaches(), getNflCoachingStaff(league.season)
  ]);
  const injuriesById = new Map(injuryContext.injuries.map((injury) => [String(injury.playerId), injury]));
  const usageById = new Map(usageContext.players.map((usage) => [String(usage.requestedPlayerId), usage]));
  const players = team.roster.map((player) => {
    const injury = injuriesById.get(espnId(player)); const usage = usageById.get(String(player.playerId));
    return { ...player, injuryStatus: injury?.status || injury?.designation?.abbreviation || player.injuryStatus, projectionProvenance: { source: projectionSource, retrievedAt: projectionTimestamp(player, envelope.retrievedAt) }, analysisInjury: injury || null, analysisUsage: usage || null };
  });
  const relevantGames = selectRosterWeatherGames(team.roster, context);
  const weatherPromise = getNwsWeatherContext(league.season, league.currentWeek, relevantGames);
  const nextGenPromise = getNflverseNextGenStats(league.season, league.currentWeek, selectRosterNextGenPlayers(players, context));
  const [grouped, nextGenContext] = await Promise.all([
    buildCoachTrackerGroups({ league, roster: team.roster, context, coachFeed, staffFeed }),
    nextGenPromise
  ]);
  const featuredOffense = trendPlayer ? grouped.offenses.find((group) => group.players.some((player) => String(player.playerId) === String(trendPlayer.playerId))) : null;
  const featuredDefense = trendPlayer ? grouped.defenses.find((group) => group.affectedPlayers.some((player) => String(player.playerId) === String(trendPlayer.playerId))) : null;
  const coachingContext = featuredOffense?.coachingContext || null;
  const teamTrend = featuredOffense?.teamTrend || null;
  const opponentPositionContext = featuredDefense?.positionContexts?.find((item) => item.position === trendPlayer?.position) || null;
  const slots = lineupSlots(league, players);
  const allowUsageAdjustment = Number(usageContext.season) === Number(league.season);
  const byPlayer = Object.fromEntries(players.map((player) => [player.playerId, situationalContext(player, context, player.analysisUsage, { allowUsageAdjustment })]));
  const lineup = slots.length ? recommendStartSit({ players, slots, objective, minimumGain: 0.8, provenance: { source: projectionSource, retrievedAt: envelope.retrievedAt }, byPlayer }) : null;
  const matchup = buildMatchup(league, team, players, context, envelope.retrievedAt, projectionSource, injuriesById);
  const recommendation = topRecommendation(lineup, matchup);
  const analysisTeam = { ...team, roster: players };
  const analysisLeague = { ...league, teams: league.teams.map((item) => item.id === team.id ? analysisTeam : item), availablePlayers: (league.availablePlayers || []).map((player) => enrichInjury(player, injuriesById)) };
  const waivers = createWaiverReport({ team: analysisTeam, league: analysisLeague, options: { minimumDelta: 0.5, maxRecommendations: 8, allowCrossPosition: false } });
  const strategy = analyzeRosterStrategy(analysisTeam, analysisLeague);
  const projections = (lineup?.projections || projectRoster(players, { provenance: { source: projectionSource, retrievedAt: envelope.retrievedAt }, byPlayer }))
    .filter((projection) => projection.available).sort((a, b) => b.mean - a.mean);
  const weatherContext = await weatherPromise;
  const recommendationQuality = buildRecommendationQualityReport({
    lineup,
    players,
    coachTracker: grouped,
    nextGenContext,
    nflContext: context,
    weatherContext,
    season: league.season,
    usageSeason: usageContext.season
  });
  const opponentPriorPlayers = selectHistoricalOpponentPriorPlayers(players, waivers);
  const opponentPriorGroups = await buildHistoricalOpponentGroups({
    league,
    players: opponentPriorPlayers,
    context,
    coachFeed,
    staffFeed,
    baseDefenses: grouped.defenses
  });
  const historicalOpponentPriors = buildHistoricalOpponentPriorReport({
    league,
    players: opponentPriorPlayers,
    defenseGroups: opponentPriorGroups,
    nextGenContext
  });
  const matchupPriors = buildHistoricalMatchupPriorMap(historicalOpponentPriors, recommendationQuality, league.currentWeek);
  const priorAdjustedDecisions = buildPriorAdjustedDecisionReport({
    season: league.season,
    currentWeek: league.currentWeek,
    lineup,
    recommendationQuality,
    matchupPriors,
    newsEvents: options.newsChanges,
    currentSeasonSample: { completedGames: completedDefenseGames(historicalOpponentPriors) }
  });
  const weeklyIntelligence = buildWeeklyIntelligence({
    league,
    lineup,
    recommendationQuality,
    priorAdjustedDecisions,
    newsChanges: options.newsChanges
  });
  const topActionsToday = buildTopActionsToday({
    league,
    lineup,
    recommendationQuality,
    priorAdjustedDecisions,
    historicalOpponentPriors,
    weeklyIntelligence,
    newsChanges: options.newsChanges,
    players,
    waivers,
    strategy,
    nflContext: context
  });
  const evidence = buildEvidence(league, envelope, leagueStale, context, relevantGames, weatherContext, players, injuryContext, usageContext, coachingContext, teamTrend, trendPlayer, opponentPositionContext);
  const missingInputs = coverageIssues(league, leagueStale, context, injuryContext, usageContext, players, coachingContext, teamTrend, opponentPositionContext, trendPlayer, matchup);
  const generatedAt = new Date().toISOString();
  const analysis = {
    generatedAt, sourceUpdatedAt: envelope.retrievedAt, stale: Boolean(leagueStale || context.stale || injuryContext.stale || usageContext.stale || grouped.stale), league: { id: league.id, key, name: league.name, week: league.currentWeek, season: league.season, platform: league.platform },
    decisionMode: { objective, label: objective === 'floor' ? 'Safer floor' : objective === 'ceiling' ? 'Higher upside' : 'Best average' },
    team: { id: team.id, name: team.name, manager: team.manager }, opponent: matchup?.opponent || null,
    recommendation, lineup, recommendationQuality, priorAdjustedDecisions, historicalOpponentPriors, weeklyIntelligence, topActionsToday, matchup, waivers, strategy, projections, evidence, missingInputs,
    injuryContext: { retrievedAt: injuryContext.retrievedAt, stale: injuryContext.stale, players: players.filter((player) => player.analysisInjury).map((player) => player.analysisInjury) },
    usageContext: { season: usageContext.season, weeks: usageContext.requestedWeeks, retrievedAt: usageContext.retrievedAt, stale: usageContext.stale, players: players.filter((player) => player.analysisUsage).map((player) => ({ playerId: player.playerId, name: player.name, summary: player.analysisUsage.summary })) },
    coachingContext, teamTrend, opponentPositionContext, coachTracker: publicCoachTracker(grouped), weatherContext, nextGenContext,
    uncertainty: uncertaintyText(lineup, missingInputs),
    changeTriggers: changeTriggers(players, relevantGames),
    safeguards: { readOnly: true, transactionsPerformed: false },
    methodology: { ranges: 'Heuristic log-normal ranges around the platform point forecast; approximately 20th/50th/80th percentiles.', lineup: 'Whole-lineup legal optimization with changes under 0.8 projected points withheld as close calls.', matchup: 'Normal approximation of lineup totals; odds are withheld when either active lineup lacks projection coverage. Current scores are a lower bound, completed-player results are fixed when available, and live remaining-game state plus correlations remain approximate.', limitation: 'These are decision-support estimates, not guarantees or calibrated probabilities yet.' }
  };
  await safelyCapturePregameDecisionSnapshots({ analysis, league, roster: players, nflContext: context, coachTracker: publicCoachTracker(grouped), weatherContext, nextGenContext });
  return analysis;
}

/** Select every roster-relevant game once, including kickers and team defenses. */
export function selectRosterWeatherGames(roster, context) {
  return uniqueGames((roster || []).filter((player) => WEATHER_POSITIONS.has(String(player?.position || '').trim().toUpperCase())).map((player) => findPlayerGame(player, context)).filter(Boolean));
}

/** Select only rostered offensive skill players and reuse durable IDs already resolved by the usage provider. */
export function selectRosterNextGenPlayers(roster, context) {
  return (roster || []).flatMap((player) => {
    const position = String(player?.position || '').trim().toUpperCase();
    if (!['QB', 'RB', 'WR', 'TE'].includes(position)) return [];
    const team = resolvePlayerNflTeam(player, context);
    return [{
      requestedPlayerId: player.playerId,
      name: player.name,
      position,
      nflTeam: team?.abbreviation || null,
      gsisId: player.externalIds?.gsis || player.analysisUsage?.gsisId || null
    }];
  });
}

export function groupRosterNflOffenses(roster, context) {
  const groups = new Map();
  for (const player of roster || []) {
    if (!['QB', 'RB', 'WR', 'TE'].includes(String(player?.position || '').toUpperCase())) continue;
    const team = resolvePlayerNflTeam(player, context);
    if (!team?.abbreviation) continue;
    const abbreviation = team.abbreviation;
    const opponent = findPlayerOpponent(player, context);
    const group = groups.get(abbreviation) || { team, opponent, players: [] };
    if (!group.opponent && opponent) group.opponent = opponent;
    group.players.push({
      playerId: player.playerId,
      name: player.name,
      position: player.position,
      slot: player.slot || null,
      lineupStatus: isNonStarter(player) ? 'bench' : 'starter'
    });
    groups.set(abbreviation, group);
  }
  return [...groups.values()].sort((a, b) => a.team.abbreviation.localeCompare(b.team.abbreviation));
}

export function groupOpponentDefenses(offenseGroups) {
  const groups = new Map();
  for (const offense of offenseGroups || []) {
    if (!offense.opponent?.abbreviation) continue;
    const abbreviation = offense.opponent.abbreviation;
    const group = groups.get(abbreviation) || { team: offense.opponent, affectedPlayers: [], positions: [] };
    for (const player of offense.players) {
      if (!group.affectedPlayers.some((saved) => String(saved.playerId) === String(player.playerId))) group.affectedPlayers.push(player);
      if (!group.positions.includes(player.position)) group.positions.push(player.position);
    }
    groups.set(abbreviation, group);
  }
  return [...groups.values()].map((group) => ({ ...group, positions: group.positions.sort() })).sort((a, b) => a.team.abbreviation.localeCompare(b.team.abbreviation));
}

async function buildCoachTrackerGroups({ league, roster, context, coachFeed, staffFeed }) {
  const offenseSeeds = groupRosterNflOffenses(roster, context);
  const defenseSeeds = groupOpponentDefenses(offenseSeeds);
  const teams = [...new Set([...offenseSeeds, ...defenseSeeds].map((group) => group.team.abbreviation))];
  const contexts = await Promise.all(teams.map(async (abbreviation) => [abbreviation, await getNflCoachingContext(league.season, league.currentWeek, { teamAbbreviation: abbreviation, coachFeed, staffFeed })]));
  const coachingByTeam = new Map(contexts);
  const offensePeriods = new Map(offenseSeeds.map((group) => [group.team.abbreviation, deriveCoachingAnalysisPeriod(coachingByTeam.get(group.team.abbreviation), 'offense')]));
  const nflverseTeams = offenseSeeds.filter((group) => offensePeriods.get(group.team.abbreviation)).map((group) => group.team.abbreviation);
  const nflverse = await getNflverseTeamTendencies(league.season, league.currentWeek, {
    teams: nflverseTeams,
    periods: Object.fromEntries(nflverseTeams.map((team) => [team, offensePeriods.get(team)]))
  });
  const nflverseByTeam = new Map((nflverse.teams || []).map((team) => [team.team, { ...team, sourceUrl: nflverse.sourceUrl, retrievedAt: nflverse.retrievedAt, dataVersion: nflverse.cache?.dataVersion || null, stale: nflverse.stale }]));
  const offenses = await Promise.all(offenseSeeds.map(async (group) => {
    const coachingContext = coachingByTeam.get(group.team.abbreviation) || null;
    const analysisPeriod = offensePeriods.get(group.team.abbreviation) || null;
    const espnTrend = coachingContext?.available && !coachingContext.stale && analysisPeriod
      ? await getNflTeamTrend(league.season, league.currentWeek, { teamId: group.team.id, teamAbbreviation: group.team.abbreviation, tenure: analysisPeriod })
      : null;
    const nflverseTrend = nflverseByTeam.get(group.team.abbreviation) || null;
    const teamTrend = espnTrend ? { ...espnTrend, nflverse: nflverseTrend } : null;
    return { ...group, coachingContext, analysisPeriod, teamTrend };
  }));
  const defenses = [];
  for (const group of defenseSeeds) {
    const coachingContext = coachingByTeam.get(group.team.abbreviation) || null;
    const analysisPeriod = deriveCoachingAnalysisPeriod(coachingContext, 'defense');
    const positionContexts = [];
    const historicalPositionContexts = [];
    for (const position of group.positions) {
      const currentContext = await getOpponentPositionContext(league.season, league.currentWeek, {
        defense: group.team,
        position,
        rawScoringRules: league.platform === 'sleeper' ? league.scoring?.raw || {} : null,
        period: analysisPeriod
      });
      positionContexts.push(currentContext);
      historicalPositionContexts.push(currentContext?.window?.basis === 'prior-season historical baseline'
        ? currentContext
        : await getOpponentPositionContext(league.season, 1, {
          defense: group.team,
          position,
          rawScoringRules: league.platform === 'sleeper' ? league.scoring?.raw || {} : null,
          period: null
        }));
    }
    defenses.push({ ...group, coachingContext, analysisPeriod, positionContexts, historicalPositionContexts });
  }
  const allTrends = [...offenses.map((group) => group.teamTrend), ...defenses.flatMap((group) => [...group.positionContexts, ...group.historicalPositionContexts])].filter(Boolean);
  return {
    offenses,
    defenses,
    stale: [...coachingByTeam.values()].some((item) => item?.stale) || allTrends.some((item) => item?.stale) || Boolean(nflverse.stale),
    decisionUse: 'descriptive_only',
    projectionsAdjusted: false,
    sources: { nflverse: { available: nflverse.available, sourceUrl: nflverse.sourceUrl, retrievedAt: nflverse.retrievedAt, stale: nflverse.stale, cache: nflverse.cache } }
  };
}

/** Keep the historical-opponent layer limited to the roster and already-ranked waiver adds. */
export function selectHistoricalOpponentPriorPlayers(roster = [], waivers = null) {
  const candidates = [
    ...(Array.isArray(roster) ? roster : []),
    ...(waivers?.recommendations || []).map((move) => move?.add).filter(Boolean)
  ];
  const unique = new Map();
  for (const player of candidates) {
    const position = String(player?.position || '').trim().toUpperCase();
    const playerId = String(player?.playerId ?? player?.id ?? '').trim();
    if (!playerId || !['QB', 'RB', 'WR', 'TE'].includes(position)) continue;
    if (!isCurrentPlayerRecommendationEligible(player)) continue;
    if (!unique.has(playerId)) unique.set(playerId, player);
  }
  return [...unique.values()];
}

async function buildHistoricalOpponentGroups({ league, players, context, coachFeed, staffFeed, baseDefenses = [] }) {
  const seeds = groupOpponentDefenses(groupRosterNflOffenses(players, context));
  const baseByTeam = new Map(baseDefenses.map((group) => [normalizedTeamKey(group.team?.abbreviation), group]));
  const groups = [];
  for (const seed of seeds) {
    const existing = baseByTeam.get(normalizedTeamKey(seed.team?.abbreviation));
    const coachingContext = existing?.coachingContext
      || await getNflCoachingContext(league.season, league.currentWeek, {
        teamAbbreviation: seed.team.abbreviation,
        coachFeed,
        staffFeed
      });
    const analysisPeriod = existing?.analysisPeriod || deriveCoachingAnalysisPeriod(coachingContext, 'defense');
    const positionContexts = [];
    const historicalPositionContexts = [];
    for (const position of seed.positions) {
      const current = existing?.positionContexts?.find((item) => String(item?.position).toUpperCase() === position)
        || await getOpponentPositionContext(league.season, league.currentWeek, {
          defense: seed.team,
          position,
          rawScoringRules: league.platform === 'sleeper' ? league.scoring?.raw || {} : null,
          period: analysisPeriod
        });
      const historical = existing?.historicalPositionContexts?.find((item) => String(item?.position).toUpperCase() === position)
        || (current?.window?.basis === 'prior-season historical baseline'
          ? current
          : await getOpponentPositionContext(league.season, 1, {
            defense: seed.team,
            position,
            rawScoringRules: league.platform === 'sleeper' ? league.scoring?.raw || {} : null,
            period: null
          }));
      positionContexts.push(current);
      historicalPositionContexts.push(historical);
    }
    groups.push({ ...seed, coachingContext, analysisPeriod, positionContexts, historicalPositionContexts });
  }
  return groups;
}

export function buildHistoricalOpponentPriorReport({ league, players = [], defenseGroups = [], nextGenContext = null } = {}) {
  const nextGenById = new Map((nextGenContext?.players || []).map((player) => [String(player.requestedPlayerId), player]));
  const groupByPlayer = new Map(defenseGroups.flatMap((group) => (group.affectedPlayers || []).map((player) => [String(player.playerId), group])));
  const historicalPlayerGames = deduplicateHistoricalPlayerGames(defenseGroups.flatMap((group) =>
    (group.historicalPositionContexts || []).flatMap((positionContext) => positionContext?.historicalPlayerGames || [])));
  const scopedPlayers = players.flatMap((player) => {
    const group = groupByPlayer.get(String(player.playerId));
    if (!group) return [];
    const position = String(player.position || '').toUpperCase();
    const historicalContext = group.historicalPositionContexts?.find((item) => String(item?.position).toUpperCase() === position) || null;
    const currentContext = group.positionContexts?.find((item) => String(item?.position).toUpperCase() === position) || null;
    return [{
      ...player,
      nextGen: nextGenById.get(String(player.playerId)) || null,
      defense: group.team,
      positionContext: historicalContext,
      currentSeasonDefense: currentContext,
      coachingContext: group.coachingContext,
      analysisPeriod: group.analysisPeriod
    }];
  });
  return buildHistoricalOpponentPriors({
    season: league?.season,
    currentWeek: league?.currentWeek,
    players: scopedPlayers,
    historicalPlayerGames,
    defensiveCoordinatorPeriods: []
  });
}

export function buildHistoricalMatchupPriorMap(opponentPriorReport, recommendationQuality, currentWeek = 1) {
  const byPlayer = new Map((opponentPriorReport?.players || []).map((prior) => [String(prior.requestedPlayerId), prior]));
  return Object.fromEntries((recommendationQuality?.comparisons || []).map((comparison) => {
    const recommendedPrior = byPlayer.get(String(comparison?.recommendedPlayer?.playerId));
    const alternativePrior = byPlayer.get(String(comparison?.alternativePlayer?.playerId));
    const evidence = buildHistoricalMatchupComparisonEvidence({
      recommendedPrior,
      alternativePrior,
      currentMatchupEvidence: Number(currentWeek) > 1 ? comparison?.evidence?.matchup : null
    });
    return [comparison.comparisonId, {
      ...evidence,
      historical: Number(currentWeek) <= 1,
      currentSeasonDefense: {
        recommended: recommendedPrior?.currentSeasonDefense || null,
        alternative: alternativePrior?.currentSeasonDefense || null
      },
      details: { recommendedPrior, alternativePrior }
    }];
  }));
}

function completedDefenseGames(report) {
  return Math.max(0, ...(report?.players || []).map((player) => Number(player?.currentSeasonDefense?.completedGames || 0)));
}

function deduplicateHistoricalPlayerGames(rows) {
  const unique = new Map();
  for (const row of rows) {
    const key = [row?.season, row?.week, row?.playerId, normalizedTeamKey(row?.defense), row?.position].join('|');
    if (!unique.has(key)) unique.set(key, row);
  }
  return [...unique.values()];
}

function normalizedTeamKey(value) {
  const team = String(value || '').trim().toUpperCase();
  return ({ WSH: 'WAS', JAC: 'JAX', LA: 'LAR', STL: 'LAR', SD: 'LAC', OAK: 'LV' })[team] || team;
}

function publicCoachTracker(grouped) {
  const compactContext = (context) => {
    if (!context || typeof context !== 'object') return context;
    const { historicalPlayerGames: _historicalPlayerGames, ...rest } = context;
    return rest;
  };
  return {
    ...grouped,
    defenses: (grouped?.defenses || []).map((group) => ({
      ...group,
      positionContexts: (group.positionContexts || []).map(compactContext),
      historicalPositionContexts: (group.historicalPositionContexts || []).map(compactContext)
    }))
  };
}

function findOwnerTeam(teams, hint) {
  const target = normalize(hint);
  return teams.find((team) => normalize(team.name).startsWith(target));
}

export function situationalContext(player, context, usage, { allowUsageAdjustment = false } = {}) {
  const game = findPlayerGame(player, context);
  const adjustments = [];
  if (player.injuryStatus && ['OUT', 'IR', 'SUSPENDED', 'INACTIVE'].includes(String(player.injuryStatus).toUpperCase())) {
    return { injuryStatus: player.injuryStatus, adjustments, sampleSize: usage?.summary?.sampleSize || null, volatility: usageVolatility(usage) };
  }
  if (game?.indoor === false && game.weather?.temperatureF != null && game.weather.temperatureF <= 25) {
    adjustments.push({ label: `Extreme cold (${game.weather.temperatureF}°F)`, delta: player.position === 'K' ? -0.06 : -0.03, source: 'ESPN NFL scoreboard', confidence: 'low' });
  }
  const wind = Number(/(\d+)\s*mph/i.exec(game?.weather?.summary || '')?.[1]);
  if (wind >= 20 && ['QB', 'WR', 'TE', 'K'].includes(player.position)) adjustments.push({ label: `High wind (${wind} mph)`, delta: -0.08, source: 'ESPN NFL scoreboard', confidence: 'low' });
  const trend = allowUsageAdjustment ? usageAdjustment(player, usage) : null;
  if (trend) adjustments.push(trend);
  return { injuryStatus: player.injuryStatus, adjustments, sampleSize: usage?.summary?.sampleSize || null, volatility: usageVolatility(usage) };
}

function buildMatchup(league, team, teamRoster, context, retrievedAt, source, injuriesById) {
  const side = league.matchups?.find((item) => item.teamId === team.id);
  const otherSide = side && league.matchups.find((item) => item.matchupId === side.matchupId && item.teamId !== team.id);
  const opponent = otherSide && league.teams.find((item) => item.id === otherSide.teamId);
  if (!side || !opponent) return null;
  const teamProjection = lineupDistribution(league, teamRoster, retrievedAt, source, context);
  const opponentRoster = opponent.roster.map((player) => enrichInjury(player, injuriesById));
  const opponentProjection = lineupDistribution(league, opponentRoster, retrievedAt, source, context);
  teamProjection.mean = Math.max(teamProjection.mean, Number(side.points || 0));
  opponentProjection.mean = Math.max(opponentProjection.mean, Number(otherSide.points || 0));
  const denominator = Math.sqrt(teamProjection.variance + opponentProjection.variance);
  const complete = teamProjection.complete && opponentProjection.complete;
  const winProbability = complete && denominator ? normalCdf((teamProjection.mean - opponentProjection.mean) / denominator) : null;
  return {
    matchupId: side.matchupId, opponent: { id: opponent.id, name: opponent.name, manager: opponent.manager },
    currentScore: { team: side.points || 0, opponent: otherSide.points || 0 },
    projected: { team: round(teamProjection.mean), opponent: round(opponentProjection.mean) },
    winProbability: winProbability == null ? null : roundProbability(winProbability),
    coverage: { team: teamProjection.coverage, opponent: opponentProjection.coverage, complete },
    confidence: 'low', caveat: complete ? 'Heuristic estimate using current scores as a floor, completed-player results when available, and projections for unresolved players; live remaining-game state and correlations are still approximate.' : 'Win chance is withheld because at least one active lineup lacks complete projection coverage.'
  };
}

function lineupDistribution(league, roster, retrievedAt, source, context) {
  const starters = roster.filter((player) => !isNonStarter(player));
  const configuredSlots = lineupSlots(league, roster);
  const required = configuredSlots.reduce((total, slot) => total + (typeof slot === 'object' && slot ? Math.max(1, Number(slot.count) || 1) : 1), 0) || starters.length;
  const projections = projectRoster(starters, { provenance: { source, retrievedAt }, byPlayer: Object.fromEntries(starters.map((player) => [player.playerId, situationalContext(player, context)])) });
  const projectionsById = new Map(projections.map((projection) => [projection.playerId, projection]));
  const distribution = starters.reduce((result, player) => {
    const projection = projectionsById.get(String(player.playerId));
    const completed = findPlayerGame(player, context)?.status?.completed === true;
    const actual = player.actualPoints == null ? null : Number(player.actualPoints);
    if (completed && Number.isFinite(actual)) { result.mean += actual; result.projected += 1; result.completed += 1; return result; }
    if (projection?.mean == null) return result;
    const sd = Math.max(0, (projection.ceiling - projection.floor) / 1.683242);
    result.mean += projection.mean; result.variance += sd * sd; result.projected += 1; return result;
  }, { mean: 0, variance: 0, projected: 0, completed: 0 });
  return { ...distribution, complete: starters.length >= required && distribution.projected >= required, coverage: { required, starters: starters.length, projected: distribution.projected, completed: distribution.completed } };
}

function topRecommendation(lineup, matchup) {
  const move = lineup?.recommendations?.[0];
  if (move) return {
    type: move.sit ? 'Start / sit' : 'Fill lineup', urgency: lineup.expectedGain >= 3 ? 'High impact' : 'Review', title: lineup.recommendations.length > 1 ? `Make ${lineup.recommendations.length} lineup changes` : move.sit ? `Start ${move.start.name} over ${move.sit.name}` : `Start ${move.start.name} in the open ${move.targetSlot} slot`,
    summary: `The best legal lineup projects ${format(lineup.expectedGain)} more points than the current lineup using the ${lineup.objectiveLabel}.`,
    caveat: move.caveats?.[0] || move.whatCouldChange?.[0] || 'Late injury, inactive, role, or weather news can change this recommendation.',
    expectedGain: lineup.expectedGain, confidence: capitalize(move.confidence?.level || 'low')
  };
  return {
    type: 'Lineup review', urgency: 'No material change', title: 'Keep the current lineup for now',
    summary: matchup?.winProbability == null ? 'No supported change clears the 0.8-point materiality threshold.' : `No supported change clears the 0.8-point threshold. Current heuristic matchup win chance: ${Math.round(matchup.winProbability * 100)}%.`,
    caveat: 'Recheck after practice reports, inactive announcements, and meaningful weather changes.', expectedGain: 0, confidence: lineup ? aggregateConfidence(lineup.projections) : 'Low'
  };
}

function buildEvidence(league, envelope, leagueStale, context, games, weatherContext, players, injuryContext, usageContext, coachingContext, teamTrend, trendPlayer, opponentPositionContext) {
  const evidence = [
    { source: league.platform === 'sleeper' ? 'Sleeper' : 'ESPN Fantasy', text: `League-specific Week ${league.currentWeek} projections, roster slots, and scoring configuration.`, retrievedAt: envelope.retrievedAt, stale: leagueStale },
    { source: 'ESPN NFL scoreboard', text: games.length ? `${games.length} relevant NFL games checked for kickoff, venue, and betting context. Official weather is listed separately.` : 'NFL game context was requested, but no roster games could be matched.', retrievedAt: context.retrievedAt, stale: context.stale },
    ...buildWeatherEvidence(games, weatherContext)
  ];
  const injuries = players.filter((player) => player.analysisInjury).map((player) => {
    const report = player.analysisInjury; const details = [report.status, report.injury?.bodyPart, report.injury?.practiceStatus].filter(Boolean).join(', ');
    return `${player.name}: ${details}`;
  });
  if (injuries.length) evidence.push({ source: 'ESPN NFL injury report', text: injuries.slice(0, 5).join('; '), retrievedAt: injuryContext.retrievedAt, stale: injuryContext.stale });
  const platformInjuries = players.filter((player) => player.injuryStatus && !player.analysisInjury && String(player.injuryStatus).toUpperCase() !== 'ACTIVE').map((player) => `${player.name}: ${player.injuryStatus}`);
  if (platformInjuries.length) evidence.push({ source: `${league.platform} player status`, text: platformInjuries.slice(0, 5).join('; '), retrievedAt: envelope.retrievedAt, stale: leagueStale });
  const usage = players.filter((player) => player.analysisUsage?.summary?.sampleSize).sort((a, b) => b.analysisUsage.summary.sampleSize - a.analysisUsage.summary.sampleSize).slice(0, 3);
  for (const player of usage) {
    const summary = player.analysisUsage.summary; const positionMetrics = usageMetrics(player.position);
    const facts = positionMetrics.map((metric) => { const value = summary.opportunity?.[metric]?.weightedAverage; return value == null ? null : `${metricLabel(metric)} ${metric === 'snapShare' ? `${Math.round(value * 100)}%` : round(value)}`; }).filter(Boolean);
    evidence.push({ source: 'Sleeper historical stats', text: `${player.name}: ${summary.sampleSize} games from the ${usageContext.season} sample; ${facts.join(', ') || 'opportunity fields unavailable'}; trend ${summary.trend.direction}.`, retrievedAt: player.analysisUsage.retrievedAt, stale: player.analysisUsage.stale });
  }
  if (coachingContext?.available && teamTrend?.available) {
    const passRate = teamTrend.metrics?.passAttemptRate?.value; const plays = teamTrend.metrics?.offensivePlaysPerGame?.value;
    const facts = [passRate == null ? null : `${Math.round(passRate * 100)}% pass-attempt share`, plays == null ? null : `${round(plays)} offensive plays/game`].filter(Boolean).join(', ');
    const weekly = weeklyCoachTrend(teamTrend.games);
    const basis = (teamTrend.tracker?.basisRoles || []).map((role) => role.label.toLowerCase()).join(' + ') || 'verified coaching roles';
    evidence.push({ source: 'Coach tracker', text: `${teamTrend.team?.abbreviation || coachingContext.team?.abbreviation || 'NFL team'} · ${league.season}: ${facts || 'trend metrics unavailable'} across ${teamTrend.window?.includedGames || 0} completed games since the latest ${basis} period began.${weekly ? ` Week by week: ${weekly}.` : ''} These are team results, not proof of an individual coach's intent.`, retrievedAt: coachingContext.retrievedAt || teamTrend.source?.newestRetrievedAt || teamTrend.generatedAt, stale: Boolean(coachingContext.stale || teamTrend.stale) });
  } else if (coachingContext?.available && teamTrend?.learning) {
    evidence.push({ source: 'Coach tracker', text: `${coachingContext.team?.abbreviation || trendPlayer?.nflTeam || 'NFL team'} has verified current coaching roles. The ${league.season} tracker is waiting for its first completed game in the current role period; no older team results are assigned to it.`, retrievedAt: coachingContext.retrievedAt, stale: Boolean(coachingContext.stale) });
  }
  const nflverse = teamTrend?.nflverse;
  if (nflverse?.available) {
    const metrics = ['neutralPassRate', 'overallPassRate', 'secondsPerPlay', 'earlyDownPassRate', 'redZonePassRate'].map((key) => nflverse.metrics?.[key]?.label).filter((label) => label && label !== 'Not enough data');
    if (nflverse.recentChange?.available) metrics.push(nflverse.recentChange.label);
    evidence.push({ source: 'nflverse play-by-play', text: `${nflverse.team}: ${metrics.join('; ') || 'current-period measurable tendencies available'}. ${nflverse.window.includedGames} completed game${nflverse.window.includedGames === 1 ? '' : 's'} included. Descriptive only; no projection adjustment applied.`, retrievedAt: nflverse.retrievedAt, stale: Boolean(nflverse.stale) });
  } else if (nflverse?.learning) {
    evidence.push({ source: 'nflverse play-by-play', text: `${nflverse.team}: waiting for completed current-period play-by-play. No tendency was guessed.`, retrievedAt: null, stale: false });
  }
  if (opponentPositionContext?.available) {
    const metric = opponentPositionContext.metrics?.opportunity;
    const sample = opponentPositionContext.sample?.includedGames || 0;
    const basis = opponentPositionContext.window?.basis === 'prior-season historical baseline' ? `${opponentPositionContext.season} historical baseline` : `${opponentPositionContext.season} current-season sample`;
    const comparison = opponentPositionContext.sample?.adequate
      ? `${metric?.band || 'near league'}`
      : `${metric?.valuePerGame ?? 'unavailable'} per game versus ${metric?.leagueValuePerGame ?? 'unavailable'} league-wide; sample too small for a strength label`;
    evidence.push({ source: 'Opponent position response', text: `${opponentPositionContext.defense?.abbreviation || 'Opponent'} allowed ${trendPlayer?.position || 'skill-position'} ${metric?.label || 'opportunity'} ${comparison} across ${sample} games (${basis}). Descriptive context only; no projection adjustment applied.`, retrievedAt: opponentPositionContext.retrievedAt, stale: Boolean(opponentPositionContext.stale) });
  }
  for (const game of games.slice(0, 4)) {
    const names = `${game.teams?.away?.abbreviation || 'Away'} at ${game.teams?.home?.abbreviation || 'Home'}`;
    const officialWeather = weatherContext?.games?.find((item) => String(item.gameId) === String(game.id));
    const legacyWeather = officialWeather?.available ? null : game.indoor === true ? 'indoors' : game.weather?.summary;
    const facts = [legacyWeather, game.odds?.total == null ? null : `total ${game.odds.total}`, game.odds?.details].filter(Boolean).join(', ');
    evidence.push({ source: 'ESPN NFL scoreboard', text: `${names}: ${facts || 'environment details unavailable'}.`, retrievedAt: game.retrievedAt, stale: game.stale });
  }
  return evidence;
}

export function buildWeatherEvidence(games, weatherContext) {
  const byGame = new Map((weatherContext?.games || []).map((game) => [String(game.gameId), game]));
  return (games || []).map((game) => {
    const names = `${game.teams?.away?.abbreviation || 'Away'} at ${game.teams?.home?.abbreviation || 'Home'}`;
    const weather = byGame.get(String(game.id));
    const summary = weather?.summary || 'Official weather temporarily unavailable.';
    const basis = weather?.forecast?.basis === 'hourly'
      ? 'NWS kickoff-hour forecast.'
      : weather?.forecast?.basis === 'forecast_period'
        ? 'NWS broader forecast period; hourly data was unavailable.'
        : ['fixed', 'covered_open_air'].includes(weather?.venue?.roofType)
          ? 'No outdoor forecast requested.'
          : '';
    return { source: 'Weather', text: `${names}: ${summary}${basis ? ` ${basis}` : ''}`, retrievedAt: weather?.retrievedAt || weatherContext?.retrievedAt || null, stale: Boolean(weather?.stale) };
  });
}

function coverageIssues(league, leagueStale, context, injuryContext, usageContext, players, coachingContext, teamTrend, opponentPositionContext, trendPlayer, matchup) {
  const issues = [];
  if (leagueStale) issues.push('The saved league snapshot is stale.');
  for (const issue of league.dataIssues || []) issues.push(issue.message || String(issue));
  if (!context.retrievedAt) issues.push('Current NFL game context is unavailable.');
  if (context.stale) issues.push('NFL game context is stale.');
  if (!injuryContext.retrievedAt) issues.push('The current NFL injury report is unavailable.');
  if (!usageContext.retrievedAt) issues.push('Historical usage data is unavailable.');
  if (trendPlayer && !coachingContext?.available) issues.push('The current head coach could not be verified for the selected high-leverage player, so no games are attributed to a coach.');
  else if (teamTrend?.learning) issues.push('The current coaching-period tracker is learning and will add one row after each completed game.');
  else if (!teamTrend?.available) issues.push('Current-season team tendency context is unavailable for the selected high-leverage player.');
  if (trendPlayer && !opponentPositionContext?.available) issues.push('Opponent position-response context is unavailable for the selected high-leverage player.');
  if (opponentPositionContext?.partial) issues.push(`Opponent position-response context is incomplete because ${opponentPositionContext.missingWeeks?.length || 1} requested week${opponentPositionContext.missingWeeks?.length === 1 ? '' : 's'} could not be loaded.`);
  if (matchup && !matchup.coverage?.complete) issues.push('Matchup win probability is withheld because an active lineup is missing projections or a filled slot.');
  if (players.some((player) => player.projection == null)) issues.push('One or more rostered players do not have a current numeric projection.');
  issues.push('Head coaches, offensive coordinators, offensive play callers, and defensive coordinators are tracked independently when verified. Defensive play callers remain Not verified; coverage/front concepts and calibrated player-specific probabilities are not inferred from box scores.');
  return issues;
}

function uncertaintyText(lineup, issues) {
  const base = 'Outcome ranges use recent player variability when enough game logs are available and position-level volatility otherwise; they are not calibrated probabilities yet.';
  return issues.length ? `${base} ${issues[0]}` : base;
}

function changeTriggers(players, games) {
  const questionable = players.filter((player) => ['QUESTIONABLE', 'DOUBTFUL', 'Q', 'D', 'DAY_TO_DAY'].includes(String(player.injuryStatus).toUpperCase())).map((player) => player.name);
  const triggers = [];
  if (questionable.length) triggers.push(`Final availability for ${questionable.slice(0, 4).join(', ')}.`);
  if (games.some((game) => game.indoor === false)) triggers.push('Wind, precipitation, or field-condition changes near kickoff.');
  triggers.push('A verified head-coach, coordinator, or play-caller change resets only the affected role period and any descriptive sample that depends on it.');
  triggers.push('Inactive announcements, confirmed role changes, or a projection move of at least 0.8 points.');
  return triggers;
}

function weeklyCoachTrend(games) {
  return [...(games || [])].sort((a, b) => Number(a.week) - Number(b.week)).slice(-6).map((game) => {
    const rate = game.metrics?.passAttemptRate; const rushes = game.metrics?.rushAttempts;
    const details = [rate == null ? null : `${Math.round(rate * 100)}% pass`, rushes == null ? null : `${round(rushes)} rushes`].filter(Boolean).join(', ');
    return `W${game.week} ${details || 'result recorded'}`;
  }).join('; ');
}

function espnId(player) { if (player.externalIds?.espn) return String(player.externalIds.espn); const match = /^espn:(.+)$/.exec(String(player.playerId)); return match?.[1] || ''; }
function enrichInjury(player, injuriesById) {
  const injury = injuriesById.get(espnId(player));
  return injury ? { ...player, injuryStatus: injury.status || injury.designation?.abbreviation || player.injuryStatus, analysisInjury: injury } : player;
}
function isNonStarter(player) { return NON_STARTERS.has(String(player?.slot || '').trim().toUpperCase()); }
function lineupSlots(league, players) {
  const configured = league.settings?.roster;
  if (Array.isArray(configured) && configured.length) return configured.filter(isActiveConfiguredSlot);
  return players.filter((player) => !isNonStarter(player)).map((player) => player.slot);
}
function isActiveConfiguredSlot(slot) {
  const value = typeof slot === 'object' && slot ? slot.name ?? slot.slot ?? slot.slotId : slot;
  return !['20', '21', 'BENCH', 'BN', 'IR', 'RESERVE', 'TAXI'].includes(String(value ?? '').trim().toUpperCase());
}
function projectionTimestamp(player, fallback) {
  if (player?.projectionUpdatedAt == null) return fallback;
  const date = new Date(player.projectionUpdatedAt);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}
function usageMetrics(position) { if (position === 'QB') return ['passAttempts', 'snaps']; if (position === 'RB') return ['carries', 'targets', 'snapShare']; if (['WR', 'TE'].includes(position)) return ['targets', 'routes', 'snapShare']; return ['snapShare']; }
function metricLabel(metric) { return ({ passAttempts: 'pass attempts', carries: 'carries', targets: 'targets', routes: 'routes', snaps: 'snaps', snapShare: 'snap share' })[metric] || metric; }
function usageAdjustment(player, usage) {
  const summary = usage?.summary; if (!summary || summary.sampleSize < 3) return null;
  const directions = usageMetrics(player.position).map((metric) => summary.opportunity?.[metric]?.direction).filter((value) => value && value !== 'unavailable');
  const rising = directions.filter((value) => value === 'increasing').length; const falling = directions.filter((value) => value === 'decreasing').length;
  if (rising >= 2 && falling === 0) return { label: 'Recent opportunity trend increasing', delta: 0.03, source: 'Sleeper historical stats', confidence: 'low' };
  if (falling >= 2 && rising === 0) return { label: 'Recent opportunity trend decreasing', delta: -0.03, source: 'Sleeper historical stats', confidence: 'low' };
  return null;
}
function usageVolatility(usage) {
  const values = (usage?.gameLogs || []).map((game) => game.fantasyPoints).filter((value) => Number.isFinite(value));
  if (values.length < 3) return null; const mean = values.reduce((a, b) => a + b, 0) / values.length; if (mean <= 0) return null;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.max(.18, Math.min(.75, Math.sqrt(variance) / mean));
}

function uniqueGames(games) { return [...new Map(games.map((game) => [game.id, game])).values()]; }
function aggregateConfidence(projections) { const scores = projections.filter((item) => item.available).map((item) => item.confidence.score); const average = scores.reduce((a, b) => a + b, 0) / (scores.length || 1); return average >= .8 ? 'High' : average >= .6 ? 'Medium' : 'Low'; }
function capitalize(value) { return String(value).charAt(0).toUpperCase() + String(value).slice(1); }
function normalize(value) { return String(value || '').normalize('NFKD').replace(/[^a-z0-9]/gi, '').toLowerCase(); }
function normalizeObjective(value) {
  const objective = value || 'mean';
  if (!['mean', 'floor', 'ceiling'].includes(objective)) throw Object.assign(new Error('Decision mode must be mean, floor, or ceiling'), { status: 400 });
  return objective;
}
function format(value) { return `${Number(value || 0).toFixed(1)} points`; }
function round(value) { return Math.round(value * 10) / 10; }
function roundProbability(value) { return Math.round(value * 100) / 100; }
function normalCdf(value) { const sign = value < 0 ? -1 : 1; const x = Math.abs(value) / Math.sqrt(2); const t = 1 / (1 + .3275911 * x); const erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-x * x)); return (1 + erf) / 2; }
