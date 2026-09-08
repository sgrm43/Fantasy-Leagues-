export const THE_ODDS_API_ENDPOINT = 'https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds';
export const THE_ODDS_API_SPORT = 'americanfootball_nfl';
export const THE_ODDS_API_REGION = 'us';
export const THE_ODDS_API_MARKETS = Object.freeze(['spreads', 'totals']);
export const THE_ODDS_API_ODDS_FORMAT = 'american';
export const THE_ODDS_API_CACHE_TTL_MS = 5 * 60_000;

const CACHE_KEY = `${THE_ODDS_API_SPORT}:${THE_ODDS_API_REGION}:${THE_ODDS_API_MARKETS.join(',')}:${THE_ODDS_API_ODDS_FORMAT}`;
const SAFE_MESSAGES = Object.freeze({
  missing_api_key: 'The Odds API key is not configured.',
  provider_error: 'The Odds API request is temporarily unavailable.',
  quota_exhausted: 'The Odds API request quota is exhausted.',
  malformed_response: 'The Odds API returned an unusable response.'
});

/** Create one provider instance whose current NFL response is shared in memory. */
export function createTheOddsApiProvider(defaults = {}) {
  const cache = defaults.cache instanceof Map ? defaults.cache : new Map();
  const pending = new Map();
  return {
    fetch: (options = {}) => fetchCurrentNflOdds({ ...defaults, ...options, cache, pending }),
    clearCache: () => { cache.clear(); pending.clear(); },
    get cacheSize() { return cache.size; }
  };
}

/**
 * Fetch current NFL spreads and totals. The credential stays inside this
 * server-side request and is never copied into returned data or error text.
 */
export async function fetchCurrentNflOdds({
  apiKey = process.env.ODDS_API_KEY,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  cache = new Map(),
  pending = new Map(),
  cacheTtlMs = THE_ODDS_API_CACHE_TTL_MS,
  timeoutMs = 15_000
} = {}) {
  const checkedAt = resolveNow(now).toISOString();
  const key = textOrNull(apiKey);
  if (!key) return unavailableResult('missing_api_key', { checkedAt, cacheStatus: 'not_requested' });
  if (typeof fetchImpl !== 'function') return unavailableResult('provider_error', { checkedAt, cacheStatus: 'not_requested' });

  const saved = cache.get(CACHE_KEY);
  if (saved && Date.parse(checkedAt) - Date.parse(saved.cachedAt) <= cacheTtlMs) {
    return withCacheStatus(saved.result, 'memory_hit', saved.cachedAt);
  }
  if (pending.has(CACHE_KEY)) return pending.get(CACHE_KEY);

  const task = requestCurrentNflOdds({ apiKey: key, fetchImpl, checkedAt, timeoutMs }).then((result) => {
    cache.set(CACHE_KEY, { cachedAt: checkedAt, result });
    return result;
  }).finally(() => pending.delete(CACHE_KEY));
  pending.set(CACHE_KEY, task);
  return task;
}

/** Normalize an already-decoded v4 odds response without retaining raw books. */
export function normalizeTheOddsApiEvents(events, { quota = emptyQuota(), retrievedAt = null } = {}) {
  if (!Array.isArray(events)) return unavailableResult('malformed_response', { quota, checkedAt: retrievedAt, cacheStatus: 'network' });
  const games = [];
  let skippedEvents = 0;
  for (const event of events) {
    const game = normalizeGame(event);
    if (game) games.push(game);
    else skippedEvents += 1;
  }
  if (events.length && !games.length) return unavailableResult('malformed_response', { quota, checkedAt: retrievedAt, cacheStatus: 'network' });
  return {
    provider: 'the-odds-api-v4',
    status: 'available',
    available: true,
    reason: null,
    sport: THE_ODDS_API_SPORT,
    region: THE_ODDS_API_REGION,
    markets: [...THE_ODDS_API_MARKETS],
    oddsFormat: THE_ODDS_API_ODDS_FORMAT,
    games: games.sort(compareGames),
    quota: normalizeQuota(quota),
    retrievedAt: isoOrNull(retrievedAt),
    cache: { status: 'network', cachedAt: isoOrNull(retrievedAt) },
    issues: skippedEvents ? [{ code: 'malformed_events_skipped', count: skippedEvents }] : []
  };
}

export function parseOddsApiQuotaHeaders(headers) {
  return {
    requestsRemaining: headerNumber(headers, 'x-requests-remaining'),
    requestsUsed: headerNumber(headers, 'x-requests-used'),
    requestsLast: headerNumber(headers, 'x-requests-last')
  };
}

async function requestCurrentNflOdds({ apiKey, fetchImpl, checkedAt, timeoutMs }) {
  const requestUrl = new URL(THE_ODDS_API_ENDPOINT);
  requestUrl.searchParams.set('apiKey', apiKey);
  requestUrl.searchParams.set('regions', THE_ODDS_API_REGION);
  requestUrl.searchParams.set('markets', THE_ODDS_API_MARKETS.join(','));
  requestUrl.searchParams.set('oddsFormat', THE_ODDS_API_ODDS_FORMAT);
  try {
    const response = await fetchImpl(requestUrl, {
      headers: { Accept: 'application/json' },
      signal: globalThis.AbortSignal?.timeout?.(timeoutMs)
    });
    const quota = parseOddsApiQuotaHeaders(response?.headers);
    if (response?.status === 429 || (!response?.ok && quota.requestsRemaining === 0)) {
      return unavailableResult('quota_exhausted', { quota, checkedAt, cacheStatus: 'network' });
    }
    if (!response?.ok) return unavailableResult('provider_error', { quota, checkedAt, cacheStatus: 'network' });
    let payload;
    try {
      payload = await response.json();
    } catch {
      return unavailableResult('malformed_response', { quota, checkedAt, cacheStatus: 'network' });
    }
    return normalizeTheOddsApiEvents(payload, { quota, retrievedAt: checkedAt });
  } catch {
    return unavailableResult('provider_error', { checkedAt, cacheStatus: 'network' });
  }
}

function normalizeGame(event) {
  const eventId = textOrNull(event?.id);
  const homeTeam = textOrNull(event?.home_team);
  const awayTeam = textOrNull(event?.away_team);
  const kickoffTime = isoOrNull(event?.commence_time);
  if (!eventId || !homeTeam || !awayTeam || homeTeam === awayTeam || !kickoffTime || !Array.isArray(event?.bookmakers)) return null;

  const homeSpreadLines = [];
  const totalLines = [];
  const validBookmakers = new Set();
  const updates = [];
  for (const [index, bookmaker] of event.bookmakers.entries()) {
    if (!bookmaker || typeof bookmaker !== 'object' || !Array.isArray(bookmaker.markets)) continue;
    const bookmakerId = textOrNull(bookmaker.key) || textOrNull(bookmaker.title) || `index:${index}`;
    const spread = firstValidMarket(bookmaker.markets, 'spreads', (market) => parseHomeSpread(market, homeTeam, awayTeam));
    const total = firstValidMarket(bookmaker.markets, 'totals', parseTotal);
    if (spread) homeSpreadLines.push(spread.point);
    if (total) totalLines.push(total.point);
    if (!spread && !total) continue;
    validBookmakers.add(bookmakerId);
    updates.push(bookmaker.last_update, spread?.lastUpdate, total?.lastUpdate);
  }
  if (!homeSpreadLines.length && !totalLines.length) return null;

  return {
    eventId,
    homeTeam,
    awayTeam,
    kickoffTime,
    bookmakerCount: validBookmakers.size,
    consensusSpread: median(homeSpreadLines),
    consensusTotal: median(totalLines),
    spreadRange: lineRange(homeSpreadLines),
    totalRange: lineRange(totalLines),
    latestBookmakerUpdate: latestTimestamp(updates)
  };
}

function firstValidMarket(markets, key, parser) {
  for (const market of markets) {
    if (market?.key !== key) continue;
    const parsed = parser(market);
    if (parsed) return { ...parsed, lastUpdate: isoOrNull(market.last_update) };
  }
  return null;
}

function parseHomeSpread(market, homeTeam, awayTeam) {
  if (!Array.isArray(market?.outcomes)) return null;
  const home = exactOutcome(market.outcomes, homeTeam);
  const away = exactOutcome(market.outcomes, awayTeam);
  if (!home || !away) return null;
  const homePoint = finiteNumber(home.point);
  const awayPoint = finiteNumber(away.point);
  if (homePoint == null || awayPoint == null || Math.abs(homePoint + awayPoint) > 0.01) return null;
  return { point: cleanNumber(homePoint) };
}

function parseTotal(market) {
  if (!Array.isArray(market?.outcomes)) return null;
  const over = exactOutcome(market.outcomes, 'Over');
  const under = exactOutcome(market.outcomes, 'Under');
  if (!over || !under) return null;
  const overPoint = finiteNumber(over.point);
  const underPoint = finiteNumber(under.point);
  if (overPoint == null || underPoint == null || Math.abs(overPoint - underPoint) > 0.01) return null;
  return { point: cleanNumber(overPoint) };
}

function exactOutcome(outcomes, name) {
  const expected = normalizeName(name);
  const matches = outcomes.filter((outcome) => normalizeName(outcome?.name) === expected);
  return matches.length === 1 ? matches[0] : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return cleanNumber(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

function lineRange(values) {
  if (!values.length) return null;
  return { min: cleanNumber(Math.min(...values)), max: cleanNumber(Math.max(...values)) };
}

function latestTimestamp(values) {
  const valid = values.map(isoOrNull).filter(Boolean);
  return valid.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) || null;
}

function compareGames(a, b) {
  return Date.parse(a.kickoffTime) - Date.parse(b.kickoffTime) || a.eventId.localeCompare(b.eventId);
}

function unavailableResult(reason, { quota = emptyQuota(), checkedAt = null, cacheStatus = 'not_requested' } = {}) {
  const safeReason = SAFE_MESSAGES[reason] ? reason : 'provider_error';
  return {
    provider: 'the-odds-api-v4',
    status: 'unavailable',
    available: false,
    reason: safeReason,
    sport: THE_ODDS_API_SPORT,
    region: THE_ODDS_API_REGION,
    markets: [...THE_ODDS_API_MARKETS],
    oddsFormat: THE_ODDS_API_ODDS_FORMAT,
    games: [],
    quota: normalizeQuota(quota),
    retrievedAt: isoOrNull(checkedAt),
    cache: { status: cacheStatus, cachedAt: isoOrNull(checkedAt) },
    issues: [{ code: safeReason, message: SAFE_MESSAGES[safeReason] }]
  };
}

function withCacheStatus(result, status, cachedAt) {
  return { ...result, games: result.games.map((game) => ({ ...game })), cache: { status, cachedAt } };
}

function normalizeQuota(quota) {
  return {
    requestsRemaining: finiteNumber(quota?.requestsRemaining),
    requestsUsed: finiteNumber(quota?.requestsUsed),
    requestsLast: finiteNumber(quota?.requestsLast)
  };
}

function emptyQuota() {
  return { requestsRemaining: null, requestsUsed: null, requestsLast: null };
}

function headerNumber(headers, name) {
  const raw = typeof headers?.get === 'function' ? headers.get(name) : null;
  return raw == null || String(raw).trim() === '' ? null : finiteNumber(raw);
}

function finiteNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanNumber(value) {
  const rounded = Math.round(Number(value) * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function normalizeName(value) {
  return textOrNull(value)?.toLowerCase() || null;
}

function textOrNull(value) {
  const text = value == null ? '' : String(value).trim();
  return text || null;
}

function isoOrNull(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function resolveNow(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}
