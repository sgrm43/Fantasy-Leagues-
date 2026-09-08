/**
 * Read-only, source-level adapters for the quiet news monitor.
 *
 * Adapters only translate structured upstream facts. They do not infer facts
 * from prose, classify fantasy impact, schedule polling, or make transactions.
 */

export const NEWS_EVENT_TYPES = Object.freeze([
  'availability',
  'practice',
  'return_from_injury',
  'snap_limitation',
  'starter_change',
  'backup_change',
  'disciplinary',
  'depth_chart',
  'role_change',
  'emergency_status',
  'game_status'
]);

export const NEWS_TRUST_LEVELS = Object.freeze([
  'official_primary',
  'official_secondary',
  'existing_provider'
]);

export const NEWS_AUTHORITY_PRIORITY = Object.freeze({
  OFFICIAL_GAME_OR_INJURY_DESIGNATION: 1,
  OFFICIAL_PRACTICE_REPORT: 2,
  OFFICIAL_TRANSACTION_OR_DEPTH_CHART: 3,
  OFFICIAL_TEAM_STATEMENT: 4,
  EXISTING_PROVIDER: 5
});

export const NEWS_SOURCE_REFRESH_MS = Object.freeze({
  DEFAULT: 10 * 60 * 1000,
  ESPN: 10 * 60 * 1000,
  SLEEPER: 10 * 60 * 1000,
  OFFICIAL_NFL: 15 * 60 * 1000,
  OFFICIAL_TEAM_REPORT: 15 * 60 * 1000,
  OFFICIAL_TEAM_TRANSACTION: 15 * 60 * 1000,
  OFFICIAL_TEAM_NEWS: 15 * 60 * 1000
});

const EVENT_TYPE_SET = new Set(NEWS_EVENT_TYPES);
const TRUST_SET = new Set(NEWS_TRUST_LEVELS);
const SAFE_ISSUE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_HEADLINE_LENGTH = 320;
const MAX_SOURCE_LENGTH = 100;
const MAX_REFERENCE_LENGTH = 200;

/**
 * Build a safe callable adapter with source-level TTL caching and in-flight
 * request reuse. Raw source data is cached; normalization is repeated against
 * each caller's exact roster scope so one download can safely serve many
 * roster players.
 */
export function createCachedNewsAdapter({
  id,
  sourceType,
  trust,
  load,
  normalize,
  cacheKey = sourceCacheKey,
  now = () => new Date(),
  ttlMs = NEWS_SOURCE_REFRESH_MS.DEFAULT,
  configured = true
} = {}) {
  const normalizedId = compactText(id, MAX_SOURCE_LENGTH);
  const normalizedSourceType = normalizeToken(sourceType);
  const normalizedTrust = normalizeTrust(trust);
  if (!normalizedId) throw new TypeError('News adapter id is required');
  if (!normalizedSourceType) throw new TypeError('News adapter sourceType is required');
  if (!normalizedTrust) throw new TypeError('News adapter trust must be official_primary, official_secondary, or existing_provider');
  if (configured !== false && typeof load !== 'function') throw new TypeError('News adapter load must be a function');
  if (normalize != null && typeof normalize !== 'function') throw new TypeError('News adapter normalize must be a function');
  if (typeof cacheKey !== 'function') throw new TypeError('News adapter cacheKey must be a function');
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new TypeError('News adapter ttlMs must be zero or greater');

  const cache = new Map();
  const inFlight = new Map();
  const normalizer = normalize || ((payload, scope, metadata) =>
    extractRows(payload).map((row) => normalizeNewsEvent(row, {
      source: normalizedId,
      sourceType: normalizedSourceType,
      trust: normalizedTrust,
      observedAt: metadata.observedAt,
      season: scope?.season,
      week: scope?.week,
      gameId: scope?.gameId,
      kickoffAt: scope?.kickoffAt
    })));

  async function acquire(scope, key, observedAt, clockMs) {
    const entry = cache.get(key);
    const entryTtlMs = entry?.value?.status === 'rate_limited'
      ? Math.max(ttlMs, Number(entry.value.retryAfterMs) || 0)
      : ttlMs;
    if (entry && clockMs - entry.cachedAtMs < entryTtlMs) {
      return { ...entry.value, fromCache: true };
    }
    if (inFlight.has(key)) {
      const value = await inFlight.get(key);
      return { ...value, fromCache: true };
    }

    const request = (async () => {
      try {
        const payload = await load(scope);
        const upstreamStatus = sourceStatus(payload?.status);
        if (upstreamStatus && upstreamStatus !== 'ok') {
          const value = safeSourceResult(upstreamStatus, observedAt, {
            retryAfterMs: retryAfterMs(payload),
            issueCode: safeIssueCode(payload?.issueCode ?? payload?.issue_code, upstreamStatus)
          });
          cache.set(key, { cachedAtMs: clockMs, value });
          return value;
        }
        const value = { status: 'ok', observedAt, payload, fromCache: false };
        cache.set(key, { cachedAtMs: clockMs, value });
        return value;
      } catch (error) {
        const rateLimited = isRateLimited(error);
        const status = rateLimited ? 'rate_limited' : 'unavailable';
        const value = safeSourceResult(status, observedAt, {
          retryAfterMs: rateLimited ? retryAfterMs(error) : null,
          issueCode: safeIssueCode(error?.code, rateLimited ? 'rate_limited' : 'source_unavailable')
        });
        cache.set(key, { cachedAtMs: clockMs, value });
        return value;
      }
    })();
    inFlight.set(key, request);
    try {
      return await request;
    } finally {
      inFlight.delete(key);
    }
  }

  return Object.freeze({
    id: normalizedId,
    sourceType: normalizedSourceType,
    trust: normalizedTrust,
    trustLevel: normalizedTrust,
    async collect(scope = {}) {
      const clock = resolveClock(now);
      const observedAt = clock.date.toISOString();
      if (configured === false) {
        return safeSourceResult('source_not_supported', observedAt, {
          issueCode: 'source_not_supported'
        });
      }

      const scopedCacheKey = compactText(cacheKey(scope), 500) || sourceCacheKey(scope);
      const acquired = await acquire(scope, scopedCacheKey, observedAt, clock.ms);
      if (acquired.status !== 'ok') {
        return safeSourceResult(acquired.status, acquired.observedAt, {
          fromCache: acquired.fromCache,
          retryAfterMs: acquired.retryAfterMs,
          issueCode: acquired.issueCode
        });
      }

      try {
        const result = await normalizer(acquired.payload, scope, {
          observedAt: acquired.observedAt,
          source: normalizedId,
          sourceType: normalizedSourceType,
          trust: normalizedTrust
        });
        const events = uniqueEvents(extractRows(result).filter(isCommonNewsEvent));
        return {
          status: 'ok',
          observedAt: acquired.observedAt,
          events,
          fromCache: acquired.fromCache === true
        };
      } catch (error) {
        return safeSourceResult('unavailable', acquired.observedAt, {
          fromCache: acquired.fromCache,
          issueCode: safeIssueCode(error?.code, 'normalization_unavailable')
        });
      }
    }
  });
}

export function createEspnNewsAdapter({
  load,
  now,
  ttlMs = NEWS_SOURCE_REFRESH_MS.ESPN
} = {}) {
  return createCachedNewsAdapter({
    id: 'espn-nfl-injury',
    sourceType: 'espn',
    trust: 'existing_provider',
    load,
    now,
    ttlMs,
    normalize(payload, scope, metadata) {
      const rows = Array.isArray(payload?.injuries) ? payload.injuries : extractRows(payload);
      const scopedPlayers = scopePlayers(scope);
      return rows.filter((row) => row?.stale !== true).map((injury) => {
        const providerId = idOrNull(injury?.playerId ?? injury?.player_id ?? injury?.athlete?.id);
        const playerId = resolveProviderPlayerId(providerId, 'espn', scopedPlayers);
        if (scopedPlayers.length && !playerId) return null;
        const practiceStatus = injury?.practiceStatus ?? injury?.practice_status ?? injury?.injury?.practiceStatus;
        const availabilityStatus = injury?.availabilityStatus ?? injury?.availability_status ?? injury?.status
          ?? injury?.designation?.description ?? injury?.designation?.abbreviation
          ?? injury?.injury?.fantasyStatus?.description ?? injury?.injury?.fantasyStatus?.abbreviation;
        return normalizeNewsEvent({
          ...injury,
          playerId,
          player: { id: playerId, name: injury?.name ?? injury?.player?.name },
          normalizedEventType: availabilityStatus ? 'availability' : 'practice',
          availabilityStatus,
          practiceStatus,
          publishedAt: injury?.updatedAt ?? injury?.publishedAt,
          observedAt: injury?.retrievedAt ?? metadata.observedAt,
          sourceReference: injury?.injuryId ?? injury?.sourceReference,
          headline: injury?.shortComment ?? structuredHeadline(injury?.name, availabilityStatus, practiceStatus)
        }, {
          source: 'espn-nfl-injury',
          sourceType: 'espn',
          trust: 'existing_provider',
          season: scope?.season,
          week: scope?.week,
          gameId: scope?.gameId,
          kickoffAt: scope?.kickoffAt,
          observedAt: metadata.observedAt
        });
      }).filter((event) => relevantToScope(event, scope));
    }
  });
}

export function createSleeperNewsAdapter({
  load,
  now,
  ttlMs = NEWS_SOURCE_REFRESH_MS.SLEEPER
} = {}) {
  return createCachedNewsAdapter({
    id: 'sleeper',
    sourceType: 'sleeper',
    trust: 'existing_provider',
    load,
    now,
    ttlMs,
    normalize(payload, scope, metadata) {
      const scopedPlayers = scopePlayers(scope);
      return extractSleeperPlayers(payload).map((player) => {
        const providerId = sleeperProviderId(player);
        const playerId = resolveProviderPlayerId(providerId, 'sleeper', scopedPlayers)
          ?? exactCanonicalPlayerId(player?.playerId ?? player?.player_id, scopedPlayers);
        if (scopedPlayers.length && !playerId) return null;
        const availabilityStatus = player?.availabilityStatus ?? player?.availability_status
          ?? player?.injuryStatus ?? player?.injury_status ?? player?.status;
        if (!availabilityStatus) return null;
        return normalizeNewsEvent({
          playerId,
          player: { id: playerId, name: player?.name ?? player?.full_name },
          team: normalizePlayerTeam(player),
          normalizedEventType: 'availability',
          availabilityStatus,
          publishedAt: player?.statusUpdatedAt ?? player?.status_updated_at ?? player?.updatedAt ?? player?.updated_at,
          observedAt: player?.retrievedAt ?? metadata.observedAt,
          sourceReference: player?.sourceReference ?? player?.source_reference ?? providerId,
          headline: structuredHeadline(player?.name ?? player?.full_name, availabilityStatus)
        }, {
          source: 'sleeper',
          sourceType: 'sleeper',
          trust: 'existing_provider',
          season: scope?.season,
          week: scope?.week,
          gameId: scope?.gameId,
          kickoffAt: scope?.kickoffAt,
          observedAt: metadata.observedAt
        });
      }).filter((event) => relevantToScope(event, scope));
    }
  });
}

export function createOfficialNflNewsAdapter({
  load,
  now,
  ttlMs = NEWS_SOURCE_REFRESH_MS.OFFICIAL_NFL
} = {}) {
  return createStructuredOfficialAdapter({
    id: 'official-nfl',
    sourceType: 'official_nfl',
    source: 'official-nfl',
    trust: 'official_primary',
    load,
    now,
    ttlMs
  });
}

export function createOfficialTeamNewsAdapter({
  load,
  now,
  ttlMs = NEWS_SOURCE_REFRESH_MS.OFFICIAL_TEAM_NEWS
} = {}) {
  return createStructuredOfficialAdapter({
    id: 'official-team-news',
    sourceType: 'official_team_news',
    source: 'official-team-news',
    trust: 'official_secondary',
    cacheKey: officialTeamSourceCacheKey,
    load,
    now,
    ttlMs
  });
}

export function createOfficialTeamReportNewsAdapter({
  load,
  now,
  ttlMs = NEWS_SOURCE_REFRESH_MS.OFFICIAL_TEAM_REPORT
} = {}) {
  return createStructuredOfficialAdapter({
    id: 'official-team-report',
    sourceType: 'official_team_report',
    source: 'official-team-report',
    trust: 'official_primary',
    cacheKey: officialTeamSourceCacheKey,
    load,
    now,
    ttlMs
  });
}

export function createOfficialTeamTransactionNewsAdapter({
  load,
  now,
  ttlMs = NEWS_SOURCE_REFRESH_MS.OFFICIAL_TEAM_TRANSACTION
} = {}) {
  return createStructuredOfficialAdapter({
    id: 'official-team-transaction',
    sourceType: 'official_team_transaction',
    source: 'official-team-transaction',
    trust: 'official_primary',
    cacheKey: officialTeamSourceCacheKey,
    load,
    now,
    ttlMs
  });
}

/** Represent a paid, authenticated, or access-controlled candidate safely. */
export function createUnsupportedNewsAdapter({
  id = 'unsupported-source',
  sourceType = 'unsupported',
  now = () => new Date()
} = {}) {
  const adapterId = compactText(id, MAX_SOURCE_LENGTH);
  const adapterType = normalizeToken(sourceType);
  if (!adapterId || !adapterType) throw new TypeError('Unsupported source id and sourceType are required');
  return Object.freeze({
    id: adapterId,
    sourceType: adapterType,
    trust: null,
    trustLevel: null,
    async collect() {
      return safeSourceResult('source_not_supported', resolveClock(now).date.toISOString(), {
        issueCode: 'source_not_supported'
      });
    }
  });
}

/**
 * Normalize one already-structured source fact. Headline prose is retained only
 * as a short display field and is never parsed to invent an event or status.
 */
export function normalizeNewsEvent(raw, defaults = {}) {
  if (!isPlainObject(raw)) return null;
  const source = compactText(defaults.source ?? raw.source, MAX_SOURCE_LENGTH);
  const sourceType = normalizeToken(defaults.sourceType ?? defaults.source_type ?? raw.sourceType ?? raw.source_type);
  const trust = normalizeTrust(defaults.trustLevel ?? defaults.trust ?? raw.trustLevel ?? raw.trust_level ?? raw.trust);
  if (!source || !sourceType || !trust) return null;

  const availabilityStatus = normalizeAvailability(
    raw.availabilityStatus ?? raw.availability_status ?? raw.designation?.description
      ?? raw.designation?.abbreviation ?? raw.injury?.fantasyStatus?.description
      ?? raw.injury?.fantasyStatus?.abbreviation
  );
  const practiceStatus = normalizePractice(raw.practiceStatus ?? raw.practice_status ?? raw.injury?.practiceStatus);
  const roleStatus = normalizeRole(raw.roleStatus ?? raw.role_status);
  const gameStatus = normalizeGameStatus(raw.gameStatus ?? raw.game_status);
  const normalizedEventType = normalizeEventType(
    raw.normalizedEventType ?? raw.normalized_event_type ?? raw.eventType ?? raw.event_type,
    { availabilityStatus, practiceStatus, roleStatus, gameStatus }
  );
  if (!normalizedEventType) return null;

  const inferred = inferStatusFields(normalizedEventType, raw.normalizedStatus ?? raw.normalized_status ?? raw.status, {
    availabilityStatus,
    practiceStatus,
    roleStatus,
    gameStatus
  });
  const normalizedStatus = normalizedEventStatus(normalizedEventType, raw.normalizedStatus ?? raw.normalized_status, inferred);
  if (!normalizedStatus) return null;

  const playerInput = raw.playerId ?? raw.player_id ?? raw.player?.id ?? raw.athlete?.id;
  const resolvedPlayerId = typeof defaults.resolvePlayerId === 'function'
    ? defaults.resolvePlayerId(playerInput, raw)
    : canonicalPlayerId(playerInput);
  const playerName = compactText(raw.player?.name ?? raw.playerName ?? raw.player_name ?? raw.name ?? raw.athlete?.displayName, 120);
  const player = resolvedPlayerId || playerName ? { id: resolvedPlayerId, name: playerName } : null;
  const team = normalizeTeam(raw.team, raw);
  const observedAt = isoOrNull(raw.observedAt ?? raw.observed_at ?? raw.retrievedAt ?? raw.retrieved_at ?? defaults.observedAt)
    ?? isoOrNull(defaults.observedAt);
  if (!observedAt) return null;
  const publishedAt = isoOrNull(raw.publishedAt ?? raw.published_at ?? raw.createdAt ?? raw.created_at
    ?? raw.updatedAt ?? raw.updated_at ?? raw.date);
  const season = positiveIntegerOrNull(raw.season ?? defaults.season);
  const week = positiveIntegerOrNull(raw.week ?? defaults.week);
  const gameId = idOrNull(raw.gameId ?? raw.game_id ?? raw.nflGameId ?? raw.nfl_game_id ?? defaults.gameId);
  const kickoffAt = isoOrNull(raw.kickoffAt ?? raw.kickoff_at ?? raw.kickoff ?? defaults.kickoffAt);
  const sourceReference = compactText(
    raw.sourceReference ?? raw.source_reference ?? raw.reference ?? raw.injuryId ?? raw.id,
    MAX_REFERENCE_LENGTH
  );
  const sourceUrl = safePublicUrl(raw.sourceUrl ?? raw.source_url ?? raw.url);
  const headline = compactText(raw.headline ?? raw.title ?? raw.shortComment ?? raw.text, MAX_HEADLINE_LENGTH);
  const affectedPlayerIds = normalizeAffectedPlayerIds(
    raw.affectedPlayerIds ?? raw.affected_player_ids,
    defaults.resolvePlayerId
  );
  const authorityPriority = newsAuthorityPriorityFor({ sourceType, trust, normalizedEventType });
  const eventId = compactText(raw.eventId ?? raw.event_id, MAX_REFERENCE_LENGTH)
    ?? generatedEventId({ source, sourceReference, season, week, gameId, team, playerId: resolvedPlayerId, normalizedEventType, normalizedStatus, publishedAt });

  return {
    eventId,
    source,
    sourceType,
    publishedAt,
    observedAt,
    season,
    week,
    gameId,
    kickoffAt,
    team,
    player,
    playerId: resolvedPlayerId,
    affectedPlayerIds,
    normalizedEventType,
    normalizedStatus,
    availabilityStatus: inferred.availabilityStatus,
    practiceStatus: inferred.practiceStatus,
    roleStatus: inferred.roleStatus,
    gameStatus: inferred.gameStatus,
    headline,
    sourceUrl,
    sourceReference,
    trust,
    trustLevel: trust,
    authorityPriority
  };
}

function createStructuredOfficialAdapter({ id, sourceType, source, trust, cacheKey, load, now, ttlMs }) {
  return createCachedNewsAdapter({
    id,
    sourceType,
    trust,
    ...(cacheKey ? { cacheKey } : {}),
    load,
    now,
    ttlMs,
    normalize(payload, scope, metadata) {
      const players = scopePlayers(scope);
      return extractRows(payload).map((row) => normalizeNewsEvent(row, {
        source: row?.source ?? source,
        sourceType,
        trust,
        season: scope?.season,
        week: scope?.week,
        gameId: scope?.gameId,
        kickoffAt: scope?.kickoffAt,
        observedAt: metadata.observedAt,
        resolvePlayerId: (value) => resolveStructuredPlayerId(value, players, scope)
      })).filter((event) => relevantToScope(event, scope));
    }
  });
}

function inferStatusFields(eventType, rawStatus, input) {
  const result = { ...input };
  if (eventType === 'return_from_injury' && !result.availabilityStatus) result.availabilityStatus = 'active';
  if (eventType === 'disciplinary' && !result.availabilityStatus) result.availabilityStatus = normalizeAvailability(rawStatus);
  if (eventType === 'starter_change' && !result.roleStatus) result.roleStatus = normalizeRole(rawStatus) || 'starter';
  if (eventType === 'backup_change' && !result.roleStatus) result.roleStatus = normalizeRole(rawStatus) || 'backup';
  if (['snap_limitation', 'depth_chart', 'role_change', 'emergency_status'].includes(eventType) && !result.roleStatus) {
    result.roleStatus = normalizeRole(rawStatus);
  }
  if (eventType === 'availability' && !result.availabilityStatus) result.availabilityStatus = normalizeAvailability(rawStatus);
  if (eventType === 'practice' && !result.practiceStatus) result.practiceStatus = normalizePractice(rawStatus);
  if (eventType === 'game_status' && !result.gameStatus) result.gameStatus = normalizeGameStatus(rawStatus);
  return result;
}

function normalizedEventStatus(eventType, explicit, fields) {
  const normalizedExplicit = normalizeGenericStatus(explicit);
  if (normalizedExplicit) return normalizedExplicit;
  if (eventType === 'game_status') return fields.gameStatus;
  if (eventType === 'practice') return fields.practiceStatus;
  if (['availability', 'return_from_injury', 'disciplinary'].includes(eventType)) return fields.availabilityStatus;
  return fields.roleStatus ?? fields.availabilityStatus ?? fields.practiceStatus ?? fields.gameStatus;
}

function normalizeEventType(value, fields) {
  const token = normalizeToken(value);
  const aliases = {
    injury: 'availability', injury_status: 'availability', availability_status: 'availability', player_status: 'availability',
    practice_status: 'practice', practice_report: 'practice',
    return: 'return_from_injury', activated: 'return_from_injury', injury_return: 'return_from_injury',
    snap_limit: 'snap_limitation', limited_snaps: 'snap_limitation',
    starter: 'starter_change', named_starter: 'starter_change',
    backup: 'backup_change', named_backup: 'backup_change',
    suspension: 'disciplinary', discipline: 'disciplinary',
    depth_chart_change: 'depth_chart',
    role: 'role_change',
    emergency: 'emergency_status',
    game: 'game_status', schedule_status: 'game_status'
  };
  const normalized = aliases[token] || token;
  if (EVENT_TYPE_SET.has(normalized)) return normalized;
  if (fields.gameStatus) return 'game_status';
  if (fields.availabilityStatus) return 'availability';
  if (fields.practiceStatus) return 'practice';
  if (fields.roleStatus) return 'role_change';
  return null;
}

function normalizeAvailability(value) {
  const token = normalizeToken(value);
  const aliases = {
    q: 'questionable', d: 'doubtful', o: 'out', p: 'probable',
    daytoday: 'day_to_day', day_to_day: 'day_to_day',
    injured_reserve: 'ir', injured_reserve_designated_for_return: 'ir',
    physically_unable_to_perform: 'pup', non_football_injury: 'nfi',
    healthy: 'active', available: 'active', cleared: 'active',
    did_not_play: 'inactive'
  };
  const normalized = aliases[token] || token;
  return new Set(['active', 'probable', 'questionable', 'doubtful', 'out', 'inactive', 'ir', 'pup', 'nfi', 'suspended', 'day_to_day']).has(normalized)
    ? normalized : null;
}

function normalizePractice(value) {
  const token = normalizeToken(value);
  const aliases = {
    fp: 'full', full_participation: 'full', full_participant: 'full',
    lp: 'limited', limited_participation: 'limited', limited_participant: 'limited',
    dnp: 'did_not_practice', did_not_participate: 'did_not_practice',
    did_not_participate_in_practice: 'did_not_practice', didnotpractice: 'did_not_practice',
    not_listed: 'not_listed'
  };
  const normalized = aliases[token] || token;
  return new Set(['full', 'limited', 'did_not_practice', 'not_listed']).has(normalized) ? normalized : null;
}

function normalizeRole(value) {
  const token = normalizeToken(value);
  const aliases = {
    first_string: 'starter', second_string: 'backup',
    rb_by_committee: 'committee', committee_backfield: 'committee',
    snap_count: 'snap_limited', limited_snaps: 'snap_limited',
    practice_squad_elevation: 'elevated', emergency_qb: 'emergency'
  };
  const normalized = aliases[token] || token;
  return new Set(['starter', 'backup', 'committee', 'snap_limited', 'elevated', 'demoted', 'inactive', 'emergency', 'expanded', 'reduced']).has(normalized)
    ? normalized : null;
}

function normalizeGameStatus(value) {
  const token = normalizeToken(value);
  const aliases = { canceled: 'cancelled', rescheduled: 'postponed', delay: 'delayed' };
  const normalized = aliases[token] || token;
  return new Set(['scheduled', 'delayed', 'postponed', 'cancelled', 'suspended', 'in_progress', 'final']).has(normalized)
    ? normalized : null;
}

function normalizeGenericStatus(value) {
  return normalizeAvailability(value) ?? normalizePractice(value) ?? normalizeRole(value) ?? normalizeGameStatus(value);
}

export function newsAuthorityPriorityFor({ sourceType, trustLevel, trust, normalizedEventType }) {
  sourceType = normalizeToken(sourceType);
  trust = normalizeTrust(trustLevel ?? trust);
  if (!trust) return NEWS_AUTHORITY_PRIORITY.EXISTING_PROVIDER;
  if (trust === 'existing_provider') return NEWS_AUTHORITY_PRIORITY.EXISTING_PROVIDER;
  if (trust === 'official_secondary') return NEWS_AUTHORITY_PRIORITY.OFFICIAL_TEAM_STATEMENT;
  if (sourceType === 'official_team_transaction'
    || ['depth_chart', 'starter_change', 'backup_change', 'role_change'].includes(normalizedEventType)) {
    return NEWS_AUTHORITY_PRIORITY.OFFICIAL_TRANSACTION_OR_DEPTH_CHART;
  }
  if (normalizedEventType === 'practice') return NEWS_AUTHORITY_PRIORITY.OFFICIAL_PRACTICE_REPORT;
  if (['game_status', 'availability', 'return_from_injury'].includes(normalizedEventType)) {
    return NEWS_AUTHORITY_PRIORITY.OFFICIAL_GAME_OR_INJURY_DESIGNATION;
  }
  return NEWS_AUTHORITY_PRIORITY.OFFICIAL_TRANSACTION_OR_DEPTH_CHART;
}

function extractSleeperPlayers(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.players)) return payload.players;
  if (Array.isArray(payload?.roster)) return payload.roster;
  if (isPlainObject(payload?.players)) return Object.entries(payload.players).map(([id, player]) => ({ ...player, sleeperPlayerId: id }));
  return [];
}

function sleeperProviderId(player) {
  const direct = idOrNull(player?.sleeperPlayerId ?? player?.sleeper_player_id ?? player?.externalIds?.sleeper ?? player?.platformPlayerId);
  if (direct) return direct;
  const prefixed = /^sleeper:(.+)$/i.exec(String(player?.playerId ?? player?.player_id ?? ''));
  return idOrNull(prefixed?.[1]);
}

function resolveProviderPlayerId(providerId, provider, players) {
  const id = idOrNull(providerId)?.replace(new RegExp(`^${provider}:`, 'i'), '');
  if (!id) return null;
  if (!players.length) return `${provider}:${id}`;
  for (const player of players) {
    const canonical = canonicalPlayerId(player?.playerId ?? player?.player_id ?? player?.id);
    if (!canonical) continue;
    if (canonical.toLowerCase() === `${provider}:${id}`.toLowerCase()) return canonical;
    const external = idOrNull(player?.externalIds?.[provider] ?? player?.external_ids?.[provider]);
    if (external === id) return canonical;
    const platform = normalizeToken(player?.platform);
    if (platform === provider && idOrNull(player?.platformPlayerId ?? player?.platform_player_id) === id) return canonical;
  }
  return null;
}

function resolveStructuredPlayerId(value, players, scope = null) {
  const id = idOrNull(value);
  if (!id) return null;
  const indexed = scope?.playerAliasIndex instanceof Map
    ? scope.playerAliasIndex.get(id)
    : scope?.playerAliasIndex?.[id];
  if (canonicalPlayerId(indexed)) return indexed;
  const canonical = canonicalPlayerId(id);
  if (!players.length) return canonical;
  for (const player of players) {
    const candidate = canonicalPlayerId(player?.playerId ?? player?.player_id ?? player?.id);
    if (candidate === id || (canonical && candidate === canonical)) return candidate;
    for (const [provider, external] of Object.entries(player?.externalIds ?? player?.external_ids ?? {})) {
      const externalId = idOrNull(external);
      if (externalId === id || `${provider}:${externalId}` === id) return candidate;
    }
  }
  return null;
}

function exactCanonicalPlayerId(value, players) {
  const id = canonicalPlayerId(value);
  if (!id) return null;
  if (!players.length) return id;
  return players.map((player) => canonicalPlayerId(player?.playerId ?? player?.player_id ?? player?.id)).find((candidate) => candidate === id) ?? null;
}

function canonicalPlayerId(value) {
  const id = idOrNull(value);
  return id && /^[a-z][a-z0-9_-]{1,31}:[^\s:][^\s]*$/i.test(id) ? id : null;
}

function scopePlayers(scope) {
  const rows = [];
  for (const value of [scope?.players, scope?.rosterPlayers, scope?.roster_players, scope?.roster]) {
    if (Array.isArray(value)) rows.push(...value);
  }
  for (const team of Array.isArray(scope?.teams) ? scope.teams : []) {
    if (Array.isArray(team?.roster)) rows.push(...team.roster);
  }
  return rows.filter(isPlainObject);
}

function relevantToScope(event, scope) {
  if (!event) return false;
  const players = scopePlayers(scope);
  const relevantPlayerIds = new Set(players.map((player) => canonicalPlayerId(player?.playerId ?? player?.player_id ?? player?.id)).filter(Boolean));
  for (const value of arrayValue(scope?.playerIds ?? scope?.player_ids ?? scope?.relevantPlayerIds ?? scope?.relevant_player_ids)) {
    const id = canonicalPlayerId(value);
    if (id) relevantPlayerIds.add(id);
  }
  const relevantTeamIds = scopeTeamIds(scope, players);
  if (!relevantPlayerIds.size && !relevantTeamIds.size) return true;
  if (event.playerId && relevantPlayerIds.has(event.playerId)) return true;
  if (event.affectedPlayerIds.some((id) => relevantPlayerIds.has(id))) return true;
  const eventTeamIds = [event.team?.id, event.team?.abbreviation].map(normalizeNflTeamIdentity).filter(Boolean);
  if (eventTeamIds.some((id) => relevantTeamIds.has(id))) {
    return event.playerId == null && event.player?.name == null;
  }
  return false;
}

function scopeTeamIds(scope, players) {
  const ids = new Set();
  const supplied = [scope?.teamIds, scope?.team_ids, scope?.relevantTeamIds, scope?.relevant_team_ids, scope?.opponentTeamIds, scope?.opponent_team_ids];
  for (const values of supplied) for (const value of arrayValue(values)) {
    const id = normalizeNflTeamIdentity(value?.id ?? value?.abbreviation ?? value);
    if (id) ids.add(id);
  }
  for (const player of players) {
    for (const value of [player?.nflTeamId, player?.nfl_team_id, player?.nflTeam, player?.nfl_team, player?.team?.id, player?.team?.abbreviation]) {
      const id = normalizeNflTeamIdentity(value);
      if (id) ids.add(id);
    }
  }
  return ids;
}

function normalizePlayerTeam(player) {
  const id = idOrNull(player?.nflTeamId ?? player?.nfl_team_id ?? player?.team?.id);
  const abbreviation = compactText(player?.nflTeam ?? player?.nfl_team ?? player?.team?.abbreviation, 12);
  const name = compactText(player?.team?.name, 100);
  return id || abbreviation || name ? { id, name, abbreviation } : null;
}

function normalizeTeam(teamValue, raw) {
  const team = isPlainObject(teamValue) ? teamValue : {};
  const id = idOrNull(team.id ?? raw.teamId ?? raw.team_id ?? raw.nflTeamId ?? raw.nfl_team_id);
  const name = compactText(team.name ?? team.displayName ?? raw.teamName ?? raw.team_name, 100);
  const abbreviation = compactText(team.abbreviation ?? team.abbrev ?? raw.teamAbbreviation ?? raw.team_abbreviation, 12);
  return id || name || abbreviation ? { id, name, abbreviation } : null;
}

function normalizeAffectedPlayerIds(values, resolver) {
  const ids = [];
  for (const value of arrayValue(values)) {
    const id = typeof resolver === 'function' ? resolver(value) : canonicalPlayerId(value);
    if (id) ids.push(id);
  }
  return [...new Set(ids)].sort();
}

function normalizeNflTeamIdentity(value) {
  const id = idOrNull(value);
  if (!id) return null;
  const match = /^nfl-team:(.+)$/i.exec(id);
  return `nfl-team:${(match?.[1] ?? id).toUpperCase()}`;
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.events)) return payload.events;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.news)) return payload.news;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function isCommonNewsEvent(event) {
  return isPlainObject(event)
    && compactText(event.eventId, MAX_REFERENCE_LENGTH) != null
    && EVENT_TYPE_SET.has(event.normalizedEventType)
    && TRUST_SET.has(event.trust)
    && Number.isInteger(event.authorityPriority);
}

function uniqueEvents(events) {
  const map = new Map();
  for (const event of events) if (event && !map.has(event.eventId)) map.set(event.eventId, event);
  return [...map.values()];
}

function generatedEventId(parts) {
  const basis = [
    parts.source,
    parts.sourceReference,
    parts.season,
    parts.week,
    parts.gameId,
    parts.team?.id,
    parts.team?.abbreviation,
    parts.playerId,
    parts.normalizedEventType,
    parts.normalizedStatus,
    parts.publishedAt
  ].map((value) => value ?? '').join('|');
  return `news:${fnv1a(basis)}`;
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function sourceCacheKey(scope) {
  const season = positiveIntegerOrNull(scope?.season) ?? 'season';
  const week = positiveIntegerOrNull(scope?.week) ?? 'week';
  const version = compactText(scope?.dataVersion ?? scope?.data_version ?? scope?.sourceVersion ?? scope?.source_version, 80) ?? 'current';
  return `${season}|${week}|${version}`;
}

function officialTeamSourceCacheKey(scope) {
  const teams = [...scopeTeamIds(scope, scopePlayers(scope))].sort();
  return `${sourceCacheKey(scope)}|teams:${teams.join(',') || 'none'}`;
}

function safeSourceResult(status, observedAt, {
  fromCache = false,
  retryAfterMs: retry = null,
  issueCode = null
} = {}) {
  const result = { status, observedAt, events: [], fromCache: fromCache === true };
  if (Number.isFinite(retry) && retry >= 0) result.retryAfterMs = Math.round(retry);
  if (issueCode) result.issueCode = issueCode;
  return result;
}

function sourceStatus(value) {
  return ['ok', 'source_not_supported', 'unavailable', 'rate_limited'].includes(value) ? value : null;
}

function isRateLimited(error) {
  const code = normalizeToken(error?.code);
  return Number(error?.status ?? error?.statusCode) === 429 || code === 'rate_limited' || code === 'too_many_requests';
}

function retryAfterMs(value) {
  const direct = Number(value?.retryAfterMs ?? value?.retry_after_ms);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const seconds = Number(value?.retryAfter ?? value?.retry_after);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function safeIssueCode(value, fallback) {
  const code = normalizeToken(value);
  return code && SAFE_ISSUE_CODE.test(code) ? code : fallback;
}

function resolveClock(now) {
  let value;
  try { value = typeof now === 'function' ? now() : now; } catch { value = null; }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return { date: safeDate, ms: safeDate.getTime() };
}

function structuredHeadline(name, ...statuses) {
  const subject = compactText(name, 120);
  const detail = statuses.map((value) => compactText(value, 80)).filter(Boolean).join(' — ');
  return subject && detail ? `${subject}: ${detail}` : subject ?? detail ?? null;
}

function safePublicUrl(value) {
  const text = compactText(value, 500);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function isoOrNull(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeTrust(value) {
  const token = normalizeToken(value);
  if (token === 'official') return 'official_primary';
  if (token === 'secondary') return 'existing_provider';
  return TRUST_SET.has(token) ? token : null;
}

function normalizeToken(value) {
  const text = textOrNull(value);
  return text?.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') ?? null;
}

function compactText(value, limit) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  const characters = Array.from(normalized);
  return characters.length <= limit ? normalized : `${characters.slice(0, Math.max(0, limit - 1)).join('').trimEnd()}…`;
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function idOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return textOrNull(value);
}

function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
