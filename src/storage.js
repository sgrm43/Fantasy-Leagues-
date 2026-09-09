import fs from 'node:fs/promises';
import path from 'node:path';
import { getStore } from '@netlify/blobs';
import { config } from './config.js';

export const NETLIFY_BLOB_STORE_NAME = 'fantasy-league-data';

export function detectStorageRuntime(environment = process.env) {
  const isNetlify = environment.NETLIFY === 'true'
    || Boolean(environment.NETLIFY_BLOBS_CONTEXT)
    || Boolean(environment.SITE_ID && environment.SITE_NAME);
  return isNetlify ? 'netlify' : 'local';
}

export function createStorage({
  runtime = detectStorageRuntime(),
  dataDir = config.dataDir,
  fileSystem = fs,
  blobStoreFactory = getStore,
  snapshotIntervalMs = config.snapshotIntervalMs,
  maxSnapshotsPerLeague = config.maxSnapshotsPerLeague,
  clock = Date.now,
  processId = process.pid
} = {}) {
  if (runtime === 'local') {
    return createFileStorage({ dataDir, fileSystem, snapshotIntervalMs, maxSnapshotsPerLeague, clock, processId });
  }
  if (runtime === 'netlify') {
    return createBlobStorage({ blobStoreFactory, snapshotIntervalMs, maxSnapshotsPerLeague, clock });
  }
  throw new Error(`Unsupported storage runtime: ${runtime}`);
}

let runtimeStorage;
function getRuntimeStorage() {
  runtimeStorage ||= createStorage();
  return runtimeStorage;
}

export function saveLeague(...args) { return getRuntimeStorage().saveLeague(...args); }
export function readLeague(...args) { return getRuntimeStorage().readLeague(...args); }
export function readCoachTracker(...args) { return getRuntimeStorage().readCoachTracker(...args); }
export function saveCoachTracker(...args) { return getRuntimeStorage().saveCoachTracker(...args); }
export function readNewsChangeState(...args) { return getRuntimeStorage().readNewsChangeState(...args); }
export function saveNewsChangeState(...args) { return getRuntimeStorage().saveNewsChangeState(...args); }
export function readPregameDecisionSnapshots(...args) { return getRuntimeStorage().readPregameDecisionSnapshots(...args); }
export function savePregameDecisionSnapshots(...args) { return getRuntimeStorage().savePregameDecisionSnapshots(...args); }
export function listSnapshots(...args) { return getRuntimeStorage().listSnapshots(...args); }

function createFileStorage({ dataDir, fileSystem, snapshotIntervalMs, maxSnapshotsPerLeague, clock, processId }) {
  const cacheDir = path.join(dataDir, 'cache');
  const snapshotDir = path.join(dataDir, 'snapshots');
  const historyDir = path.join(dataDir, 'history');
  const coachTrackerFile = path.join(cacheDir, 'coach-tracker.json');
  const newsChangeStateFile = path.join(cacheDir, 'news-change-state.json');
  const pregameDecisionSnapshotsFile = path.join(historyDir, 'pregame-decision-snapshots.json');

  async function ensureDirs() {
    await Promise.all([
      fileSystem.mkdir(cacheDir, { recursive: true }),
      fileSystem.mkdir(snapshotDir, { recursive: true }),
      fileSystem.mkdir(historyDir, { recursive: true })
    ]);
  }

  async function atomicJson(file, value) {
    await ensureDirs();
    const temp = `${file}.${processId}.tmp`;
    await fileSystem.writeFile(temp, JSON.stringify(value, null, 2));
    await fileSystem.rename(temp, file);
  }

  async function snapshotFiles(key) {
    await ensureDirs();
    return (await fileSystem.readdir(snapshotDir))
      .filter((name) => name.startsWith(`${key}-`) && name.endsWith('.json'))
      .sort();
  }

  async function pruneSnapshots(key) {
    const files = await snapshotFiles(key);
    const excess = Math.max(0, files.length - Math.max(1, maxSnapshotsPerLeague));
    await Promise.all(files.slice(0, excess).map((name) => fileSystem.unlink(path.join(snapshotDir, name))));
  }

  return {
    async saveLeague(key, value) {
      const envelope = { retrievedAt: new Date(clock()).toISOString(), data: value };
      const stamp = envelope.retrievedAt.replaceAll(':', '-');
      await atomicJson(path.join(cacheDir, `${key}.json`), envelope);
      const existing = await snapshotFiles(key);
      const newest = existing.at(-1);
      const newestAge = newest ? clock() - (await fileSystem.stat(path.join(snapshotDir, newest))).mtimeMs : Infinity;
      if (newestAge >= snapshotIntervalMs) {
        await atomicJson(path.join(snapshotDir, `${key}-${stamp}.json`), envelope);
        await pruneSnapshots(key);
      }
      return envelope;
    },

    async readLeague(key) {
      try { return JSON.parse(await fileSystem.readFile(path.join(cacheDir, `${key}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },

    async readCoachTracker() {
      try { return JSON.parse(await fileSystem.readFile(coachTrackerFile, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },

    async saveCoachTracker(value) {
      await atomicJson(coachTrackerFile, value);
      return value;
    },

    async readNewsChangeState() {
      try { return JSON.parse(await fileSystem.readFile(newsChangeStateFile, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },

    async saveNewsChangeState(value) {
      await atomicJson(newsChangeStateFile, value);
      return value;
    },

    async readPregameDecisionSnapshots() {
      try { return JSON.parse(await fileSystem.readFile(pregameDecisionSnapshotsFile, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },

    async savePregameDecisionSnapshots(value) {
      await atomicJson(pregameDecisionSnapshotsFile, value);
      return value;
    },

    async listSnapshots(key) {
      return (await snapshotFiles(key)).reverse();
    }
  };
}

function createBlobStorage({ blobStoreFactory, snapshotIntervalMs, maxSnapshotsPerLeague, clock }) {
  let storePromise;
  const getBlobStore = () => {
    storePromise ||= Promise.resolve(blobStoreFactory({
      name: NETLIFY_BLOB_STORE_NAME,
      consistency: 'strong'
    }));
    return storePromise;
  };

  const cacheKey = (key) => `cache/${key}.json`;
  const snapshotPrefix = (key) => `snapshots/${key}-`;
  const snapshotKey = (name) => `snapshots/${name}`;

  async function readJson(key) {
    return (await getBlobStore()).get(key, { type: 'json' });
  }

  async function writeJson(key, value, options) {
    await (await getBlobStore()).setJSON(key, value, options);
  }

  async function snapshotFiles(key) {
    const store = await getBlobStore();
    const result = await store.list({ prefix: snapshotPrefix(key) });
    return (result.blobs || [])
      .map((blob) => blob.key.slice('snapshots/'.length))
      .filter((name) => name.startsWith(`${key}-`) && name.endsWith('.json'))
      .sort();
  }

  async function pruneSnapshots(key) {
    const store = await getBlobStore();
    const files = await snapshotFiles(key);
    const excess = Math.max(0, files.length - Math.max(1, maxSnapshotsPerLeague));
    await Promise.all(files.slice(0, excess).map((name) => store.delete(snapshotKey(name))));
  }

  return {
    async saveLeague(key, value) {
      const envelope = { retrievedAt: new Date(clock()).toISOString(), data: value };
      const stamp = envelope.retrievedAt.replaceAll(':', '-');
      await writeJson(cacheKey(key), envelope);
      const existing = await snapshotFiles(key);
      const newest = existing.at(-1);
      let newestAge = Infinity;
      if (newest) {
        const metadata = await (await getBlobStore()).getMetadata(snapshotKey(newest));
        const retrievedAt = metadata?.metadata?.retrievedAt;
        if (retrievedAt) newestAge = clock() - Date.parse(retrievedAt);
      }
      if (newestAge >= snapshotIntervalMs) {
        await writeJson(snapshotKey(`${key}-${stamp}.json`), envelope, {
          metadata: { retrievedAt: envelope.retrievedAt }
        });
        await pruneSnapshots(key);
      }
      return envelope;
    },

    readLeague(key) {
      return readJson(cacheKey(key));
    },

    readCoachTracker() {
      return readJson('cache/coach-tracker.json');
    },

    async saveCoachTracker(value) {
      await writeJson('cache/coach-tracker.json', value);
      return value;
    },

    readNewsChangeState() {
      return readJson('cache/news-change-state.json');
    },

    async saveNewsChangeState(value) {
      await writeJson('cache/news-change-state.json', value);
      return value;
    },

    readPregameDecisionSnapshots() {
      return readJson('history/pregame-decision-snapshots.json');
    },

    async savePregameDecisionSnapshots(value) {
      await writeJson('history/pregame-decision-snapshots.json', value);
      return value;
    },

    async listSnapshots(key) {
      return (await snapshotFiles(key)).reverse();
    }
  };
}
