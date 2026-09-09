import { config, safeConfig } from './config.js';
import { getLeagueStates, syncAll, syncLeague } from './sync.js';
import { listSnapshots, readLeague } from './storage.js';
import { summarizeSamples } from './scoring.js';
import { buildWeeklyAnalysis } from './analysis-service.js';
import { evaluateTrade } from './analytics/trades.js';
import { getNflInjuries } from './context-service.js';
import { buildLeagueBacktest } from './backtest-service.js';

const MAX_BODY_BYTES = 1_000_000;

const defaultServices = {
  config,
  safeConfig,
  getLeagueStates,
  syncAll,
  syncLeague,
  listSnapshots,
  readLeague,
  summarizeSamples,
  buildWeeklyAnalysis,
  evaluateTrade,
  getNflInjuries,
  buildLeagueBacktest
};

export function createApiRouter(overrides = {}) {
  const services = { ...defaultServices, ...overrides };

  return async function handleApiRequest(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/health') {
        return jsonResponse(200, { ok: true, mode: 'read-only', now: new Date().toISOString(), config: services.safeConfig() });
      }
      if (url.pathname === '/api/leagues' && request.method === 'GET') {
        return jsonResponse(200, await services.getLeagueStates());
      }
      if (url.pathname === '/api/sync' && request.method === 'POST') {
        return jsonResponse(200, await services.syncAll());
      }
      if (url.pathname.startsWith('/api/sync/') && request.method === 'POST') {
        return jsonResponse(200, await services.syncLeague(decodeURIComponent(url.pathname.slice(10))));
      }
      if (url.pathname.startsWith('/api/snapshots/') && request.method === 'GET') {
        return jsonResponse(200, await services.listSnapshots(decodeURIComponent(url.pathname.slice(15))));
      }
      if (url.pathname.startsWith('/api/analysis/') && request.method === 'GET') {
        const key = decodeURIComponent(url.pathname.slice(14));
        return jsonResponse(200, await services.buildWeeklyAnalysis(key, url.searchParams.get('teamId'), { objective: url.searchParams.get('objective') }));
      }
      if (url.pathname.startsWith('/api/backtest/') && request.method === 'GET') {
        const key = decodeURIComponent(url.pathname.slice(14));
        return jsonResponse(200, await services.buildLeagueBacktest(key));
      }
      if (url.pathname.startsWith('/api/trade/') && request.method === 'POST') {
        const key = decodeURIComponent(url.pathname.slice(11));
        if (!services.config.leagues.some((league) => league.key === key)) {
          return jsonResponse(404, { error: 'Unknown league' });
        }
        const envelope = await services.readLeague(key);
        if (!envelope) {
          return jsonResponse(409, { error: 'Sync this league before analyzing a trade' });
        }
        const body = await readBody(request);
        validateTradeBody(body);
        try {
          const injuryContext = await services.getNflInjuries();
          const injuriesById = new Map(injuryContext.injuries.map((injury) => [String(injury.playerId), injury]));
          const league = {
            ...envelope.data,
            teams: envelope.data.teams.map((team) => ({
              ...team,
              roster: team.roster.map((player) => withCurrentInjury(player, injuriesById))
            }))
          };
          const result = services.evaluateTrade({
            league,
            fromTeamId: body.fromTeamId,
            toTeamId: body.toTeamId,
            givePlayerIds: body.givePlayerIds,
            receivePlayerIds: body.receivePlayerIds,
            provenance: {
              source: `${envelope.data.platform} weekly projection + current ESPN injury status`,
              retrievedAt: envelope.retrievedAt
            }
          });
          return jsonResponse(200, {
            ...result,
            evidence: [{ source: 'ESPN NFL injury report', retrievedAt: injuryContext.retrievedAt, stale: injuryContext.stale }]
          });
        } catch (error) {
          if (!error.status) error.status = 400;
          throw error;
        }
      }
      if (url.pathname === '/api/project' && request.method === 'POST') {
        const body = await readBody(request);
        return jsonResponse(200, services.summarizeSamples(body.samples, body.rules, body.thresholds));
      }
      return jsonResponse(404, { error: 'Not found' });
    } catch (error) {
      const status = error.code === 'ENOENT' ? 404 : error.status || 500;
      return jsonResponse(status, {
        error: status === 500 ? 'Request failed' : error.message,
        detail: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  };
}

export const handleApiRequest = createApiRouter();

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

async function readBody(request) {
  const declaredSize = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_BODY_BYTES) {
    throw Object.assign(new Error('Payload too large'), { status: 413 });
  }

  const reader = request.body?.getReader();
  if (!reader) return {};

  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw Object.assign(new Error('Payload too large'), { status: 413 });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { status: 400 });
  }
}

function validateTradeBody(body) {
  const validIds = (value) => Array.isArray(value)
    && value.length >= 1
    && value.length <= 5
    && value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 100);
  if (typeof body?.fromTeamId !== 'string'
    || typeof body?.toTeamId !== 'string'
    || !validIds(body.givePlayerIds)
    || !validIds(body.receivePlayerIds)) {
    throw Object.assign(new Error('Select two teams and at least one valid player from each side'), { status: 400 });
  }
}

function withCurrentInjury(player, injuriesById) {
  const id = player.externalIds?.espn
    ? String(player.externalIds.espn)
    : /^espn:(.+)$/.exec(String(player.playerId))?.[1];
  const injury = id ? injuriesById.get(id) : null;
  return injury
    ? { ...player, injuryStatus: injury.status || injury.designation?.abbreviation || player.injuryStatus }
    : player;
}
