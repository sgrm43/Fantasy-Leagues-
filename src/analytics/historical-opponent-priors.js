/**
 * Pure historical opponent/scheme priors for already-selected fantasy players.
 *
 * This module deliberately performs no I/O and does not know about any provider.
 * Callers may supply the normalized public `positionContext` returned by the
 * existing opponent-position adapter, plus normalized historical player-games:
 *
 *   { playerId, position, defense, season, week, style?, role?,
 *     defenseTendency?, stats?, fantasyPoints?, opportunity?,
 *     expectedFantasyPoints?, expectedOpportunity? }
 *
 * Player style is read only from explicit role, usage, or NGS/reference fields.
 * Missing fields stay missing; a name, projection, or position alone is never
 * used to invent a style.
 */

export const HISTORICAL_OPPONENT_PRIOR_SAMPLE_THRESHOLDS = Object.freeze({
  strong: 50,
  moderate: 25,
  weak: 10
});

// Short alias for consumers that do not include "prior" in configuration names.
export const HISTORICAL_OPPONENT_SAMPLE_THRESHOLDS = HISTORICAL_OPPONENT_PRIOR_SAMPLE_THRESHOLDS;

export const HISTORICAL_OPPONENT_COHORT_ORDER = Object.freeze([
  Object.freeze({ key: 'exact_style+tendency', fields: Object.freeze(['position', 'style', 'defenseTendency']) }),
  Object.freeze({ key: 'role+tendency', fields: Object.freeze(['position', 'role', 'defenseTendency']) }),
  Object.freeze({ key: 'position+tendency', fields: Object.freeze(['position', 'defenseTendency']) }),
  Object.freeze({ key: 'position', fields: Object.freeze(['position']) })
]);

export const HISTORICAL_OPPONENT_EFFECT_THRESHOLDS = Object.freeze({
  favorable: 0.15,
  mildlyFavorable: 0.05,
  mildlyDifficult: -0.05,
  difficult: -0.15
});

export const PLAYER_STYLES_BY_POSITION = Object.freeze({
  QB: Object.freeze(['rushing_qb', 'pocket_passer', 'high_air_yard_passer', 'short_intermediate_volume_passer']),
  RB: Object.freeze(['early_down_runner', 'pass_catching_back', 'goal_line_back', 'explosive_runner', 'committee_back']),
  WR: Object.freeze(['deep_threat', 'slot_short_area_target', 'possession_receiver', 'yac_oriented_receiver', 'high_volume_alpha_role']),
  TE: Object.freeze(['field_stretching_te', 'short_intermediate_te'])
});

const SUPPORTED_POSITIONS = new Set(Object.keys(PLAYER_STYLES_BY_POSITION));
const QUALITY_RANK = Object.freeze({ insufficient: 0, weak: 1, moderate: 2, strong: 3 });
const QUALITY_BY_RANK = Object.freeze(['insufficient', 'weak', 'moderate', 'strong']);
const MODEL = 'historical-opponent-scheme-prior-v1';
const STYLE_LABELS = Object.freeze({
  rushing_qb: 'Rushing QB',
  pocket_passer: 'Pocket passer',
  high_air_yard_passer: 'High-air-yard passer',
  short_intermediate_volume_passer: 'Short/intermediate volume passer',
  early_down_runner: 'Early-down runner',
  pass_catching_back: 'Pass-catching back',
  goal_line_back: 'Goal-line back',
  explosive_runner: 'Explosive runner',
  committee_back: 'Committee back',
  deep_threat: 'Deep threat',
  slot_short_area_target: 'Slot / short-area target',
  possession_receiver: 'Possession receiver',
  yac_oriented_receiver: 'YAC-oriented receiver',
  high_volume_alpha_role: 'High-volume alpha role',
  field_stretching_te: 'Field-stretching TE',
  short_intermediate_te: 'Short/intermediate TE',
  style_not_confident: 'style_not_confident'
});

/** Return the centralized quality tier for a comparable player-game count. */
export function historicalOpponentSampleQuality(sampleSize) {
  const count = nonNegativeInteger(sampleSize) ?? 0;
  if (count >= HISTORICAL_OPPONENT_PRIOR_SAMPLE_THRESHOLDS.strong) return 'strong';
  if (count >= HISTORICAL_OPPONENT_PRIOR_SAMPLE_THRESHOLDS.moderate) return 'moderate';
  if (count >= HISTORICAL_OPPONENT_PRIOR_SAMPLE_THRESHOLDS.weak) return 'weak';
  return 'insufficient';
}

export const sampleQuality = historicalOpponentSampleQuality;

/**
 * Build priors only for the supplied roster/decision candidates. `players` is
 * the scope boundary; this function never expands it to league-wide players.
 */
export function buildHistoricalOpponentPriors(input = {}) {
  if (!Array.isArray(input.players)) throw new TypeError('players must be an array');
  validateOptionalRows(input.historicalPlayerGames, 'historicalPlayerGames');
  validateOptionalRows(input.historicalMatchupRows, 'historicalMatchupRows');
  validateOptionalRows(input.historicalDefenseRows, 'historicalDefenseRows');
  validateOptionalRows(input.defensiveCoordinatorPeriods, 'defensiveCoordinatorPeriods');
  const season = positiveIntegerOr(input.season, 2026);
  const week = positiveIntegerOr(input.currentWeek ?? input.week, 1);
  const players = input.players
    .filter((player) => SUPPORTED_POSITIONS.has(normalizePosition(player?.position)))
    .map((player) => {
      const usage = indexedEvidence(input.analysisUsageByPlayer ?? input.historicalUsage?.players ?? input.analysisUsage?.players, player);
      const nextGen = indexedEvidence(input.nextGenByPlayer ?? input.nextGenContext?.players ?? input.nextGen?.players, player);
      return buildHistoricalOpponentPrior({
        ...input,
        season,
        currentWeek: week,
        player: { ...player, analysisUsage: player.analysisUsage ?? usage ?? undefined, nextGen: player.nextGen ?? nextGen ?? undefined },
        defense: indexedEvidence(input.defenses ?? input.opponents, player) ?? player?.defense ?? input.defense,
        positionContext: indexedEvidence(input.positionContexts, player) ?? player?.positionContext ?? input.positionContext,
        currentSeasonDefense: indexedEvidence(input.currentSeasonDefenses, player) ?? player?.currentSeasonDefense ?? input.currentSeasonDefense,
        coachingContext: indexedEvidence(input.coachingContexts, player) ?? player?.coachingContext ?? input.coachingContext,
        analysisPeriod: indexedEvidence(input.analysisPeriods, player) ?? player?.analysisPeriod ?? input.analysisPeriod
      });
    });
  return {
    model: MODEL,
    season,
    week,
    players,
    available: players.some((player) => player.status === 'available' || player.status === 'mixed'),
    scope: 'supplied_roster_and_decision_candidates_only',
    cohortOrder: HISTORICAL_OPPONENT_COHORT_ORDER.map((level) => level.key),
    thresholds: { ...HISTORICAL_OPPONENT_PRIOR_SAMPLE_THRESHOLDS, insufficientBelow: HISTORICAL_OPPONENT_PRIOR_SAMPLE_THRESHOLDS.weak },
    decisionUse: 'bounded_matchup_evidence',
    projectionsAdjusted: false,
    optimizerAdjusted: false,
    safeguards: readOnlySafeguards()
  };
}

export const buildHistoricalOpponentPriorLayer = buildHistoricalOpponentPriors;

/** Build one roster-relevant player's historical matchup prior. */
export function buildHistoricalOpponentPrior(input = {}) {
  const season = positiveIntegerOr(input.season, 2026);
  const week = positiveIntegerOr(input.currentWeek ?? input.week, 1);
  const suppliedPlayer = input.player && typeof input.player === 'object' ? input.player : input;
  const styleEvidencePlayer = {
    ...suppliedPlayer,
    analysisUsage: suppliedPlayer.analysisUsage ?? input.analysisUsage ?? input.usage,
    nextGen: suppliedPlayer.nextGen ?? input.nextGen ?? input.ngs,
    nextGenReference: suppliedPlayer.nextGenReference ?? input.nextGenReference ?? input.ngsReference,
    roleEvidence: suppliedPlayer.roleEvidence ?? input.roleEvidence
  };
  const player = normalizePlayer(suppliedPlayer);
  const defense = normalizeDefense(input.defense ?? input.opponent ?? input.player?.defense, player);
  const currentSeasonDefense = normalizeCurrentSeasonDefense(
    input.currentSeasonDefense ?? input.currentDefenseEvidence,
    { season, defense: defense.team }
  );
  if (!player.position) return unavailablePlayerPrior(player, defense, currentSeasonDefense, season, week);

  const playerStyle = classifyPlayerStyle(styleEvidencePlayer);
  const coordinatorPrior = buildDefensiveCoordinatorHistoricalPrior({
    season,
    defense,
    coachingContext: input.coachingContext ?? defense.coachingContext,
    analysisPeriod: input.analysisPeriod ?? defense.analysisPeriod,
    defensiveCoordinator: input.defensiveCoordinator,
    defensiveCoordinatorPeriods: input.defensiveCoordinatorPeriods
      ?? defense.defensiveCoordinatorPeriods
      ?? input.coordinatorPeriods
      ?? []
  });
  const historicalDefensePrior = buildDefensiveHistoricalPrior({
    season,
    position: player.position,
    defense,
    positionContext: input.positionContext ?? positionContextFor(defense, player.position),
    historicalPlayerGames: input.historicalPlayerGames ?? [],
    historicalDefenseRows: input.historicalDefenseRows ?? [],
    coordinatorPrior,
    personnelTurnover: input.personnelTurnover ?? defense.personnelTurnover
  });
  const defenseTendency = firstText(
    tendencyForPosition(input.defenseTendency, player.position),
    tendencyForPosition(defense.tendency, player.position),
    historicalDefensePrior.defenseTendency
  );
  const styleMatchupPrior = buildPlayerStyleMatchupPrior({
    season,
    player,
    playerStyle,
    defenseTendency,
    historicalMatchupRows: input.historicalMatchupRows,
    historicalPlayerGames: input.historicalPlayerGames
  });
  const matchupEvidence = collapseHistoricalMatchupEvidence({
    player,
    historicalDefensePrior,
    coordinatorPrior,
    styleMatchupPrior,
    currentSeasonDefense,
    personnelTurnover: input.personnelTurnover ?? defense.personnelTurnover
  });

  return {
    model: MODEL,
    requestedPlayerId: player.playerId,
    name: player.name,
    position: player.position,
    defense: defense.public,
    season,
    week,
    status: matchupEvidence.status,
    playerStyle,
    historicalDefensePrior,
    coordinatorPrior,
    styleMatchupPrior,
    currentSeasonDefense,
    matchupEvidence,
    explanation: matchupEvidence.summary,
    historicalPriorUsedAsCurrentEvidence: false,
    decisionUse: 'bounded_matchup_evidence',
    projectionsAdjusted: false,
    optimizerAdjusted: false,
    safeguards: readOnlySafeguards()
  };
}

/**
 * Classify a player using only explicit normalized role/usage/NGS evidence.
 * Supported existing shapes include `analysisUsage.summary.opportunity`, its
 * `gameLogs`, and NGS `current`/`reference.metrics[].values` records.
 */
export function classifyPlayerStyle(value = {}) {
  const player = value.player && typeof value.player === 'object' ? value.player : value;
  const position = normalizePosition(player?.position);
  if (!position) return styleNotConfident(position, 'A supported QB, RB, WR, or TE position is required.');
  const explicit = normalizeStyle(firstText(
    player.style,
    player.playerStyle?.style ?? (typeof player.playerStyle === 'string' ? player.playerStyle : null),
    player.archetype,
    player.roleEvidence?.style,
    player.evidence?.style
  ), position);
  if (explicit) {
    return styleResult(position, explicit, roleFor(player, explicit), 'strong', [
      evidenceFact('explicit_style', explicit, 'Supplied normalized player style')
    ]);
  }

  const roles = roleTokens(player);
  const usage = (key, aliases = []) => usageMetric(player, [key, ...aliases]);
  const ngs = (key, aliases = []) => ngsMetric(player, [key, ...aliases]);
  const candidates = [];
  const add = (style, confidence, facts) => candidates.push({ style, confidence, facts: facts.filter(Boolean) });

  if (position === 'QB') {
    const rushes = usage('rushAttemptsPerGame', ['rushAttempts', 'carries']);
    const passes = usage('passAttemptsPerGame', ['passAttempts']);
    const adot = ngs('avgIntendedAirYards', ['averageIntendedAirYards', 'aDot']) ?? usage('avgIntendedAirYards', ['aDot']);
    if (roleHas(roles, ['rushing qb', 'mobile qb', 'dual threat']) || rushes?.value >= 5) {
      add('rushing_qb', roleHas(roles, ['rushing qb', 'mobile qb', 'dual threat']) ? 'strong' : 'moderate', [
        roleFact(roles, ['rushing qb', 'mobile qb', 'dual threat']), metricFact('rushAttemptsPerGame', rushes)
      ]);
    }
    if (adot?.value >= 8.5) add('high_air_yard_passer', 'moderate', [metricFact('avgIntendedAirYards', adot)]);
    if (adot?.value <= 7.5 && passes?.value >= 30) add('short_intermediate_volume_passer', 'moderate', [metricFact('avgIntendedAirYards', adot), metricFact('passAttemptsPerGame', passes)]);
    if (roleHas(roles, ['pocket passer', 'pocket qb']) || (rushes?.value <= 2 && passes?.value >= 25)) {
      add('pocket_passer', roleHas(roles, ['pocket passer', 'pocket qb']) ? 'strong' : 'moderate', [
        roleFact(roles, ['pocket passer', 'pocket qb']), metricFact('rushAttemptsPerGame', rushes), metricFact('passAttemptsPerGame', passes)
      ]);
    }
  }

  if (position === 'RB') {
    const carries = usage('carriesPerGame', ['rushAttemptsPerGame', 'carries', 'rushAttempts']);
    const targets = usage('targetsPerGame', ['targets']);
    const redZoneCarries = usage('redZoneCarriesPerGame', ['redZoneCarries', 'goalLineCarries']);
    const snapShare = usage('snapShare');
    const rushOverExpected = ngs('rushYardsOverExpectedPerAtt', ['rushingYardsOverExpectedPerAttempt']);
    if (roleHas(roles, ['pass catching back', 'receiving back', 'third down back']) || targets?.value >= 4) {
      add('pass_catching_back', roleHas(roles, ['pass catching back', 'receiving back', 'third down back']) ? 'strong' : 'moderate', [roleFact(roles, ['pass catching back', 'receiving back', 'third down back']), metricFact('targetsPerGame', targets)]);
    }
    if (roleHas(roles, ['goal line back', 'short yardage back']) || redZoneCarries?.value >= 2) {
      add('goal_line_back', roleHas(roles, ['goal line back', 'short yardage back']) ? 'strong' : 'moderate', [roleFact(roles, ['goal line back', 'short yardage back']), metricFact('redZoneCarriesPerGame', redZoneCarries)]);
    }
    if (roleHas(roles, ['explosive runner', 'home run back']) || rushOverExpected?.value >= 0.5) {
      add('explosive_runner', roleHas(roles, ['explosive runner', 'home run back']) ? 'strong' : 'moderate', [roleFact(roles, ['explosive runner', 'home run back']), metricFact('rushYardsOverExpectedPerAtt', rushOverExpected)]);
    }
    if (roleHas(roles, ['early down runner', 'early down back', 'between the tackles']) || (carries?.value >= 12 && targets?.value <= 3)) {
      add('early_down_runner', roleHas(roles, ['early down runner', 'early down back', 'between the tackles']) ? 'strong' : 'moderate', [roleFact(roles, ['early down runner', 'early down back', 'between the tackles']), metricFact('carriesPerGame', carries), metricFact('targetsPerGame', targets)]);
    }
    if (roleHas(roles, ['committee back', 'committee rb', 'change of pace']) || (snapShare?.value != null && snapShare.value <= 0.55 && (carries?.value != null || targets?.value != null))) {
      add('committee_back', roleHas(roles, ['committee back', 'committee rb', 'change of pace']) ? 'strong' : 'moderate', [roleFact(roles, ['committee back', 'committee rb', 'change of pace']), metricFact('snapShare', snapShare)]);
    }
  }

  if (position === 'WR') {
    const targets = usage('targetsPerGame', ['targets']);
    const targetShare = usage('targetShare');
    const slotRate = usage('slotRate', ['slotShare']);
    const catchRate = usage('catchRate');
    const adot = ngs('avgIntendedAirYards', ['averageIntendedAirYards', 'aDot']) ?? usage('avgIntendedAirYards', ['aDot']);
    const airShare = ngs('percentShareOfIntendedAirYards', ['airYardsShare']) ?? usage('airYardsShare');
    const yac = ngs('avgYac', ['yardsAfterCatchPerReception']) ?? usage('yardsAfterCatchPerReception', ['avgYac']);
    const yacOverExpected = ngs('avgYacAboveExpectation');
    if (roleHas(roles, ['deep threat', 'field stretcher', 'vertical receiver']) || adot?.value >= 13) {
      add('deep_threat', roleHas(roles, ['deep threat', 'field stretcher', 'vertical receiver']) ? 'strong' : 'moderate', [roleFact(roles, ['deep threat', 'field stretcher', 'vertical receiver']), metricFact('avgIntendedAirYards', adot)]);
    }
    if (roleHas(roles, ['slot receiver', 'slot target', 'short area target']) || slotRate?.value >= 0.55) {
      add('slot_short_area_target', roleHas(roles, ['slot receiver', 'slot target', 'short area target']) ? 'strong' : 'moderate', [roleFact(roles, ['slot receiver', 'slot target', 'short area target']), metricFact('slotRate', slotRate), adot?.value <= 10 ? metricFact('avgIntendedAirYards', adot) : null]);
    }
    if (roleHas(roles, ['high volume alpha', 'alpha receiver', 'primary target']) || targetShare?.value >= 0.25 || (targets?.value >= 8 && airShare?.value >= 25)) {
      add('high_volume_alpha_role', roleHas(roles, ['high volume alpha', 'alpha receiver', 'primary target']) ? 'strong' : 'moderate', [roleFact(roles, ['high volume alpha', 'alpha receiver', 'primary target']), metricFact('targetShare', targetShare), metricFact('targetsPerGame', targets), metricFact('percentShareOfIntendedAirYards', airShare)]);
    }
    if (roleHas(roles, ['yac receiver', 'yac oriented receiver']) || yacOverExpected?.value >= 0.5 || (yac?.value >= 6 && adot?.value <= 10)) {
      add('yac_oriented_receiver', roleHas(roles, ['yac receiver', 'yac oriented receiver']) ? 'strong' : 'moderate', [roleFact(roles, ['yac receiver', 'yac oriented receiver']), metricFact('avgYac', yac), metricFact('avgYacAboveExpectation', yacOverExpected)]);
    }
    if (roleHas(roles, ['possession receiver']) || (targets?.value >= 7 && catchRate?.value >= 0.65 && (adot?.value == null || adot.value < 13))) {
      add('possession_receiver', roleHas(roles, ['possession receiver']) ? 'strong' : 'moderate', [roleFact(roles, ['possession receiver']), metricFact('targetsPerGame', targets), metricFact('catchRate', catchRate)]);
    }
  }

  if (position === 'TE') {
    const targets = usage('targetsPerGame', ['targets']);
    const adot = ngs('avgIntendedAirYards', ['averageIntendedAirYards', 'aDot']) ?? usage('avgIntendedAirYards', ['aDot']);
    if (roleHas(roles, ['field stretching te', 'field stretcher', 'vertical tight end']) || adot?.value >= 10.5) {
      add('field_stretching_te', roleHas(roles, ['field stretching te', 'field stretcher', 'vertical tight end']) ? 'strong' : 'moderate', [roleFact(roles, ['field stretching te', 'field stretcher', 'vertical tight end']), metricFact('avgIntendedAirYards', adot)]);
    }
    if (roleHas(roles, ['short intermediate te', 'short area tight end', 'move tight end']) || (adot?.value <= 8.5 && targets?.value >= 4)) {
      add('short_intermediate_te', roleHas(roles, ['short intermediate te', 'short area tight end', 'move tight end']) ? 'strong' : 'moderate', [roleFact(roles, ['short intermediate te', 'short area tight end', 'move tight end']), metricFact('avgIntendedAirYards', adot), metricFact('targetsPerGame', targets)]);
    }
  }

  if (!candidates.length) return styleNotConfident(position, 'Explicit role, usage, and NGS evidence did not support a player style.');
  const priorities = PLAYER_STYLES_BY_POSITION[position];
  candidates.sort((left, right) => QUALITY_RANK[right.confidence] - QUALITY_RANK[left.confidence] || priorities.indexOf(left.style) - priorities.indexOf(right.style));
  const selected = candidates[0];
  return styleResult(position, selected.style, roleFor(player, selected.style), selected.confidence, selected.facts);
}

/** Build the team historical reference without attributing it to an unverified staff period. */
export function buildDefensiveHistoricalPrior({
  season = 2026,
  position,
  defense = {},
  positionContext = null,
  historicalPlayerGames = [],
  historicalDefenseRows = [],
  coordinatorPrior = null,
  personnelTurnover = null
} = {}) {
  validateOptionalRows(historicalPlayerGames, 'historicalPlayerGames');
  validateOptionalRows(historicalDefenseRows, 'historicalDefenseRows');
  const normalizedPosition = normalizePosition(position);
  const normalizedDefense = normalizeDefense(defense);
  const team = normalizedDefense.team;
  const candidates = [
    defenseRowsCandidate(historicalDefenseRows, { team, position: normalizedPosition, season }),
    playerGamesDefenseCandidate(historicalPlayerGames, { team, position: normalizedPosition, season }),
    positionContextCandidate(positionContext, { team, position: normalizedPosition, season })
  ].filter(Boolean);
  candidates.sort((left, right) => QUALITY_RANK[right.sampleQuality] - QUALITY_RANK[left.sampleQuality] || right.sampleSize - left.sampleSize || left.priority - right.priority);
  const selected = candidates[0] || null;
  const turnover = turnoverUncertainty(personnelTurnover);
  // Without verified same-team staff continuity these results remain a team
  // reference, but are lower-confidence evidence for the current scheme.
  const uncertaintySteps = (coordinatorPrior?.continuity?.currentTeamVerified === true ? 0 : 1) + (turnover.material ? 1 : 0);
  if (!selected || selected.sampleQuality === 'insufficient') {
    return {
      label: 'Team historical reference',
      status: 'insufficient',
      assessment: 'insufficient_evidence',
      score: 0,
      sampleSize: selected?.sampleSize ?? 0,
      sampleQuality: 'insufficient',
      confidence: 'insufficient',
      source: selected?.source ?? null,
      sourceSeason: selected?.sourceSeason ?? null,
      defenseTendency: selected?.defenseTendency ?? tendencyForPosition(normalizedDefense.tendency, normalizedPosition),
      attributedToCurrentCoordinator: false,
      referenceOnly: true,
      correlatedInputsCollapsed: true,
      summary: `Team historical reference is insufficient (${selected?.sampleSize ?? 0} qualifying ${sampleWord(selected?.sampleUnit)}).`,
      issues: [{ code: 'insufficient_historical_defense_sample', sampleSize: selected?.sampleSize ?? 0 }],
      safeguards: readOnlySafeguards(),
      projectionsAdjusted: false
    };
  }
  const assessment = effectAssessment(selected.score);
  const confidence = lowerQuality(selected.sampleQuality, uncertaintySteps);
  return {
    label: 'Team historical reference',
    status: 'available',
    assessment,
    score: selected.score,
    sampleSize: selected.sampleSize,
    sampleQuality: selected.sampleQuality,
    confidence,
    source: selected.source,
    sourceSeason: selected.sourceSeason,
    sampleUnit: selected.sampleUnit,
    defenseTendency: selected.defenseTendency ?? tendencyForPosition(normalizedDefense.tendency, normalizedPosition),
    metric: selected.metric,
    attributedToCurrentCoordinator: coordinatorPrior?.continuity?.currentTeamVerified === true,
    referenceOnly: coordinatorPrior?.continuity?.currentTeamVerified !== true,
    correlatedInputsCollapsed: true,
    candidateSources: candidates.map((candidate) => ({ source: candidate.source, sampleSize: candidate.sampleSize, sampleQuality: candidate.sampleQuality, selected: candidate === selected })),
    summary: `Team historical reference is ${displayAssessment(assessment)} across ${selected.sampleSize} ${sampleWord(selected.sampleUnit)}.`,
    uncertainty: { coordinatorChange: Boolean(coordinatorPrior?.changeDetected), personnelTurnover: turnover.level, confidenceReduced: confidence !== selected.sampleQuality },
    safeguards: readOnlySafeguards(),
    projectionsAdjusted: false
  };
}

/** Use only verified periods matching the current defensive coordinator identity. */
export function buildDefensiveCoordinatorHistoricalPrior({
  season = 2026,
  defense = {},
  coachingContext = null,
  analysisPeriod = null,
  defensiveCoordinator = null,
  defensiveCoordinatorPeriods = []
} = {}) {
  validateOptionalRows(defensiveCoordinatorPeriods, 'defensiveCoordinatorPeriods');
  const normalizedDefense = normalizeDefense(defense);
  const current = normalizeCurrentCoordinator(defensiveCoordinator, coachingContext);
  const periodBoundary = analysisPeriod ?? normalizedDefense.analysisPeriod ?? null;
  if (!current.verified) return unavailableCoordinator('current_coordinator_not_verified', current, 0, false);

  const verified = defensiveCoordinatorPeriods.filter(isVerifiedCoordinatorPeriod).filter((period) => isHistoricalRecord(period, season));
  const teamPeriods = verified.filter((period) => !normalizedDefense.team || normalizeTeam(periodTeam(period)) === normalizedDefense.team);
  const matching = verified.filter((period) => sameCoordinator(current, period));
  const usable = matching.map((period) => ({ period, score: scoreFromRecord(period), sampleSize: recordSampleSize(period) }))
    .filter((item) => item.score != null && item.sampleSize > 0);
  const sampleSize = usable.reduce((sum, item) => sum + item.sampleSize, 0);
  const quality = historicalOpponentSampleQuality(sampleSize);
  const changed = explicitDefensiveChange(coachingContext, periodBoundary)
    || (teamPeriods.length > 0 && teamPeriods.every((period) => !sameCoordinator(current, period)));
  if (!usable.length || quality === 'insufficient') {
    return unavailableCoordinator(changed ? 'coordinator_change_no_attributable_sample' : 'insufficient_verified_coordinator_sample', current, sampleSize, changed, verified.length - matching.length);
  }

  const score = round(weightedMean(usable.map((item) => ({ value: item.score, weight: item.sampleSize }))), 4);
  const currentTeamMatches = usable.filter((item) => normalizeTeam(periodTeam(item.period)) === normalizedDefense.team);
  const currentTeamVerified = currentTeamMatches.some((item) => continuityIsVerified(item.period, current));
  const continuity = {
    verified: usable.some((item) => continuityIsVerified(item.period, current)),
    currentTeamVerified,
    basis: currentTeamVerified ? 'verified_current_team_continuity' : 'verified_coordinator_identity_only'
  };
  const confidence = lowerQuality(quality, continuity.currentTeamVerified ? 0 : 1);
  const assessment = effectAssessment(score);
  return {
    label: 'Defensive coordinator historical prior',
    status: 'available',
    verified: true,
    historical: true,
    currentCoordinator: { id: current.id, name: current.name, tenureId: current.tenureId },
    assessment,
    score,
    sampleSize,
    sampleQuality: quality,
    confidence,
    periodsUsed: usable.map((item) => publicCoordinatorPeriod(item.period, item.sampleSize)),
    excludedPeriods: verified.length - matching.length,
    changeDetected: changed,
    continuity,
    causalityClaimed: false,
    summary: `Defensive coordinator historical prior is ${displayAssessment(assessment)} across ${sampleSize} verified-period player-games; it describes results during those periods, not personal causation.`,
    safeguards: readOnlySafeguards(),
    projectionsAdjusted: false
  };
}

/** Select the first meaningful cohort in the required deterministic order. */
export function buildPlayerStyleMatchupPrior({
  season = 2026,
  player = {},
  playerStyle = null,
  defenseTendency = null,
  historicalMatchupRows,
  historicalPlayerGames
} = {}) {
  validateOptionalRows(historicalMatchupRows, 'historicalMatchupRows');
  validateOptionalRows(historicalPlayerGames, 'historicalPlayerGames');
  const normalizedPlayer = normalizePlayer(player);
  const style = playerStyle ?? classifyPlayerStyle(player);
  if (style.status === 'style_not_confident') return insufficientStyleMatchup(style, []);
  const sourceRows = Array.isArray(historicalMatchupRows) && historicalMatchupRows.length
    ? historicalMatchupRows
    : historicalPlayerGames ?? [];
  const normalizedRows = sourceRows.map((row) => normalizeMatchupRow(row, season)).filter(Boolean);
  const target = {
    position: normalizedPlayer.position,
    style: style.style,
    role: style.role,
    defenseTendency: normalizeToken(defenseTendency)
  };
  const attempts = [];
  let selected = null;
  for (const level of HISTORICAL_OPPONENT_COHORT_ORDER) {
    const missing = level.fields.filter((field) => !target[field]);
    if (missing.length) {
      attempts.push({ level: level.key, eligible: false, sampleSize: 0, sampleQuality: 'insufficient', reason: `target_${missing.join('_and_')}_unavailable` });
      continue;
    }
    const rows = normalizedRows.filter((row) => level.fields.every((field) => row[field] === target[field]));
    const usableRows = rows.filter((row) => rowHasOutcome(row));
    const sampleSize = usableRows.reduce((sum, row) => sum + row.sampleSize, 0);
    const quality = historicalOpponentSampleQuality(sampleSize);
    const evaluated = { level, rows: usableRows, sampleSize, sampleQuality: quality };
    attempts.push({ level: level.key, eligible: true, sampleSize, sampleQuality: quality, reason: quality === 'insufficient' ? 'below_minimum_sample' : null });
    selected = evaluated;
    if (quality !== 'insufficient') break;
  }
  if (!selected || selected.sampleQuality === 'insufficient') return insufficientStyleMatchup(style, attempts, selected?.sampleSize ?? 0);

  const score = cohortScore(selected.rows, normalizedRows, selected.level, target);
  const assessment = effectAssessment(score);
  const players = new Set(selected.rows.map((row) => row.playerId).filter(Boolean));
  return {
    label: 'Player-style matchup prior',
    status: 'available',
    assessment,
    score,
    style: style.style,
    styleLabel: style.label,
    role: style.role,
    defenseTendency: target.defenseTendency,
    cohort: {
      selectedLevel: selected.level.key,
      criteria: Object.fromEntries(selected.level.fields.map((field) => [field, target[field]])),
      broadened: selected.level.key !== HISTORICAL_OPPONENT_COHORT_ORDER[0].key,
      attempts
    },
    sampleSize: selected.sampleSize,
    sampleQuality: selected.sampleQuality,
    confidence: selected.sampleQuality,
    sample: { comparablePlayerGames: selected.sampleSize, uniquePlayers: players.size || null },
    summary: `${style.label} historical matchup prior is ${displayAssessment(assessment)} in the ${selected.level.key} cohort (${selected.sampleSize} comparable player-games).`,
    safeguards: readOnlySafeguards(),
    projectionsAdjusted: false
  };
}

export const selectHistoricalStyleCohort = buildPlayerStyleMatchupPrior;

/** Collapse team, coordinator, style, and usable current context to one signal. */
export function collapseHistoricalMatchupEvidence({
  player = {},
  historicalDefensePrior = null,
  coordinatorPrior = null,
  styleMatchupPrior = null,
  currentSeasonDefense = null,
  personnelTurnover = null
} = {}) {
  const normalizedPlayer = normalizePlayer(player);
  const signals = [
    signalFromPrior('team_historical_reference', historicalDefensePrior),
    signalFromPrior('defensive_coordinator_historical_prior', coordinatorPrior),
    signalFromPrior('player_style_matchup_prior', styleMatchupPrior),
    signalFromCurrent(currentSeasonDefense)
  ].filter(Boolean);
  const directional = signals.filter((signal) => signal.score !== 0);
  const conflict = directional.some((signal) => signal.score > 0) && directional.some((signal) => signal.score < 0);
  const turnover = turnoverUncertainty(personnelTurnover);
  if (!signals.length) {
    return {
      group: 'matchup', status: 'insufficient', assessment: 'insufficient_evidence', outlook: 'insufficient_evidence',
      score: 0, strength: 'weak', confidence: 'insufficient', summary: positionExplanation(normalizedPlayer, 'insufficient_evidence', styleMatchupPrior),
      facts: [], countedAsOneGroup: true, correlatedInputsCollapsed: true, appliedSignalCount: 0,
      safeguards: readOnlySafeguards(), projectionsAdjusted: false
    };
  }
  const baseQuality = bestQuality(signals.map((signal) => signal.confidence));
  const score = round(weightedMean(signals.map((signal) => ({ value: signal.score, weight: qualityWeight(signal.confidence) }))), 4);
  const outlook = conflict ? 'mixed' : effectAssessment(score);
  const confidence = lowerQuality(baseQuality, (conflict ? 1 : 0) + (turnover.material ? 1 : 0));
  return {
    group: 'matchup',
    status: conflict ? 'mixed' : 'available',
    assessment: outlook,
    outlook,
    score: conflict ? round(score / 2, 4) : score,
    strength: conflict ? 'weak' : effectStrength(score, confidence),
    confidence,
    summary: positionExplanation(normalizedPlayer, outlook, styleMatchupPrior, historicalDefensePrior),
    facts: signals.map((signal) => ({ type: signal.type, assessment: signal.assessment, score: signal.score, confidence: signal.confidence, sampleSize: signal.sampleSize, summary: signal.summary })),
    countedAsOneGroup: true,
    correlatedInputsCollapsed: true,
    appliedSignalCount: 1,
    sourceSignalCount: signals.length,
    conflict: conflict ? { preserved: true, directions: [...new Set(directional.map((signal) => Math.sign(signal.score) > 0 ? 'favorable' : 'difficult'))] } : { preserved: false, directions: [] },
    safeguards: readOnlySafeguards(),
    projectionsAdjusted: false
  };
}

/**
 * Turn two per-player priors into the existing comparison-level Matchup seam.
 * All correlated details are nested in `facts`; this returns one group only.
 */
export function buildHistoricalMatchupComparisonEvidence({
  recommendedPrior,
  alternativePrior,
  currentMatchupEvidence = null
} = {}) {
  const recommended = priorView(recommendedPrior);
  const alternative = priorView(alternativePrior);
  const historicalAvailable = recommended.available || alternative.available;
  const historicalDelta = (recommended.available ? recommended.score : 0) - (alternative.available ? alternative.score : 0);
  const current = comparisonSignal(currentMatchupEvidence);
  const directions = [historicalAvailable && Math.abs(historicalDelta) >= 0.03 ? Math.sign(historicalDelta) : 0, current?.sign ?? 0].filter(Boolean);
  const conflict = directions.includes(1) && directions.includes(-1)
    || recommended.mixed
    || alternative.mixed;
  const combined = current && historicalAvailable
    ? weightedMean([{ value: historicalDelta, weight: qualityWeight(recommended.confidence) + qualityWeight(alternative.confidence) }, { value: current.score, weight: qualityWeight(current.confidence) }])
    : current?.score ?? historicalDelta;
  const assessment = !historicalAvailable && !current
    ? 'insufficient'
    : conflict
      ? 'mixed'
      : combined >= 0.05
        ? 'supports_recommended'
        : combined <= -0.05
          ? 'supports_alternative'
          : 'neutral';
  const confidence = lowerQuality(bestQuality([
    recommended.available ? recommended.confidence : 'insufficient',
    alternative.available ? alternative.confidence : 'insufficient',
    current?.confidence ?? 'insufficient'
  ]), conflict ? 1 : 0);
  const strength = assessment === 'mixed' || assessment === 'insufficient' ? 'weak' : effectStrength(combined, confidence);
  return {
    group: 'matchup',
    assessment,
    strength,
    confidence,
    summary: comparisonSummary(assessment, recommendedPrior, alternativePrior),
    facts: [
      historicalAvailable ? {
        metric: 'historicalOpponentPrior',
        label: 'Historical opponent + player-style prior',
        recommended: priorFact(recommendedPrior),
        alternative: priorFact(alternativePrior),
        delta: round(historicalDelta, 4),
        historical: true
      } : null,
      current ? {
        metric: 'currentMatchupContext',
        label: 'Current-season matchup context',
        assessment: currentMatchupEvidence.assessment,
        historical: false
      } : null
    ].filter(Boolean),
    countedAsOneGroup: true,
    correlatedInputsCollapsed: true,
    sourceSignalCount: Number(historicalAvailable) + Number(Boolean(current)),
    projectionsAdjusted: false,
    safeguards: readOnlySafeguards()
  };
}

function normalizeCurrentSeasonDefense(value, { season, defense }) {
  const completedGames = nonNegativeInteger(value?.completedGames ?? value?.sample?.includedGames ?? value?.sampleSize)
    ?? (Array.isArray(value?.games) ? value.games.length : 0);
  const suppliedSeason = positiveIntegerOrNull(value?.season);
  const isCurrent = suppliedSeason == null || suppliedSeason === Number(season);
  const learning = !value || !isCurrent || completedGames === 0 || value.learning === true || normalizeToken(value.status) === 'learning';
  if (learning) return {
    label: `${season} defense sample: Learning`, season: Number(season), defense, status: 'learning', learning: true,
    available: false, completedGames: 0, assessment: 'insufficient_evidence', score: 0, historical: false,
    usedInHistoricalPrior: false, summary: `${season} defense sample: Learning`, safeguards: readOnlySafeguards(), projectionsAdjusted: false
  };
  const score = scoreFromRecord(value) ?? 0;
  return {
    label: `${season} defense sample`, season: Number(season), defense, status: 'available', learning: false,
    available: true, completedGames, assessment: effectAssessment(score), score, historical: false,
    confidence: normalizeQuality(value?.confidence) ?? historicalOpponentSampleQuality(completedGames),
    usedInHistoricalPrior: false, summary: firstText(value.summary, value.assessment?.explanation, `${season} current defensive context.`),
    safeguards: readOnlySafeguards(), projectionsAdjusted: false
  };
}

function defenseRowsCandidate(rows, context) {
  const eligible = rows.filter((row) => rowMatchesDefense(row, context) && isHistoricalRecord(row, context.season));
  if (!eligible.length) return null;
  const scored = eligible.map((row) => ({ score: scoreFromRecord(row), sampleSize: recordSampleSize(row) })).filter((row) => row.score != null && row.sampleSize > 0);
  if (!scored.length) return null;
  const sampleSize = scored.reduce((sum, row) => sum + row.sampleSize, 0);
  return {
    priority: 0, source: 'normalized historical defense evidence', sourceSeason: seasonRange(eligible), sampleSize,
    sampleQuality: historicalOpponentSampleQuality(sampleSize), sampleUnit: 'player-games', score: round(weightedMean(scored.map((row) => ({ value: row.score, weight: row.sampleSize }))), 4),
    metric: 'one normalized defensive response per observation', defenseTendency: mode(eligible.map((row) => normalizeToken(row.defenseTendency ?? row.tendency)).filter(Boolean))
  };
}

function playerGamesDefenseCandidate(rows, context) {
  const allPosition = rows.map((row) => normalizeGameRow(row, context.season)).filter((row) => row?.position === context.position);
  const target = allPosition.filter((row) => row.defense === context.team);
  if (!target.length) return null;
  const outcome = commonOutcome(target, allPosition);
  if (!outcome) return null;
  const sampleSize = target.reduce((sum, row) => sum + row.sampleSize, 0);
  return {
    priority: 1, source: 'normalized historical player-games', sourceSeason: seasonRange(target), sampleSize,
    sampleQuality: historicalOpponentSampleQuality(sampleSize), sampleUnit: 'player-games', score: outcome.score,
    metric: outcome.metric, defenseTendency: mode(target.map((row) => row.defenseTendency).filter(Boolean))
  };
}

function positionContextCandidate(value, { team, position, season }) {
  if (!value || typeof value !== 'object') return null;
  const sourceSeason = positiveIntegerOrNull(value.season);
  const historical = value.historical === true || sourceSeason != null && sourceSeason < Number(season) || /historical|prior[- ]season/i.test(String(value.basis ?? value.window?.basis ?? ''));
  if (!historical || (normalizePosition(value.position) && normalizePosition(value.position) !== position)) return null;
  const contextTeam = normalizeTeam(value.defense?.abbreviation ?? value.defense ?? value.team);
  if (team && contextTeam && team !== contextTeam) return null;
  const metric = value.metrics?.opportunity ?? value.metrics?.fantasyPoints ?? null;
  const index = finiteNumber(metric?.index);
  const score = index != null ? clamp((index - 100) / 100, -1, 1) : scoreFromRecord(value);
  if (score == null) return null;
  const sampleSize = nonNegativeInteger(value.sample?.includedGames ?? metric?.sampleGames ?? value.sampleSize) ?? 0;
  return {
    priority: 2, source: 'normalized opponent-position context', sourceSeason, sampleSize,
    sampleQuality: historicalOpponentSampleQuality(sampleSize), sampleUnit: 'defense games', score: round(score, 4),
    metric: firstText(metric?.label, 'position opportunity response'), defenseTendency: normalizeToken(value.defenseTendency ?? value.tendency)
  };
}

function normalizeMatchupRow(row, season) {
  if (!row || typeof row !== 'object' || !isHistoricalRecord(row, season)) return null;
  const position = normalizePosition(row.position ?? row.player?.position);
  if (!position) return null;
  const explicitStyle = normalizeStyle(row.style ?? row.playerStyle?.style ?? row.archetype, position);
  const classified = explicitStyle
    ? { style: explicitStyle, role: normalizeToken(row.role ?? row.positionRole ?? roleFor(row, explicitStyle)) }
    : classifyPlayerStyle({ ...row, position, analysisUsage: row.analysisUsage ?? row.usage ?? { gameLogs: row.stats ? [normalizeHistoricalStats(row.stats)] : [] } });
  return {
    raw: row,
    playerId: firstText(row.playerId, row.player_id),
    position,
    style: classified.style === 'style_not_confident' ? null : classified.style,
    role: normalizeToken(row.role ?? row.positionRole ?? classified.role),
    defenseTendency: normalizeToken(row.defenseTendency ?? row.defensiveTendency ?? row.defense?.tendency),
    sampleSize: recordSampleSize(row),
    score: scoreFromRecord(row),
    fantasyPoints: firstFinite(row.fantasyPoints, row.fantasy_points, row.stats?.fantasyPoints, row.stats?.pts_ppr, row.stats?.pts_half_ppr, row.stats?.pts_std),
    opportunity: numericOpportunity(row.opportunity) ?? opportunityFromStats(position, row.stats)
  };
}

function cohortScore(rows, allRows, level, target) {
  const scored = rows.filter((row) => row.score != null);
  if (scored.length) return round(weightedMean(scored.map((row) => ({ value: row.score, weight: row.sampleSize }))), 4);
  const field = rows.some((row) => row.fantasyPoints != null) ? 'fantasyPoints' : 'opportunity';
  const selected = weightedFieldMean(rows, field);
  if (selected == null) return 0;
  const baselineRows = allRows.filter((row) => row.position === target.position
    && (level.key === 'exact_style+tendency' ? row.style === target.style
      : level.key === 'role+tendency' ? row.role === target.role
        : true));
  const baseline = weightedFieldMean(baselineRows, field);
  return baseline > 0 ? round(clamp(selected / baseline - 1, -1, 1), 4) : 0;
}

function commonOutcome(targetRows, baselineRows) {
  const scored = targetRows.filter((row) => row.score != null);
  if (scored.length) return { score: round(weightedMean(scored.map((row) => ({ value: row.score, weight: row.sampleSize }))), 4), metric: 'normalized outcome versus expectation' };
  const field = targetRows.some((row) => row.fantasyPoints != null) && baselineRows.some((row) => row.fantasyPoints != null) ? 'fantasyPoints' : 'opportunity';
  const target = weightedFieldMean(targetRows, field);
  const baseline = weightedFieldMean(baselineRows, field);
  if (target == null || !(baseline > 0)) return null;
  return { score: round(clamp(target / baseline - 1, -1, 1), 4), metric: field === 'fantasyPoints' ? 'fantasy points versus position baseline' : 'opportunity versus position baseline' };
}

function normalizeGameRow(row, season) {
  if (!row || typeof row !== 'object' || !isHistoricalRecord(row, season)) return null;
  const position = normalizePosition(row.position ?? row.player?.position);
  const defense = normalizeTeam(row.defense?.abbreviation ?? row.defense ?? row.opponent);
  if (!position || !defense) return null;
  return {
    ...normalizeMatchupRow(row, season),
    defense,
    season: positiveIntegerOrNull(row.season),
    defenseTendency: normalizeToken(row.defenseTendency ?? row.defensiveTendency ?? row.defense?.tendency)
  };
}

function scoreFromRecord(value) {
  if (!value || typeof value !== 'object') return null;
  const direct = firstFinite(
    value.score,
    value.matchupScore,
    value.relativeOutcome,
    value.relativePerformance,
    value.outcomeDelta,
    value.outcome?.relative,
    value.metrics?.composite?.relative
  );
  if (direct != null) return round(normalizeRelativeValue(direct), 4);
  const index = firstFinite(value.index, value.performanceIndex, value.opportunityIndex, value.metrics?.opportunity?.index, value.metrics?.fantasyPoints?.index);
  if (index != null) return round(clamp(index > 2 ? (index - 100) / 100 : index - 1, -1, 1), 4);
  const actual = firstFinite(value.fantasyPoints, value.outcome?.fantasyPoints);
  const expected = firstFinite(value.expectedFantasyPoints, value.baselineFantasyPoints, value.outcome?.expectedFantasyPoints);
  if (actual != null && expected > 0) return round(clamp(actual / expected - 1, -1, 1), 4);
  const opportunity = numericOpportunity(value.opportunity);
  const expectedOpportunity = numericOpportunity(value.expectedOpportunity ?? value.baselineOpportunity);
  if (opportunity != null && expectedOpportunity > 0) return round(clamp(opportunity / expectedOpportunity - 1, -1, 1), 4);
  const assessment = normalizeAssessment(value.assessment?.label ?? value.assessment ?? value.direction ?? value.outlook);
  return scoreForAssessment(assessment);
}

function scoreForAssessment(value) {
  const assessment = normalizeAssessment(value);
  if (assessment === 'favorable') return 0.2;
  if (assessment === 'mildly_favorable') return 0.1;
  if (assessment === 'mildly_difficult') return -0.1;
  if (assessment === 'difficult') return -0.2;
  if (assessment === 'supports_recommended' || assessment === 'higher_than_league') return 0.15;
  if (assessment === 'supports_alternative' || assessment === 'lower_than_league') return -0.15;
  if (assessment === 'neutral' || assessment === 'near_league') return 0;
  return null;
}

function effectAssessment(value) {
  const score = finiteNumber(value) ?? 0;
  if (score >= HISTORICAL_OPPONENT_EFFECT_THRESHOLDS.favorable) return 'favorable';
  if (score >= HISTORICAL_OPPONENT_EFFECT_THRESHOLDS.mildlyFavorable) return 'mildly_favorable';
  if (score <= HISTORICAL_OPPONENT_EFFECT_THRESHOLDS.difficult) return 'difficult';
  if (score <= HISTORICAL_OPPONENT_EFFECT_THRESHOLDS.mildlyDifficult) return 'mildly_difficult';
  return 'neutral';
}

function effectStrength(score, confidence) {
  const magnitude = Math.abs(finiteNumber(score) ?? 0);
  let strength = magnitude >= 0.18 ? 'strong' : magnitude >= 0.08 ? 'moderate' : 'weak';
  if (QUALITY_RANK[strength] > QUALITY_RANK[confidence]) strength = normalizeQuality(confidence) ?? 'weak';
  return strength === 'insufficient' ? 'weak' : strength;
}

function normalizeCurrentCoordinator(explicit, coachingContext) {
  const role = explicit ?? coachingContext?.roles?.defensiveCoordinator ?? coachingContext?.defensiveCoordinator ?? null;
  const period = role?.period ?? role?.analysisPeriod ?? null;
  const verified = role?.verified === true || role?.status === 'verified';
  return {
    verified: Boolean(verified && (period || role?.coordinatorId || role?.id || role?.name)),
    id: firstText(role?.coordinatorId, role?.coachId, role?.id, period?.coachId),
    name: firstText(role?.name, role?.coachName, period?.coachName),
    tenureId: firstText(role?.tenureId, period?.tenureId),
    period
  };
}

function sameCoordinator(current, period) {
  const periodId = firstText(period.coordinatorId, period.coachId, period.id);
  const periodName = firstText(period.coordinatorName, period.coachName, period.name);
  if (current.id && periodId) return current.id === periodId;
  return Boolean(current.name && periodName && normalizePerson(current.name) === normalizePerson(periodName));
}

function continuityIsVerified(period, current) {
  return period.continuityVerified === true
    || period.continuesIntoCurrent === true
    || period.continuousThroughCurrent === true
    || Boolean(current.tenureId && firstText(period.tenureId, period.periodId) === current.tenureId);
}

function explicitDefensiveChange(coachingContext, analysisPeriod) {
  const role = coachingContext?.roles?.defensiveCoordinator ?? coachingContext?.defensiveCoordinator;
  return role?.changed === true
    || role?.changeDetected === true
    || coachingContext?.defensiveCoordinatorChangeDetected === true
    || analysisPeriod?.changeDetected === true
    || Number(analysisPeriod?.startWeek) > 1;
}

function unavailableCoordinator(reason, current, sampleSize, changeDetected, excludedPeriods = 0) {
  return {
    label: 'Defensive coordinator historical prior', status: 'insufficient', verified: current.verified, historical: true,
    currentCoordinator: { id: current.id, name: current.name, tenureId: current.tenureId }, assessment: 'insufficient_evidence', score: 0,
    sampleSize, sampleQuality: historicalOpponentSampleQuality(sampleSize), confidence: 'insufficient', periodsUsed: [], excludedPeriods,
    changeDetected, continuity: { verified: false, currentTeamVerified: false, basis: reason }, causalityClaimed: false,
    summary: reason === 'coordinator_change_no_attributable_sample'
      ? 'The verified defensive coordinator changed, so prior team results are not attributed to the current coordinator.'
      : 'Verified defensive coordinator historical evidence is insufficient.',
    issues: [{ code: reason }], safeguards: readOnlySafeguards(), projectionsAdjusted: false
  };
}

function insufficientStyleMatchup(style, attempts, sampleSize = 0) {
  return {
    label: 'Player-style matchup prior', status: 'insufficient', assessment: 'insufficient_evidence', score: 0,
    style: style.style, styleLabel: style.label, role: style.role, defenseTendency: null,
    cohort: { selectedLevel: null, criteria: null, broadened: attempts.some((attempt) => attempt.eligible), attempts },
    sampleSize, sampleQuality: 'insufficient', confidence: 'insufficient', sample: { comparablePlayerGames: sampleSize, uniquePlayers: null },
    summary: style.status === 'style_not_confident'
      ? 'Player-style matchup evidence is insufficient because the player style is not confident.'
      : `Player-style matchup evidence is insufficient (${sampleSize} comparable player-games).`,
    safeguards: readOnlySafeguards(), projectionsAdjusted: false
  };
}

function styleNotConfident(position, message) {
  return {
    status: 'style_not_confident', style: 'style_not_confident', label: STYLE_LABELS.style_not_confident,
    position, role: null, confidence: 'insufficient', evidence: [], message,
    safeguards: readOnlySafeguards(), projectionsAdjusted: false
  };
}

function styleResult(position, style, role, confidence, evidence) {
  return {
    status: 'available', style, label: STYLE_LABELS[style], position, role,
    confidence, evidence: evidence.filter(Boolean), safeguards: readOnlySafeguards(), projectionsAdjusted: false
  };
}

function roleFor(player, style) {
  const explicit = normalizeToken(firstText(player.role?.category, player.role?.type, player.positionRole, typeof player.role === 'string' ? player.role : null));
  if (explicit) return explicit;
  const roles = {
    rushing_qb: 'mobile_qb', pocket_passer: 'passer', high_air_yard_passer: 'passer', short_intermediate_volume_passer: 'passer',
    early_down_runner: 'early_down_back', pass_catching_back: 'receiving_back', goal_line_back: 'scoring_back', explosive_runner: 'rushing_back', committee_back: 'committee_back',
    deep_threat: 'perimeter_receiver', slot_short_area_target: 'slot_receiver', possession_receiver: 'possession_receiver', yac_oriented_receiver: 'receiver', high_volume_alpha_role: 'primary_receiver',
    field_stretching_te: 'receiving_tight_end', short_intermediate_te: 'receiving_tight_end'
  };
  return roles[style] ?? null;
}

function roleTokens(player) {
  const values = [player.role, player.positionRole, player.roleLabel, player.depthChartRole, player.roleEvidence?.role, player.evidence?.role]
    .flatMap((value) => value && typeof value === 'object' ? [value.name, value.label, value.type, value.category] : [value])
    .map(normalizePhrase).filter(Boolean);
  return [...new Set(values)];
}

function usageMetric(player, keys) {
  const roots = [player, player.evidence, player.roleEvidence, player.usage, player.analysisUsage].filter((root) => root && typeof root === 'object');
  for (const key of keys) {
    for (const root of roots) {
      const direct = metricValue(root[key]);
      if (direct != null) return { value: direct, source: root === player.analysisUsage || root === player.usage ? 'usage' : 'supplied evidence' };
      const summary = root.summary;
      for (const section of ['opportunity', 'production', 'role']) {
        const summarized = metricValue(summary?.[section]?.[key]);
        if (summarized != null) return { value: summarized, source: 'usage summary' };
      }
      const logs = Array.isArray(root.gameLogs) ? root.gameLogs : [];
      const values = logs.map((log) => finiteNumber(log?.[key])).filter((number) => number != null);
      if (values.length) return { value: mean(values), source: 'usage game logs', sampleSize: values.length };
    }
  }
  return null;
}

function ngsMetric(player, keys) {
  const roots = [
    player.ngs, player.nextGen, player.nextGenReference,
    player.nextGen?.current, player.nextGen?.reference,
    player.ngs?.current, player.ngs?.reference,
    player.evidence?.nextGen, player.evidence?.ngs
  ].filter((root) => root && typeof root === 'object');
  for (const key of keys) {
    for (const root of roots) {
      const direct = metricValue(root[key] ?? root.metrics?.[key]);
      if (direct != null) return { value: direct, source: root.label || 'NGS/reference' };
      if (Array.isArray(root.metrics)) {
        for (const metric of root.metrics) {
          const nested = metricValue(metric?.values?.[key] ?? (metric?.key === key ? metric?.value : null));
          if (nested != null) return { value: nested, source: root.label || 'NGS/reference' };
        }
      }
    }
  }
  return null;
}

function metricValue(value) {
  if (value && typeof value === 'object') return firstFinite(value.weightedAverage, value.perGame, value.value, value.average, value.mean);
  return finiteNumber(value);
}

function roleHas(roles, choices) { return roles.some((role) => choices.some((choice) => role.includes(choice))); }
function roleFact(roles, choices) { const value = roles.find((role) => choices.some((choice) => role.includes(choice))); return value ? evidenceFact('role', value, 'Supplied role') : null; }
function metricFact(field, metric) { return metric ? evidenceFact(field, metric.value, metric.source, metric.sampleSize) : null; }
function evidenceFact(field, value, source, sampleSize = null) { return { field, value, source, ...(sampleSize == null ? {} : { sampleSize }) }; }

function positionExplanation(player, outlook, stylePrior, teamPrior) {
  const name = player.name || 'This player';
  if (outlook === 'insufficient_evidence') return `${name}'s matchup prior is neutral because the historical evidence is insufficient.`;
  if (outlook === 'mixed') return `${name} has mixed matchup evidence: the team defensive reference and player-style cohort point in different directions, so confidence is lower.`;
  const style = stylePrior?.styleLabel && stylePrior.style !== 'style_not_confident' ? stylePrior.styleLabel.toLowerCase() : null;
  const assessment = displayAssessment(outlook);
  if (player.position === 'QB') return style === 'rushing qb'
    ? `${name}'s ${style} cohort has a ${assessment} prior for the defense's passing and quarterback-rushing environment.`
    : `${name}'s ${style || 'quarterback'} profile has a ${assessment} prior for the defense's pressure and explosive-passing environment.`;
  if (player.position === 'RB') return style === 'pass-catching back'
    ? `${name}'s ${style} cohort has a ${assessment} prior for receiving-back opportunity; rushing resistance and game script remain separate uncertainties.`
    : `${name}'s ${style || 'running back'} profile has a ${assessment} prior for rushing resistance and red-zone opportunity.`;
  if (player.position === 'TE') return `${name}'s ${style || 'tight end'} profile has a ${assessment} prior for middle-of-field targets and target depth.`;
  if (style === 'deep threat') return `${name}'s deep-threat role has a ${assessment} prior in this explosive-pass environment; the matchup affects downfield upside more than target opportunity.`;
  return `${name}'s ${style || 'receiver'} profile has a ${assessment} prior for target depth, short-area/YAC conditions, and positional response.`;
}

function comparisonSummary(assessment, recommendedPrior, alternativePrior) {
  const recommended = firstText(recommendedPrior?.name, recommendedPrior?.requestedPlayerId, 'the recommended player');
  const alternative = firstText(alternativePrior?.name, alternativePrior?.requestedPlayerId, 'the alternative');
  if (assessment === 'supports_recommended') return `Historical opponent evidence favors ${recommended} over ${alternative}; all defensive inputs count as one Matchup group.`;
  if (assessment === 'supports_alternative') return `Historical opponent evidence favors ${alternative} over ${recommended}; all defensive inputs count as one Matchup group.`;
  if (assessment === 'mixed') return 'Historical matchup evidence conflicts, so the Matchup group is mixed and confidence is lower.';
  if (assessment === 'neutral') return 'The collapsed historical Matchup group is neutral between these players.';
  return 'Historical matchup evidence is insufficient for this comparison.';
}

function signalFromPrior(type, prior) {
  if (!prior || prior.status !== 'available' || prior.assessment === 'insufficient_evidence') return null;
  const score = finiteNumber(prior.score);
  if (score == null) return null;
  return { type, score, assessment: prior.assessment, confidence: normalizeQuality(prior.confidence ?? prior.sampleQuality) ?? 'weak', sampleSize: nonNegativeInteger(prior.sampleSize), summary: prior.summary };
}

function signalFromCurrent(prior) {
  if (!prior || prior.status !== 'available' || prior.historical === true) return null;
  const score = finiteNumber(prior.score);
  return score == null ? null : { type: 'current_season_defense', score, assessment: prior.assessment, confidence: normalizeQuality(prior.confidence) ?? 'weak', sampleSize: nonNegativeInteger(prior.completedGames), summary: prior.summary };
}

function priorView(prior) {
  const evidence = prior?.matchupEvidence ?? prior;
  const status = normalizeToken(evidence?.status);
  return {
    available: Boolean(evidence && !['insufficient', 'unavailable'].includes(status) && finiteNumber(evidence.score) != null),
    mixed: evidence?.assessment === 'mixed' || evidence?.outlook === 'mixed' || status === 'mixed',
    score: finiteNumber(evidence?.score) ?? 0,
    confidence: normalizeQuality(evidence?.confidence) ?? 'weak'
  };
}

function priorFact(prior) {
  const evidence = prior?.matchupEvidence ?? prior;
  return {
    playerId: prior?.requestedPlayerId ?? prior?.playerId ?? null,
    assessment: evidence?.assessment ?? evidence?.outlook ?? 'insufficient_evidence',
    score: finiteNumber(evidence?.score) ?? 0,
    confidence: evidence?.confidence ?? 'insufficient',
    style: prior?.playerStyle?.style ?? prior?.style ?? null,
    historicalDefensePrior: prior?.historicalDefensePrior ? {
      assessment: prior.historicalDefensePrior.assessment,
      sampleSize: prior.historicalDefensePrior.sampleSize,
      attributedToCurrentCoordinator: prior.historicalDefensePrior.attributedToCurrentCoordinator
    } : null,
    coordinatorPrior: prior?.coordinatorPrior ? {
      status: prior.coordinatorPrior.status,
      assessment: prior.coordinatorPrior.assessment,
      sampleSize: prior.coordinatorPrior.sampleSize
    } : null,
    styleMatchupPrior: prior?.styleMatchupPrior ? {
      assessment: prior.styleMatchupPrior.assessment,
      sampleSize: prior.styleMatchupPrior.sampleSize,
      selectedLevel: prior.styleMatchupPrior.cohort?.selectedLevel
    } : null
  };
}

function comparisonSignal(value) {
  if (!value || ['insufficient', 'unavailable'].includes(normalizeToken(value.status)) || normalizeToken(value.assessment) === 'insufficient') return null;
  const assessment = normalizeAssessment(value.assessment);
  const score = scoreForAssessment(assessment);
  if (score == null) return null;
  return { sign: Math.sign(score), score, confidence: normalizeQuality(value.strength ?? value.confidence) ?? 'weak' };
}

function normalizePlayer(player = {}) {
  return {
    playerId: firstText(player.playerId, player.requestedPlayerId, player.id),
    name: firstText(player.name, player.fullName, player.playerName),
    position: normalizePosition(player.position)
  };
}

function normalizeDefense(value = {}, player = {}) {
  const object = value && typeof value === 'object' ? value : { team: value };
  const team = normalizeTeam(object.team?.abbreviation ?? object.abbreviation ?? object.team ?? object.defense ?? player.opponentTeam ?? player.opponent);
  return {
    team,
    public: { team, name: firstText(object.name, object.team?.name), id: firstText(object.id, object.team?.id) },
    tendency: object.tendency ?? object.defenseTendency ?? object.tendencies,
    positionContext: object.positionContext,
    positionContexts: object.positionContexts,
    coachingContext: object.coachingContext,
    analysisPeriod: object.analysisPeriod,
    defensiveCoordinatorPeriods: object.defensiveCoordinatorPeriods,
    personnelTurnover: object.personnelTurnover
  };
}

function unavailablePlayerPrior(player, defense, currentSeasonDefense, season, week) {
  return {
    model: MODEL, requestedPlayerId: player.playerId, name: player.name, position: null, defense: defense.public,
    season, week, status: 'insufficient', playerStyle: styleNotConfident(null, 'A supported position is required.'),
    historicalDefensePrior: null, coordinatorPrior: null, styleMatchupPrior: null, currentSeasonDefense,
    matchupEvidence: collapseHistoricalMatchupEvidence({ player }), explanation: 'A supported QB, RB, WR, or TE position is required.',
    historicalPriorUsedAsCurrentEvidence: false, decisionUse: 'bounded_matchup_evidence', projectionsAdjusted: false, optimizerAdjusted: false, safeguards: readOnlySafeguards()
  };
}

function rowMatchesDefense(row, { team, position }) {
  const rowTeam = normalizeTeam(row.defense?.abbreviation ?? row.defense ?? row.team?.abbreviation ?? row.team);
  const rowPosition = normalizePosition(row.position);
  return (!team || rowTeam === team) && (!position || !rowPosition || rowPosition === position);
}

function isHistoricalRecord(row, season) {
  const rowSeason = positiveIntegerOrNull(row?.season ?? row?.sourceSeason);
  return row?.historical !== false && (rowSeason == null || rowSeason < Number(season));
}

function isVerifiedCoordinatorPeriod(period) {
  const role = normalizeToken(period?.role);
  return Boolean(period && (period.verified === true || period.status === 'verified') && (!role || ['defensivecoordinator', 'defensive_coordinator'].includes(role)));
}

function publicCoordinatorPeriod(period, sampleSize) {
  return {
    periodId: firstText(period.periodId, period.tenureId),
    coordinatorId: firstText(period.coordinatorId, period.coachId, period.id),
    coordinatorName: firstText(period.coordinatorName, period.coachName, period.name),
    team: normalizeTeam(periodTeam(period)),
    season: positiveIntegerOrNull(period.season),
    sampleSize,
    continuityVerified: continuityIsVerified(period, { tenureId: null })
  };
}

function periodTeam(period) { return period.priorTeam ?? period.team?.abbreviation ?? period.team ?? period.defense; }
function recordSampleSize(value) { return nonNegativeInteger(value?.sampleSize ?? value?.sample_size ?? value?.playerGames ?? value?.sample?.playerGames ?? value?.sample?.includedGames) ?? 1; }
function rowHasOutcome(row) { return row.score != null || row.fantasyPoints != null || row.opportunity != null; }
function weightedFieldMean(rows, field) { return weightedMean(rows.filter((row) => finiteNumber(row[field]) != null).map((row) => ({ value: row[field], weight: row.sampleSize }))); }
function numericOpportunity(value) { if (value && typeof value === 'object') return firstFinite(value.value, value.total, value.primary, value.perGame); return finiteNumber(value); }

function normalizeHistoricalStats(stats = {}) {
  return {
    ...stats,
    carries: firstFinite(stats.carries, stats.rushAttempts, stats.rush_att),
    targets: firstFinite(stats.targets, stats.rec_tgt, stats.tgt),
    passAttempts: firstFinite(stats.passAttempts, stats.pass_att, stats.passing_attempts),
    redZoneCarries: firstFinite(stats.redZoneCarries, stats.red_zone_carries, stats.rush_rz_att),
    redZoneTargets: firstFinite(stats.redZoneTargets, stats.red_zone_targets, stats.rec_rz_tgt, stats.rz_tgt)
  };
}

function opportunityFromStats(position, stats) {
  if (!stats || typeof stats !== 'object') return null;
  const normalized = normalizeHistoricalStats(stats);
  if (position === 'QB') return normalized.passAttempts;
  if (position === 'RB') {
    const values = [normalized.carries, normalized.targets].filter((value) => value != null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  }
  return normalized.targets;
}

function positionContextFor(defense, position) {
  if (defense.positionContext) return defense.positionContext;
  if (!Array.isArray(defense.positionContexts)) return null;
  return defense.positionContexts.find((context) => normalizePosition(context?.position) === position) ?? null;
}

function turnoverUncertainty(value) {
  const level = normalizeToken(value?.level ?? value?.status ?? value);
  const material = value?.major === true || value?.material === true || ['major', 'high', 'substantial', 'significant'].includes(level);
  return { level: level || (material ? 'major' : 'not_supplied'), material };
}

function tendencyForPosition(value, position) {
  if (typeof value === 'string') return normalizeToken(value);
  if (!value || typeof value !== 'object') return null;
  return normalizeToken(value[position] ?? value[position?.toLowerCase()] ?? value.label ?? value.key ?? value.type);
}

function normalizeStyle(value, position) {
  const normalized = normalizeToken(value);
  if (!normalized) return null;
  const aliases = {
    mobile_qb: 'rushing_qb', dual_threat_qb: 'rushing_qb', high_air_yards_passer: 'high_air_yard_passer', short_intermediate_passer: 'short_intermediate_volume_passer',
    receiving_back: 'pass_catching_back', early_down_back: 'early_down_runner', goal_line_runner: 'goal_line_back',
    slot_receiver: 'slot_short_area_target', short_area_target: 'slot_short_area_target', yac_receiver: 'yac_oriented_receiver', alpha_receiver: 'high_volume_alpha_role',
    field_stretching_tight_end: 'field_stretching_te', short_intermediate_tight_end: 'short_intermediate_te'
  };
  const canonical = aliases[normalized] ?? normalized;
  return PLAYER_STYLES_BY_POSITION[position]?.includes(canonical) ? canonical : null;
}

function normalizeAssessment(value) {
  const token = normalizeToken(value);
  const aliases = {
    mildlyfavorable: 'mildly_favorable', favorable_prior: 'favorable', mildly_favorable_prior: 'mildly_favorable',
    difficult_prior: 'difficult', mildlydifficult: 'mildly_difficult', mixed_matchup_evidence: 'mixed',
    insufficient_evidence: 'insufficient', insufficient_sample: 'insufficient', nearleague: 'near_league',
    higherthanleague: 'higher_than_league', lowerthanleague: 'lower_than_league'
  };
  return aliases[token] ?? token;
}

function displayAssessment(value) {
  return ({ favorable: 'favorable', mildly_favorable: 'mildly favorable', neutral: 'neutral', mildly_difficult: 'mildly difficult', difficult: 'difficult', mixed: 'mixed', insufficient_evidence: 'insufficient' })[value] ?? 'neutral';
}

function normalizeRelativeValue(value) {
  const number = Number(value);
  if (Math.abs(number) > 2 && Math.abs(number) <= 200) return clamp(number / 100, -1, 1);
  return clamp(number, -1, 1);
}

function bestQuality(values) {
  return values.map(normalizeQuality).filter(Boolean).sort((left, right) => QUALITY_RANK[right] - QUALITY_RANK[left])[0] ?? 'insufficient';
}
function lowerQuality(value, steps = 1) { const quality = normalizeQuality(value) ?? 'insufficient'; return QUALITY_BY_RANK[Math.max(0, QUALITY_RANK[quality] - steps)]; }
function normalizeQuality(value) { const quality = normalizeToken(value); return quality in QUALITY_RANK ? quality : null; }
function qualityWeight(value) { return ({ insufficient: 0.25, weak: 0.5, moderate: 0.75, strong: 1 })[normalizeQuality(value)] ?? 0.5; }

function weightedMean(items) {
  const usable = items.filter((item) => finiteNumber(item.value) != null && finiteNumber(item.weight) > 0);
  const weight = usable.reduce((sum, item) => sum + Number(item.weight), 0);
  return weight ? usable.reduce((sum, item) => sum + Number(item.value) * Number(item.weight), 0) / weight : null;
}

function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function mode(values) { if (!values.length) return null; const counts = new Map(); for (const value of values) counts.set(value, (counts.get(value) || 0) + 1); return [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0]; }
function seasonRange(rows) { const seasons = rows.map((row) => positiveIntegerOrNull(row.season ?? row.sourceSeason)).filter(Boolean).sort((a, b) => a - b); return seasons.length ? { earliest: seasons[0], latest: seasons.at(-1) } : null; }
function sampleWord(unit) { return unit === 'defense games' ? 'defense games' : 'player-games'; }

function indexedEvidence(collection, player) {
  if (!collection) return null;
  const id = firstText(player?.playerId, player?.requestedPlayerId, player?.id);
  const team = normalizeTeam(player?.opponentTeam ?? player?.opponent ?? player?.defense?.team ?? player?.defense);
  if (Array.isArray(collection)) return collection.find((item) => id && firstText(item?.playerId, item?.requestedPlayerId) === id)
    ?? collection.find((item) => team && normalizeTeam(item?.team?.abbreviation ?? item?.team ?? item?.defense) === team)
    ?? null;
  if (typeof collection === 'object') return collection[id] ?? collection[team] ?? null;
  return null;
}

function validateOptionalRows(value, label) { if (value != null && !Array.isArray(value)) throw new TypeError(`${label} must be an array`); }
function readOnlySafeguards() { return { readOnly: true, transactionsPerformed: false }; }
function normalizePosition(value) { const position = String(value ?? '').trim().toUpperCase(); return SUPPORTED_POSITIONS.has(position) ? position : null; }
function normalizeTeam(value) { const team = String(value ?? '').trim().toUpperCase().replace(/[^A-Z]/g, ''); return (({ JAC: 'JAX', WSH: 'WAS', LA: 'LAR', STL: 'LAR', SD: 'LAC', OAK: 'LV' })[team] ?? team) || null; }
function normalizeToken(value) { return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || null; }
function normalizePhrase(value) { return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() || null; }
function normalizePerson(value) { return String(value ?? '').normalize('NFKD').replace(/[^a-z0-9]/gi, '').toLowerCase(); }
function firstText(...values) { for (const value of values) { const text = String(value ?? '').trim(); if (text) return text; } return null; }
function firstFinite(...values) { for (const value of values) { const number = finiteNumber(value); if (number != null) return number; } return null; }
function finiteNumber(value) { if (value == null || value === '') return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function nonNegativeInteger(value) { const number = Number(value); return Number.isInteger(number) && number >= 0 ? number : null; }
function positiveIntegerOrNull(value) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : null; }
function positiveIntegerOr(value, fallback) { return positiveIntegerOrNull(value) ?? fallback; }
function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }
function round(value, digits = 4) { const factor = 10 ** digits; return Math.round(Number(value) * factor) / factor; }
