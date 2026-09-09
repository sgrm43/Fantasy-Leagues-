import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStorage, detectStorageRuntime, NETLIFY_BLOB_STORE_NAME } from '../src/storage.js';

const LEAGUE_KEYS = ['sleeper', 'champions', 'frontera', 'pistoleros'];

test('local storage retains filesystem cache behavior under the configured data directory', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fantasy-storage-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const storage = createStorage({
    runtime: 'local',
    dataDir,
    snapshotIntervalMs: 60_000,
    maxSnapshotsPerLeague: 10,
    clock: () => Date.parse('2026-09-08T12:00:00.000Z'),
    processId: 123
  });

  const saved = await storage.saveLeague('sleeper', { league: 'sleeper' });
  assert.deepEqual(await storage.readLeague('sleeper'), saved);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(dataDir, 'cache', 'sleeper.json'), 'utf8')),
    saved
  );
  assert.equal((await storage.listSnapshots('sleeper')).length, 1);
});

test('Netlify runtime routes all four league caches through site-scoped Blobs without filesystem writes', async () => {
  const blobStore = memoryBlobStore();
  const filesystemCalls = [];
  const forbiddenFileSystem = new Proxy({}, {
    get(_target, method) {
      return async (...args) => {
        filesystemCalls.push({ method, args });
        throw new Error(`Unexpected filesystem call: ${String(method)}`);
      };
    }
  });
  let storeOptions;
  const storage = createStorage({
    runtime: detectStorageRuntime({ SITE_ID: 'test-site-id', SITE_NAME: 'test-site' }),
    dataDir: '/var/task/data',
    fileSystem: forbiddenFileSystem,
    blobStoreFactory: (options) => { storeOptions = options; return blobStore; },
    snapshotIntervalMs: 60_000,
    maxSnapshotsPerLeague: 10,
    clock: () => Date.parse('2026-09-08T12:00:00.000Z')
  });

  for (const key of LEAGUE_KEYS) {
    const saved = await storage.saveLeague(key, { league: key });
    assert.deepEqual(await storage.readLeague(key), saved);
  }
  await storage.saveCoachTracker({ coaches: [] });
  await storage.saveNewsChangeState({ items: [] });
  await storage.savePregameDecisionSnapshots({ records: [] });
  assert.deepEqual(await storage.readCoachTracker(), { coaches: [] });
  assert.deepEqual(await storage.readNewsChangeState(), { items: [] });
  assert.deepEqual(await storage.readPregameDecisionSnapshots(), { records: [] });
  assert.equal((await storage.listSnapshots('sleeper')).length, 1);

  assert.deepEqual(storeOptions, { name: NETLIFY_BLOB_STORE_NAME, consistency: 'strong' });
  assert.deepEqual(
    blobStore.calls
      .filter((call) => call.method === 'setJSON' && LEAGUE_KEYS.some((key) => call.key === `cache/${key}.json`))
      .map((call) => call.key),
    LEAGUE_KEYS.map((key) => `cache/${key}.json`)
  );
  assert.deepEqual(
    blobStore.calls
      .filter((call) => call.method === 'get' && LEAGUE_KEYS.some((key) => call.key === `cache/${key}.json`))
      .map((call) => call.key),
    LEAGUE_KEYS.map((key) => `cache/${key}.json`)
  );
  assert.deepEqual(filesystemCalls, []);
});

function memoryBlobStore() {
  const values = new Map();
  const metadata = new Map();
  const calls = [];
  return {
    calls,
    async setJSON(key, value, options = {}) {
      calls.push({ method: 'setJSON', key });
      values.set(key, structuredClone(value));
      metadata.set(key, structuredClone(options.metadata || {}));
    },
    async get(key, options) {
      calls.push({ method: 'get', key, type: options?.type });
      return values.has(key) ? structuredClone(values.get(key)) : null;
    },
    async getMetadata(key) {
      calls.push({ method: 'getMetadata', key });
      return values.has(key) ? { etag: `etag-${key}`, metadata: structuredClone(metadata.get(key)) } : null;
    },
    async list({ prefix }) {
      calls.push({ method: 'list', key: prefix });
      return {
        blobs: [...values.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key, etag: `etag-${key}` }))
      };
    },
    async delete(key) {
      calls.push({ method: 'delete', key });
      values.delete(key);
      metadata.delete(key);
    }
  };
}
