import fs from 'node:fs';
import path from 'node:path';

function loadLocalEnv() {
  const file = path.resolve('.env.local');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const split = line.indexOf('=');
    if (split < 1) continue;
    const key = line.slice(0, split).trim();
    const value = line.slice(split + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadLocalEnv();

export const config = {
  port: Number(process.env.PORT || 4173),
  cacheTtlMs: Number(process.env.CACHE_TTL_MINUTES || 15) * 60_000,
  snapshotIntervalMs: Number(process.env.SNAPSHOT_INTERVAL_HOURS || 6) * 60 * 60_000,
  maxSnapshotsPerLeague: Number(process.env.MAX_SNAPSHOTS_PER_LEAGUE || 240),
  dataDir: path.resolve('data'),
  espn: { s2: process.env.ESPN_S2 || '', swid: process.env.SWID || '' },
  leagues: [
    { key: 'sleeper', name: 'Sleeper League', platform: 'sleeper', id: '1389327804176277504', ownerTeam: 'Ad Te Venio' },
    { key: 'champions', name: 'League of Champions', platform: 'espn', id: '1396249048', ownerTeam: 'Big C' },
    { key: 'frontera', name: 'Frontera Bowl', platform: 'espn', id: '48114707', ownerTeam: 'Bang Bang' },
    { key: 'pistoleros', name: 'Los Pistoleros', platform: 'espn', id: '1764386137', ownerTeam: 'DeflateGate' }
  ]
};

export function safeConfig() {
  return {
    leagues: config.leagues,
    espnAuthenticated: Boolean(config.espn.s2 && config.espn.swid),
    cacheTtlMinutes: config.cacheTtlMs / 60_000,
    snapshotIntervalHours: config.snapshotIntervalMs / 60 / 60_000
  };
}
