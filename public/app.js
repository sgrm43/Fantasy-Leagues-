const grid = document.querySelector('#leagues');
const template = document.querySelector('#league-template');
const syncAllButton = document.querySelector('#sync');
let leagueStates = [];
let activeLeague = null;
let activeTeam = null;
let compared = [];
let activeTeamHint = '';
let analysisRequest = 0;
let tradeRequest = 0;
let backtestRequest = 0;
let activeObjective = 'mean';
let currentAnalysis = null;
let lastDecisionRefresh = 0;
const backtestCache = new Map();

async function load() {
  const response = await fetch('/api/leagues');
  const states = await response.json();
  render(states);
}

function render(states) {
  leagueStates = states;
  grid.replaceChildren();
  let healthy = 0;
  let newest = null;
  for (const state of states) {
    const node = template.content.cloneNode(true);
    const card = node.querySelector('.league-card');
    const data = state.cache?.data;
    node.querySelector('.platform').textContent = state.definition.platform;
    node.querySelector('h3').textContent = data?.name || state.definition.name;
    node.querySelector('.league-id').textContent = `ID ${state.definition.id}`;
    node.querySelector('.teams').textContent = data?.teams?.length ?? '—';
    node.querySelector('.week').textContent = data?.currentWeek ?? '—';
    node.querySelector('.scoring').textContent = scoringLabel(data);
    const health = node.querySelector('.health');
    const dataWarnings = data?.dataIssues?.length || 0;
    health.textContent = state.cache ? state.cache.stale ? '● Stale' : dataWarnings ? `● Connected · ${dataWarnings} warning${dataWarnings === 1 ? '' : 's'}` : '● Connected' : '○ Not synced';
    health.classList.add(state.cache && !state.cache.stale ? 'ok' : state.cache?.stale ? 'error' : '');
    node.querySelector('.message').textContent = state.cache ? `${state.cache.stale ? 'Cached data needs a refresh.' : dataWarnings ? 'Core league data is current; one supporting source is unavailable.' : 'Snapshot current.'} Updated ${relative(state.cache.retrievedAt)}.` : 'Run a connection test to retrieve league data.';
    if (state.cache && !state.cache.stale) healthy++;
    if (state.cache?.retrievedAt && (!newest || state.cache.retrievedAt > newest)) newest = state.cache.retrievedAt;
    node.querySelector('.sync-one').addEventListener('click', (event) => syncOne(state.definition.key, event.currentTarget));
    const view = node.querySelector('.view-roster');
    view.disabled = !data;
    view.addEventListener('click', () => showLeague(state));
    grid.append(card);
  }
  document.querySelector('#system-status').textContent = healthy === states.length ? 'All leagues connected' : `${healthy} of ${states.length} current`;
  document.querySelector('#summary').textContent = `${healthy}/${states.length} league snapshots current`;
  document.querySelector('#last-refresh').textContent = newest ? relative(newest) : 'Never';
}

function showLeague(state) {
  activeLeague = state.cache?.data;
  activeTeamHint = state.definition?.ownerTeam || activeTeamHint;
  if (!activeLeague) return;
  const section = document.querySelector('#roster-view');
  const select = document.querySelector('#team-select');
  document.querySelector('#roster-league').textContent = activeLeague.name;
  select.replaceChildren(...activeLeague.teams.map((team) => new Option(`${team.id === localStorage.getItem(`my-team:${activeLeague.key}`) ? '★ ' : ''}${team.name}`, team.id)));
  select.onchange = () => showTeam(activeLeague.teams.find((team) => team.id === select.value));
  section.hidden = false;
  const saved = localStorage.getItem(`my-team:${activeLeague.key}`);
  const hinted = activeLeague.teams.find((team) => normalize(team.name).startsWith(normalize(activeTeamHint)));
  const initial = activeLeague.teams.find((team) => team.id === saved) || hinted || activeLeague.teams[0];
  if (!saved && hinted) localStorage.setItem(`my-team:${activeLeague.key}`, hinted.id);
  select.value = initial.id; showTeam(initial);
  section.scrollIntoView({ behavior: 'smooth' });
}

function showTeam(team) {
  if (!team) return;
  activeTeam = team; compared = []; currentAnalysis = null; renderComparison();
  document.querySelector('#team-name').textContent = team.name;
  document.querySelector('#manager-name').textContent = team.manager ? `Managed by ${team.manager}` : 'Manager not provided';
  document.querySelector('#team-record').textContent = `${team.record?.wins || 0}–${team.record?.losses || 0}${team.record?.ties ? `–${team.record.ties}` : ''}`;
  const mark = document.querySelector('#mark-team');
  const mine = localStorage.getItem(`my-team:${activeLeague.key}`) === team.id;
  mark.textContent = mine ? '★ My team' : '☆ Make this my team';
  mark.onclick = () => { localStorage.setItem(`my-team:${activeLeague.key}`, team.id); showLeague({ cache: { data: activeLeague } }); };
  renderMatchup(team);
  const starters = team.roster.filter((player) => !['bench', 'IR', 'taxi'].includes(player.slot));
  const bench = team.roster.filter((player) => ['bench', 'IR', 'taxi'].includes(player.slot));
  renderPlayers('#starters', starters); renderPlayers('#bench', bench);
  document.querySelector('#starter-count').textContent = `${starters.length} players`;
  document.querySelector('#bench-count').textContent = `${bench.length} players`;
  setupTrade(team);
  loadDecision(team);
  loadBacktest(activeLeague.key);
}

function setupTrade(team) {
  tradeRequest += 1;
  const otherSelect = document.querySelector('#trade-team'); const give = document.querySelector('#trade-give'); const receive = document.querySelector('#trade-receive');
  const others = activeLeague.teams.filter((item) => item.id !== team.id);
  otherSelect.replaceChildren(...others.map((item) => new Option(item.name, item.id)));
  give.replaceChildren(...[...team.roster].sort(playerSort).map((player) => new Option(`${player.name} · ${player.position} · ${point(player.projection)}`, player.playerId)));
  const fillReceive = () => { const other = activeLeague.teams.find((item) => item.id === otherSelect.value); receive.replaceChildren(...[...(other?.roster || [])].sort(playerSort).map((player) => new Option(`${player.name} · ${player.position} · ${point(player.projection)}`, player.playerId))); };
  otherSelect.onchange = fillReceive; fillReceive();
  const result = document.querySelector('#trade-result'); result.hidden = true; result.replaceChildren(); result.setAttribute('aria-busy', 'false');
  const button = document.querySelector('#analyze-trade'); button.disabled = false; button.textContent = 'Analyze trade';
  button.onclick = () => analyzeTrade(team, otherSelect.value, give.value, receive.value);
}

async function analyzeTrade(team, otherTeamId, giveId, receiveId) {
  const requestId = ++tradeRequest; const button = document.querySelector('#analyze-trade'); const target = document.querySelector('#trade-result');
  button.disabled = true; button.textContent = 'Analyzing…'; target.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(`/api/trade/${encodeURIComponent(activeLeague.key)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fromTeamId: team.id, toTeamId: otherTeamId, givePlayerIds: [giveId], receivePlayerIds: [receiveId] }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Trade analysis failed');
    if (requestId !== tradeRequest || activeTeam?.id !== team.id) return;
    renderTrade(result);
  } catch (error) {
    if (requestId !== tradeRequest || activeTeam?.id !== team.id) return;
    target.hidden = false; target.textContent = error.message;
  } finally {
    if (requestId === tradeRequest) { button.disabled = false; button.textContent = 'Analyze trade'; target.setAttribute('aria-busy', 'false'); }
  }
}

function renderTrade(result) {
  const target = document.querySelector('#trade-result'); const mine = result.sides.from; const theirs = result.sides.to;
  const caveats = (result.caveats || []).slice(0, 3).join(' ');
  target.hidden = false; target.innerHTML = `<div class="trade-verdict"><small>Current-week verdict</small><strong>${escapeHtml(result.verdict)}</strong><p>${escapeHtml(caveats)}</p></div><div class="trade-side"><span>${escapeHtml(mine.team.name)}</span><strong>${signed(mine.expectedLineupDelta)} lineup</strong><b>${percent(mine.probabilityImproves)} improve chance · ${signed(mine.depthDelta)} depth</b><em>${seasonSignal(mine.seasonSignal)}</em><small>${escapeHtml(mine.explanation)}</small></div><div class="trade-side"><span>${escapeHtml(theirs.team.name)}</span><strong>${signed(theirs.expectedLineupDelta)} lineup</strong><b>${percent(theirs.probabilityImproves)} improve chance · ${signed(theirs.depthDelta)} depth</b><em>${seasonSignal(theirs.seasonSignal)}</em><small>${escapeHtml(theirs.explanation)}</small></div>`;
}

function playerSort(a, b) { return String(a.position).localeCompare(String(b.position)) || Number(b.projection || 0) - Number(a.projection || 0); }
function signed(value) { const number = Number(value || 0); return `${number >= 0 ? '+' : ''}${number.toFixed(1)} pts`; }
function seasonSignal(signal) { return signal?.available ? `Broad season lineup signal ${signed(signal.expectedLineupDelta)}${signal.depthDelta == null ? '' : ` · depth ${signed(signal.depthDelta)}`}` : 'Broad season signal unavailable'; }

async function loadDecision(team) {
  const requestId = ++analysisRequest;
  const center = document.querySelector('#decision-center');
  center.dataset.state = 'loading'; center.setAttribute('aria-busy', 'true');
  currentAnalysis = null; renderComparison(); updateObjectiveButtons();
  renderTopActions(null);
  document.querySelector('#decision-empty').hidden = false; document.querySelector('#decision-content').hidden = true;
  document.querySelector('#decision-empty strong').textContent = 'Running your analysis…';
  document.querySelector('#decision-empty p').textContent = 'Checking lineup choices, injuries, usage, weather, waivers, and season depth.';
  document.querySelector('#decision-status').textContent = 'Analyzing projections, lineup legality, injuries, weather, and game context…';
  try {
    const response = await fetch(`/api/analysis/${encodeURIComponent(activeLeague.key)}?teamId=${encodeURIComponent(team.id)}&objective=${encodeURIComponent(activeObjective)}`);
    const analysis = await response.json();
    if (requestId !== analysisRequest) return;
    if (!response.ok) throw new Error(analysis.error || 'Analysis unavailable');
    renderDecision(analysis);
  } catch (error) {
    if (requestId !== analysisRequest) return;
    center.dataset.state = 'empty'; center.setAttribute('aria-busy', 'false');
    document.querySelector('#decision-empty').hidden = false; document.querySelector('#decision-content').hidden = true;
    document.querySelector('#decision-empty strong').textContent = 'Analysis unavailable';
    document.querySelector('#decision-empty p').textContent = 'Refresh the league and try again.';
    document.querySelector('#decision-status').textContent = error.message;
  }
}

function renderDecision(analysis) {
  currentAnalysis = analysis;
  lastDecisionRefresh = Date.now();
  activeObjective = analysis.decisionMode?.objective || activeObjective; updateObjectiveButtons();
  const center = document.querySelector('#decision-center'); center.dataset.state = analysis.stale ? 'stale' : 'ready'; center.setAttribute('aria-busy', 'false');
  document.querySelector('#decision-empty').hidden = true; document.querySelector('#decision-content').hidden = false;
  const win = analysis.matchup?.winProbability;
  document.querySelector('#decision-status').textContent = `Week ${analysis.league.week} analysis${win == null ? '' : ` · ${Math.round(win * 100)}% heuristic matchup win chance`}`;
  const updated = document.querySelector('#decision-updated'); updated.textContent = relative(analysis.generatedAt); updated.dateTime = analysis.generatedAt;
  const recommendation = analysis.recommendation;
  setText('#recommendation-type', recommendation.type); setText('#recommendation-urgency', recommendation.urgency); setText('#recommendation-title', recommendation.title);
  const gainLabel = activeObjective === 'floor' ? 'Safer-floor gain' : activeObjective === 'ceiling' ? 'Upside gain' : 'Expected weekly gain';
  setText('#recommendation-summary', recommendation.summary); setText('#recommendation-caveat', recommendation.caveat); setText('#recommendation-gain-label', gainLabel); setText('#recommendation-gain', `+${Number(recommendation.expectedGain || 0).toFixed(1)} pts`); setText('#recommendation-confidence', recommendation.confidence);
  renderTopActions(analysis.topActionsToday);
  renderWeeklyIntelligence(analysis.weeklyIntelligence);
  renderProjectionCards(analysis.projections.slice(0, 8), activeTeam, analysis.projections.length, analysis.nextGenContext);
  renderLineupAlerts(analysis.lineup?.recommendations || []);
  renderWaivers(analysis.waivers?.recommendations || []);
  renderStrategy(analysis.strategy);
  renderCoachTracker(analysis.coachTracker);
  renderEvidence(analysis.evidence || []);
  setText('#uncertainty-text', analysis.uncertainty); setText('#change-text', (analysis.changeTriggers || []).join(' '));
  renderComparison();
}

function renderTopActions(report) {
  const panel = document.querySelector('#top-actions');
  const list = document.querySelector('#top-actions-list');
  const actions = Array.isArray(report?.actions) ? report.actions.slice(0, 5) : [];
  list.replaceChildren();
  panel.hidden = actions.length === 0;
  if (!actions.length) return;

  document.querySelector('#top-actions-title').textContent = report.title || 'Top Actions Today';
  document.querySelector('#top-actions-count').textContent = `${actions.length} action${actions.length === 1 ? '' : 's'}`;
  for (const action of actions) {
    const item = document.createElement('li'); item.className = 'top-action';
    item.dataset.status = String(action.status || 'Monitor').toLowerCase().replace(/[^a-z]+/g, '-');
    const status = document.createElement('span'); status.className = 'top-action-status'; status.textContent = action.status || 'Monitor';
    const copy = document.createElement('div');
    const title = document.createElement('h4'); title.textContent = action.action || 'Review this decision';
    const reason = document.createElement('p'); reason.textContent = action.reason || 'No additional context is available yet.';
    copy.append(title, reason); item.append(status, copy); list.append(item);
  }
}

function renderWeeklyIntelligence(report) {
  let panel = document.querySelector('#weekly-intelligence');
  if (!panel) {
    panel = document.createElement('section');
    panel.id = 'weekly-intelligence'; panel.className = 'weekly-intelligence'; panel.setAttribute('aria-labelledby', 'weekly-intelligence-title');
    panel.innerHTML = '<div class="panel-heading"><div><p class="eyebrow">Why this lineup</p><h4 id="weekly-intelligence-title">Weekly Intelligence</h4></div><span id="weekly-intelligence-count" class="panel-count"></span></div><ol id="weekly-intelligence-list" class="weekly-intelligence-list"></ol><section class="why-lineup" aria-labelledby="why-lineup-title"><h5 id="why-lineup-title">Why this lineup</h5><div id="why-lineup-list" class="why-lineup-list"></div></section><aside id="weekly-key-uncertainty" class="weekly-key-uncertainty" hidden><strong>Key uncertainty</strong><h5></h5><p></p></aside><p class="weekly-readonly-note">Explanation only. Projections and lineup choices are unchanged, and no fantasy move is made.</p>';
    document.querySelector('#top-recommendation').after(panel);
  }

  const observations = report?.observations || [];
  const observationList = panel.querySelector('#weekly-intelligence-list'); observationList.replaceChildren();
  setText('#weekly-intelligence-count', observations.length ? `${observations.length} key observation${observations.length === 1 ? '' : 's'}` : 'No material updates');
  if (!observations.length) {
    const empty = document.createElement('li'); empty.className = 'weekly-intelligence-empty';
    empty.textContent = 'No high-value evidence is available yet. Missing and Learning data are kept neutral.'; observationList.append(empty);
  }
  for (const observation of observations) {
    const item = document.createElement('li'); item.className = 'weekly-intelligence-item'; item.dataset.kind = observation.kind || 'context';
    const copy = document.createElement('div'); const title = document.createElement('h5'); const explanation = document.createElement('p');
    title.textContent = observation.headline; explanation.textContent = observation.explanation; copy.append(title, explanation); item.append(copy);
    const tags = intelligenceTags(observation.evidenceCategories, observation.confidence); if (tags) item.append(tags);
    observationList.append(item);
  }

  const decisions = report?.whyThisLineup || [];
  const whyList = panel.querySelector('#why-lineup-list'); whyList.replaceChildren();
  panel.querySelector('.why-lineup').hidden = decisions.length === 0;
  for (const decision of decisions) {
    const item = document.createElement('article'); item.className = 'why-lineup-item';
    const top = document.createElement('div'); const title = document.createElement('h6'); const quality = document.createElement('span');
    title.textContent = decision.alternativePlayer
      ? `${decision.targetSlot || 'Lineup'} · ${decision.recommendedPlayer.name} over ${decision.alternativePlayer.name}`
      : `${decision.targetSlot || 'Lineup'} · Start ${decision.recommendedPlayer.name}`;
    quality.textContent = `${decision.qualityLabel || intelligenceQualityLabel(decision.supportClassification)} · ${decision.confidence || 'Uncertain'} confidence`;
    top.append(title, quality); const explanation = document.createElement('p'); explanation.textContent = decision.explanation;
    item.append(top, explanation); whyList.append(item);
  }

  const uncertainty = report?.keyUncertainty;
  const uncertaintyPanel = panel.querySelector('#weekly-key-uncertainty'); uncertaintyPanel.hidden = !uncertainty;
  if (uncertainty) {
    uncertaintyPanel.querySelector('h5').textContent = uncertainty.headline;
    uncertaintyPanel.querySelector('p').textContent = uncertainty.explanation;
  }
}

function intelligenceTags(categories = [], confidence = null) {
  const labels = [...new Set(categories)].slice(0, 3).map(intelligenceCategoryLabel);
  if (confidence && !labels.length) labels.push(`${confidence} confidence`);
  if (!labels.length) return null;
  const wrap = document.createElement('div'); wrap.className = 'weekly-intelligence-tags';
  for (const label of labels) { const tag = document.createElement('span'); tag.textContent = label; wrap.append(tag); }
  return wrap;
}

function intelligenceCategoryLabel(category) {
  return ({ volumeOpportunity: 'Opportunity / volume', role: 'Role', scoringOpportunity: 'Scoring opportunity', efficiency: 'Efficiency', recentTrend: 'Recent trend', gameEnvironment: 'Game environment', matchup: 'Matchup', healthAvailability: 'Health' })[category]
    || String(category || '').replace(/([a-z])([A-Z])/g, '$1 $2');
}

function intelligenceQualityLabel(classification) {
  return ({ strongly_supported: 'Strongly supported', supported: 'Supported', mixed: 'Mixed evidence', projection_conflict: 'Projection conflict', insufficient_evidence: 'Insufficient evidence' })[classification] || 'Evidence review';
}

function renderCoachTracker(tracker) {
  let panel = document.querySelector('#coach-tracker-panel');
  if (!panel) {
    panel = document.createElement('section');
    panel.id = 'coach-tracker-panel'; panel.className = 'coach-tracker-panel'; panel.setAttribute('aria-labelledby', 'coach-tracker-title');
    panel.innerHTML = '<div class="panel-heading"><div><p class="eyebrow">All rostered QB · RB · WR · TE teams</p><h4 id="coach-tracker-title">Coach tracker</h4></div><span id="coach-tracker-status" class="panel-count" role="status" aria-live="polite"></span></div><section class="coach-tracker-section" aria-labelledby="coach-offenses-title"><h5 id="coach-offenses-title">Your roster offenses</h5><div id="coach-offense-groups" class="coach-tracker-groups"></div></section><section class="coach-tracker-section" aria-labelledby="coach-defenses-title"><h5 id="coach-defenses-title">This week\'s opponent defenses</h5><div id="coach-defense-groups" class="coach-tracker-groups"></div></section><p class="waiver-scope">Team results are descriptive only. They do not change projections or prove an individual coach\'s intent.</p>';
    document.querySelector('#calibration-panel').before(panel);
  }
  const offenseGroups = panel.querySelector('#coach-offense-groups'); const defenseGroups = panel.querySelector('#coach-defense-groups');
  offenseGroups.replaceChildren(); defenseGroups.replaceChildren();
  const offenses = tracker?.offenses || []; const defenses = tracker?.defenses || [];
  setText('#coach-tracker-status', `${offenses.length} offense${offenses.length === 1 ? '' : 's'} · ${defenses.length} defense${defenses.length === 1 ? '' : 's'}`);
  if (!offenses.length) offenseGroups.append(coachEmpty('No rostered QB, RB, WR, or TE teams could be identified.'));
  else for (const group of offenses) offenseGroups.append(renderOffenseCoachCard(group));
  if (!defenses.length) defenseGroups.append(coachEmpty('No current opponent defenses could be matched.'));
  else for (const group of defenses) defenseGroups.append(renderDefenseCoachCard(group));
}

function renderOffenseCoachCard(group) {
  const card = coachCard(group.team?.abbreviation || 'NFL', 'offense', group.coachingContext);
  card.append(coachPlayers(group.players, 'Rostered players'));
  card.append(coachRoles(group.coachingContext, ['headCoach', 'offensiveCoordinator', 'offensivePlayCaller']));
  const trend = group.teamTrend; const tendency = document.createElement('p'); tendency.className = 'coach-tendency';
  if (trend?.available) {
    const passRate = trend.metrics?.passAttemptRate?.value; const runRate = trend.metrics?.rushAttemptRate?.value; const rushes = trend.metrics?.rushAttemptsPerGame?.value; const plays = trend.metrics?.offensivePlaysPerGame?.value;
    tendency.textContent = [passRate == null ? null : `${Math.round(passRate * 100)}% pass`, runRate == null ? null : `${Math.round(runRate * 100)}% run`, rushes == null ? null : `${Number(rushes).toFixed(1)} rushes/game`, plays == null ? null : `${Number(plays).toFixed(1)} plays/game`, `${trend.window?.includedGames || 0}-game sample`].filter(Boolean).join(' · ');
  } else if (trend?.learning) tendency.textContent = 'Learning — waiting for the first completed game in this coaching period.';
  else tendency.textContent = 'Current-period team tendency is not available.';
  card.append(tendency);
  if (trend?.nflverse) card.append(coachNflverseTendencies(trend.nflverse));
  if (trend?.games?.length) card.append(coachWeekDetails(trend.games));
  return card;
}

function coachNflverseTendencies(trend) {
  const wrap = document.createElement('div'); wrap.className = 'coach-nflverse'; const title = document.createElement('strong'); title.textContent = 'nflverse play-by-play'; wrap.append(title);
  if (!trend.available) { const empty = document.createElement('p'); empty.textContent = 'Learning — waiting for completed current-period play-by-play.'; wrap.append(empty); return wrap; }
  const list = document.createElement('ul'); const metrics = trend.metrics || {};
  const rows = [
    ['Neutral situations', metrics.neutralPassRate?.value == null ? null : percent(metrics.neutralPassRate.value), metrics.neutralPassRate?.label],
    ['Overall pass/run', metrics.overallPassRate?.value == null ? null : `${percent(metrics.overallPassRate.value)} pass · ${percent(metrics.overallRunRate?.value)} run`, metrics.overallPassRate?.label],
    ['Pace', metrics.secondsPerPlay?.value == null ? null : `${metrics.secondsPerPlay.value} seconds/play`, metrics.secondsPerPlay?.label],
    ['Early downs', metrics.earlyDownPassRate?.value == null ? null : percent(metrics.earlyDownPassRate.value), metrics.earlyDownPassRate?.label],
    ['Red zone', metrics.redZonePassRate?.value == null ? null : `${percent(metrics.redZonePassRate.value)} pass · ${percent(metrics.redZoneRunRate?.value)} run`, metrics.redZonePassRate?.label],
    ['Recent change', null, trend.recentChange?.label]
  ];
  for (const [label, value, meaning] of rows) {
    if (!value && (!meaning || meaning === 'Not enough data' || meaning === 'Not enough weekly data')) continue;
    const item = document.createElement('li'); item.textContent = `${label}: ${[value, meaning].filter(Boolean).join(' · ')}`; list.append(item);
  }
  if (!list.childElementCount) { const item = document.createElement('li'); item.textContent = 'Not enough current-period plays yet.'; list.append(item); }
  wrap.append(list); return wrap;
}

function renderDefenseCoachCard(group) {
  const card = coachCard(group.team?.abbreviation || 'NFL', 'defense', group.coachingContext);
  card.append(coachPlayers(group.affectedPlayers, 'Your affected players'));
  card.append(coachRoles(group.coachingContext, ['headCoach', 'defensiveCoordinator', 'defensivePlayCaller']));
  const contexts = document.createElement('div'); contexts.className = 'coach-position-contexts';
  for (const item of group.positionContexts || []) {
    const row = document.createElement('p'); const metric = item.metrics?.opportunity; const sample = item.sample?.includedGames || 0;
    const value = metric?.valuePerGame == null ? null : `${metric.valuePerGame} ${metric.unit}`;
    const comparison = item.sample?.adequate ? metric.band : sample ? 'small sample' : item.learning ? 'learning' : 'Not verified';
    const basis = item.attribution?.toCurrentStaff === false ? 'historical team baseline; not current-staff attribution' : 'current defensive period';
    row.textContent = `${item.position || 'Position'}: ${value || 'Not verified'} · ${comparison} · ${sample} game${sample === 1 ? '' : 's'} · ${basis}`;
    contexts.append(row);
  }
  if (!contexts.childElementCount) contexts.append(coachEmpty('Opponent position response is not available.'));
  card.append(contexts);
  return card;
}

function coachCard(team, side, coaching) {
  const card = document.createElement('article'); card.className = 'coach-team-card';
  const header = document.createElement('header'); const title = document.createElement('h6'); const status = document.createElement('span');
  title.textContent = `${team} ${side}`;
  status.textContent = !coaching?.available ? 'Not verified' : coaching.stale ? 'Stale' : 'Verified';
  status.className = 'coach-status'; header.append(title, status); card.append(header); return card;
}

function coachPlayers(players, label) {
  const wrap = document.createElement('div'); wrap.className = 'coach-players'; const strong = document.createElement('strong'); strong.textContent = label;
  const list = document.createElement('ul');
  for (const player of players || []) { const item = document.createElement('li'); item.textContent = `${player.name || 'Unknown player'} · ${player.position || '?'} · ${player.lineupStatus || player.slot || 'roster'}`; list.append(item); }
  wrap.append(strong, list); return wrap;
}

function coachRoles(coaching, roles) {
  const list = document.createElement('dl'); list.className = 'coach-role-list';
  for (const roleName of roles) {
    const role = coaching?.roles?.[roleName]; const row = document.createElement('div'); const label = document.createElement('dt'); const value = document.createElement('dd'); const name = document.createElement('strong'); const period = document.createElement('small');
    label.textContent = role?.label || coachRoleLabel(roleName); name.textContent = role?.status === 'verified' ? role.name : 'Not verified';
    period.textContent = role?.status === 'verified' && role.period?.startWeek ? `Tracked from Week ${role.period.startWeek}` : 'No current verified period';
    value.append(name, period); row.append(label, value); list.append(row);
  }
  return list;
}

function coachWeekDetails(games) {
  const details = document.createElement('details'); details.className = 'coach-week-details'; const summary = document.createElement('summary'); summary.textContent = 'Week-by-week team results'; const list = document.createElement('ul');
  for (const game of [...games].sort((a, b) => Number(a.week) - Number(b.week)).slice(-6)) {
    const row = document.createElement('li'); const rate = game.metrics?.passAttemptRate; const rushes = game.metrics?.rushAttempts; const plays = game.metrics?.offensivePlays;
    row.textContent = [`Week ${game.week}`, game.opponent?.abbreviation ? `vs ${game.opponent.abbreviation}` : null, rate == null ? null : `${Math.round(rate * 100)}% pass`, rushes == null ? null : `${rushes} rushes`, plays == null ? null : `${plays} plays`].filter(Boolean).join(' · '); list.append(row);
  }
  details.append(summary, list); return details;
}

function coachEmpty(message) { const empty = document.createElement('p'); empty.className = 'coach-tracker-empty'; empty.textContent = message; return empty; }
function coachRoleLabel(role) { return ({ headCoach: 'Head coach', offensiveCoordinator: 'Offensive coordinator', offensivePlayCaller: 'Offensive play caller', defensiveCoordinator: 'Defensive coordinator', defensivePlayCaller: 'Defensive play caller' })[role] || role; }

function renderStrategy(strategy) {
  const groups = document.querySelector('#position-groups'); const moves = document.querySelector('#strategy-moves'); groups.replaceChildren(); moves.replaceChildren();
  setText('#strategy-needs', !strategy ? 'Unavailable' : strategy.needs?.length ? `Needs: ${strategy.needs.join(', ')}` : 'Balanced depth');
  for (const group of strategy?.positionGroups || []) {
    const item = document.createElement('div'); item.className = `position-group ${group.depth}`;
    item.innerHTML = `<strong>${escapeHtml(group.position)}</strong><span>${group.rostered} rostered</span><b>${escapeHtml(group.depth)}</b>`; groups.append(item);
  }
  for (const move of (strategy?.recommendations || []).slice(0, 3)) {
    const item = document.createElement('div'); item.className = 'strategy-move';
    item.innerHTML = `<span>#${move.rank}</span><div><strong>Add ${escapeHtml(move.add.name)} · Drop ${escapeHtml(move.drop.name)}</strong><small>${escapeHtml(move.reason)}</small></div><b>+${move.seasonProjectionDelta.toFixed(1)} season pts</b>`; moves.append(item);
  }
  if (!strategy?.recommendations?.length) { const empty = document.createElement('p'); empty.className = 'panel-empty'; empty.textContent = strategy ? 'No supported full-season add/drop upgrade found.' : 'Season strategy is unavailable for this league right now.'; moves.append(empty); }
}

async function loadBacktest(key) {
  const requestId = ++backtestRequest;
  const cacheKey = `${key}:${activeLeague?.season || ''}:${activeLeague?.currentWeek || ''}`;
  const panel = document.querySelector('#calibration-panel');
  const metrics = document.querySelector('#calibration-metrics');
  const positions = document.querySelector('#calibration-positions');
  panel.dataset.state = 'loading';
  panel.setAttribute('aria-busy', 'true');
  metrics.replaceChildren(); positions.replaceChildren();
  renderSystemEvaluation(null, { loading: true });
  setText('#calibration-status', 'Checking…');
  setText('#calibration-summary', 'Comparing past platform projections with actual scores.');
  setText('#calibration-note', 'This is a preliminary accuracy check, not a promise about the next game.');
  try {
    let result = backtestCache.get(cacheKey);
    if (!result) {
      const response = await fetch(`/api/backtest/${encodeURIComponent(key)}`);
      result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Historical check unavailable');
      backtestCache.set(cacheKey, result);
    }
    if (requestId !== backtestRequest || activeLeague?.key !== key) return;
    renderBacktest(result);
  } catch (error) {
    if (requestId !== backtestRequest || activeLeague?.key !== key) return;
    panel.dataset.state = 'error';
    panel.setAttribute('aria-busy', 'false');
    setText('#calibration-status', 'Unavailable');
    setText('#calibration-summary', error.message);
    setText('#calibration-note', 'Your live recommendations still work. This section only checks past accuracy.');
    renderSystemEvaluation(null, { unavailable: true });
  }
}

function renderBacktest(result) {
  const panel = document.querySelector('#calibration-panel');
  const metrics = document.querySelector('#calibration-metrics');
  const positions = document.querySelector('#calibration-positions');
  const sampleSize = Number(result.sampleSize || 0);
  const weeks = result.includedWeeks?.length ? result.includedWeeks.join(', ') : null;
  panel.setAttribute('aria-busy', 'false');
  renderSystemEvaluation(result.selfEvaluation);
  if (!sampleSize) {
    panel.dataset.state = 'empty';
    metrics.replaceChildren(); positions.replaceChildren();
    setText('#calibration-status', 'No usable history');
    setText('#calibration-summary', weeks ? `No usable player results were found in ${result.window?.season}, Weeks ${weeks}.` : 'No completed historical weeks were available for this check.');
    setText('#calibration-note', [...(result.limitations || []), result.methodology?.leakageRisk].filter(Boolean).join(' '));
    return;
  }
  panel.dataset.state = result.partial ? 'partial' : 'ready';
  setText('#calibration-status', result.partial ? `Partial · ${sampleSize} player-weeks` : `${sampleSize} player-weeks`);
  setText('#calibration-summary', `Checked ${result.window?.season || 'past games'} · Weeks ${weeks} · ${sampleSize} player-weeks`);

  const cards = [
    { label: 'Average miss', value: result.metrics?.mae == null ? '—' : `${Number(result.metrics.mae).toFixed(1)} pts`, note: 'Typical difference from the actual score' },
    { label: 'Range hit', value: percent(result.metrics?.intervalCoverage), note: 'Actual score landed inside floor–ceiling' },
    { label: 'Probability error', value: result.metrics?.brierError == null ? '—' : Number(result.metrics.brierError).toFixed(2), note: 'Lower is better' },
    { label: 'Projection link', value: result.metrics?.correlation == null ? '—' : Number(result.metrics.correlation).toFixed(2), note: 'Correlation with actual scores' }
  ];
  metrics.replaceChildren(...cards.map((card) => {
    const item = document.createElement('div'); item.className = 'calibration-metric';
    const label = document.createElement('small'); label.textContent = card.label;
    const value = document.createElement('strong'); value.textContent = card.value;
    const note = document.createElement('span'); note.textContent = card.note;
    item.append(label, value, note); return item;
  }));

  positions.replaceChildren(...(result.byPosition || []).map((group) => {
    const item = document.createElement('span');
    item.textContent = `${group.position}: ${group.mae == null ? '—' : `${Number(group.mae).toFixed(1)} pts`} avg miss`;
    return item;
  }));
  const partialNote = result.partial ? ' Some weeks could not be loaded.' : '';
  const limitations = [result.methodology?.leakageRisk, ...(result.limitations || [])].filter(Boolean).join(' ');
  setText('#calibration-note', `${limitations || 'Historical results are a preliminary check.'}${partialNote}`);
}

function renderSystemEvaluation(report, { loading = false, unavailable = false } = {}) {
  let section = document.querySelector('#system-evaluation');
  if (!section) {
    section = document.createElement('section');
    section.id = 'system-evaluation';
    section.className = 'system-evaluation';
    section.setAttribute('aria-labelledby', 'system-evaluation-title');
    section.innerHTML = '<div class="system-evaluation-head"><div><p class="eyebrow">Leakage-safe results</p><h5 id="system-evaluation-title"></h5></div><span id="system-evaluation-period" class="panel-count"></span></div><p id="system-evaluation-message" class="system-evaluation-message"></p><dl id="system-evaluation-metrics" class="system-evaluation-metrics"></dl>';
    document.querySelector('#calibration-panel .panel-heading').after(section);
  }

  const title = section.querySelector('#system-evaluation-title');
  const message = section.querySelector('#system-evaluation-message');
  const period = section.querySelector('#system-evaluation-period');
  const metrics = section.querySelector('#system-evaluation-metrics');
  if (loading) {
    section.dataset.state = 'loading';
    title.textContent = 'System Score: Checking…';
    message.textContent = 'Checking completed pregame predictions against confirmed final results.';
    period.textContent = '';
    metrics.replaceChildren();
    return;
  }
  if (unavailable) {
    section.dataset.state = 'unavailable';
    title.textContent = 'System Score: Unavailable';
    message.textContent = 'The accuracy record could not be loaded right now.';
    period.textContent = '';
    metrics.replaceChildren();
    return;
  }

  const status = String(report?.status || 'collecting').toLowerCase();
  const score = report?.score == null ? null : Number(report.score);
  const scored = status === 'scored' && Number.isFinite(score);
  section.dataset.state = scored ? 'scored' : status;
  title.textContent = scored
    ? (report.display || `System Score: ${score.toFixed(1)}/100`)
    : status === 'early_analysis'
      ? 'System Score: Early Analysis'
      : 'System Score: Collecting';
  message.textContent = report?.message || (status === 'collecting'
    ? 'Not enough completed predictions yet to calculate a reliable score.'
    : 'There is enough completed history to inspect patterns, but not enough to treat the score as reliable.');
  period.textContent = report?.season?.season ? `Season ${report.season.season}` : '';

  const sample = report?.sample || {};
  const cards = [
    ['Completed decisions', Number(sample.completedDecisions || 0)],
    ['Completed predictions', Number(sample.completedRecords || 0)],
    ['Unique player-games', Number(sample.uniquePlayerGames || 0)],
    ['NFL weeks', Number(sample.weeksRepresented || 0)]
  ];
  metrics.replaceChildren(...cards.map(([labelText, valueText]) => {
    const item = document.createElement('div');
    const label = document.createElement('dt'); label.textContent = labelText;
    const value = document.createElement('dd'); value.textContent = String(valueText);
    item.append(label, value);
    return item;
  }));
}

function renderWaivers(moves) {
  const container = document.querySelector('#waiver-list'); container.replaceChildren();
  document.querySelector('#waiver-empty').hidden = moves.length > 0; setText('#waiver-count', `${moves.length} moves`);
  for (const move of moves.slice(0, 6)) {
    const node = document.querySelector('#waiver-template').content.cloneNode(true);
    node.querySelector('.waiver-rank').textContent = `#${move.rank}`; node.querySelector('.waiver-action').textContent = `${move.urgency} urgency · ${move.positionFit}`;
    node.querySelector('.waiver-add').textContent = move.add.name; node.querySelector('.waiver-drop').textContent = move.drop.name;
    node.querySelector('.waiver-reason').textContent = move.reasons?.[0] || 'Weekly projection upgrade.';
    node.querySelector('.waiver-impact strong').textContent = `+${move.expectedWeeklyDelta.toFixed(1)}`; container.append(node);
  }
}

function renderProjectionCards(projections, team, total = projections.length, nextGenContext = null) {
  const container = document.querySelector('#projection-cards'); container.replaceChildren();
  setText('#projection-count', total > projections.length ? `Top ${projections.length} of ${total}` : `${projections.length} players`);
  const slots = new Map(team.roster.map((player) => [player.playerId, player.slot]));
  const nextGenById = new Map((nextGenContext?.players || []).map((player) => [String(player.requestedPlayerId), player]));
  const max = Math.max(1, ...projections.map((item) => item.ceiling || 0));
  for (const projection of projections) {
    const node = document.querySelector('#projection-template').content.cloneNode(true); const card = node.querySelector('.projection-card');
    node.querySelector('.projection-slot').textContent = `${slots.get(projection.playerId) || projection.position} · ${projection.position}`;
    node.querySelector('.projection-name').textContent = projection.name; node.querySelector('.projection-median').textContent = point(projection.median);
    node.querySelector('.projection-floor').textContent = point(projection.floor); node.querySelector('.projection-mid').textContent = point(projection.median); node.querySelector('.projection-ceiling').textContent = point(projection.ceiling);
    node.querySelector('.projection-context').textContent = thresholdSummary(projection);
    node.querySelector('.projection-volatility').textContent = `Bust ${percent(projection.bustProbability)} · Spike ${percent(projection.spikeProbability)}`;
    node.querySelector('.projection-source').textContent = `${projection.confidence.level} confidence · ${projection.freshness.status}`;
    renderNextGen(node.querySelector('.projection-next-gen'), nextGenById.get(String(projection.playerId)));
    card.style.setProperty('--range-start', `${Math.max(0, projection.floor / max * 100)}%`); card.style.setProperty('--range-width', `${Math.max(2, (projection.ceiling - projection.floor) / max * 100)}%`); card.style.setProperty('--marker', `${Math.max(0, Math.min(100, (projection.median - projection.floor) / Math.max(.1, projection.ceiling - projection.floor) * 100))}%`);
    container.append(node);
  }
}

function renderNextGen(container, player) {
  if (!container || !player) return;
  container.hidden = false;
  const current = player.current?.available ? player.current : null;
  const reference = player.reference?.available ? player.reference : null;
  container.querySelector('.next-gen-period').textContent = current?.label || 'Learning';
  container.querySelector('.next-gen-summary').textContent = current ? (current.descriptions || []).join(' · ') : player.status;
  const referenceCopy = container.querySelector('.next-gen-reference');
  referenceCopy.hidden = !reference || Boolean(current);
  if (reference && !current) referenceCopy.textContent = `${reference.label} · ${(reference.descriptions || []).join(' · ')}`;
  const metrics = current?.metrics || reference?.metrics || [];
  const list = container.querySelector('.next-gen-metrics'); list.replaceChildren();
  for (const metric of metrics.slice(0, 5)) {
    const item = document.createElement('div');
    const label = document.createElement('dt'); label.textContent = metric.label;
    const value = document.createElement('dd'); value.textContent = metric.display;
    item.append(label, value); list.append(item);
  }
}

function renderLineupAlerts(recommendations) {
  const container = document.querySelector('#lineup-alerts'); container.replaceChildren();
  const empty = document.querySelector('#alerts-empty'); empty.hidden = recommendations.length > 0; setText('#alert-count', `${recommendations.length} alerts`);
  for (const recommendation of recommendations) {
    const node = document.querySelector('#lineup-alert-template').content.cloneNode(true); const alert = node.querySelector('.lineup-alert');
    const severity = recommendation.expectedGain >= 3 ? 'high' : recommendation.expectedGain >= 1.5 ? 'medium' : 'low'; alert.dataset.severity = severity;
    node.querySelector('.alert-severity').textContent = severity; node.querySelector('.alert-title').textContent = `Start ${recommendation.start.name}`;
    node.querySelector('.alert-summary').textContent = recommendation.sit ? `Sit ${recommendation.sit.name}; use ${recommendation.targetSlot}. About ${percent(recommendation.probabilityStartOutscoresSit)} chance to score more.` : `Fill the open ${recommendation.targetSlot} slot.`;
    node.querySelector('.alert-reason').textContent = recommendation.caveats?.[0] || recommendation.rationale?.[0] || '';
    node.querySelector('.alert-impact').textContent = `+${recommendation.expectedGain.toFixed(1)} pts`; container.append(node);
  }
}

function renderEvidence(evidence) {
  const container = document.querySelector('#evidence-list'); container.replaceChildren();
  for (const item of evidence) {
    const node = document.querySelector('#evidence-template').content.cloneNode(true); node.querySelector('.evidence-source').textContent = item.source;
    node.querySelector('.evidence-text').textContent = item.text; node.querySelector('.evidence-time').textContent = item.retrievedAt ? relative(item.retrievedAt) : 'unavailable'; container.append(node);
  }
}

function setText(selector, value) { document.querySelector(selector).textContent = value == null ? 'Unavailable' : value; }
function point(value) { return value == null ? '—' : Number(value).toFixed(1); }
function percent(value) { return value == null ? '—' : `${Math.round(value * 100)}%`; }
function thresholdSummary(projection) { const values = projection.thresholdProbabilities || []; return values.length ? values.map((item) => `${item.threshold}+ pts ${percent(item.probability)}`).join(' · ') : 'Point-threshold chances unavailable'; }

function renderPlayers(target, players) {
  const container = document.querySelector(target); container.replaceChildren();
  for (const player of players) {
    const node = document.querySelector('#player-template').content.cloneNode(true);
    node.querySelector('.slot').textContent = player.slot;
    node.querySelector('.avatar').textContent = initials(player.name || player.position || '?');
    node.querySelector('.player-info strong').textContent = player.name || `Player ${player.platformPlayerId}`;
    node.querySelector('.player-info small').textContent = [player.position, player.nflTeam].filter(Boolean).join(' · ') || 'Position unavailable';
    node.querySelector('.player-id').textContent = player.position || '';
    const row = node.querySelector('.player-row');
    if (compared.some((item) => item.playerId === player.playerId)) row.classList.add('selected');
    row.addEventListener('click', () => selectPlayer(player));
    container.append(node);
  }
}

function renderMatchup(team) {
  const strip = document.querySelector('#matchup-strip');
  const matchup = activeLeague.matchups?.find((item) => item.teamId === team.id);
  const opponentMatchup = matchup && activeLeague.matchups?.find((item) => item.matchupId === matchup.matchupId && item.teamId !== team.id);
  const opponent = opponentMatchup && activeLeague.teams.find((item) => item.id === opponentMatchup.teamId);
  strip.innerHTML = matchup ? `<span>Week ${activeLeague.currentWeek} matchup</span><strong>${escapeHtml(team.name)} <i>${matchup.points || 0} — ${opponentMatchup?.points || 0}</i> ${escapeHtml(opponent?.name || 'Opponent TBD')}</strong>` : '<span>Weekly matchup</span><strong>Matchup not available yet</strong>';
}

function selectPlayer(player) {
  const index = compared.findIndex((item) => item.playerId === player.playerId);
  if (index >= 0) compared.splice(index, 1); else { if (compared.length === 2) compared.shift(); compared.push(player); }
  renderPlayers('#starters', activeTeam.roster.filter((p) => !['bench', 'IR', 'taxi'].includes(p.slot)));
  renderPlayers('#bench', activeTeam.roster.filter((p) => ['bench', 'IR', 'taxi'].includes(p.slot)));
  renderComparison();
}

function renderComparison() {
  const box = document.querySelector('#compare'); box.hidden = false;
  const slots = document.querySelector('#compare-slots'); slots.replaceChildren();
  for (let index = 0; index < 2; index++) {
    const player = compared[index]; const card = document.createElement('div'); card.className = 'compare-card';
    const projection = player && currentAnalysis?.projections?.find((item) => item.playerId === player.playerId);
    card.innerHTML = player ? `<small>${escapeHtml(player.slot || player.position || 'Player')} · ${escapeHtml(player.position || '')}</small><strong>${escapeHtml(player.name || player.platformPlayerId)}</strong><b>${projection ? `${point(projection.median)} median pts` : player.projection == null ? 'Projection unavailable' : `${point(player.projection)} source pts`}</b>${projection ? `<span>Range ${point(projection.floor)}–${point(projection.ceiling)}</span><span>${escapeHtml(thresholdSummary(projection))}</span>` : ''}` : '<small>Choose a player</small><strong>Click a roster row</strong><b>—</b>';
    slots.append(card);
  }
}

document.querySelector('#clear-compare').addEventListener('click', () => { compared = []; if (activeTeam) { renderPlayers('#starters', activeTeam.roster.filter((p) => !['bench', 'IR', 'taxi'].includes(p.slot))); renderPlayers('#bench', activeTeam.roster.filter((p) => ['bench', 'IR', 'taxi'].includes(p.slot))); renderComparison(); } });
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }

function initials(name) { return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(); }
function normalize(value) { return String(value || '').normalize('NFKD').replace(/[^a-z0-9]/gi, '').toLowerCase(); }

async function syncOne(key, button) {
  button.disabled = true; button.textContent = 'Connecting…';
  const response = await fetch(`/api/sync/${key}`, { method: 'POST' });
  const result = await response.json();
  if (!result.ok) alert(result.code === 'ESPN_AUTH' ? `${result.error}. Add ESPN_S2 and SWID to .env.local, then restart.` : result.error);
  await load();
}

syncAllButton.addEventListener('click', async () => {
  syncAllButton.disabled = true; syncAllButton.textContent = '↻ Syncing…';
  const response = await fetch('/api/sync', { method: 'POST' });
  const results = await response.json();
  const failures = results.filter((r) => !r.ok);
  if (failures.length) alert(failures.map((r) => `${r.key}: ${r.error}`).join('\n'));
  syncAllButton.disabled = false; syncAllButton.innerHTML = '<span>↻</span> Sync all leagues'; await load();
});

function scoringLabel(data) { if (!data) return '—'; const reception = data.scoring?.rules?.receptions; return reception === 1 ? 'PPR' : reception === .5 ? 'Half PPR' : data.platform === 'sleeper' ? 'Custom' : 'League rules'; }
function relative(date) { const seconds = Math.round((Date.now() - Date.parse(date)) / 1000); if (seconds < 60) return 'just now'; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`; return `${Math.floor(seconds / 86400)}d ago`; }

function updateObjectiveButtons() {
  for (const button of document.querySelectorAll('[data-objective]')) button.setAttribute('aria-pressed', String(button.dataset.objective === activeObjective));
}
for (const button of document.querySelectorAll('[data-objective]')) {
  button.addEventListener('click', () => { if (!activeTeam || button.dataset.objective === activeObjective) return; activeObjective = button.dataset.objective; loadDecision(activeTeam); });
}
updateObjectiveButtons();

const AUTO_ANALYSIS_MS = 5 * 60_000;
setInterval(() => { if (activeTeam && document.visibilityState === 'visible') loadDecision(activeTeam); }, AUTO_ANALYSIS_MS);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && activeTeam && Date.now() - lastDecisionRefresh >= AUTO_ANALYSIS_MS) loadDecision(activeTeam); });

load().catch(() => { document.querySelector('#system-status').textContent = 'Server unavailable'; });
