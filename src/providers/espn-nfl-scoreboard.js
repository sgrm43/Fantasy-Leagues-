export const ESPN_NFL_SCOREBOARD_ENDPOINT =
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

export const DEFAULT_CONTEXT_STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * Build the public ESPN NFL scoreboard request used by the context provider.
 */
export function buildEspnNflScoreboardUrl({ season, week, seasonType = 2 } = {}) {
  const normalizedSeason = positiveInteger(season, 'season');
  const normalizedWeek = positiveInteger(week, 'week');
  const normalizedSeasonType = positiveInteger(seasonType, 'seasonType');
  const query = new URLSearchParams({
    dates: String(normalizedSeason),
    seasontype: String(normalizedSeasonType),
    week: String(normalizedWeek)
  });
  return `${ESPN_NFL_SCOREBOARD_ENDPOINT}?${query}`;
}

/**
 * Fetch read-only game context for an NFL week. A fetch implementation can be
 * injected so callers and tests do not need to use the network.
 */
export async function fetchNflScoreboardContext({
  season,
  week,
  seasonType = 2,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  staleAfterMs = DEFAULT_CONTEXT_STALE_AFTER_MS,
  timeoutMs = 15_000,
  signal
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be greater than zero');

  const sourceUrl = buildEspnNflScoreboardUrl({ season, week, seasonType });
  const timeoutSignal = signal || globalThis.AbortSignal?.timeout?.(timeoutMs);
  const response = await fetchImpl(sourceUrl, {
    headers: { Accept: 'application/json' },
    ...(timeoutSignal ? { signal: timeoutSignal } : {})
  });

  if (!response?.ok) {
    const status = response?.status ?? null;
    const error = new Error(`ESPN NFL scoreboard returned HTTP ${status ?? 'unknown'}`);
    error.code = 'ESPN_NFL_SCOREBOARD_HTTP';
    error.status = status;
    error.sourceUrl = sourceUrl;
    throw error;
  }

  const payload = await response.json();
  const retrievalTime = resolveNow(now);
  const retrievedAt = toIso(retrievalTime);
  return normalizeNflScoreboard(payload, {
    season,
    week,
    seasonType,
    sourceUrl,
    retrievedAt,
    now: retrievalTime,
    staleAfterMs
  });
}

/**
 * Convert ESPN's scoreboard response into a small, stable game-context shape.
 * Unavailable source values remain null and are called out in missing/issues.
 */
export function normalizeNflScoreboard(payload, {
  season,
  week,
  seasonType,
  sourceUrl = ESPN_NFL_SCOREBOARD_ENDPOINT,
  retrievedAt = new Date().toISOString(),
  now = new Date(),
  staleAfterMs = DEFAULT_CONTEXT_STALE_AFTER_MS
} = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('ESPN scoreboard payload must be an object');
  }
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new TypeError('staleAfterMs must be zero or greater');
  }

  const normalizedRetrievedAt = toIso(retrievedAt);
  const normalizedNow = toDate(now);
  const stale = normalizedRetrievedAt == null || normalizedNow == null
    ? true
    : normalizedNow.getTime() - new Date(normalizedRetrievedAt).getTime() > staleAfterMs;
  const normalizedSeason = integerOrNull(season) ?? integerOrNull(payload.season?.year);
  const normalizedWeek = integerOrNull(week) ?? integerOrNull(payload.week?.number);
  const normalizedSeasonType = integerOrNull(seasonType) ?? integerOrNull(payload.season?.type);
  const normalizedSourceUrl = textOrNull(sourceUrl);
  const events = Array.isArray(payload.events) ? payload.events : [];
  const games = events.map((event) => normalizeGame(event, {
    sourceUrl: normalizedSourceUrl,
    retrievedAt: normalizedRetrievedAt,
    stale
  }));

  const missing = [];
  const issues = [];
  addMissing(missing, issues, normalizedSeason == null, 'season', 'season_unavailable', 'ESPN did not provide a season.');
  addMissing(missing, issues, normalizedWeek == null, 'week', 'week_unavailable', 'ESPN did not provide a week.');
  addMissing(missing, issues, normalizedSeasonType == null, 'seasonType', 'season_type_unavailable', 'ESPN did not provide a season type.');
  addMissing(missing, issues, normalizedSourceUrl == null, 'sourceUrl', 'source_url_unavailable', 'No source URL was supplied.');
  addMissing(missing, issues, normalizedRetrievedAt == null, 'retrievedAt', 'retrieval_time_unavailable', 'The retrieval time is invalid or unavailable.');
  addMissing(missing, issues, !Array.isArray(payload.events), 'games', 'games_unavailable', 'ESPN did not provide a games list.');
  for (const game of games) {
    const prefix = `games.${game.id ?? 'unknown'}`;
    for (const field of game.missing) missing.push(`${prefix}.${field}`);
    for (const issue of game.issues) issues.push({ ...issue, gameId: game.id });
  }

  return {
    provider: 'espn',
    sport: 'football',
    league: 'nfl',
    season: normalizedSeason,
    week: normalizedWeek,
    seasonType: normalizedSeasonType,
    games,
    sourceUrl: normalizedSourceUrl,
    retrievedAt: normalizedRetrievedAt,
    stale,
    missing,
    issues
  };
}

function normalizeGame(event, provenance) {
  const competition = Array.isArray(event?.competitions) ? event.competitions[0] : null;
  const competitors = Array.isArray(competition?.competitors) ? competition.competitors : [];
  const home = competitors.find((competitor) => competitor?.homeAway === 'home');
  const away = competitors.find((competitor) => competitor?.homeAway === 'away');
  const normalizedHome = normalizeTeam(home);
  const normalizedAway = normalizeTeam(away);
  const venue = normalizeVenue(competition?.venue);
  const weather = normalizeWeather(competition?.weather);
  const odds = normalizeOdds(firstOdds(competition?.odds), { home, away });
  const kickoff = toIso(competition?.date ?? event?.date);
  const status = normalizeStatus(competition?.status ?? event?.status);
  const id = idOrNull(event?.id ?? competition?.id);
  const missing = [];
  const issues = [];

  addMissing(missing, issues, id == null, 'id', 'game_id_unavailable', 'ESPN did not provide a game ID.');
  addMissing(missing, issues, kickoff == null, 'kickoff', 'kickoff_unavailable', 'ESPN did not provide a valid kickoff time.');
  addMissing(missing, issues, home == null, 'teams.home', 'home_team_unavailable', 'ESPN did not identify a home team.');
  addMissing(missing, issues, away == null, 'teams.away', 'away_team_unavailable', 'ESPN did not identify an away team.');
  addMissing(missing, issues, normalizedHome != null && normalizedHome.name == null, 'teams.home.name', 'home_team_name_unavailable', 'ESPN did not provide the home team name.');
  addMissing(missing, issues, normalizedAway != null && normalizedAway.name == null, 'teams.away.name', 'away_team_name_unavailable', 'ESPN did not provide the away team name.');
  addMissing(missing, issues, venue == null, 'venue', 'venue_unavailable', 'ESPN did not provide a venue.');
  addMissing(missing, issues, venue != null && venue.name == null, 'venue.name', 'venue_name_unavailable', 'ESPN did not provide the venue name.');
  addMissing(missing, issues, venue != null && venue.indoor == null, 'venue.indoor', 'indoor_indicator_unavailable', 'ESPN did not provide an indoor/outdoor indicator.');
  addMissing(missing, issues, weather == null, 'weather', 'weather_unavailable', 'ESPN did not provide weather for this game.');
  addMissing(missing, issues, weather != null && weather.summary == null, 'weather.summary', 'weather_summary_unavailable', 'ESPN did not provide a weather summary.');
  addMissing(missing, issues, weather != null && weather.temperatureF == null, 'weather.temperatureF', 'weather_temperature_unavailable', 'ESPN did not provide a temperature.');
  addMissing(missing, issues, odds == null, 'odds', 'odds_unavailable', 'ESPN did not provide betting context for this game.');
  addMissing(missing, issues, odds != null && odds.spread == null, 'odds.spread', 'spread_unavailable', 'ESPN did not provide a point spread.');
  addMissing(missing, issues, odds != null && odds.total == null, 'odds.total', 'total_unavailable', 'ESPN did not provide a game total.');

  return {
    id,
    name: textOrNull(event?.name),
    shortName: textOrNull(event?.shortName),
    kickoff,
    status,
    teams: {
      home: normalizedHome,
      away: normalizedAway
    },
    venue,
    indoor: venue?.indoor ?? null,
    weather,
    odds,
    eventUrl: eventLink(event?.links),
    sourceUrl: provenance.sourceUrl,
    retrievedAt: provenance.retrievedAt,
    stale: provenance.stale,
    missing,
    issues
  };
}

function normalizeTeam(competitor) {
  if (!competitor || typeof competitor !== 'object') return null;
  const team = competitor.team || {};
  const primaryRecord = Array.isArray(competitor.records) ? competitor.records[0] : null;
  return {
    id: idOrNull(team.id ?? competitor.id),
    name: textOrNull(team.displayName ?? team.shortDisplayName ?? team.name),
    abbreviation: textOrNull(team.abbreviation),
    location: textOrNull(team.location),
    logo: textOrNull(team.logo),
    homeAway: competitor.homeAway === 'home' || competitor.homeAway === 'away' ? competitor.homeAway : null,
    score: numberOrNull(competitor.score),
    winner: booleanOrNull(competitor.winner),
    record: textOrNull(primaryRecord?.summary)
  };
}

function normalizeVenue(value) {
  if (!value || typeof value !== 'object') return null;
  const address = value.address && typeof value.address === 'object' ? value.address : {};
  return {
    id: idOrNull(value.id),
    name: textOrNull(value.fullName ?? value.name),
    city: textOrNull(address.city),
    state: textOrNull(address.state),
    country: textOrNull(address.country),
    indoor: booleanOrNull(value.indoor)
  };
}

function normalizeWeather(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    summary: textOrNull(value.displayValue),
    temperatureF: numberOrNull(value.temperature),
    highTemperatureF: numberOrNull(value.highTemperature),
    conditionId: idOrNull(value.conditionId),
    sourceUrl: textOrNull(value.link?.href ?? value.link)
  };
}

function normalizeOdds(value, competitors) {
  if (!value || typeof value !== 'object') return null;
  const homeOdds = normalizeTeamOdds(value.homeTeamOdds);
  const awayOdds = normalizeTeamOdds(value.awayTeamOdds);
  const favorite = homeOdds?.favorite === true
    ? competitors.home
    : awayOdds?.favorite === true
      ? competitors.away
      : null;
  return {
    provider: {
      id: idOrNull(value.provider?.id),
      name: textOrNull(value.provider?.name)
    },
    details: textOrNull(value.details),
    spread: numberOrNull(value.spread),
    total: numberOrNull(value.overUnder),
    favoriteTeamId: idOrNull(favorite?.team?.id ?? favorite?.id),
    home: homeOdds,
    away: awayOdds
  };
}

function normalizeTeamOdds(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    favorite: booleanOrNull(value.favorite),
    underdog: booleanOrNull(value.underdog),
    moneyLine: numberOrNull(value.moneyLine),
    spreadPrice: numberOrNull(value.spreadOdds)
  };
}

function normalizeStatus(value) {
  if (!value || typeof value !== 'object') return null;
  const type = value.type && typeof value.type === 'object' ? value.type : {};
  return {
    state: textOrNull(type.state),
    name: textOrNull(type.name),
    detail: textOrNull(type.detail ?? value.displayClock),
    shortDetail: textOrNull(type.shortDetail),
    completed: booleanOrNull(type.completed)
  };
}

function firstOdds(value) {
  if (Array.isArray(value)) return value.find((item) => item && typeof item === 'object') || null;
  return value && typeof value === 'object' ? value : null;
}

function eventLink(links) {
  if (!Array.isArray(links)) return null;
  const preferred = links.find((link) => link?.rel?.includes?.('summary')) || links[0];
  return textOrNull(preferred?.href);
}

function addMissing(missing, issues, condition, field, code, message) {
  if (!condition) return;
  missing.push(field);
  issues.push({ code, field, message });
}

function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return normalized;
}

function integerOrNull(value) {
  if (value == null || value === '') return null;
  const normalized = Number(value);
  return Number.isInteger(normalized) ? normalized : null;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function idOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return textOrNull(value);
}

function toDate(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(value) {
  const date = toDate(value);
  return date?.toISOString() ?? null;
}

function resolveNow(now) {
  return typeof now === 'function' ? now() : now;
}

export const fetchNflContext = fetchNflScoreboardContext;
export const normalizeNflContext = normalizeNflScoreboard;
