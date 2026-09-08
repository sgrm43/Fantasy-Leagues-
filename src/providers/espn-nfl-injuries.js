export const ESPN_NFL_INJURIES_ENDPOINT =
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries';

export const DEFAULT_INJURY_STALE_AFTER_MS = 15 * 60 * 1000;
export const MAX_INJURY_CONTEXT_LENGTH = 300;

/**
 * Return the public, read-only ESPN NFL injury-report endpoint.
 */
export function buildEspnNflInjuriesUrl() {
  return ESPN_NFL_INJURIES_ENDPOINT;
}

/**
 * Fetch the current NFL injury report. fetchImpl is injectable so tests and
 * callers can supply a deterministic transport without making network calls.
 */
export async function fetchNflInjuryContext({
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  staleAfterMs = DEFAULT_INJURY_STALE_AFTER_MS,
  timeoutMs = 15_000,
  signal
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be greater than zero');
  }

  const sourceUrl = buildEspnNflInjuriesUrl();
  const timeoutSignal = signal || globalThis.AbortSignal?.timeout?.(timeoutMs);
  const response = await fetchImpl(sourceUrl, {
    headers: { Accept: 'application/json' },
    ...(timeoutSignal ? { signal: timeoutSignal } : {})
  });

  if (!response?.ok) {
    const status = response?.status ?? null;
    const error = new Error(`ESPN NFL injuries returned HTTP ${status ?? 'unknown'}`);
    error.code = 'ESPN_NFL_INJURIES_HTTP';
    error.status = status;
    error.sourceUrl = sourceUrl;
    throw error;
  }

  const payload = await response.json();
  const retrievalTime = resolveNow(now);
  return normalizeNflInjuries(payload, {
    sourceUrl,
    retrievedAt: toIso(retrievalTime),
    now: retrievalTime,
    staleAfterMs
  });
}

/**
 * Flatten ESPN's team-grouped injury report into one record per injury. Values
 * that ESPN does not provide remain null; narrative context is whitespace-
 * normalized and capped to avoid retaining long copyrighted source passages.
 */
export function normalizeNflInjuries(payload, {
  sourceUrl = ESPN_NFL_INJURIES_ENDPOINT,
  retrievedAt = new Date().toISOString(),
  now = new Date(),
  staleAfterMs = DEFAULT_INJURY_STALE_AFTER_MS
} = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('ESPN injuries payload must be an object');
  }
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new TypeError('staleAfterMs must be zero or greater');
  }

  const normalizedRetrievedAt = toIso(retrievedAt);
  const normalizedNow = toDate(now);
  const stale = normalizedRetrievedAt == null || normalizedNow == null
    ? true
    : normalizedNow.getTime() - new Date(normalizedRetrievedAt).getTime() > staleAfterMs;
  const normalizedSourceUrl = textOrNull(sourceUrl);
  const sourceUpdatedAt = toIso(payload.timestamp);
  const groups = Array.isArray(payload.injuries) ? payload.injuries : [];
  const injuries = groups.flatMap((group) => {
    const entries = Array.isArray(group?.injuries) ? group.injuries : [];
    return entries.map((entry) => normalizeInjury(entry, group, {
      sourceUrl: normalizedSourceUrl,
      retrievedAt: normalizedRetrievedAt,
      stale
    }));
  });

  const missing = [];
  const issues = [];
  addMissing(
    missing,
    issues,
    normalizedSourceUrl == null,
    'sourceUrl',
    'source_url_unavailable',
    'No source URL was supplied.'
  );
  addMissing(
    missing,
    issues,
    normalizedRetrievedAt == null,
    'retrievedAt',
    'retrieval_time_unavailable',
    'The retrieval time is invalid or unavailable.'
  );
  addMissing(
    missing,
    issues,
    sourceUpdatedAt == null,
    'sourceUpdatedAt',
    'source_update_time_unavailable',
    'ESPN did not provide a valid feed timestamp.'
  );
  addMissing(
    missing,
    issues,
    !Array.isArray(payload.injuries),
    'injuries',
    'injuries_unavailable',
    'ESPN did not provide an injuries list.'
  );

  for (const injury of injuries) {
    const prefix = `injuries.${injury.injuryId ?? injury.playerId ?? 'unknown'}`;
    for (const field of injury.missing) missing.push(`${prefix}.${field}`);
    for (const issue of injury.issues) {
      issues.push({
        ...issue,
        injuryId: injury.injuryId,
        playerId: injury.playerId
      });
    }
  }

  return {
    provider: 'espn',
    sport: 'football',
    league: 'nfl',
    sourceUpdatedAt,
    injuries,
    sourceUrl: normalizedSourceUrl,
    retrievedAt: normalizedRetrievedAt,
    stale,
    missing,
    issues
  };
}

function normalizeInjury(entry, group, provenance) {
  const athlete = objectOrNull(entry?.athlete);
  const team = normalizeTeam(objectOrNull(athlete?.team), group);
  const designation = normalizeDesignation(entry?.type);
  const injury = normalizeDetails(entry?.details);
  const playerId = athleteId(athlete);
  const injuryId = idOrNull(entry?.id);
  const name = textOrNull(athlete?.displayName ?? athlete?.fullName ?? athlete?.shortName);
  const status = textOrNull(entry?.status);
  const updatedAt = toIso(entry?.date);
  const shortComment = textOrNull(entry?.shortComment);
  const context = conciseContext(entry?.longComment);
  const source = normalizeSource(entry?.source);
  const missing = [];
  const issues = [];

  addMissing(missing, issues, playerId == null, 'playerId', 'player_id_unavailable', 'ESPN did not provide an athlete ID.');
  addMissing(missing, issues, name == null, 'name', 'player_name_unavailable', 'ESPN did not provide an athlete name.');
  addMissing(missing, issues, team == null, 'team', 'team_unavailable', 'ESPN did not identify the athlete\'s NFL team.');
  addMissing(missing, issues, status == null, 'status', 'status_unavailable', 'ESPN did not provide an injury status.');
  addMissing(missing, issues, updatedAt == null, 'updatedAt', 'injury_update_time_unavailable', 'ESPN did not provide a valid injury update time.');

  return {
    injuryId,
    playerId,
    name,
    position: normalizePosition(athlete?.position),
    team,
    status,
    designation,
    injury,
    shortComment,
    context,
    updatedAt,
    source,
    sourceUrl: provenance.sourceUrl,
    retrievedAt: provenance.retrievedAt,
    stale: provenance.stale,
    missing,
    issues
  };
}

function normalizeTeam(athleteTeam, group) {
  const id = idOrNull(athleteTeam?.id ?? group?.id);
  const name = textOrNull(
    athleteTeam?.displayName
      ?? athleteTeam?.shortDisplayName
      ?? group?.displayName
      ?? group?.shortDisplayName
  );
  const abbreviation = textOrNull(athleteTeam?.abbreviation ?? group?.abbreviation);
  if (id == null && name == null && abbreviation == null) return null;
  return { id, name, abbreviation };
}

function normalizePosition(value) {
  if (!value || typeof value !== 'object') return null;
  const id = idOrNull(value.id);
  const name = textOrNull(value.displayName ?? value.name);
  const abbreviation = textOrNull(value.abbreviation);
  if (id == null && name == null && abbreviation == null) return null;
  return { id, name, abbreviation };
}

function normalizeDesignation(value) {
  if (!value || typeof value !== 'object') return null;
  const id = idOrNull(value.id);
  const name = textOrNull(value.name);
  const description = textOrNull(value.description);
  const abbreviation = textOrNull(value.abbreviation);
  if (id == null && name == null && description == null && abbreviation == null) return null;
  return { id, name, description, abbreviation };
}

function normalizeDetails(value) {
  if (!value || typeof value !== 'object') return null;
  const type = textOrNull(value.type);
  const bodyPart = textOrNull(value.bodyPart ?? value.location);
  const detail = textOrNull(value.detail);
  const side = textOrNull(value.side);
  const returnAt = toIso(value.returnDate ?? value.returnAt);
  const practiceStatus = textOrNull(
    value.practiceStatus?.description
      ?? value.practiceStatus?.displayValue
      ?? value.practiceStatus
  );
  const fantasyStatus = normalizeStatusLabel(value.fantasyStatus);
  if (
    type == null
    && bodyPart == null
    && detail == null
    && side == null
    && returnAt == null
    && practiceStatus == null
    && fantasyStatus == null
  ) return null;
  return { type, bodyPart, detail, side, returnAt, practiceStatus, fantasyStatus };
}

function normalizeStatusLabel(value) {
  if (typeof value === 'string') {
    const description = textOrNull(value);
    return description == null ? null : { description, abbreviation: null };
  }
  if (!value || typeof value !== 'object') return null;
  const description = textOrNull(value.description ?? value.displayValue ?? value.name);
  const abbreviation = textOrNull(value.abbreviation);
  if (description == null && abbreviation == null) return null;
  return { description, abbreviation };
}

function normalizeSource(value) {
  if (!value || typeof value !== 'object') return null;
  const id = idOrNull(value.id);
  const description = textOrNull(value.description ?? value.name);
  const state = textOrNull(value.state);
  if (id == null && description == null && state == null) return null;
  return { id, description, state };
}

function conciseContext(value) {
  const normalized = textOrNull(value)?.replace(/\s+/g, ' ') ?? null;
  if (normalized == null) return null;
  const characters = Array.from(normalized);
  if (characters.length <= MAX_INJURY_CONTEXT_LENGTH) return normalized;
  return `${characters.slice(0, MAX_INJURY_CONTEXT_LENGTH - 1).join('').trimEnd()}…`;
}

function athleteId(athlete) {
  const direct = idOrNull(athlete?.id); if (direct) return direct;
  const uidMatch = /(?:^|~)a:(\d+)(?:~|$)/.exec(String(athlete?.uid || '')); if (uidMatch) return uidMatch[1];
  for (const link of Array.isArray(athlete?.links) ? athlete.links : []) {
    const match = /\/id\/(\d+)(?:\/|$)/.exec(String(link?.href || '')); if (match) return match[1];
  }
  return null;
}

function addMissing(missing, issues, condition, field, code, message) {
  if (!condition) return;
  missing.push(field);
  issues.push({ code, field, message });
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
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

export const fetchEspnNflInjuries = fetchNflInjuryContext;
export const normalizeEspnNflInjuries = normalizeNflInjuries;
