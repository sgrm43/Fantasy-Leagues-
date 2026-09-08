import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, safeConfig } from './config.js';
import { getLeagueStates, syncAll, syncLeague } from './sync.js';
import { listSnapshots, readLeague } from './storage.js';
import { summarizeSamples } from './scoring.js';
import { buildWeeklyAnalysis } from './analysis-service.js';
import { evaluateTrade } from './analytics/trades.js';
import { getNflInjuries } from './context-service.js';
import { buildLeagueBacktest } from './backtest-service.js';

const publicDir = path.resolve('public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/api/health') return json(response, 200, { ok: true, mode: 'read-only', now: new Date().toISOString(), config: safeConfig() });
    if (url.pathname === '/api/leagues' && request.method === 'GET') return json(response, 200, await getLeagueStates());
    if (url.pathname === '/api/sync' && request.method === 'POST') return json(response, 200, await syncAll());
    if (url.pathname.startsWith('/api/sync/') && request.method === 'POST') return json(response, 200, await syncLeague(decodeURIComponent(url.pathname.slice(10))));
    if (url.pathname.startsWith('/api/snapshots/') && request.method === 'GET') return json(response, 200, await listSnapshots(decodeURIComponent(url.pathname.slice(15))));
    if (url.pathname.startsWith('/api/analysis/') && request.method === 'GET') {
      const key = decodeURIComponent(url.pathname.slice(14));
      return json(response, 200, await buildWeeklyAnalysis(key, url.searchParams.get('teamId'), { objective: url.searchParams.get('objective') }));
    }
    if (url.pathname.startsWith('/api/backtest/') && request.method === 'GET') {
      const key = decodeURIComponent(url.pathname.slice(14));
      return json(response, 200, await buildLeagueBacktest(key));
    }
    if (url.pathname.startsWith('/api/trade/') && request.method === 'POST') {
      const key = decodeURIComponent(url.pathname.slice(11));
      if (!config.leagues.some((league) => league.key === key)) return json(response, 404, { error: 'Unknown league' });
      const envelope = await readLeague(key);
      if (!envelope) return json(response, 409, { error: 'Sync this league before analyzing a trade' });
      const body = await readBody(request);
      validateTradeBody(body);
      try {
        const injuryContext = await getNflInjuries();
        const injuriesById = new Map(injuryContext.injuries.map((injury) => [String(injury.playerId), injury]));
        const league = { ...envelope.data, teams: envelope.data.teams.map((team) => ({ ...team, roster: team.roster.map((player) => withCurrentInjury(player, injuriesById)) })) };
        const result = evaluateTrade({ league, fromTeamId: body.fromTeamId, toTeamId: body.toTeamId, givePlayerIds: body.givePlayerIds, receivePlayerIds: body.receivePlayerIds, provenance: { source: `${envelope.data.platform} weekly projection + current ESPN injury status`, retrievedAt: envelope.retrievedAt } });
        return json(response, 200, { ...result, evidence: [{ source: 'ESPN NFL injury report', retrievedAt: injuryContext.retrievedAt, stale: injuryContext.stale }] });
      } catch (error) {
        if (!error.status) error.status = 400;
        throw error;
      }
    }
    if (url.pathname === '/api/project' && request.method === 'POST') {
      const body = await readBody(request); return json(response, 200, summarizeSamples(body.samples, body.rules, body.thresholds));
    }
    if (url.pathname.startsWith('/api/')) return json(response, 404, { error: 'Not found' });
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(publicDir, relative);
    if (!file.startsWith(publicDir)) return json(response, 403, { error: 'Forbidden' });
    const content = await fs.readFile(file); response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); response.end(content);
  } catch (error) {
    const status = error.code === 'ENOENT' ? 404 : error.status || 500;
    json(response, status, { error: status === 500 ? 'Request failed' : error.message, detail: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
});

function json(response, status, value) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); }
async function readBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 1_000_000) throw Object.assign(new Error('Payload too large'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Request body must be valid JSON'), { status: 400 }); }
}
function validateTradeBody(body) {
  const validIds = (value) => Array.isArray(value) && value.length >= 1 && value.length <= 5 && value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 100);
  if (typeof body?.fromTeamId !== 'string' || typeof body?.toTeamId !== 'string' || !validIds(body.givePlayerIds) || !validIds(body.receivePlayerIds)) {
    throw Object.assign(new Error('Select two teams and at least one valid player from each side'), { status: 400 });
  }
}
function withCurrentInjury(player, injuriesById) {
  const id = player.externalIds?.espn ? String(player.externalIds.espn) : /^espn:(.+)$/.exec(String(player.playerId))?.[1];
  const injury = id ? injuriesById.get(id) : null;
  return injury ? { ...player, injuryStatus: injury.status || injury.designation?.abbreviation || player.injuryStatus } : player;
}

server.listen(config.port, '127.0.0.1', () => console.log(`Fantasy League Analytics running at http://localhost:${config.port} (read-only, local computer only)`));
const refreshTimer = setInterval(() => syncAll().catch((error) => console.error(`Automatic read-only refresh failed: ${error.message}`)), config.cacheTtlMs);
refreshTimer.unref();
