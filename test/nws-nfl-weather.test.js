import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeatherEvidence, selectRosterWeatherGames, situationalContext } from '../src/analysis-service.js';
import { createNwsGameWeatherProvider, deriveWeatherFlags, normalizeForecastPeriod, selectForecastPeriod } from '../src/providers/nws-nfl-weather.js';

const NOW = '2026-10-18T12:00:00.000Z';
const KICKOFF = '2026-10-18T20:25:00.000Z';
const VENUES = [
  { key: 'outdoor', names: ['Test Field'], normalizedNames: ['test field'], latitude: 37.4, longitude: -121.97, roofType: 'outdoor', espnVenueIds: ['out'] },
  { key: 'fixed', names: ['Indoor Field'], normalizedNames: ['indoor field'], latitude: 42.34, longitude: -83.04, roofType: 'fixed', espnVenueIds: ['fixed'] },
  { key: 'retractable', names: ['Roof Field'], normalizedNames: ['roof field'], latitude: 33.52, longitude: -112.26, roofType: 'retractable', espnVenueIds: ['roof'] },
  { key: 'covered', names: ['Covered Field'], normalizedNames: ['covered field'], latitude: 33.95, longitude: -118.34, roofType: 'covered_open_air', espnVenueIds: ['covered'] }
];

function game({ id = 'game-1', venueId = 'out', venueName = 'Test Field' } = {}) {
  return {
    id,
    kickoff: KICKOFF,
    status: { completed: false },
    teams: { away: { id: '26', abbreviation: 'SEA' }, home: { id: '25', abbreviation: 'SF' } },
    venue: { id: venueId, name: venueName, indoor: venueId === 'fixed' },
    indoor: venueId === 'fixed',
    weather: { temperatureF: 68, summary: '68 degrees, partly cloudy' }
  };
}

function nwsMock({ hourlyFails = false, alerts = [] } = {}) {
  const calls = [];
  const hourlyUrl = 'https://api.weather.gov/gridpoints/MTR/90,105/forecast/hourly';
  const forecastUrl = 'https://api.weather.gov/gridpoints/MTR/90,105/forecast';
  const periods = [
    forecastPeriod({ startTime: '2026-10-18T19:00:00.000Z', endTime: '2026-10-18T20:00:00.000Z', temperature: 59 }),
    forecastPeriod({ startTime: '2026-10-18T20:00:00.000Z', endTime: '2026-10-18T21:00:00.000Z', temperature: 67 })
  ];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/points/')) return response({ properties: { forecastHourly: hourlyUrl, forecast: forecastUrl } }, 86_400);
    if (String(url).includes('/alerts/active')) return response({ features: alerts }, 300);
    if (String(url) === hourlyUrl) {
      if (hourlyFails) throw new Error('hourly unavailable');
      return response({ properties: { periods } }, 600);
    }
    if (String(url) === forecastUrl) {
      return response({ properties: { periods: [forecastPeriod({ startTime: '2026-10-18T18:00:00.000Z', endTime: '2026-10-19T06:00:00.000Z', temperature: 70 })] } }, 600);
    }
    throw new Error(`Unexpected NWS URL: ${url}`);
  };
  return { calls, fetchImpl };
}

function forecastPeriod(overrides = {}) {
  return {
    startTime: '2026-10-18T20:00:00.000Z',
    endTime: '2026-10-18T21:00:00.000Z',
    temperature: 67,
    temperatureUnit: 'F',
    windSpeed: '7 to 9 mph',
    windGust: '17 mph',
    windDirection: 'NW',
    probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: 20 },
    relativeHumidity: { unitCode: 'wmoUnit:percent', value: 55 },
    shortForecast: 'Chance Rain Showers',
    ...overrides
  };
}

function response(payload, maxAge) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/geo+json', 'cache-control': `max-age=${maxAge}` } });
}

test('multiple roster players in one NFL game share one cached NWS forecast', async () => {
  const selected = selectRosterWeatherGames([
    { playerId: 'one', position: 'QB', nflTeamId: 25 },
    { playerId: 'two', position: 'WR', nflTeamId: 25 },
    { playerId: 'three', position: 'K', nflTeamId: 25 }
  ], { games: [game()] });
  assert.equal(selected.length, 1);

  const mock = nwsMock();
  const provider = createNwsGameWeatherProvider({ fetchImpl: mock.fetchImpl, now: () => new Date(NOW), venueCatalog: VENUES });
  const first = await provider.fetch({ season: 2026, week: 7, games: selected });
  const second = await provider.fetch({ season: 2026, week: 7, games: selected });
  assert.equal(first.games.length, 1);
  assert.equal(mock.calls.filter((url) => url.endsWith('/forecast/hourly')).length, 1);
  assert.equal(second.games[0].cache.forecast, 'memory_hit');
});

test('outdoor venue requests NWS and preserves kickoff weather fields', async () => {
  const mock = nwsMock();
  const provider = createNwsGameWeatherProvider({ fetchImpl: mock.fetchImpl, now: () => new Date(NOW), venueCatalog: VENUES });
  const result = await provider.fetch({ season: 2026, week: 7, games: [game()] });
  const weather = result.games[0];
  assert.equal(mock.calls.some((url) => url.includes('/points/')), true);
  assert.equal(weather.nwsAvailable, true);
  assert.deepEqual(weather.forecast, {
    basis: 'hourly', selectionMethod: 'contains_kickoff', validFrom: '2026-10-18T20:00:00.000Z', validTo: '2026-10-18T21:00:00.000Z',
    temperatureF: 67, windSpeedMph: 9, windGustMph: 17, windDirection: 'NW', precipitationProbabilityPercent: 20,
    precipitationType: 'rain', shortForecast: 'Chance Rain Showers', relativeHumidityPercent: 55, hazardous: false, alerts: []
  });
  assert.match(weather.summary, /67°F.*9 mph wind.*20% precipitation chance/);
});

test('fixed indoor venue does not make an NWS request', async () => {
  let calls = 0;
  const provider = createNwsGameWeatherProvider({ fetchImpl: async () => { calls += 1; throw new Error('should not fetch'); }, now: () => new Date(NOW), venueCatalog: VENUES });
  const result = await provider.fetch({ season: 2026, week: 7, games: [game({ venueId: 'fixed', venueName: 'Indoor Field' })] });
  assert.equal(calls, 0);
  assert.equal(result.games[0].summary, 'Indoor venue — weather impact minimal');
  assert.equal(result.games[0].cache.forecast, 'not_requested_indoor');
});

test('covered fixed-roof field does not present outside rain as playing-field weather', async () => {
  let calls = 0;
  const provider = createNwsGameWeatherProvider({ fetchImpl: async () => { calls += 1; throw new Error('should not fetch'); }, now: () => new Date(NOW), venueCatalog: VENUES });
  const result = await provider.fetch({ season: 2026, week: 7, games: [game({ venueId: 'covered', venueName: 'Covered Field' })] });
  assert.equal(calls, 0);
  assert.equal(result.games[0].summary, 'Covered fixed-roof venue — direct weather impact minimal');
  assert.equal(result.games[0].cache.forecast, 'not_requested_covered');
});

test('retractable roof reports unknown status instead of guessing', async () => {
  const mock = nwsMock();
  const provider = createNwsGameWeatherProvider({ fetchImpl: mock.fetchImpl, now: () => new Date(NOW), venueCatalog: VENUES });
  const result = await provider.fetch({ season: 2026, week: 7, games: [game({ venueId: 'roof', venueName: 'Roof Field' })] });
  assert.equal(result.games[0].roof.status, 'unknown');
  assert.equal(result.games[0].roof.verified, false);
  assert.match(result.games[0].summary, /^Retractable roof — status not verified/);

  let earlyCalls = 0;
  const earlyProvider = createNwsGameWeatherProvider({ fetchImpl: async () => { earlyCalls += 1; throw new Error('should not fetch'); }, now: () => new Date('2026-10-01T12:00:00.000Z'), venueCatalog: VENUES });
  const early = await earlyProvider.fetch({ season: 2026, week: 7, games: [game({ venueId: 'roof', venueName: 'Roof Field' })] });
  assert.equal(earlyCalls, 0);
  assert.match(early.games[0].summary, /^Retractable roof — status not verified.*not available this far ahead/);
});

test('forecast period containing kickoff is selected instead of an adjacent hour', () => {
  const periods = [
    forecastPeriod({ startTime: '2026-10-18T19:00:00.000Z', endTime: '2026-10-18T20:00:00.000Z', temperature: 59 }),
    forecastPeriod({ startTime: '2026-10-18T20:00:00.000Z', endTime: '2026-10-18T21:00:00.000Z', temperature: 67 })
  ];
  const selected = selectForecastPeriod(periods, KICKOFF);
  assert.equal(selected.period.temperature, 67);
  assert.equal(selected.method, 'contains_kickoff');
});

test('forecast parser accepts NWS quantitative values and unit conversions', () => {
  const normalized = normalizeForecastPeriod(forecastPeriod({
    temperature: { value: 20, unitCode: 'wmoUnit:degC' },
    windSpeed: { value: 16.0934, unitCode: 'wmoUnit:km_h-1' },
    windGust: null,
    probabilityOfPrecipitation: { value: 45 },
    relativeHumidity: { value: 72 }
  }));
  assert.equal(normalized.temperatureF, 68);
  assert.equal(normalized.windSpeedMph, 10);
  assert.equal(normalized.windGustMph, null);
  assert.equal(normalized.precipitationProbabilityPercent, 45);
  assert.equal(normalized.relativeHumidityPercent, 72);
});

test('weather flags use deterministic thresholds without player penalties', () => {
  const weather = { temperatureF: 25, windSpeedMph: 20, windGustMph: 35, precipitationProbabilityPercent: 60, precipitationType: 'snow', hazardous: true, alerts: [{ event: 'Winter Storm Warning', severity: 'Severe' }] };
  assert.deepEqual(deriveWeatherFlags(weather), ['Severe-weather watch', 'Strong wind', 'Snow possible', 'Cold']);
  assert.deepEqual(deriveWeatherFlags(weather), deriveWeatherFlags(weather));
  assert.deepEqual(deriveWeatherFlags({ temperatureF: 70, windSpeedMph: 5, windGustMph: 10, precipitationProbabilityPercent: 10 }), ['Calm']);
});

test('broader NWS period is clearly used when hourly forecast fails', async () => {
  const mock = nwsMock({ hourlyFails: true });
  const provider = createNwsGameWeatherProvider({ fetchImpl: mock.fetchImpl, now: () => new Date(NOW), venueCatalog: VENUES });
  const result = await provider.fetch({ season: 2026, week: 7, games: [game()] });
  assert.equal(result.games[0].available, true);
  assert.equal(result.games[0].forecast.basis, 'forecast_period');
  assert.equal(result.games[0].forecast.temperatureF, 70);
});

test('NWS failure returns an unavailable game and does not break the weather context', async () => {
  let calls = 0;
  const provider = createNwsGameWeatherProvider({ fetchImpl: async () => { calls += 1; throw new Error('network down'); }, now: () => new Date(NOW), venueCatalog: VENUES });
  const result = await provider.fetch({ season: 2026, week: 7, games: [game()] });
  const repeated = await provider.fetch({ season: 2026, week: 7, games: [game()] });
  assert.equal(result.games.length, 1);
  assert.equal(result.games[0].available, false);
  assert.equal(result.games[0].summary, 'Official weather temporarily unavailable.');
  assert.equal(calls, 1);
  assert.equal(repeated.games[0].cache.forecast, 'memory_hit');
  assert.equal(result.projectionsAdjusted, false);
  assert.deepEqual(result.safeguards, { readOnly: true, transactionsPerformed: false });
});

test('an expired forecast is reused as stale when an NWS refresh fails', async () => {
  const mock = nwsMock();
  let current = new Date(NOW);
  let failing = false;
  const provider = createNwsGameWeatherProvider({
    fetchImpl: (...args) => failing ? Promise.reject(new Error('refresh failed')) : mock.fetchImpl(...args),
    now: () => current,
    venueCatalog: VENUES,
    forecastCacheTtlMs: 1
  });
  const first = await provider.fetch({ season: 2026, week: 7, games: [game()] });
  assert.equal(first.games[0].available, true);
  current = new Date(current.getTime() + 301_000);
  failing = true;
  const second = await provider.fetch({ season: 2026, week: 7, games: [game()] });
  assert.equal(second.games[0].available, true);
  assert.equal(second.games[0].stale, true);
  assert.equal(second.games[0].cache.forecast, 'cached_after_failure');
  current = new Date(new Date(NOW).getTime() + 4 * 60 * 60_000);
  const tooOld = await provider.fetch({ season: 2026, week: 7, games: [game()] });
  assert.equal(tooOld.games[0].available, false);
  assert.equal(tooOld.games[0].summary, 'Official weather temporarily unavailable.');
});

test('NWS display data does not change existing projection context', () => {
  const player = { playerId: 'kicker', position: 'K', nflTeamId: 25, injuryStatus: null };
  const originalGame = game();
  const baseline = situationalContext(player, { games: [originalGame] });
  const withOfficialWeather = situationalContext(player, { games: [{ ...originalGame, officialWeather: { temperatureF: 10, windSpeedMph: 30 } }] });
  assert.deepEqual(withOfficialWeather, baseline);

  const evidence = buildWeatherEvidence([originalGame], { games: [{ gameId: originalGame.id, summary: '67°F • 9 mph wind', retrievedAt: NOW, forecast: { basis: 'hourly' } }] });
  assert.equal(evidence[0].source, 'Weather');
  assert.match(evidence[0].text, /NWS kickoff-hour forecast/);
});
