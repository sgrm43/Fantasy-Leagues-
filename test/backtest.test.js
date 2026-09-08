import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutcomeProjection } from '../src/analytics/projections.js';
import { fetchSleeperSamples, requireCompletedHistoricalWeek, selectBacktestWindow, summarizeBacktestSamples } from '../src/backtest-service.js';

test('backtest window never includes the current week', () => {
  assert.deepEqual(selectBacktestWindow(2026, 8).weeks, [4, 5, 6, 7]);
  assert.deepEqual(selectBacktestWindow(2026, 1), { season: 2025, weeks: [12, 13, 14, 15], basis: 'four late-season weeks from the prior season' });
});

test('historical summary measures errors, ranges, probabilities, and positions', () => {
  const result = summarizeBacktestSamples([
    { playerId: 'a', position: 'QB', projection: 20, actual: 25, week: 12 },
    { playerId: 'b', position: 'QB', projection: 10, actual: 5, week: 12 },
    { playerId: 'c', position: 'WR', projection: 2, actual: 30, week: 12 }
  ]);
  assert.equal(result.sampleSize, 2);
  assert.equal(result.metrics.mae, 5);
  assert.equal(result.metrics.rmse, 5);
  assert.equal(result.metrics.bias, 0);
  assert.equal(result.metrics.correlation, 1);
  assert.ok(result.metrics.intervalCoverage >= 0 && result.metrics.intervalCoverage <= 1);
  assert.ok(result.metrics.brierError >= 0 && result.metrics.brierError <= 1);
  assert.equal(result.calibration.reduce((sum, bin) => sum + bin.count, 0), 6);
  assert.deepEqual(result.byPosition.map((group) => group.position), ['QB']);
});

test('empty historical samples stay visibly unavailable', () => {
  const result = summarizeBacktestSamples([]);
  assert.equal(result.sampleSize, 0);
  assert.equal(result.metrics.mae, null);
  assert.equal(result.metrics.intervalCoverage, null);
  assert.deepEqual(result.calibration, []);
});

test('point thresholds include an actual score exactly on the threshold', () => {
  const projection = 12;
  const result = summarizeBacktestSamples([{ playerId: 'a', position: 'RB', projection, actual: 10, week: 12 }]);
  const probabilities = buildOutcomeProjection({ id: 'a', position: 'RB', projection, thresholds: [10, 15, 20] }).thresholdProbabilities;
  const expected = Math.round((probabilities.reduce((sum, item) => sum + (item.probability - (item.threshold === 10 ? 1 : 0)) ** 2, 0) / 3) * 100) / 100;
  assert.equal(result.metrics.brierError, expected);
});

test('Sleeper historical fetch counts a projected DNP as zero and preserves a partial week', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/2?')) return { ok: false, status: 503, json: async () => ({}) };
    if (url.includes('/projections/')) return { ok: true, status: 200, json: async () => [{ player_id: 'p1', player: { position: 'RB' }, stats: { rush_yd: 100 } }] };
    return { ok: true, status: 200, json: async () => [] };
  };
  const result = await fetchSleeperSamples({ season: 2025, weeks: [1, 2], rules: { rush_yd: 0.1 }, fetchImpl });
  assert.deepEqual(result.includedWeeks, [1]);
  assert.equal(result.failedWeeks.length, 1);
  assert.equal(result.samples[0].projection, 10);
  assert.equal(result.samples[0].actual, 0);
  assert.equal(result.samples[0].actualSource, 'missing_stat_row_assumed_zero');
});

test('a total historical source failure is rejected instead of cached as an empty success', () => {
  assert.throws(() => requireCompletedHistoricalWeek({ includedWeeks: [], failedWeeks: [{ week: 1 }] }, 'test'), /could not be loaded/);
});
