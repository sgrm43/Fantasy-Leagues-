import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const cacheDir = path.join(config.dataDir, 'cache');
const snapshotDir = path.join(config.dataDir, 'snapshots');
const historyDir = path.join(config.dataDir, 'history');
const coachTrackerFile = path.join(cacheDir, 'coach-tracker.json');
const newsChangeStateFile = path.join(cacheDir, 'news-change-state.json');
const pregameDecisionSnapshotsFile = path.join(historyDir, 'pregame-decision-snapshots.json');

async function ensureDirs() {
  await Promise.all([fs.mkdir(cacheDir, { recursive: true }), fs.mkdir(snapshotDir, { recursive: true }), fs.mkdir(historyDir, { recursive: true })]);
}

async function atomicJson(file, value) {
  await ensureDirs();
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  await fs.rename(temp, file);
}

export async function saveLeague(key, value) {
  const envelope = { retrievedAt: new Date().toISOString(), data: value };
  const stamp = envelope.retrievedAt.replaceAll(':', '-');
  await atomicJson(path.join(cacheDir, `${key}.json`), envelope);
  const existing = await snapshotFiles(key);
  const newest = existing.at(-1);
  const newestAge = newest ? Date.now() - (await fs.stat(path.join(snapshotDir, newest))).mtimeMs : Infinity;
  if (newestAge >= config.snapshotIntervalMs) {
    await atomicJson(path.join(snapshotDir, `${key}-${stamp}.json`), envelope);
    await pruneSnapshots(key);
  }
  return envelope;
}

export async function readLeague(key) {
  try { return JSON.parse(await fs.readFile(path.join(cacheDir, `${key}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function readCoachTracker() {
  try { return JSON.parse(await fs.readFile(coachTrackerFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function saveCoachTracker(value) {
  await atomicJson(coachTrackerFile, value);
  return value;
}

export async function readNewsChangeState() {
  try { return JSON.parse(await fs.readFile(newsChangeStateFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function saveNewsChangeState(value) {
  await atomicJson(newsChangeStateFile, value);
  return value;
}

export async function readPregameDecisionSnapshots() {
  try { return JSON.parse(await fs.readFile(pregameDecisionSnapshotsFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function savePregameDecisionSnapshots(value) {
  await atomicJson(pregameDecisionSnapshotsFile, value);
  return value;
}

export async function listSnapshots(key) {
  return (await snapshotFiles(key)).reverse();
}

async function snapshotFiles(key) {
  await ensureDirs();
  return (await fs.readdir(snapshotDir)).filter((name) => name.startsWith(`${key}-`) && name.endsWith('.json')).sort();
}

async function pruneSnapshots(key) {
  const files = await snapshotFiles(key);
  const excess = Math.max(0, files.length - Math.max(1, config.maxSnapshotsPerLeague));
  await Promise.all(files.slice(0, excess).map((name) => fs.unlink(path.join(snapshotDir, name))));
}
