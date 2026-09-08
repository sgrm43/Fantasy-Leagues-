import { config } from './config.js';
import { syncSleeper } from './adapters/sleeper.js';
import { syncEspn } from './adapters/espn.js';
import { readLeague, saveLeague } from './storage.js';

const inFlight = new Map();

export function syncLeague(key) {
  if (inFlight.has(key)) return inFlight.get(key);
  const request = performSync(key).finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

async function performSync(key) {
  const definition = config.leagues.find((league) => league.key === key);
  if (!definition) throw Object.assign(new Error(`Unknown league: ${key}`), { status: 404 });
  const startedAt = new Date().toISOString();
  try {
    const data = definition.platform === 'sleeper' ? await syncSleeper(definition) : await syncEspn(definition, config.espn);
    const envelope = await saveLeague(key, data);
    return { key, ok: true, startedAt, retrievedAt: envelope.retrievedAt, data };
  } catch (error) {
    const cached = await readLeague(key);
    return { key, ok: false, startedAt, error: error.message, code: error.code || 'UPSTREAM_ERROR', cached: cached ? withFreshness(cached) : null };
  }
}

export async function syncAll() { return Promise.all(config.leagues.map((league) => syncLeague(league.key))); }

export async function getLeagueStates() {
  return Promise.all(config.leagues.map(async (definition) => {
    const cached = await readLeague(definition.key);
    return { definition, cache: cached ? withFreshness(cached) : null };
  }));
}

function withFreshness(envelope) {
  const ageMs = Date.now() - Date.parse(envelope.retrievedAt);
  return { ...envelope, ageMs, stale: ageMs > config.cacheTtlMs };
}
