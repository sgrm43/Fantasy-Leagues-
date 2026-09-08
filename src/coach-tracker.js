import { readCoachTracker, saveCoachTracker } from './storage.js';
import { normalizeNflTeamAbbreviation } from './providers/espn-nfl-coaches.js';

export const COACHING_ROLES = Object.freeze(['headCoach', 'offensiveCoordinator', 'offensivePlayCaller', 'defensiveCoordinator', 'defensivePlayCaller']);
const EXTRA_ROLES = COACHING_ROLES.filter((role) => role !== 'headCoach');
let trackerQueue = Promise.resolve();

export function observeHeadCoach(observation) {
  return observeHeadCoaches([observation]).then((results) => results[0]);
}

export function observeHeadCoaches(observations) {
  return observeCoachRoles(observations.map((observation) => ({ ...observation, role: 'headCoach', status: 'verified' })));
}

/** Record verified or explicitly unverified role checks with one atomic write. */
export function observeCoachRoles(observations) {
  if (!Array.isArray(observations) || !observations.length) throw new TypeError('observations must contain at least one coaching role');
  const job = trackerQueue.then(async () => {
    let state = await readCoachTracker();
    const results = [];
    let stateChanged = false;
    for (const observation of observations) {
      const update = updateCoachRoleTrackerState(state, observation);
      state = update.state;
      stateChanged ||= update.stateChanged;
      results.push({ ...withoutState(update), teamAbbreviation: normalizeNflTeamAbbreviation(observation.teamAbbreviation) });
    }
    if (stateChanged) await saveCoachTracker(state);
    return results;
  });
  trackerQueue = job.then(() => undefined, () => undefined);
  return job;
}

export async function getTrackedHeadCoach(season, teamAbbreviation) {
  const tracked = await getTrackedCoachRole(season, teamAbbreviation, 'headCoach');
  return tracked?.lastKnownPeriod ? { ...tracked.lastKnownPeriod, season: Number(season), teamAbbreviation: normalizeNflTeamAbbreviation(teamAbbreviation) } : null;
}

export async function getTrackedCoachRole(season, teamAbbreviation, role) {
  await trackerQueue;
  const normalizedSeason = positiveInteger(season, 'season');
  const team = normalizeNflTeamAbbreviation(teamAbbreviation);
  const normalizedRole = coachingRole(role);
  if (!team) return null;
  const state = normalizeState(await readCoachTracker());
  const entry = state.teams[`${normalizedSeason}:${team}`];
  if (!entry) return null;
  const periods = periodsFor(entry, normalizedRole);
  const lastKnownPeriod = periods.at(-1) || null;
  const check = entry.roleChecks?.[normalizedRole] || null;
  const expired = check?.expiresAt && Date.parse(check.expiresAt) <= Date.now();
  const status = expired ? 'not_verified' : check?.status || (lastKnownPeriod ? 'verified' : 'not_verified');
  return { role: normalizedRole, status, period: status === 'verified' ? lastKnownPeriod : null, lastKnownPeriod, check };
}

/** Backward-compatible head-coach state transition. */
export function updateCoachTrackerState(input, observation = {}) {
  return updateCoachRoleTrackerState(input, { ...observation, role: 'headCoach', status: 'verified' });
}

/** Pure role-specific transition. A change affects only the requested role. */
export function updateCoachRoleTrackerState(input, {
  season, week, teamAbbreviation, role = 'headCoach', status = 'verified', coachId = null, coachName = null,
  observedAt = new Date().toISOString(), sourceUrl = null, sourceKey = null, sourceUpdatedAt = null, expiresAt = null, reasonCode = null
} = {}) {
  const normalizedSeason = positiveInteger(season, 'season');
  const normalizedWeek = positiveInteger(week, 'week');
  const team = normalizeNflTeamAbbreviation(teamAbbreviation);
  const normalizedRole = coachingRole(role);
  const verificationStatus = status === 'not_verified' ? 'not_verified' : status === 'verified' ? 'verified' : null;
  const coach = textOrNull(coachName);
  const id = textOrNull(coachId);
  const timestamp = toIso(observedAt);
  const normalizedSourceUpdatedAt = toIso(sourceUpdatedAt);
  const normalizedExpiresAt = toIso(expiresAt);
  if (!team) throw new TypeError('teamAbbreviation is required');
  if (!verificationStatus) throw new TypeError('status must be verified or not_verified');
  if (verificationStatus === 'verified' && !coach) throw new TypeError('coachName is required for a verified role');
  if (!timestamp) throw new TypeError('observedAt must be a valid date');

  const state = normalizeState(input);
  const key = `${normalizedSeason}:${team}`;
  const entry = state.teams[key] || emptyEntry(normalizedSeason, team);
  const periods = periodsFor(entry, normalizedRole);
  const current = periods.at(-1) || null;
  const priorCheck = entry.roleChecks[normalizedRole] || null;
  const priorWeek = priorCheck?.checkedWeek ?? current?.lastSeenWeek;
  const priorTimestamp = priorCheck?.checkedAt ?? current?.lastSeenAt;
  if (priorWeek && priorTimestamp && compareObservation(normalizedWeek, timestamp, priorWeek, priorTimestamp) < 0) {
    return unchanged(state, normalizedRole, current, priorCheck, 'out_of_order_observation');
  }
  if (priorCheck?.sourceUpdatedAt && normalizedSourceUpdatedAt && Date.parse(normalizedSourceUpdatedAt) < Date.parse(priorCheck.sourceUpdatedAt)) {
    return unchanged(state, normalizedRole, current, priorCheck, 'older_source_version');
  }

  if (verificationStatus === 'not_verified') {
    if (priorCheck?.status === 'verified') {
      return unchanged(state, normalizedRole, current, priorCheck, 'unverified_check_cannot_downgrade_verified_role');
    }
    const check = roleCheck({ status: verificationStatus, week: normalizedWeek, timestamp, sourceUrl, sourceKey, sourceUpdatedAt: normalizedSourceUpdatedAt, expiresAt: normalizedExpiresAt, reasonCode, tenureId: null });
    const stateChanged = JSON.stringify(priorCheck) !== JSON.stringify(check);
    entry.roleChecks[normalizedRole] = check;
    state.teams[key] = entry;
    if (stateChanged) state.updatedAt = timestamp;
    return { state, role: normalizedRole, period: null, lastKnownPeriod: current, changed: false, previousCoach: null, ignored: false, reason: reasonCode, verificationStatus, stateChanged };
  }

  let period = current;
  let changed = false;
  let previousCoach = null;
  let stateChanged = false;
  if (current && priorWeek === normalizedWeek && priorTimestamp === timestamp && !sameCoach(current, { id, name: coach })) {
    return unchanged(state, normalizedRole, current, priorCheck, 'conflicting_observation');
  }
  if (!current) {
    period = newPeriod(normalizedSeason, team, normalizedRole, id, coach, normalizedWeek, timestamp, sourceUrl);
    periods.push(period); stateChanged = true;
  } else if (sameCoach(current, { id, name: coach })) {
    const nextId = current.coachId || id;
    stateChanged = current.coachId !== nextId || current.coachName !== coach || current.lastSeenWeek !== normalizedWeek || current.lastSeenAt !== timestamp || (textOrNull(sourceUrl) && current.sourceUrl !== textOrNull(sourceUrl));
    current.coachId = nextId; current.coachName = coach; current.lastSeenWeek = Math.max(current.lastSeenWeek, normalizedWeek); current.lastSeenAt = timestamp; current.sourceUrl = textOrNull(sourceUrl) || current.sourceUrl || null;
    period = current;
  } else {
    previousCoach = current.coachName;
    current.endWeek = Math.max(current.startWeek, normalizedWeek - 1);
    current.endedWhenDetectedAt = timestamp;
    period = newPeriod(normalizedSeason, team, normalizedRole, id, coach, normalizedWeek, timestamp, sourceUrl);
    periods.push(period); changed = true; stateChanged = true;
  }
  const check = roleCheck({ status: verificationStatus, week: normalizedWeek, timestamp, sourceUrl, sourceKey, sourceUpdatedAt: normalizedSourceUpdatedAt, expiresAt: normalizedExpiresAt, reasonCode: null, tenureId: period.tenureId });
  stateChanged ||= JSON.stringify(priorCheck) !== JSON.stringify(check);
  entry.roleChecks[normalizedRole] = check;
  state.teams[key] = entry;
  if (stateChanged) state.updatedAt = timestamp;
  return { state, role: normalizedRole, period, lastKnownPeriod: period, changed, previousCoach, ignored: false, reason: null, verificationStatus, stateChanged };
}

function unchanged(state, role, current, check, reason) {
  return { state, role, period: check?.status === 'verified' ? current : null, lastKnownPeriod: current, changed: false, previousCoach: null, ignored: true, reason, verificationStatus: check?.status || 'not_verified', stateChanged: false };
}

function roleCheck({ status, week, timestamp, sourceUrl, sourceKey, sourceUpdatedAt, expiresAt, reasonCode, tenureId }) {
  return { status, checkedAt: timestamp, checkedWeek: week, expiresAt: toIso(expiresAt), sourceUrl: textOrNull(sourceUrl), sourceKey: textOrNull(sourceKey), sourceUpdatedAt: toIso(sourceUpdatedAt), reasonCode: textOrNull(reasonCode), tenureId: textOrNull(tenureId) };
}

function newPeriod(season, team, role, coachId, coachName, week, observedAt, sourceUrl) {
  const identity = coachId || normalizeName(coachName);
  return {
    tenureId: role === 'headCoach' ? `${season}:${team}:${identity}:${observedAt}` : `${season}:${team}:${role}:${identity}:${observedAt}`,
    role, coachId, coachName, startWeek: week, endWeek: null, firstSeenWeek: week, lastSeenWeek: week,
    firstSeenAt: observedAt, lastSeenAt: observedAt, sourceUrl: textOrNull(sourceUrl),
    boundaryConfidence: 'first-observed-not-official-effective-time'
  };
}

function sameCoach(current, incoming) {
  if (current.coachId && incoming.id) return current.coachId === incoming.id;
  return normalizeName(current.coachName) === normalizeName(incoming.name);
}

function normalizeState(input) {
  const teams = {};
  if (input?.teams && typeof input.teams === 'object' && !Array.isArray(input.teams)) {
    for (const [key, raw] of Object.entries(input.teams)) {
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.periods)) continue;
      const entry = emptyEntry(Number(raw.season), normalizeNflTeamAbbreviation(raw.teamAbbreviation));
      Object.assign(entry, raw, {
        season: Number(raw.season), teamAbbreviation: normalizeNflTeamAbbreviation(raw.teamAbbreviation),
        periods: raw.periods.map(clonePeriod),
        rolePeriods: Object.fromEntries(EXTRA_ROLES.map((role) => [role, Array.isArray(raw.rolePeriods?.[role]) ? raw.rolePeriods[role].map(clonePeriod) : []])),
        roleChecks: Object.fromEntries(COACHING_ROLES.flatMap((role) => raw.roleChecks?.[role] ? [[role, { ...raw.roleChecks[role] }]] : []))
      });
      if (!entry.roleChecks.headCoach && entry.periods.length) {
        const latest = entry.periods.at(-1);
        entry.roleChecks.headCoach = roleCheck({ status: 'verified', week: latest.lastSeenWeek || latest.startWeek, timestamp: latest.lastSeenAt || latest.firstSeenAt, sourceUrl: latest.sourceUrl, sourceKey: 'legacy-head-coach-tracker', sourceUpdatedAt: latest.lastSeenAt || latest.firstSeenAt, expiresAt: null, reasonCode: null, tenureId: latest.tenureId });
      }
      teams[key] = entry;
    }
  }
  return { ...(input && typeof input === 'object' ? input : {}), version: 2, updatedAt: toIso(input?.updatedAt), teams };
}

function emptyEntry(season, teamAbbreviation) {
  return { season, teamAbbreviation, periods: [], rolePeriods: Object.fromEntries(EXTRA_ROLES.map((role) => [role, []])), roleChecks: {} };
}

function periodsFor(entry, role) { return role === 'headCoach' ? entry.periods : entry.rolePeriods[role]; }
function clonePeriod(period) { return { ...period }; }
function coachingRole(value) { if (!COACHING_ROLES.includes(value)) throw new TypeError(`Unsupported coaching role: ${value}`); return value; }
function compareObservation(week, timestamp, priorWeek, priorTimestamp) { if (week !== Number(priorWeek)) return week < Number(priorWeek) ? -1 : 1; return Date.parse(timestamp) < Date.parse(priorTimestamp) ? -1 : Date.parse(timestamp) > Date.parse(priorTimestamp) ? 1 : 0; }
function withoutState({ state, ...result }) { return result; }
function normalizeName(value) { return String(value || '').normalize('NFKD').replace(/[^a-z0-9]/gi, '').toLowerCase(); }
function textOrNull(value) { const text = String(value ?? '').trim(); return text || null; }
function toIso(value) { if (value == null || value === '') return null; const date = value instanceof Date ? value : new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function positiveInteger(value, label) { const number = Number(value); if (!Number.isInteger(number) || number < 1) throw new TypeError(`${label} must be a positive integer`); return number; }
