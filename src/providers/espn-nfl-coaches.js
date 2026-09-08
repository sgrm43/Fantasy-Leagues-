export const ESPN_NFL_COACHES_URL = 'https://www.espn.com/nfl/coaches';

export const DEFAULT_COACH_STALE_AFTER_MS = 24 * 60 * 60_000;

/**
 * Fetch ESPN's public NFL head-coach table. This is a read-only identity source;
 * it does not identify the offensive play caller or establish coaching intent.
 */
export async function fetchNflHeadCoaches({
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = 15_000,
  signal
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be greater than zero');

  const timeoutSignal = signal || globalThis.AbortSignal?.timeout?.(timeoutMs);
  const response = await fetchImpl(ESPN_NFL_COACHES_URL, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'FantasyLeagueAnalytics/0.1 (local read-only dashboard)'
    },
    ...(timeoutSignal ? { signal: timeoutSignal } : {})
  });
  if (!response?.ok) {
    const status = response?.status ?? null;
    const error = new Error(`ESPN NFL coaches returned HTTP ${status ?? 'unknown'}`);
    error.code = 'ESPN_NFL_COACHES_HTTP';
    error.status = status;
    error.sourceUrl = ESPN_NFL_COACHES_URL;
    throw error;
  }

  return normalizeNflHeadCoaches(await response.text(), {
    sourceUrl: ESPN_NFL_COACHES_URL,
    retrievedAt: toIso(resolveNow(now))
  });
}

/** Parse the small coach/team table into a stable, conservative shape. */
export function normalizeNflHeadCoaches(html, {
  sourceUrl = ESPN_NFL_COACHES_URL,
  retrievedAt = new Date().toISOString(),
  now = new Date(),
  staleAfterMs = DEFAULT_COACH_STALE_AFTER_MS
} = {}) {
  if (typeof html !== 'string') throw new TypeError('ESPN coaches page must be HTML text');
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) throw new TypeError('staleAfterMs must be zero or greater');

  const normalizedRetrievedAt = toIso(retrievedAt);
  const currentTime = toDate(now);
  const stale = normalizedRetrievedAt == null || currentTime == null
    ? true
    : currentTime.getTime() - new Date(normalizedRetrievedAt).getTime() > staleAfterMs;
  const plainPage = htmlText(html);
  const season = integerOrNull(/\b(20\d{2})\s+RECORD\b/i.exec(plainPage)?.[1]);
  const coaches = [];
  const seenTeams = new Set();
  const duplicateTeams = [];

  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
    if (cells.length < 4) continue;
    const coachLink = /<a\b[^>]*href=["']([^"']*\/nfl\/coaches\/_\/id\/([^\/"'?]+)[^"']*)["'][^>]*>/i.exec(cells[0]);
    const teamLink = /<a\b[^>]*href=["']([^"']*\/nfl\/team\/_\/name\/([^\/"'?]+)[^"']*)["'][^>]*>/i.exec(cells[3]);
    const name = textOrNull(htmlText(cells[0]));
    const teamName = textOrNull(htmlText(cells[3]));
    const teamAbbreviation = normalizeNflTeamAbbreviation(teamLink?.[2]);
    if (!name || !teamName || !teamAbbreviation) continue;
    if (seenTeams.has(teamAbbreviation)) { duplicateTeams.push(teamAbbreviation); continue; }
    seenTeams.add(teamAbbreviation);
    coaches.push({
      id: textOrNull(coachLink?.[2]),
      name,
      role: 'Head coach',
      experienceYears: integerOrNull(htmlText(cells[1])),
      seasonRecord: normalizeRecord(htmlText(cells[2])),
      team: {
        name: teamName,
        abbreviation: teamAbbreviation,
        sourceUrl: absoluteUrl(teamLink?.[1], sourceUrl)
      }
    });
  }

  if (!coaches.length) {
    const error = new Error('ESPN NFL coaches page did not contain a usable coach table');
    error.code = 'ESPN_NFL_COACHES_PARSE';
    error.sourceUrl = sourceUrl;
    throw error;
  }

  const issues = [];
  const missing = [];
  if (season == null) {
    missing.push('season');
    issues.push({ code: 'coach_season_unavailable', field: 'season', message: 'The coach table did not identify its NFL season.' });
  }
  if (coaches.length < 32) {
    issues.push({ code: 'coach_table_partial', field: 'coaches', message: `The coach table contained ${coaches.length} of 32 NFL teams.` });
  }
  if (duplicateTeams.length) {
    issues.push({ code: 'coach_table_duplicate_team', field: 'coaches', message: `The coach table repeated ${[...new Set(duplicateTeams)].join(', ')}.` });
  }
  const complete = season != null && coaches.length === 32 && duplicateTeams.length === 0;

  return {
    provider: 'espn',
    sport: 'football',
    league: 'nfl',
    season,
    complete,
    coveredRoles: ['headCoach'],
    coaches,
    sourceUrl: textOrNull(sourceUrl),
    retrievedAt: normalizedRetrievedAt,
    stale,
    missing,
    issues,
    limitations: [
      'This source identifies the listed head coach, not the offensive coordinator or game-day play caller.',
      'Observed team results can be tracked during a coach\'s period, but they do not prove who caused the result.'
    ]
  };
}

export function normalizeNflTeamAbbreviation(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return ({ JAC: 'JAX', WAS: 'WSH', LA: 'LAR', STL: 'LAR', SD: 'LAC', OAK: 'LV' })[normalized] || normalized || null;
}

function normalizeRecord(value) {
  const normalized = textOrNull(value);
  return normalized === '--' ? null : normalized;
}

function absoluteUrl(value, base) {
  if (!value) return null;
  try { return new URL(decodeEntities(value), base).toString(); }
  catch { return null; }
}

function htmlText(value) {
  return decodeEntities(String(value || '').replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(value) {
  const named = { amp: '&', apos: "'", quot: '"', lt: '<', gt: '>', nbsp: ' ' };
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|apos|quot|lt|gt|nbsp);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const numeric = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function resolveNow(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = toDate(value);
  if (!date) throw new TypeError('now must resolve to a valid date');
  return date;
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(value) { return toDate(value)?.toISOString() ?? null; }
function integerOrNull(value) { const number = Number(value); return Number.isInteger(number) ? number : null; }
function textOrNull(value) { const text = String(value ?? '').trim(); return text || null; }
