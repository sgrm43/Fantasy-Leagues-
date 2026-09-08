export const NWS_API_BASE_URL = 'https://api.weather.gov';
export const NWS_GRID_CACHE_TTL_MS = 30 * 24 * 60 * 60_000;
export const NWS_FORECAST_CACHE_TTL_MS = 30 * 60_000;
export const NWS_FAILURE_CACHE_TTL_MS = 5 * 60_000;
export const NWS_STALE_IF_ERROR_MAX_AGE_MS = 3 * 60 * 60_000;
export const NWS_MAX_FORECAST_LEAD_MS = 8 * 24 * 60 * 60_000;

export const WEATHER_FLAG_THRESHOLDS = Object.freeze({
  calmWindMph: 10,
  calmGustMph: 15,
  elevatedWindMph: 15,
  elevatedGustMph: 25,
  strongWindMph: 20,
  strongGustMph: 35,
  precipitationProbabilityPercent: 30,
  coldTemperatureF: 32,
  heatTemperatureF: 90
});

/**
 * Static venue metadata is used only to resolve an ESPN venue to the NWS grid.
 * Neutral/international venues do not fall back to a team's usual home stadium.
 */
export const NFL_VENUE_WEATHER = Object.freeze([
  venue('state-farm', ['State Farm Stadium', 'University of Phoenix Stadium'], 33.5276, -112.2626, 'retractable'),
  venue('mercedes-benz-atl', ['Mercedes-Benz Stadium'], 33.7554, -84.401, 'retractable'),
  venue('mt-bank', ['M&T Bank Stadium'], 39.278, -76.6227, 'outdoor'),
  venue('highmark', ['Highmark Stadium', 'New Highmark Stadium'], 42.7738, -78.787, 'outdoor'),
  venue('bank-of-america', ['Bank of America Stadium'], 35.2258, -80.8528, 'outdoor'),
  venue('soldier-field', ['Soldier Field'], 41.8623, -87.6167, 'outdoor'),
  venue('paycor', ['Paycor Stadium', 'Paul Brown Stadium'], 39.0954, -84.516, 'outdoor'),
  venue('cleveland', ['Huntington Bank Field', 'Cleveland Browns Stadium', 'FirstEnergy Stadium'], 41.5061, -81.6995, 'outdoor'),
  venue('att', ['AT&T Stadium', 'Cowboys Stadium'], 32.7473, -97.0945, 'retractable'),
  venue('empower', ['Empower Field at Mile High', 'Sports Authority Field at Mile High'], 39.7439, -105.0201, 'outdoor'),
  venue('ford-field', ['Ford Field'], 42.34, -83.0456, 'fixed'),
  venue('lambeau', ['Lambeau Field'], 44.5013, -88.0622, 'outdoor'),
  venue('nrg', ['NRG Stadium', 'Reliant Stadium'], 29.6847, -95.4107, 'retractable'),
  venue('lucas-oil', ['Lucas Oil Stadium'], 39.7601, -86.1639, 'retractable'),
  venue('everbank', ['EverBank Stadium', 'TIAA Bank Field', 'Jacksonville Municipal Stadium'], 30.3239, -81.6373, 'outdoor'),
  venue('arrowhead', ['GEHA Field at Arrowhead Stadium', 'Arrowhead Stadium'], 39.0489, -94.4839, 'outdoor'),
  venue('allegiant', ['Allegiant Stadium'], 36.0908, -115.183, 'fixed'),
  venue('sofi', ['SoFi Stadium'], 33.9535, -118.3392, 'covered_open_air'),
  venue('hard-rock', ['Hard Rock Stadium', 'Sun Life Stadium'], 25.958, -80.2389, 'outdoor', ['3948']),
  venue('us-bank', ['U.S. Bank Stadium', 'US Bank Stadium'], 44.9736, -93.2575, 'fixed'),
  venue('gillette', ['Gillette Stadium'], 42.0909, -71.2643, 'outdoor'),
  venue('superdome', ['Caesars Superdome', 'Mercedes-Benz Superdome'], 29.9511, -90.0812, 'fixed'),
  venue('metlife', ['MetLife Stadium'], 40.8135, -74.0745, 'outdoor'),
  venue('lincoln-financial', ['Lincoln Financial Field'], 39.9008, -75.1675, 'outdoor'),
  venue('acrisure', ['Acrisure Stadium', 'Heinz Field'], 40.4468, -80.0158, 'outdoor'),
  venue('lumen', ['Lumen Field', 'CenturyLink Field'], 47.5952, -122.3316, 'outdoor'),
  venue('levis', ["Levi's Stadium", 'Levis Stadium'], 37.403, -121.97, 'outdoor', ['4738']),
  venue('raymond-james', ['Raymond James Stadium'], 27.9759, -82.5033, 'outdoor'),
  venue('nissan', ['Nissan Stadium', 'LP Field'], 36.1665, -86.7713, 'outdoor'),
  venue('northwest', ['Northwest Stadium', 'Commanders Field', 'FedExField'], 38.9076, -76.8645, 'outdoor')
]);

export function createNwsGameWeatherProvider(defaults = {}) {
  const gridCache = defaults.gridCache instanceof Map ? defaults.gridCache : new Map();
  const forecastCache = defaults.forecastCache instanceof Map ? defaults.forecastCache : new Map();
  const gridPending = new Map();
  const forecastPending = new Map();
  return {
    fetch: (options = {}) => fetchNwsGameWeather({ ...defaults, ...options, gridCache, forecastCache, gridPending, forecastPending }),
    clearCache: () => { gridCache.clear(); forecastCache.clear(); gridPending.clear(); forecastPending.clear(); }
  };
}

export async function fetchNwsGameWeather({
  season,
  week,
  games = [],
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  venueCatalog = NFL_VENUE_WEATHER,
  gridCache = new Map(),
  forecastCache = new Map(),
  gridPending = new Map(),
  forecastPending = new Map(),
  gridCacheTtlMs = NWS_GRID_CACHE_TTL_MS,
  forecastCacheTtlMs = NWS_FORECAST_CACHE_TTL_MS,
  failureCacheTtlMs = NWS_FAILURE_CACHE_TTL_MS,
  staleIfErrorMaxAgeMs = NWS_STALE_IF_ERROR_MAX_AGE_MS,
  timeoutMs = 12_000,
  concurrency = 4
} = {}) {
  const normalizedSeason = positiveInteger(season, 'season');
  const normalizedWeek = positiveInteger(week, 'week');
  const nowDate = resolveNow(now);
  const relevantGames = uniqueGames(games);
  if (!relevantGames.length) return emptyWeatherContext(normalizedSeason, normalizedWeek, nowDate);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

  const results = await mapWithConcurrency(relevantGames, concurrency, (game) => resolveGameWeather(game, {
    season: normalizedSeason,
    week: normalizedWeek,
    fetchImpl,
    nowDate,
    venueCatalog,
    gridCache,
    forecastCache,
    gridPending,
    forecastPending,
    gridCacheTtlMs,
    forecastCacheTtlMs,
    failureCacheTtlMs,
    staleIfErrorMaxAgeMs,
    timeoutMs
  }));

  return {
    provider: 'nws',
    available: results.some((game) => game.available),
    season: normalizedSeason,
    week: normalizedWeek,
    games: results,
    retrievedAt: latestTimestamp(results.map((game) => game.retrievedAt)) || nowDate.toISOString(),
    stale: results.some((game) => game.stale),
    issues: results.flatMap((game) => game.issues.map((issue) => ({ ...issue, gameId: game.gameId }))),
    decisionUse: 'descriptive_only',
    projectionsAdjusted: false,
    safeguards: { readOnly: true, transactionsPerformed: false }
  };
}

async function resolveGameWeather(game, options) {
  const venueMetadata = resolveVenueMetadata(game, options.venueCatalog);
  const base = baseGameResult(game, venueMetadata, options);
  if (!venueMetadata) return unavailableGame(base, 'venue_weather_metadata_unavailable', 'Official weather temporarily unavailable because this venue could not be matched safely.');

  if (venueMetadata.roofType === 'fixed' || venueMetadata.roofType === 'covered_open_air') {
    const coveredOpenAir = venueMetadata.roofType === 'covered_open_air';
    return {
      ...base,
      available: true,
      nwsAvailable: false,
      summary: coveredOpenAir ? 'Covered fixed-roof venue — direct weather impact minimal' : 'Indoor venue — weather impact minimal',
      flags: [coveredOpenAir ? 'Covered venue' : 'Indoor'],
      cache: { ...base.cache, grid: 'not_requested', forecast: coveredOpenAir ? 'not_requested_covered' : 'not_requested_indoor' }
    };
  }

  const kickoff = toDate(game?.kickoff);
  if (!kickoff) return unavailableGame(base, 'kickoff_unavailable', 'Official weather temporarily unavailable because kickoff time is missing.');
  if (game?.status?.completed === true) return unavailableGame(base, 'game_completed', 'Official kickoff forecast is no longer available for this completed game.');
  if (kickoff.getTime() - options.nowDate.getTime() > NWS_MAX_FORECAST_LEAD_MS) {
    return unavailableGame(base, 'forecast_not_yet_available', 'Official NWS forecast is not available this far ahead yet.');
  }

  const gameKey = `${options.season}:${options.week}:${base.gameId}`;
  const saved = options.forecastCache.get(gameKey);
  if (saved && options.nowDate.getTime() <= Date.parse(saved.expiresAt)) {
    return { ...saved.result, cache: { ...saved.result.cache, forecast: 'memory_hit' } };
  }
  if (options.forecastPending.has(gameKey)) return options.forecastPending.get(gameKey);

  const task = loadGameForecast(base, kickoff, venueMetadata, options).then((loaded) => {
    const expiresAt = loaded.expiresAt || new Date(options.nowDate.getTime() + options.forecastCacheTtlMs).toISOString();
    const result = { ...loaded.result, cache: { ...loaded.result.cache, gameKey, forecast: loaded.result.cache?.forecast || 'downloaded' } };
    options.forecastCache.set(gameKey, { cachedAt: options.nowDate.toISOString(), expiresAt, result });
    return result;
  }).catch((error) => {
    const savedAgeMs = saved?.cachedAt ? options.nowDate.getTime() - Date.parse(saved.cachedAt) : Infinity;
    if (saved?.result && savedAgeMs <= options.staleIfErrorMaxAgeMs) {
      return {
        ...saved.result,
        stale: true,
        cache: { ...saved.result.cache, forecast: 'cached_after_failure' },
        issues: [...saved.result.issues, { code: 'forecast_refresh_failed', message: error.message }]
      };
    }
    const result = {
      ...unavailableGame(base, 'nws_unavailable', 'Official weather temporarily unavailable.', error.message),
      cache: { ...base.cache, gameKey, forecast: 'failed' }
    };
    options.forecastCache.set(gameKey, {
      cachedAt: options.nowDate.toISOString(),
      expiresAt: new Date(options.nowDate.getTime() + Math.min(options.forecastCacheTtlMs, options.failureCacheTtlMs)).toISOString(),
      result
    });
    return result;
  }).finally(() => options.forecastPending.delete(gameKey));

  options.forecastPending.set(gameKey, task);
  return task;
}

async function loadGameForecast(base, kickoff, venueMetadata, options) {
  const grid = await getGridMetadata(venueMetadata, options);
  const requests = await Promise.allSettled([
    requestNwsJson(grid.forecastHourlyUrl, options),
    requestNwsJson(`${NWS_API_BASE_URL}/alerts/active?point=${venueMetadata.latitude},${venueMetadata.longitude}`, options)
  ]);
  const hourly = requests[0].status === 'fulfilled' ? requests[0].value : null;
  const alertsResponse = requests[1].status === 'fulfilled' ? requests[1].value : null;
  let selected = hourly ? selectForecastPeriod(hourly.payload?.properties?.periods, kickoff, { maxGapMs: 90 * 60_000 }) : null;
  let basis = 'hourly';
  let fallback = null;
  if (!selected && grid.forecastUrl) {
    try {
      fallback = await requestNwsJson(grid.forecastUrl, options);
      selected = selectForecastPeriod(fallback.payload?.properties?.periods, kickoff, { maxGapMs: 0 });
      basis = 'forecast_period';
    } catch {
      fallback = null;
    }
  }

  if (!selected && requests[0].status === 'rejected' && !fallback) throw requests[0].reason;

  const issues = [];
  if (requests[0].status === 'rejected') issues.push({ code: 'hourly_forecast_unavailable', message: requests[0].reason.message });
  if (requests[1].status === 'rejected') issues.push({ code: 'alerts_unavailable', message: requests[1].reason.message });
  const alerts = alertsResponse ? normalizeActiveAlerts(alertsResponse.payload, kickoff) : null;
  if (!selected) {
    const result = unavailableGame(base, 'kickoff_forecast_unavailable', 'Official NWS forecast is not available for kickoff yet.');
    return {
      result: { ...result, issues: [...result.issues, ...issues], cache: { ...result.cache, grid: grid.cacheStatus, forecast: 'downloaded_unavailable' } },
      expiresAt: earliestTimestamp([hourly?.expiresAt, alertsResponse?.expiresAt, fallback?.expiresAt]) || new Date(options.nowDate.getTime() + options.forecastCacheTtlMs).toISOString()
    };
  }

  const forecast = normalizeForecastPeriod(selected.period, { basis, selectionMethod: selected.method });
  const hazardous = alerts == null ? null : alerts.length > 0;
  const flags = deriveWeatherFlags({ ...forecast, hazardous, alerts: alerts || [] });
  const outsideSummary = buildWeatherSummary(forecast, flags);
  const roofPrefix = venueMetadata.roofType === 'retractable'
    ? 'Retractable roof — status not verified'
    : venueMetadata.roofType === 'covered_open_air'
      ? 'Covered open-air venue'
      : null;
  const summary = roofPrefix ? `${roofPrefix} • Outside: ${outsideSummary}` : outsideSummary;
  return {
    result: {
      ...base,
      available: true,
      nwsAvailable: true,
      summary,
      flags,
      forecast: { ...forecast, hazardous, alerts: alerts || [] },
      sourceUrl: basis === 'hourly' ? grid.forecastHourlyUrl : grid.forecastUrl,
      retrievedAt: options.nowDate.toISOString(),
      stale: Boolean(grid.stale),
      issues,
      cache: { ...base.cache, grid: grid.cacheStatus, forecast: 'downloaded' }
    },
    expiresAt: earliestTimestamp([basis === 'hourly' ? hourly?.expiresAt : fallback?.expiresAt, alertsResponse?.expiresAt]) || new Date(options.nowDate.getTime() + options.forecastCacheTtlMs).toISOString()
  };
}

async function getGridMetadata(venueMetadata, options) {
  const key = venueMetadata.key;
  const saved = options.gridCache.get(key);
  if (saved && options.nowDate.getTime() <= Date.parse(saved.expiresAt)) return { ...saved.value, cacheStatus: 'memory_hit' };
  if (options.gridPending.has(key)) return options.gridPending.get(key);
  const task = (async () => {
    try {
      const url = `${NWS_API_BASE_URL}/points/${venueMetadata.latitude},${venueMetadata.longitude}`;
      const response = await requestNwsJson(url, options);
      const properties = response.payload?.properties || {};
      if (!properties.forecastHourly && !properties.forecast) throw new Error('NWS points response did not provide a forecast endpoint.');
      const value = {
        forecastHourlyUrl: safeNwsUrl(properties.forecastHourly),
        forecastUrl: safeNwsUrl(properties.forecast),
        sourceUrl: url,
        retrievedAt: options.nowDate.toISOString()
      };
      if (!value.forecastHourlyUrl && !value.forecastUrl) throw new Error('NWS points response did not provide a safe forecast endpoint.');
      const expiresAt = new Date(options.nowDate.getTime() + options.gridCacheTtlMs).toISOString();
      options.gridCache.set(key, { expiresAt, value });
      return { ...value, cacheStatus: 'downloaded' };
    } catch (error) {
      if (saved?.value) return { ...saved.value, cacheStatus: 'cached_after_failure', stale: true };
      throw error;
    }
  })().finally(() => options.gridPending.delete(key));
  options.gridPending.set(key, task);
  return task;
}

async function requestNwsJson(url, { fetchImpl, nowDate, timeoutMs, forecastCacheTtlMs }) {
  if (!url) throw new Error('NWS endpoint is unavailable.');
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/geo+json',
      'User-Agent': 'FantasyLeagueAnalytics/0.1 (local read-only application)'
    },
    signal: globalThis.AbortSignal?.timeout?.(timeoutMs)
  });
  if (!response?.ok) throw Object.assign(new Error(`National Weather Service returned HTTP ${response?.status ?? 'unknown'}`), { status: response?.status });
  return {
    payload: await response.json(),
    expiresAt: responseExpiry(response.headers, nowDate, forecastCacheTtlMs)
  };
}

export function selectForecastPeriod(periods, kickoff, { maxGapMs = 90 * 60_000 } = {}) {
  const kickoffDate = toDate(kickoff);
  if (!kickoffDate) return null;
  const candidates = (Array.isArray(periods) ? periods : []).map((period) => ({ period, start: toDate(period?.startTime), end: toDate(period?.endTime) })).filter((item) => item.start && item.end);
  const containing = candidates.find((item) => item.start.getTime() <= kickoffDate.getTime() && kickoffDate.getTime() < item.end.getTime());
  if (containing) return { period: containing.period, method: 'contains_kickoff', distanceMs: 0 };
  const nearest = candidates.map((item) => {
    const distanceMs = kickoffDate < item.start ? item.start.getTime() - kickoffDate.getTime() : kickoffDate.getTime() - item.end.getTime();
    return { ...item, distanceMs };
  }).sort((a, b) => a.distanceMs - b.distanceMs || a.start - b.start)[0];
  return nearest && nearest.distanceMs <= maxGapMs ? { period: nearest.period, method: 'nearest_kickoff', distanceMs: nearest.distanceMs } : null;
}

export function normalizeForecastPeriod(period, { basis = 'hourly', selectionMethod = 'contains_kickoff' } = {}) {
  const shortForecast = textOrNull(period?.shortForecast);
  return {
    basis,
    selectionMethod,
    validFrom: toIso(period?.startTime),
    validTo: toIso(period?.endTime),
    temperatureF: parseTemperatureF(period?.temperature, period?.temperatureUnit),
    windSpeedMph: parseSpeedMph(period?.windSpeed),
    windGustMph: parseSpeedMph(period?.windGust),
    windDirection: textOrNull(period?.windDirection),
    precipitationProbabilityPercent: parsePercent(period?.probabilityOfPrecipitation),
    precipitationType: precipitationType(shortForecast),
    shortForecast,
    relativeHumidityPercent: parsePercent(period?.relativeHumidity)
  };
}

export function deriveWeatherFlags(weather, thresholds = WEATHER_FLAG_THRESHOLDS) {
  const flags = [];
  const wind = numberOrNull(weather?.windSpeedMph);
  const gust = numberOrNull(weather?.windGustMph);
  const temperature = numberOrNull(weather?.temperatureF);
  const precipitation = numberOrNull(weather?.precipitationProbabilityPercent);
  if (hasSevereWeatherAlert(weather?.alerts)) flags.push('Severe-weather watch');
  if ((wind != null && wind >= thresholds.strongWindMph) || (gust != null && gust >= thresholds.strongGustMph)) flags.push('Strong wind');
  else if ((wind != null && wind >= thresholds.elevatedWindMph) || (gust != null && gust >= thresholds.elevatedGustMph)) flags.push('Wind elevated');
  if (precipitation != null && precipitation >= thresholds.precipitationProbabilityPercent) {
    flags.push(weather?.precipitationType === 'snow' || weather?.precipitationType === 'wintry mix' ? 'Snow possible' : 'Rain possible');
  }
  if (temperature != null && temperature <= thresholds.coldTemperatureF) flags.push('Cold');
  if (temperature != null && temperature >= thresholds.heatTemperatureF) flags.push('Heat');
  if (!flags.length && wind != null && wind <= thresholds.calmWindMph && (gust == null || gust <= thresholds.calmGustMph) && (precipitation == null || precipitation < thresholds.precipitationProbabilityPercent)) flags.push('Calm');
  return flags;
}

function buildWeatherSummary(forecast, flags) {
  const parts = [];
  if (forecast.temperatureF != null) parts.push(`${Math.round(forecast.temperatureF)}°F`);
  if (forecast.windSpeedMph != null) parts.push(`${Math.round(forecast.windSpeedMph)} mph wind`);
  if (forecast.windGustMph != null) parts.push(`gusts to ${Math.round(forecast.windGustMph)} mph`);
  if (forecast.precipitationProbabilityPercent != null) parts.push(`${Math.round(forecast.precipitationProbabilityPercent)}% precipitation chance`);
  if (forecast.shortForecast) parts.push(forecast.shortForecast);
  const measurements = parts.join(' • ') || 'Official forecast details unavailable';
  const lead = flags.includes('Severe-weather watch') ? 'Severe-weather watch' : flags.includes('Strong wind') ? 'Strong wind' : flags.includes('Wind elevated') ? 'Wind elevated' : null;
  return lead ? `${lead}: ${measurements}` : measurements;
}

function normalizeActiveAlerts(payload, kickoff) {
  const time = toDate(kickoff)?.getTime();
  return (Array.isArray(payload?.features) ? payload.features : []).map((feature) => feature?.properties || {}).filter((alert) => {
    if (alert.status && alert.status !== 'Actual') return false;
    const onset = toDate(alert.onset || alert.effective)?.getTime();
    const expires = toDate(alert.expires || alert.ends)?.getTime();
    return time == null || (onset == null || onset <= time) && (expires == null || time < expires);
  }).map((alert) => ({
    event: textOrNull(alert.event),
    severity: textOrNull(alert.severity),
    urgency: textOrNull(alert.urgency),
    certainty: textOrNull(alert.certainty),
    headline: textOrNull(alert.headline)
  })).slice(0, 3);
}

function baseGameResult(game, venueMetadata, { season, week, nowDate }) {
  const roofType = venueMetadata?.roofType || 'unknown';
  return {
    gameId: String(game?.id || gameKeyFallback(game)),
    season,
    week,
    kickoff: toIso(game?.kickoff),
    matchup: { away: textOrNull(game?.teams?.away?.abbreviation), home: textOrNull(game?.teams?.home?.abbreviation) },
    venue: { id: textOrNull(game?.venue?.id), name: textOrNull(game?.venue?.name), roofType },
    roof: { type: roofType, status: roofType === 'retractable' ? 'unknown' : roofType === 'fixed' ? 'fixed' : 'not_applicable', verified: roofType !== 'retractable' && roofType !== 'unknown' },
    available: false,
    nwsAvailable: false,
    summary: 'Official weather temporarily unavailable.',
    flags: [],
    forecast: null,
    sourceUrl: null,
    retrievedAt: nowDate.toISOString(),
    stale: false,
    cache: { gameKey: `${season}:${week}:${String(game?.id || gameKeyFallback(game))}`, grid: 'not_requested', forecast: 'not_requested' },
    issues: []
  };
}

function unavailableGame(base, code, message, detail = null) {
  const summary = base.venue?.roofType === 'retractable' ? `Retractable roof — status not verified • ${message}` : message;
  return { ...base, available: false, nwsAvailable: false, summary, issues: [{ code, message: detail ? `${summary} ${detail}` : summary }] };
}

function emptyWeatherContext(season, week, nowDate) {
  return { provider: 'nws', available: false, season, week, games: [], retrievedAt: nowDate.toISOString(), stale: false, issues: [], decisionUse: 'descriptive_only', projectionsAdjusted: false, safeguards: { readOnly: true, transactionsPerformed: false } };
}

function resolveVenueMetadata(game, catalog) {
  const venueId = textOrNull(game?.venue?.id);
  const venueName = normalizeText(game?.venue?.name);
  return (Array.isArray(catalog) ? catalog : []).find((item) =>
    venueId && (item.espnVenueIds || []).map(String).includes(venueId) || venueName && (item.normalizedNames || (item.names || []).map(normalizeText)).includes(venueName)
  ) || null;
}

function hasSevereWeatherAlert(alerts) {
  return (alerts || []).some((alert) =>
    ['severe', 'extreme'].includes(String(alert?.severity || '').toLowerCase()) || /\b(watch|warning)\b/i.test(String(alert?.event || ''))
  );
}

function venue(key, names, latitude, longitude, roofType, espnVenueIds = []) {
  return Object.freeze({ key, names, normalizedNames: names.map(normalizeText), latitude, longitude, roofType, espnVenueIds: espnVenueIds.map(String) });
}

function uniqueGames(games) {
  const map = new Map();
  for (const game of games || []) {
    if (!game || typeof game !== 'object') continue;
    const key = String(game.id || gameKeyFallback(game));
    if (!map.has(key)) map.set(key, game);
  }
  return [...map.values()];
}

async function mapWithConcurrency(items, limit, task) {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, Number(limit) || 1), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return output;
}

function responseExpiry(headers, nowDate, fallbackMs) {
  const cacheControl = headerValue(headers, 'cache-control');
  const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl || '');
  if (maxAge) return new Date(nowDate.getTime() + Number(maxAge[1]) * 1000).toISOString();
  const expires = toDate(headerValue(headers, 'expires'));
  return expires && expires > nowDate ? expires.toISOString() : new Date(nowDate.getTime() + fallbackMs).toISOString();
}

function safeNwsUrl(value) {
  const text = textOrNull(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.hostname === 'api.weather.gov' ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseTemperatureF(value, unit) {
  const numeric = numberOrNull(value && typeof value === 'object' ? value.value : value);
  if (numeric == null) return null;
  const unitCode = String(value && typeof value === 'object' ? value.unitCode || unit || '' : unit || '').toLowerCase();
  return roundOne(unitCode.includes('degc') || unitCode === 'c' ? numeric * 9 / 5 + 32 : numeric);
}

function parseSpeedMph(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    const numeric = numberOrNull(value.value);
    if (numeric == null) return null;
    const unit = String(value.unitCode || '').toLowerCase();
    if (unit.includes('km_h') || unit.includes('km/h')) return roundOne(numeric * 0.621371);
    if (unit.includes('m_s') || unit.includes('m/s')) return roundOne(numeric * 2.23694);
    return roundOne(numeric);
  }
  const text = String(value).trim();
  if (/^calm$/i.test(text)) return 0;
  const numbers = [...text.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  if (!numbers.length) return null;
  const speed = Math.max(...numbers);
  return roundOne(/km\/?h/i.test(text) ? speed * 0.621371 : /m\/?s/i.test(text) ? speed * 2.23694 : speed);
}

function parsePercent(value) {
  const numeric = numberOrNull(value && typeof value === 'object' ? value.value : value);
  return numeric == null ? null : Math.max(0, Math.min(100, roundOne(numeric)));
}

function precipitationType(summary) {
  const text = String(summary || '').toLowerCase();
  const snow = /snow|flurr/.test(text);
  const rain = /rain|shower|drizzle/.test(text);
  if (snow && rain) return 'wintry mix';
  if (/sleet/.test(text)) return 'sleet';
  if (/freezing|ice/.test(text)) return 'ice';
  if (/thunder/.test(text)) return 'thunderstorms';
  if (snow) return 'snow';
  if (rain) return 'rain';
  return null;
}

function gameKeyFallback(game) { return [game?.teams?.away?.abbreviation, game?.teams?.home?.abbreviation, game?.kickoff].filter(Boolean).join(':') || 'unknown'; }
function normalizeText(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function textOrNull(value) { const text = String(value ?? '').trim(); return text || null; }
function numberOrNull(value) { if (value == null || value === '') return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function positiveInteger(value, label) { const number = Number(value); if (!Number.isInteger(number) || number < 1) throw new TypeError(`${label} must be a positive integer`); return number; }
function toDate(value) { const date = value instanceof Date ? value : new Date(value); return Number.isNaN(date.getTime()) ? null : date; }
function toIso(value) { return toDate(value)?.toISOString() || null; }
function resolveNow(now) { const date = toDate(typeof now === 'function' ? now() : now); if (!date) throw new TypeError('now must resolve to a valid date'); return date; }
function roundOne(value) { return Math.round(value * 10) / 10; }
function headerValue(headers, name) { return typeof headers?.get === 'function' ? headers.get(name) : null; }
function latestTimestamp(values) { return (values || []).filter(Boolean).sort().at(-1) || null; }
function earliestTimestamp(values) { return (values || []).filter(Boolean).sort()[0] || null; }
