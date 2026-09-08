import { evaluateNewsChanges } from '../news-change-evaluator.js';
import { newsAuthorityPriorityFor } from './source-adapters.js';

export const DEFAULT_NEWS_DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000;
export const NEWS_CONFLICT_STATUS = Object.freeze({
  RESOLVED: 'resolved_by_authority',
  UNRESOLVED: 'conflicting_reports'
});

const STATUS_FIELDS = Object.freeze([
  ['availabilityStatus', 'availability'],
  ['practiceStatus', 'practice'],
  ['roleStatus', 'role_change'],
  ['gameStatus', 'game_status']
]);

/**
 * Build an ID-only scope for the currently selected fantasy roster. Names are
 * deliberately not used as identity because two NFL players can share a name.
 */
export function buildRosterNewsScope({
  season,
  week,
  gameId = null,
  kickoffAt = null,
  rosterPlayers = [],
  opponentTeams = []
} = {}) {
  const playerIds = new Set();
  const teamIds = new Set();
  const playerAliasIndex = new Map();
  const playerAliasesByCanonical = new Map();
  const teamPlayerIds = new Map();

  for (const player of Array.isArray(rosterPlayers) ? rosterPlayers : []) {
    const canonical = textOrNull(player?.playerId);
    if (!canonical) continue;
    const aliases = new Set([
      canonical,
      prefixedId('espn', player?.externalIds?.espn),
      prefixedId('sleeper', player?.externalIds?.sleeper),
      prefixedId('gsis', player?.externalIds?.gsis ?? player?.gsisId),
      player?.platform === 'espn' ? prefixedId('espn', player?.platformPlayerId) : null,
      player?.platform === 'sleeper' ? prefixedId('sleeper', player?.platformPlayerId) : null
    ].filter(Boolean));
    playerIds.add(canonical);
    playerAliasesByCanonical.set(canonical, aliases);
    for (const alias of aliases) playerAliasIndex.set(alias, canonical);

    for (const teamId of teamIdentityCandidates(player)) {
      teamIds.add(teamId);
      if (!teamPlayerIds.has(teamId)) teamPlayerIds.set(teamId, new Set());
      for (const alias of aliases) teamPlayerIds.get(teamId).add(alias);
    }
  }
  for (const team of Array.isArray(opponentTeams) ? opponentTeams : []) {
    for (const id of teamIdentityCandidates(team)) teamIds.add(id);
  }

  return {
    season,
    week,
    gameId,
    kickoffAt,
    rosterPlayers,
    playerIds: [...playerIds],
    teamIds: [...teamIds],
    playerAliasIndex,
    playerAliasesByCanonical,
    teamPlayerIds
  };
}

/**
 * Merge equivalent cross-source reports, apply the explicit authority order,
 * and preserve every safe source reference. This function is deterministic.
 */
export function reconcileNewsEvents(events, {
  dedupWindowMs = DEFAULT_NEWS_DEDUP_WINDOW_MS
} = {}) {
  if (!Number.isFinite(dedupWindowMs) || dedupWindowMs <= 0) {
    throw new TypeError('dedupWindowMs must be greater than zero');
  }
  const expanded = (Array.isArray(events) ? events : []).flatMap(expandStatusFields).filter(isReconcilable);
  const groups = new Map();

  for (const event of expanded) {
    const key = baseEventKey(event);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }

  const output = [];
  for (const [key, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const clusters = timeClusters(group, dedupWindowMs);
    for (let index = 0; index < clusters.length; index += 1) {
      output.push(reconcileCluster(clusters[index], `${key}|${index}`));
    }
  }
  return output.sort(compareCanonicalEvents);
}

/**
 * Run all adapters in one shared cycle. A rejected or unavailable source is
 * recorded in source health and cannot clear prior evaluator state.
 */
export async function runNewsSourceCycle({
  adapters = [],
  scope = {},
  analysis = null,
  evaluator = evaluateNewsChanges,
  evaluatorStore,
  now = () => new Date(),
  dedupWindowMs = DEFAULT_NEWS_DEDUP_WINDOW_MS
} = {}) {
  const observedAt = toIso(resolveNow(now));
  const configuredAdapters = (Array.isArray(adapters) ? adapters : []).filter((adapter) => adapter && typeof adapter.collect === 'function');
  const settled = await Promise.allSettled(configuredAdapters.map((adapter) => adapter.collect(scope)));
  const sourceHealth = [];
  const sourceEvents = [];

  for (let index = 0; index < settled.length; index += 1) {
    const adapter = configuredAdapters[index];
    const result = settled[index];
    if (result.status === 'rejected') {
      sourceHealth.push({
        source: textOrNull(adapter.id) || `adapter-${index + 1}`,
        sourceType: textOrNull(adapter.sourceType),
        status: 'unavailable',
        fromCache: false,
        issueCode: safeIssueCode(result.reason) || 'SOURCE_ADAPTER_FAILED'
      });
      continue;
    }
    const collected = safeCollection(adapter, result.value);
    sourceHealth.push(collected.health);
    if (collected.health.status === 'ok') sourceEvents.push(...collected.events);
  }

  const canonicalized = sourceEvents.map((event) => canonicalizeEventIdentity(event, scope));
  const relevant = canonicalized.filter((event) => eventIsRelevant(event, scope));
  const events = reconcileNewsEvents(relevant, { dedupWindowMs });
  const observations = lowerEventsToEvaluatorObservations(events, scope, observedAt);
  const evaluation = observations.length
    ? await evaluator(observations, {
      analysis,
      ...(evaluatorStore ? { store: evaluatorStore } : {})
    })
    : { stored: false, changed: false, evaluations: [] };
  const actionable = (evaluation?.evaluations || []).filter((item) =>
    item?.requires_reanalysis === true && ['meaningful', 'critical'].includes(item?.materiality));

  return {
    observedAt,
    sourceHealth,
    events,
    conflicts: events.filter((event) => event.conflictStatus != null),
    observations,
    evaluation,
    actionable
  };
}

function reconcileCluster(cluster, identity) {
  const candidates = [...cluster].sort(compareSourceCandidates);
  const bestPriority = Math.min(...candidates.map(authorityPriority));
  const best = candidates.filter((event) => authorityPriority(event) === bestPriority);
  const bestStatuses = new Set(best.map(eventStatus));
  const unresolved = bestStatuses.size > 1;
  const winner = best[0];
  const winnerStatus = unresolved ? NEWS_CONFLICT_STATUS.UNRESOLVED : eventStatus(winner);
  const conflicting = new Set(candidates.map(eventStatus)).size > 1;
  const provenance = uniqueProvenance(candidates);
  const field = eventFamily(winner);
  const affectedPlayerIds = uniqueText(candidates.flatMap((event) => [event.playerId, ...(event.affectedPlayerIds || [])]));
  const selectedFields = Object.fromEntries(STATUS_FIELDS.map(([name]) => [name, null]));
  if (!unresolved && STATUS_FIELDS.some(([name]) => name === field)) selectedFields[field] = eventStatus(winner);

  return {
    ...winner,
    ...selectedFields,
    eventId: stableEventId(identity, winnerStatus),
    normalizedEventType: familyEventType(field, winner.normalizedEventType),
    normalizedStatus: winnerStatus,
    trust: normalizeTrust(winner.trustLevel ?? winner.trust),
    trustLevel: normalizeTrust(winner.trustLevel ?? winner.trust),
    conflictStatus: unresolved
      ? NEWS_CONFLICT_STATUS.UNRESOLVED
      : conflicting ? NEWS_CONFLICT_STATUS.RESOLVED : null,
    observedAt: latestIso(candidates.map((event) => event.observedAt)) || winner.observedAt,
    affectedPlayerIds,
    provenance,
    supportingSources: uniqueText(provenance.filter((item) => item.normalizedStatus === winnerStatus).map((item) => item.source)),
    conflictingSources: unresolved || conflicting
      ? uniqueText(provenance.filter((item) => item.normalizedStatus !== eventStatus(winner)).map((item) => item.source))
      : []
  };
}

function lowerEventsToEvaluatorObservations(events, scope, observedAt) {
  const groups = new Map();
  for (const event of events) {
    if (event.conflictStatus === NEWS_CONFLICT_STATUS.UNRESOLVED) continue;
    const playerId = textOrNull(event.playerId);
    const teamId = textOrNull(event.team?.id);
    if (!playerId && !teamId) continue;
    if (!STATUS_FIELDS.some(([field]) => textOrNull(event[field]))) continue;
    const boundary = event.gameId || `week-${event.week}`;
    const key = [event.season, event.week, boundary, playerId ? 'player' : 'team', playerId || teamId].join('|');
    const current = groups.get(key) || {
      season: event.season,
      week: event.week,
      gameId: event.gameId,
      kickoffAt: event.kickoffAt,
      playerId,
      teamId,
      displayName: event.player?.name || event.team?.name || null,
      source: 'existing-context',
      availabilityStatus: null,
      practiceStatus: null,
      roleStatus: null,
      gameStatus: null,
      observedAt,
      affectedPlayerIds: []
    };
    for (const [field] of STATUS_FIELDS) if (event[field]) current[field] = event[field];
    current.affectedPlayerIds = uniqueText([
      ...current.affectedPlayerIds,
      ...affectedIdsForEvent(event, scope)
    ]);
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => observationKey(left).localeCompare(observationKey(right)));
}

function canonicalizeEventIdentity(event, scope) {
  const incoming = textOrNull(event?.playerId ?? event?.player?.id);
  const canonical = aliasLookup(scope?.playerAliasIndex, incoming) || incoming;
  const aliases = canonical ? aliasesFor(scope?.playerAliasesByCanonical, canonical) : [];
  const affectedPlayerIds = uniqueText([incoming, canonical, ...(event?.affectedPlayerIds || []), ...aliases]);
  const teamId = teamIdentityCandidates(event?.team)[0] || null;
  return {
    ...event,
    playerId: canonical,
    player: event?.player ? { ...event.player, id: canonical } : canonical ? { id: canonical, name: null } : null,
    team: event?.team ? { ...event.team, id: teamId } : teamId ? { id: teamId, name: null, abbreviation: null } : null,
    affectedPlayerIds
  };
}

function eventIsRelevant(event, scope) {
  const playerFilter = new Set([
    ...(Array.isArray(scope?.playerIds) ? scope.playerIds : []),
    ...(Array.isArray(scope?.rosterPlayerIds) ? scope.rosterPlayerIds : [])
  ].map(String));
  const teamFilter = new Set([
    ...(Array.isArray(scope?.teamIds) ? scope.teamIds : []),
    ...(Array.isArray(scope?.opponentTeamIds) ? scope.opponentTeamIds : [])
  ].map(String));
  const hasFilter = playerFilter.size > 0 || teamFilter.size > 0 || Array.isArray(scope?.rosterPlayers);
  if (!hasFilter) return true;
  const playerIds = uniqueText([event?.playerId, ...(event?.affectedPlayerIds || [])]);
  if (playerIds.length && playerIds.some((id) => playerFilter.has(id))) return true;
  if (playerIds.length) return false;
  const teamIds = teamIdentityCandidates(event?.team);
  return teamIds.some((id) => teamFilter.has(id));
}

function affectedIdsForEvent(event, scope) {
  const values = [event.playerId, ...(event.affectedPlayerIds || [])];
  if (!event.playerId && event.team?.id) values.push(...setValues(mapLookup(scope?.teamPlayerIds, event.team.id)));
  return uniqueText(values);
}

function safeCollection(adapter, value) {
  const allowedStatuses = new Set(['ok', 'source_not_supported', 'unavailable', 'rate_limited']);
  const status = allowedStatuses.has(value?.status) ? value.status : 'unavailable';
  return {
    health: {
      source: textOrNull(adapter.id) || 'unknown-adapter',
      sourceType: textOrNull(adapter.sourceType),
      status,
      observedAt: toIso(value?.observedAt),
      fromCache: value?.fromCache === true,
      ...(Number.isFinite(Number(value?.retryAfterMs)) && Number(value.retryAfterMs) >= 0
        ? { retryAfterMs: Number(value.retryAfterMs) } : {}),
      ...(safeIssueCode(value?.issueCode) ? { issueCode: safeIssueCode(value.issueCode) } : {})
    },
    events: status === 'ok' && Array.isArray(value?.events) ? value.events : []
  };
}

function expandStatusFields(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return [];
  const populated = STATUS_FIELDS.filter(([field]) => textOrNull(event[field]));
  if (populated.length <= 1) return [event];
  return populated.map(([selected, type]) => ({
    ...event,
    ...Object.fromEntries(STATUS_FIELDS.map(([field]) => [field, field === selected ? event[field] : null])),
    normalizedEventType: type,
    normalizedStatus: event[selected],
    authorityPriority: newsAuthorityPriorityFor({
      sourceType: event.sourceType,
      trustLevel: event.trustLevel ?? event.trust,
      normalizedEventType: type
    })
  }));
}

function isReconcilable(event) {
  return positiveInteger(event?.season) && positiveInteger(event?.week)
    && Boolean(textOrNull(event?.playerId) || textOrNull(event?.team?.id))
    && Boolean(eventFamily(event)) && Boolean(eventStatus(event));
}

function baseEventKey(event) {
  const boundary = textOrNull(event.gameId) || `week-${event.week}`;
  const entity = textOrNull(event.playerId) || textOrNull(event.team?.id);
  return [event.season, event.week, boundary, entity, eventFamily(event)].map((value) => encodeURIComponent(String(value))).join('|');
}

function timeClusters(events, dedupWindowMs) {
  const sorted = [...events].sort((left, right) => eventTime(left) - eventTime(right) || compareSourceCandidates(left, right));
  const clusters = [];
  for (const event of sorted) {
    const time = eventTime(event);
    const current = clusters.at(-1);
    if (!current || (time && current.latestTime && time - current.latestTime > dedupWindowMs)) {
      clusters.push({ events: [event], latestTime: time });
    } else {
      current.events.push(event);
      current.latestTime = Math.max(current.latestTime || 0, time || 0);
    }
  }
  return clusters.map((cluster) => cluster.events);
}

function compareSourceCandidates(left, right) {
  return authorityPriority(left) - authorityPriority(right)
    || eventTime(right) - eventTime(left)
    || String(left?.source || '').localeCompare(String(right?.source || ''))
    || String(left?.sourceReference || '').localeCompare(String(right?.sourceReference || ''));
}

function compareCanonicalEvents(left, right) {
  return eventTime(left) - eventTime(right) || String(left.eventId).localeCompare(String(right.eventId));
}

function uniqueProvenance(events) {
  const records = events.map((event) => ({
    source: textOrNull(event.source),
    sourceType: textOrNull(event.sourceType),
    trust: normalizeTrust(event.trustLevel ?? event.trust),
    trustLevel: normalizeTrust(event.trustLevel ?? event.trust),
    authorityPriority: authorityPriority(event),
    publishedAt: toIso(event.publishedAt),
    observedAt: toIso(event.observedAt),
    headline: compactText(event.headline, 240),
    sourceUrl: safeUrl(event.sourceUrl),
    sourceReference: compactText(event.sourceReference, 200),
    normalizedStatus: eventStatus(event)
  }));
  const seen = new Set();
  return records.filter((record) => {
    const key = JSON.stringify(record);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => left.authorityPriority - right.authorityPriority
    || String(right.publishedAt || '').localeCompare(String(left.publishedAt || ''))
    || String(left.source || '').localeCompare(String(right.source || '')));
}

function eventFamily(event) {
  for (const [field] of STATUS_FIELDS) if (textOrNull(event?.[field])) return field;
  return textOrNull(event?.normalizedEventType);
}

function eventStatus(event) {
  const family = eventFamily(event);
  return textOrNull(event?.[family]) || textOrNull(event?.normalizedStatus);
}

function familyEventType(field, fallback) {
  return STATUS_FIELDS.find(([name]) => name === field)?.[1] || fallback || field;
}

function authorityPriority(event) {
  const value = Number(event?.authorityPriority);
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : 5;
}

function normalizeTrust(value) {
  if (value === 'official') return 'official_primary';
  if (value === 'secondary') return 'existing_provider';
  return ['official_primary', 'official_secondary', 'existing_provider'].includes(value)
    ? value : 'existing_provider';
}

function eventTime(event) {
  return timestamp(event?.publishedAt) || timestamp(event?.observedAt) || 0;
}

function latestIso(values) {
  const latest = Math.max(...values.map(timestamp).filter(Boolean), 0);
  return latest ? new Date(latest).toISOString() : null;
}

function stableEventId(identity, status) {
  return `news:${encodeURIComponent(identity)}:${encodeURIComponent(String(status))}`;
}

function observationKey(value) {
  return [value.season, value.week, value.gameId || '', value.playerId || value.teamId || ''].join('|');
}

function aliasLookup(index, key) {
  if (!key || !index) return null;
  if (index instanceof Map) return textOrNull(index.get(key));
  return textOrNull(index[key]);
}

function aliasesFor(index, key) {
  if (!index || !key) return [];
  return setValues(mapLookup(index, key));
}

function mapLookup(index, key) {
  if (!index) return null;
  return index instanceof Map ? index.get(key) : index[key];
}

function setValues(value) {
  if (value instanceof Set) return [...value];
  return Array.isArray(value) ? value : [];
}

function teamIdentityCandidates(value) {
  if (!value || typeof value !== 'object') return [];
  return uniqueText([
    normalizeTeamId(value.id ?? value.nflTeamId),
    normalizeTeamId(value.abbreviation ?? value.nflTeam)
  ]);
}

function normalizeTeamId(value) {
  const id = textOrNull(value);
  if (!id) return null;
  return /^[a-z0-9_-]+:.+$/i.test(id) ? id : `nfl-team:${id.toUpperCase()}`;
}

function prefixedId(prefix, value) {
  const id = textOrNull(value);
  return id ? (/^[a-z0-9_-]+:.+$/i.test(id) ? id : `${prefix}:${id}`) : null;
}

function uniqueText(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(textOrNull).filter(Boolean))].sort();
}

function compactText(value, limit) {
  const text = textOrNull(value)?.replace(/\s+/g, ' ') || null;
  return text && text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function safeUrl(value) {
  const text = textOrNull(value);
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

function safeIssueCode(value) {
  const raw = typeof value === 'object' ? value?.code : value;
  const code = String(raw || '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,47}$/.test(code) ? code : null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function resolveNow(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now must resolve to a valid date');
  return date;
}

function timestamp(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : 0;
}

function toIso(value) {
  const time = value instanceof Date ? value.getTime() : timestamp(value);
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null;
}

function textOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}
