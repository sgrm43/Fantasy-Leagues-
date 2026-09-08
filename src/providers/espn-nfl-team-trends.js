import { buildEspnNflScoreboardUrl } from './espn-nfl-scoreboard.js';

export const ESPN_NFL_SUMMARY_ENDPOINT =
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary';

export const DEFAULT_TEAM_TREND_WINDOW = 4;

const MAX_TEAM_TREND_WINDOW = 18;
const PROVIDER_NAME = 'ESPN public NFL game summary';

const AVERAGE_METRICS = Object.freeze({
  pointsPerGame: {
    read: (game) => game.pointsFor,
    unit: 'points/game',
    definition: 'Team points scored, including any defensive or special-teams points.'
  },
  pointsAllowedPerGame: {
    read: (game) => game.pointsAgainst,
    unit: 'points/game',
    definition: 'Opponent points scored.'
  },
  passAttemptsPerGame: {
    read: (game) => game.metrics.passAttempts,
    unit: 'attempts/game',
    definition: 'Official pass attempts; sacks are excluded.'
  },
  rushAttemptsPerGame: {
    read: (game) => game.metrics.rushAttempts,
    unit: 'attempts/game',
    definition: 'Official team rushing attempts; quarterback kneel-downs may be included by the source.'
  },
  offensivePlaysPerGame: {
    read: (game) => game.metrics.offensivePlays,
    unit: 'plays/game',
    definition: 'ESPN total offensive plays.'
  },
  drivesPerGame: {
    read: (game) => game.metrics.drives,
    unit: 'drives/game',
    definition: 'ESPN total drives.'
  },
  possessionSecondsPerGame: {
    read: (game) => game.metrics.possessionSeconds,
    unit: 'seconds/game',
    definition: 'Team time of possession in seconds.'
  },
  firstDownsPerGame: {
    read: (game) => game.metrics.firstDowns,
    unit: 'first downs/game',
    definition: 'Team first downs.'
  },
  totalYardsPerGame: {
    read: (game) => game.metrics.totalYards,
    unit: 'yards/game',
    definition: 'Team total yards.'
  },
  netPassingYardsPerGame: {
    read: (game) => game.metrics.netPassingYards,
    unit: 'yards/game',
    definition: 'Team net passing yards.'
  },
  rushingYardsPerGame: {
    read: (game) => game.metrics.rushingYards,
    unit: 'yards/game',
    definition: 'Team rushing yards.'
  },
  turnoversPerGame: {
    read: (game) => game.metrics.turnovers,
    unit: 'turnovers/game',
    definition: 'Team turnovers.'
  }
});

/** Build the public, read-only ESPN summary URL for one NFL event. */
export function buildEspnNflSummaryUrl(eventId) {
  const id = idOrNull(eventId);
  if (id == null) throw new TypeError('eventId is required');
  const query = new URLSearchParams({ event: id });
  return `${ESPN_NFL_SUMMARY_ENDPOINT}?${query}`;
}

/**
 * Find a team's completed games in one or more ESPN scoreboard payloads.
 * Results are newest-first and de-duplicated by event ID.
 */
export function findCompletedTeamGames(scoreboardPayloads, {
  teamId,
  teamAbbreviation,
  window = DEFAULT_TEAM_TREND_WINDOW
} = {}) {
  const selector = normalizeTeamSelector({ teamId, teamAbbreviation });
  const normalizedWindow = boundedWindow(window);
  const payloads = Array.isArray(scoreboardPayloads) ? scoreboardPayloads : [scoreboardPayloads];
  const found = new Map();

  for (const payload of payloads) {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.events)) continue;
    for (const event of payload.events) {
      const game = normalizeScoreboardTeamGame(event, selector);
      if (game?.completed && game.eventId != null) found.set(game.eventId, game);
    }
  }

  return [...found.values()]
    .sort(compareGamesNewestFirst)
    .slice(0, normalizedWindow);
}

/**
 * Normalize the team portion of one ESPN NFL game summary. Missing source
 * values remain null and are explicitly reported; no coaching or scheme
 * conclusions are inferred from a box score.
 */
export function normalizeNflTeamGameSummary(payload, {
  teamId,
  teamAbbreviation,
  sourceUrl = ESPN_NFL_SUMMARY_ENDPOINT,
  retrievedAt = new Date().toISOString()
} = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('ESPN NFL summary payload must be an object');
  }
  const selector = normalizeTeamSelector({ teamId, teamAbbreviation });
  const normalizedRetrievedAt = toIso(retrievedAt);
  const header = payload.header && typeof payload.header === 'object' ? payload.header : {};
  const competition = Array.isArray(header.competitions) ? header.competitions[0] : null;
  const competitors = Array.isArray(competition?.competitors) ? competition.competitors : [];
  const boxscoreTeams = Array.isArray(payload.boxscore?.teams) ? payload.boxscore.teams : [];
  const headerTeam = competitors.find((competitor) => teamMatches(competitor?.team ?? competitor, selector)) ?? null;
  const boxscoreTeam = boxscoreTeams.find((entry) => teamMatches(entry?.team ?? entry, selector)) ?? null;

  if (headerTeam == null && boxscoreTeam == null) {
    const error = new Error(`Requested NFL team was not found in ESPN event ${idOrNull(header.id ?? competition?.id) ?? 'unknown'}`);
    error.code = 'ESPN_NFL_TEAM_NOT_FOUND';
    throw error;
  }

  const opponentHeader = competitors.find((competitor) => competitor !== headerTeam) ?? null;
  const statMap = indexStatistics(boxscoreTeam?.statistics);
  const passAttempts = passingAttempts(statMap);
  const rushAttempts = numericStatistic(statMap, ['rushingAttempts', 'rushAttempts']);
  const sacksAllowed = firstPartStatistic(statMap, ['sacksYardsLost']);
  const offensivePlays = numericStatistic(statMap, ['totalOffensivePlays', 'offensivePlays']);
  const drives = numericStatistic(statMap, ['totalDrives', 'drives']);
  const possessionSeconds = possessionSecondsStatistic(statMap);
  const redZone = pairedStatistic(statMap, ['redZoneAttempts']);
  const totalAttempts = sumWhenComplete(passAttempts, rushAttempts);
  const dropbacks = sumWhenComplete(passAttempts, sacksAllowed);
  const dropbackPlays = sumWhenComplete(dropbacks, rushAttempts);
  const pointsFor = numberOrNull(headerTeam?.score);
  const pointsAgainst = numberOrNull(opponentHeader?.score);
  const status = normalizeStatus(competition?.status);

  const metrics = {
    passAttempts,
    rushAttempts,
    totalAttempts,
    passAttemptRate: safeRatio(passAttempts, totalAttempts),
    rushAttemptRate: safeRatio(rushAttempts, totalAttempts),
    sacksAllowed,
    dropbacks,
    dropbackRate: safeRatio(dropbacks, dropbackPlays),
    offensivePlays,
    drives,
    playsPerDrive: safeRatio(offensivePlays, drives),
    possessionSeconds,
    possessionSecondsPerOffensivePlay: safeRatio(possessionSeconds, offensivePlays),
    firstDowns: numericStatistic(statMap, ['firstDowns']),
    totalYards: numericStatistic(statMap, ['totalYards']),
    netPassingYards: numericStatistic(statMap, ['netPassingYards', 'passingYards']),
    rushingYards: numericStatistic(statMap, ['rushingYards']),
    yardsPerPlay: numericStatistic(statMap, ['yardsPerPlay']),
    redZoneScores: redZone?.first ?? null,
    redZoneTrips: redZone?.second ?? null,
    turnovers: numericStatistic(statMap, ['turnovers'])
  };

  const missing = [];
  const issues = [];
  const eventId = idOrNull(header.id ?? competition?.id);
  const date = toIso(competition?.date);
  addMissing(missing, issues, eventId == null, 'eventId', 'event_id_unavailable', 'ESPN did not provide an event ID.');
  addMissing(missing, issues, date == null, 'date', 'game_date_unavailable', 'ESPN did not provide a valid game date.');
  addMissing(missing, issues, status.completed == null, 'status.completed', 'game_status_unavailable', 'ESPN did not provide a completion status.');
  addMissing(missing, issues, pointsFor == null, 'pointsFor', 'team_score_unavailable', 'ESPN did not provide the team score.');
  addMissing(missing, issues, pointsAgainst == null, 'pointsAgainst', 'opponent_score_unavailable', 'ESPN did not provide the opponent score.');
  addMissing(missing, issues, boxscoreTeam == null, 'metrics', 'team_boxscore_unavailable', 'ESPN did not provide team box-score statistics.');
  for (const [field, value] of Object.entries(metrics)) {
    addMissing(missing, issues, value == null, `metrics.${field}`, 'team_stat_unavailable', `ESPN did not provide enough data for ${field}.`);
  }
  if (status.completed === false) {
    issues.push({
      code: 'game_not_final',
      field: 'status.completed',
      message: 'The game is not final; its box-score values can still change.'
    });
  }
  addMissing(missing, issues, normalizedRetrievedAt == null, 'source.retrievedAt', 'retrieval_time_unavailable', 'The retrieval time is invalid or unavailable.');
  missing.push('context.headCoach', 'context.offensiveScheme');
  issues.push({
    code: 'context_not_supported_by_source',
    field: 'context',
    message: 'This ESPN game-summary source does not directly establish the head coach or offensive scheme; neither is inferred.'
  });

  return {
    provider: 'espn',
    eventId,
    season: integerOrNull(header.season?.year),
    seasonType: integerOrNull(header.season?.type),
    week: integerOrNull(header.week?.number ?? header.week),
    date,
    status,
    team: normalizeTeam(headerTeam?.team ?? boxscoreTeam?.team),
    opponent: normalizeTeam(opponentHeader?.team),
    homeAway: homeAwayOrNull(headerTeam?.homeAway ?? boxscoreTeam?.homeAway),
    pointsFor,
    pointsAgainst,
    pointDifferential: subtractWhenComplete(pointsFor, pointsAgainst),
    metrics,
    context: {
      headCoach: null,
      offensiveScheme: null
    },
    source: {
      provider: PROVIDER_NAME,
      url: textOrNull(sourceUrl),
      retrievedAt: normalizedRetrievedAt
    },
    missing,
    issues,
    limitations: [
      'Pass-attempt rate uses pass attempts divided by pass attempts plus rush attempts; sacks are excluded.',
      'Dropback rate adds sacks to pass attempts, but it does not identify scrambles or designed quarterback runs.',
      'Points per drive is only a pace/efficiency proxy because team points can include defense and special teams.',
      'A short recent-game window is descriptive, not a causal coaching or scheme model.'
    ]
  };
}

/** Aggregate normalized game summaries into a recent, auditable team trend. */
export function aggregateNflTeamTrends(games, {
  teamId,
  teamAbbreviation,
  window = DEFAULT_TEAM_TREND_WINDOW,
  generatedAt = new Date().toISOString()
} = {}) {
  if (!Array.isArray(games)) throw new TypeError('games must be an array');
  const normalizedWindow = boundedWindow(window);
  const selector = optionalTeamSelector({ teamId, teamAbbreviation });
  const selected = games
    .filter((game) => game && typeof game === 'object' && game.status?.completed !== false)
    .filter((game) => selector == null || teamMatches(game.team, selector))
    .sort(compareGamesNewestFirst)
    .slice(0, normalizedWindow);
  const inferredTeam = selected.find((game) => game.team)?.team ?? null;
  const team = inferredTeam ?? (selector == null ? null : {
    id: selector.teamId,
    abbreviation: selector.teamAbbreviation,
    name: null
  });
  const metrics = {};
  const missing = [];
  const issues = [];

  for (const [name, descriptor] of Object.entries(AVERAGE_METRICS)) {
    metrics[name] = averageMetric(selected, descriptor);
    reportCoverage(name, metrics[name], selected.length, missing, issues);
  }

  metrics.passAttemptRate = pooledMetric(selected, {
    numerator: (game) => game.metrics.passAttempts,
    denominator: (game) => game.metrics.totalAttempts,
    unit: 'share',
    definition: 'Pass attempts / (pass attempts + rush attempts); sacks excluded.'
  });
  metrics.rushAttemptRate = pooledMetric(selected, {
    numerator: (game) => game.metrics.rushAttempts,
    denominator: (game) => game.metrics.totalAttempts,
    unit: 'share',
    definition: 'Rush attempts / (pass attempts + rush attempts).'
  });
  metrics.dropbackRate = pooledMetric(selected, {
    numerator: (game) => game.metrics.dropbacks,
    denominator: (game) => sumWhenComplete(game.metrics.dropbacks, game.metrics.rushAttempts),
    unit: 'share',
    definition: '(Pass attempts + sacks) / (pass attempts + sacks + rush attempts).'
  });
  metrics.playsPerDrive = pooledMetric(selected, {
    numerator: (game) => game.metrics.offensivePlays,
    denominator: (game) => game.metrics.drives,
    unit: 'plays/drive',
    definition: 'Total offensive plays / total drives.'
  });
  metrics.pointsPerDriveProxy = pooledMetric(selected, {
    numerator: (game) => game.pointsFor,
    denominator: (game) => game.metrics.drives,
    unit: 'team points/drive',
    definition: 'All team points / offensive drives; this can include defensive and special-teams scoring.'
  });
  metrics.possessionSecondsPerOffensivePlayProxy = pooledMetric(selected, {
    numerator: (game) => game.metrics.possessionSeconds,
    denominator: (game) => game.metrics.offensivePlays,
    unit: 'possession seconds/play',
    definition: 'Time of possession / offensive plays; this is a pace proxy, not official seconds per snap.'
  });
  metrics.yardsPerPlay = pooledMetric(selected, {
    numerator: (game) => game.metrics.totalYards,
    denominator: (game) => game.metrics.offensivePlays,
    unit: 'yards/play',
    definition: 'Total yards / total offensive plays.'
  });

  for (const name of [
    'passAttemptRate',
    'rushAttemptRate',
    'dropbackRate',
    'playsPerDrive',
    'pointsPerDriveProxy',
    'possessionSecondsPerOffensivePlayProxy',
    'yardsPerPlay'
  ]) {
    reportCoverage(name, metrics[name], selected.length, missing, issues);
  }

  if (selected.length === 0) {
    issues.unshift({
      code: 'no_completed_games',
      field: 'games',
      message: 'No completed games were available for the requested team and window.'
    });
    missing.unshift('games');
  } else if (selected.length < normalizedWindow) {
    issues.unshift({
      code: 'short_window',
      field: 'window.includedGames',
      message: `Only ${selected.length} completed game${selected.length === 1 ? '' : 's'} were available for the requested ${normalizedWindow}-game window.`
    });
  }

  missing.push('context.headCoach', 'context.offensiveScheme');
  issues.push({
    code: 'context_not_supported_by_source',
    field: 'context',
    message: 'Box-score trends do not directly establish coaching intent or scheme, so neither is inferred.'
  });

  const sourceUrls = unique(selected.map((game) => game.source?.url).filter(Boolean));
  const retrievalTimes = selected.map((game) => toIso(game.source?.retrievedAt)).filter(Boolean).sort();
  return {
    provider: 'espn',
    available: selected.length > 0,
    generatedAt: toIso(generatedAt),
    team,
    window: {
      requestedGames: normalizedWindow,
      includedGames: selected.length,
      newestGameAt: selected[0]?.date ?? null,
      oldestGameAt: selected.at(-1)?.date ?? null
    },
    games: selected,
    metrics,
    context: {
      headCoach: null,
      offensiveScheme: null
    },
    source: {
      provider: PROVIDER_NAME,
      urls: sourceUrls,
      newestRetrievedAt: retrievalTimes.at(-1) ?? null,
      oldestRetrievedAt: retrievalTimes[0] ?? null
    },
    missing: unique(missing),
    issues,
    limitations: [
      'Recent box scores describe what happened; they do not prove why it happened or what a coach will call next.',
      'Pass-attempt share excludes sacks. Dropback share includes sacks but cannot separate scrambles from designed runs.',
      'Possession seconds per offensive play is a pace proxy, not official snap-to-snap timing.',
      'Points per drive can be distorted by defensive and special-teams scoring.'
    ]
  };
}

/**
 * Fetch a team's most recent completed games from public ESPN scoreboards and
 * summaries. `beforeWeek` avoids leaking the target week's result into a
 * pre-game decision; `throughWeek` explicitly includes a completed target week.
 */
export async function fetchNflTeamTrends({
  season,
  beforeWeek,
  throughWeek,
  fromWeek = 1,
  observedAfter,
  seasonType = 2,
  teamId,
  teamAbbreviation,
  window = DEFAULT_TEAM_TREND_WINDOW,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = 15_000,
  signal
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be greater than zero');
  const normalizedSeason = positiveInteger(season, 'season');
  const normalizedSeasonType = positiveInteger(seasonType, 'seasonType');
  const selector = normalizeTeamSelector({ teamId, teamAbbreviation });
  const normalizedWindow = boundedWindow(window);
  const finalWeek = resolveFinalWeek({ beforeWeek, throughWeek });
  const normalizedFromWeek = positiveInteger(fromWeek, 'fromWeek');
  if (normalizedFromWeek > finalWeek) throw new RangeError('fromWeek cannot be later than the final included week');
  const normalizedObservedAfter = observedAfter == null ? null : toIso(observedAfter);
  if (observedAfter != null && normalizedObservedAfter == null) throw new TypeError('observedAfter must be a valid date');
  const retrievalTime = resolveNow(now);
  const retrievedAt = toIso(retrievalTime);
  const scoreboardUrls = [];
  const discoveryIssues = [];
  const discovered = new Map();

  for (let week = finalWeek; week >= normalizedFromWeek && discovered.size < normalizedWindow; week -= 1) {
    const sourceUrl = buildEspnNflScoreboardUrl({
      season: normalizedSeason,
      week,
      seasonType: normalizedSeasonType
    });
    scoreboardUrls.push(sourceUrl);
    try {
      const payload = await requestJson(sourceUrl, { fetchImpl, timeoutMs, signal });
      const games = findCompletedTeamGames(payload, { ...selector, window: normalizedWindow });
      for (const game of games) discovered.set(game.eventId, { ...game, scoreboardSourceUrl: sourceUrl });
    } catch (error) {
      if (signal?.aborted) throw error;
      discoveryIssues.push(fetchIssue(error, 'scoreboard', sourceUrl, week));
    }
  }

  const selectedGames = [...discovered.values()]
    .sort(compareGamesNewestFirst)
    .filter((game) => normalizedObservedAfter == null || Date.parse(game.date) >= Date.parse(normalizedObservedAfter))
    .slice(0, normalizedWindow);
  const normalizedGames = [];
  const summaryIssues = [];
  const summaryUrls = [];

  const results = await Promise.all(selectedGames.map(async (game) => {
    const sourceUrl = buildEspnNflSummaryUrl(game.eventId);
    summaryUrls.push(sourceUrl);
    try {
      const payload = await requestJson(sourceUrl, { fetchImpl, timeoutMs, signal });
      return normalizeNflTeamGameSummary(payload, {
        ...selector,
        sourceUrl,
        retrievedAt
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      summaryIssues.push(fetchIssue(error, 'summary', sourceUrl, game.week, game.eventId));
      return null;
    }
  }));
  normalizedGames.push(...results.filter(Boolean));

  const aggregate = aggregateNflTeamTrends(normalizedGames, {
    ...selector,
    window: normalizedWindow,
    generatedAt: retrievedAt
  });
  const fetchIssues = [...discoveryIssues, ...summaryIssues];
  return {
    ...aggregate,
    requested: {
      season: normalizedSeason,
      seasonType: normalizedSeasonType,
      beforeWeek: beforeWeek == null ? null : integerOrNull(beforeWeek),
      throughWeek: throughWeek == null ? null : integerOrNull(throughWeek),
      fromWeek: normalizedFromWeek,
      observedAfter: normalizedObservedAfter,
      finalIncludedWeek: finalWeek,
      teamId: selector.teamId,
      teamAbbreviation: selector.teamAbbreviation,
      games: normalizedWindow
    },
    discovery: {
      completedGamesFound: selectedGames.length,
      summariesLoaded: normalizedGames.length,
      scoreboardUrls,
      summaryUrls,
      retrievedAt
    },
    missing: fetchIssues.length && normalizedGames.length === 0
      ? unique([...aggregate.missing, 'source.summaries'])
      : aggregate.missing,
    issues: [...fetchIssues, ...aggregate.issues]
  };
}

function normalizeScoreboardTeamGame(event, selector) {
  if (!event || typeof event !== 'object') return null;
  const competition = Array.isArray(event.competitions) ? event.competitions[0] : null;
  const competitors = Array.isArray(competition?.competitors) ? competition.competitors : [];
  const selected = competitors.find((competitor) => teamMatches(competitor?.team ?? competitor, selector));
  if (!selected) return null;
  const opponent = competitors.find((competitor) => competitor !== selected) ?? null;
  const status = normalizeStatus(competition?.status ?? event.status);
  return {
    eventId: idOrNull(event.id ?? competition?.id),
    season: integerOrNull(event.season?.year),
    seasonType: integerOrNull(event.season?.type),
    week: integerOrNull(event.week?.number),
    date: toIso(competition?.date ?? event.date),
    completed: status.completed === true || status.state === 'post',
    status,
    team: normalizeTeam(selected.team ?? selected),
    opponent: normalizeTeam(opponent?.team ?? opponent),
    homeAway: homeAwayOrNull(selected.homeAway),
    pointsFor: numberOrNull(selected.score),
    pointsAgainst: numberOrNull(opponent?.score)
  };
}

function normalizeStatus(value) {
  const type = value?.type && typeof value.type === 'object' ? value.type : {};
  return {
    completed: booleanOrNull(type.completed),
    state: textOrNull(type.state),
    name: textOrNull(type.name),
    detail: textOrNull(type.detail ?? type.shortDetail)
  };
}

function normalizeTeam(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    id: idOrNull(value.id),
    abbreviation: upperTextOrNull(value.abbreviation),
    name: textOrNull(value.displayName ?? value.shortDisplayName ?? value.name)
  };
}

function normalizeTeamSelector({ teamId, teamAbbreviation }) {
  const selector = optionalTeamSelector({ teamId, teamAbbreviation });
  if (selector == null) throw new TypeError('teamId or teamAbbreviation is required');
  return selector;
}

function optionalTeamSelector({ teamId, teamAbbreviation }) {
  const normalizedId = idOrNull(teamId);
  const normalizedAbbreviation = upperTextOrNull(teamAbbreviation);
  if (normalizedId == null && normalizedAbbreviation == null) return null;
  return { teamId: normalizedId, teamAbbreviation: normalizedAbbreviation };
}

function teamMatches(team, selector) {
  if (!team || typeof team !== 'object' || selector == null) return false;
  if (selector.teamId != null) return idOrNull(team.id) === selector.teamId;
  return upperTextOrNull(team.abbreviation) === selector.teamAbbreviation;
}

function indexStatistics(value) {
  const map = new Map();
  if (!Array.isArray(value)) return map;
  for (const statistic of value) {
    const name = textOrNull(statistic?.name);
    if (name != null && !map.has(name)) map.set(name, statistic);
  }
  return map;
}

function findStatistic(statMap, names) {
  for (const name of names) {
    if (statMap.has(name)) return statMap.get(name);
  }
  return null;
}

function numericStatistic(statMap, names) {
  const statistic = findStatistic(statMap, names);
  return numberOrNull(statistic?.value) ?? numberOrNull(statistic?.displayValue);
}

function passingAttempts(statMap) {
  const direct = numericStatistic(statMap, ['passingAttempts', 'passAttempts']);
  if (direct != null) return direct;
  const combined = findStatistic(statMap, ['completionAttempts', 'completionsAttempts']);
  return parsePair(combined?.displayValue ?? combined?.value, '/')?.second ?? null;
}

function firstPartStatistic(statMap, names) {
  const statistic = findStatistic(statMap, names);
  const pair = parsePair(statistic?.displayValue ?? statistic?.value, '-');
  return pair?.first ?? numberOrNull(statistic?.value) ?? null;
}

function pairedStatistic(statMap, names) {
  const statistic = findStatistic(statMap, names);
  return parsePair(statistic?.displayValue ?? statistic?.value, '-');
}

function possessionSecondsStatistic(statMap) {
  const statistic = findStatistic(statMap, ['possessionTime', 'timeOfPossession']);
  const numericValue = numberOrNull(statistic?.value);
  if (numericValue != null) return numericValue;
  const text = textOrNull(statistic?.displayValue);
  if (text == null) return null;
  const match = text.match(/^(\d+):(\d{2})$/);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  return seconds < 60 ? minutes * 60 + seconds : null;
}

function parsePair(value, delimiter) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const escaped = delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(value).trim().match(new RegExp(`^([0-9.]+)\\s*${escaped}\\s*([0-9.]+)$`));
  if (!match) return null;
  const first = numberOrNull(match[1]);
  const second = numberOrNull(match[2]);
  return first == null || second == null ? null : { first, second };
}

function averageMetric(games, descriptor) {
  const values = games.map(descriptor.read).filter(isFiniteNumber);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    value: values.length ? round(total / values.length) : null,
    sampleGames: values.length,
    unit: descriptor.unit,
    definition: descriptor.definition
  };
}

function pooledMetric(games, descriptor) {
  let numerator = 0;
  let denominator = 0;
  let sampleGames = 0;
  for (const game of games) {
    const gameNumerator = descriptor.numerator(game);
    const gameDenominator = descriptor.denominator(game);
    if (!isFiniteNumber(gameNumerator) || !isFiniteNumber(gameDenominator) || gameDenominator <= 0) continue;
    numerator += gameNumerator;
    denominator += gameDenominator;
    sampleGames += 1;
  }
  return {
    value: sampleGames && denominator > 0 ? round(numerator / denominator) : null,
    sampleGames,
    unit: descriptor.unit,
    definition: descriptor.definition
  };
}

function reportCoverage(name, metric, totalGames, missing, issues) {
  if (metric.value == null) {
    missing.push(`metrics.${name}`);
    issues.push({
      code: 'trend_metric_unavailable',
      field: `metrics.${name}`,
      message: `No source games contained enough data to calculate ${name}.`
    });
  } else if (metric.sampleGames < totalGames) {
    issues.push({
      code: 'partial_metric_coverage',
      field: `metrics.${name}`,
      message: `${name} uses ${metric.sampleGames} of ${totalGames} included games.`
    });
  }
}

async function requestJson(sourceUrl, { fetchImpl, timeoutMs, signal }) {
  const timeoutSignal = signal || globalThis.AbortSignal?.timeout?.(timeoutMs);
  const response = await fetchImpl(sourceUrl, {
    headers: { Accept: 'application/json' },
    ...(timeoutSignal ? { signal: timeoutSignal } : {})
  });
  if (!response?.ok) {
    const error = new Error(`ESPN NFL endpoint returned HTTP ${response?.status ?? 'unknown'}`);
    error.code = 'ESPN_NFL_HTTP';
    error.status = response?.status ?? null;
    error.sourceUrl = sourceUrl;
    throw error;
  }
  return response.json();
}

function fetchIssue(error, endpoint, sourceUrl, week, eventId = null) {
  return {
    code: error?.code === 'ESPN_NFL_HTTP' ? `${endpoint}_http_error` : `${endpoint}_fetch_failed`,
    field: endpoint === 'summary' ? 'games' : 'discovery',
    message: error?.message || `Unable to load ESPN NFL ${endpoint} data.`,
    endpoint,
    status: integerOrNull(error?.status),
    week: integerOrNull(week),
    eventId: idOrNull(eventId),
    sourceUrl
  };
}

function resolveFinalWeek({ beforeWeek, throughWeek }) {
  if (throughWeek != null) return positiveInteger(throughWeek, 'throughWeek');
  if (beforeWeek != null) {
    const normalized = positiveInteger(beforeWeek, 'beforeWeek') - 1;
    if (normalized < 1) throw new RangeError('beforeWeek must be at least 2 when no prior-season backfill is requested');
    return normalized;
  }
  throw new TypeError('beforeWeek or throughWeek is required');
}

function boundedWindow(value) {
  const normalized = positiveInteger(value, 'window');
  if (normalized > MAX_TEAM_TREND_WINDOW) {
    throw new RangeError(`window must be ${MAX_TEAM_TREND_WINDOW} games or fewer`);
  }
  return normalized;
}

function compareGamesNewestFirst(left, right) {
  const leftTime = toDate(left?.date)?.getTime() ?? -Infinity;
  const rightTime = toDate(right?.date)?.getTime() ?? -Infinity;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return (integerOrNull(right?.week) ?? -Infinity) - (integerOrNull(left?.week) ?? -Infinity);
}

function addMissing(missing, issues, condition, field, code, message) {
  if (!condition) return;
  missing.push(field);
  issues.push({ code, field, message });
}

function safeRatio(numerator, denominator) {
  return isFiniteNumber(numerator) && isFiniteNumber(denominator) && denominator > 0
    ? round(numerator / denominator)
    : null;
}

function sumWhenComplete(left, right) {
  return isFiniteNumber(left) && isFiniteNumber(right) ? left + right : null;
}

function subtractWhenComplete(left, right) {
  return isFiniteNumber(left) && isFiniteNumber(right) ? left - right : null;
}

function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) throw new TypeError(`${label} must be a positive integer`);
  return normalized;
}

function integerOrNull(value) {
  if (value == null || value === '') return null;
  const normalized = Number(value);
  return Number.isInteger(normalized) ? normalized : null;
}

function numberOrNull(value) {
  if (value == null || value === '' || value === '-') return null;
  const normalized = Number(typeof value === 'string' ? value.replaceAll(',', '').trim() : value);
  return Number.isFinite(normalized) ? normalized : null;
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function upperTextOrNull(value) {
  return textOrNull(value)?.toUpperCase() ?? null;
}

function idOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return textOrNull(value);
}

function homeAwayOrNull(value) {
  return value === 'home' || value === 'away' ? value : null;
}

function toDate(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(value) {
  return toDate(value)?.toISOString() ?? null;
}

function resolveNow(now) {
  return typeof now === 'function' ? now() : now;
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function unique(values) {
  return [...new Set(values)];
}

export const fetchEspnNflTeamTrends = fetchNflTeamTrends;
export const normalizeEspnNflTeamGameSummary = normalizeNflTeamGameSummary;
