# Fantasy League Project — Checkpoint

Updated: September 8, 2026

## Start here next time

Tell Codex: **“Read `PROJECT_CHECKPOINT.md`, continue with only one bounded part, test it, restart the local site, and stop.”**

The local site is: http://localhost:4173

If it is not running, start it from this project with `npm start`.

## User preferences

- Explain everything simply and directly, as if the user is 12.
- Work in small parts and stop after each part to protect usage.
- At the end, say only what the user needs to click.
- Keep the system read-only. It may recommend moves but must never make fantasy transactions.

## Connected fantasy teams

- Sleeper — Ad te venio 🏈
- Sundays Are for DUI — sgrm43
- League of Champions — Big C
- Frontera Bowl — Bang Bang Niner Gang
- Los Pistoleros — Deflate Gate

Private ESPN cookies are already stored in `.env.local`. Never display or copy their values.

## Working now

- All five leagues sync with correct teams and rosters.
- League-specific scoring, weekly projections, floor/median/ceiling ranges, bust/spike and point-threshold chances.
- Legal full-lineup optimization for best average, safer floor, and higher upside.
- Weekly matchup estimate, injury/practice context, weather, venue, betting context, recent player usage, and opponent-position response.
- Weekly waiver add/drop recommendations, broad season roster strategy, and read-only trade analysis.
- Four-week historical accuracy checks for every league.
- Current 2026 head coaches are verified from ESPN for all 32 teams.
- A local coach-period ledger lives at `data/cache/coach-tracker.json`.
- Coach changes open a new period; prior-season or pre-observation games are not attributed to a new coach.
- Current-season team pass/run/pace results are tracked week by week for the featured high-leverage starter's NFL offense. At Week 1 the panel correctly says “Learning.”
- The Coach tracker is now a visible panel on the main analysis screen.

## Next Gen Stats status

- The nflverse Next Gen provider is implemented for passing, receiving, and rushing context on rostered QBs, RBs, WRs, and TEs.
- Each league-wide stat file is downloaded once, cached by stat type and source data version, then filtered locally. The same cached files are reused across leagues and players.
- nflverse currently has no 2026 Next Gen rows, so current-season player context correctly says “Learning — no 2026 Next Gen Stats sample yet.”
- Qualifying 2025 data may appear only in a separate section labeled “2025 reference”; it is never substituted for 2026 data.
- Next Gen Stats remains descriptive only. It does not enter projection, floor/median/ceiling, bust/spike, lineup, waiver, or trade calculations.
- Real limitation: Next Gen Stats omits players below its qualification thresholds, so a missing player or metric remains unavailable rather than becoming zero.

## Secondary odds integration status

- The existing The Odds API v4 provider is connected to the cached NFL game context for spreads and totals only.
- ESPN remains primary. When both sources have a line, ESPN stays returned and The Odds API is retained only as confirmation context; missing ESPN fields can fall back to clearly labeled The Odds API consensus lines.
- Totals are `confirmed` within 1 point, `minor_difference` above 1 through 3, and `disagreement` above 3. Home-perspective spreads use the same labels at 0.5 and 1.5 points.
- One module-level provider/cache is reused by every matched game and roster player. Quota metadata is not copied into player-facing context.
- Odds remain descriptive and unweighted. Projection, lineup, waiver, and trade calculations are unchanged, and all safeguards remain read-only.
- Exact home/away team names and a compatible kickoff are required; ambiguous or unavailable secondary data leaves current ESPN behavior unchanged.

## Betting calibration status

- A calibration-data audit was completed, but no betting calibration analysis was created because the existing historical projection rows contain no game/team identity, home/away status, kickoff, pregame spread/total, or verified pre-kickoff line timestamp.
- Leakage-safe historical betting sample: 0 for QB, RB, WR, and TE. Current odds caches are temporary and are not historical records.
- Game total, implied team points, and spread/game script therefore have unknown—not zero—residual predictive value.
- No production betting weights or projection changes were applied.
- Per the insufficient-data stop rule, no calibration tests were added.

## Pregame decision snapshot status

- Leakage-safe pregame snapshots are stored locally at `data/history/pregame-decision-snapshots.json` with atomic writes and a serialized read-modify-write queue.
- Each compact QB/RB/WR/TE record retains game/player/league identity, the scoring-settings fingerprint, median/floor/ceiling, primary and secondary betting lines, comparison status, and lightweight injury, venue/weather, coaching-period, NGS, and nflverse status.
- Identity is `season + week + NFL game + player + fantasy league`, so repeat pregame analysis updates one record while different league projections remain separate. `first_capture_at` is preserved and `latest_capture_at` advances.
- A capture is accepted only when `captured_at < kickoff`. The earliest known `lock_at` is immutable, so a later schedule value cannot reopen a protected record after kickoff.
- A callable postgame result service now attaches actual fantasy points only after the matching ESPN NFL scoreboard game has `status.completed === true`.
- ESPN `appliedTotal` and Sleeper `players_points` are fetched for the exact league/week and retained as league-scored results; scoring fingerprints must match the locked snapshot.
- Results are stored in a separate compact `result` section. Every locked pregame field remains unchanged, and a valid attached result is never rewritten by duplicate processing.
- No accuracy analysis, calibration weights, or projection changes have been applied. Read-only fantasy safeguards remain unchanged.

## Calibration readiness status

- A callable calibration-readiness evaluator reports completed leakage-safe records from `data/history/pregame-decision-snapshots.json` for one season at a time; the current scope is 2026 only.
- QB, RB, WR, and TE are reported separately. League-specific observations remain visible, while duplicate fantasy-league copies are deduplicated for the unique player-game counts used by readiness thresholds.
- `early_analysis` requires every position to have at least 20 unique player-games across 4 NFL weeks. `calibration_candidate` requires every position to have at least 60 across 8 weeks.
- Current status: `collecting` — 0 completed 2026 records across 0 NFL weeks. The history file contains 13 valid Week 1 pregame records; all 13 remain pending, with 0 unmatched and 0 unavailable.
- This is reporting only. No calibration, automatic weights, or projection changes are applied.

## System self-evaluation status

- A read-only System Self-Evaluation framework now evaluates the existing leakage-safe pregame snapshot and confirmed postgame-result history; it does not create a second historical database.
- Current 2026 status is `collecting`: 0 completed predictions and 0 completed start/sit decisions; all 13 stored pregame records remain pending. Weekly and season scores are unavailable. The UI and machine report show `System Score: Collecting`, never `0/100`.
- Separate weekly, season-to-date, QB/RB/WR/TE, and fantasy-league/scoring-context reports are supported. Season scores aggregate the underlying observations rather than averaging weekly percentages.
- Components cover start/sit accuracy and actual margin, decision value, Brier probability calibration, locked-median projection error/bias, floor/median/ceiling outcome location, locked bust/spike/threshold probabilities, confidence-group discipline, agreement accuracy, and counterfactual follow-through.
- Ignored recommendations are graded against their locked alternative independently of what the user started. Agreement decisions are gradeable only when a pregame alternative was also locked.
- Readiness gates are centralized and use completed decisions, unique player-games, NFL weeks, and position diversity. Weekly early/scored gates are 6/12 decisions; season early/scored gates are 20/60 decisions across at least 4/8 weeks, with corresponding unique-player-game and position requirements.
- Overall component weights are explicitly provisional configuration. No calibration weights, projection formulas, optimizer behavior, recommendation logic, or fantasy transactions are changed automatically.

## Top Actions Today status

- A compact `Top Actions Today` section now appears below the selected-team header and before the deeper weekly analysis, with at most five items and no filler actions.
- The fixed priority order is availability emergencies/actionable news, material optimizer lineup changes, close or conflicting lineup decisions, the existing top-ranked waiver action, then meaningful Weekly Intelligence observations.
- It reuses the organized current/recommended lineup, Recommendation Quality classifications, Weekly Intelligence, actionable news, injury context, and existing waiver ranking. It does not create a second optimizer or analysis model.
- Related player/news/lineup items and duplicate versions of one recommendation are merged. Empty inputs stay empty; an explicitly matching current/recommended lineup may show one `No action` item.
- `projection_conflict`, mixed, Low, and Uncertain comparisons are labeled `Close call` rather than overstated as strong instructions.
- The section is read-only and cannot set a lineup, add/drop a player, submit a claim, or change projections, optimizer results, or waiver rankings.

## News-change evaluation status

- A shared callable news-source adapter layer now normalizes roster-relevant ESPN, Sleeper, structured official NFL reports, official team injury/practice reports, official transaction/depth-chart information, and official team news/PR input before using the existing news-change evaluator.
- Official inputs must be normally accessible public structured data. X/social APIs, paid news APIs, paywalled/authenticated sources, browser automation, access-control workarounds, and generic scraping are explicitly not supported; such candidates return `source_not_supported` without blocking the monitor.
- Every adapter returns the same compact event shape and uses exact player/team IDs. One shared source cycle filters to the selected roster, isolates failures, and retains safe source health without clearing known player state.
- Trust levels are `official_primary`, `official_secondary`, and `existing_provider`. Authority order is: official game/injury designation, official practice report, official transaction/depth chart, official team news/PR statement, then ESPN/Sleeper.
- Equivalent cross-source reports merge into one event with provenance. A higher-authority source wins a resolvable disagreement; equal-authority disagreement remains `conflicting_reports` and is not guessed into the evaluator.
- Source-level raw-response TTL caches and in-flight reuse prevent per-player downloads. Team-page caches include the relevant NFL-team scope so the same page can be shared safely without leaking one team’s payload into another. A rate-limited source stays cached through its retry window; other sources continue normally.
- The callable news-change evaluator compares minimal normalized player/team availability, practice, role, and game status. Its local baseline state is stored atomically at `data/cache/news-change-state.json`.
- The first observation within each season/week/game/source boundary is baseline only. Repeated or equivalent wording is deduplicated and returns `none` instead of replaying a change.
- Deterministic `none`, `minor`, `meaningful`, and `critical` rules identify only fantasy-relevant changes. Meaningful/critical changes flag structured lineup, confidence, waiver, or availability recommendations for reanalysis through stable player IDs.
- The existing evaluator and recommendation filtering are unchanged. No polling timer, notification delivery, fantasy transaction, or projection change was added.

## Recommendation Quality status

- A callable Recommendation Quality layer now reviews each existing start/sit recommendation and each unambiguous one-player close call without changing the optimizer's choice.
- Evidence is collapsed into eight groups: volume/opportunity, role, scoring opportunity, efficiency, recent trend, game environment, matchup, and health/availability. Correlated metrics contribute only one direction per group.
- Deterministic results are `strongly_supported`, `supported`, `mixed`, `projection_conflict`, or `insufficient_evidence`, with High, Moderate, Low, or Uncertain confidence labels and no invented confidence percentages.
- Opportunity, role, and scoring opportunity take priority over short-term efficiency. The report flags both small-volume efficiency dependence and strong workload without recent scoring.
- Missing, stale, unavailable, Learning, and prior-season NGS reference values remain neutral. Unsupported fields such as target share, rushing share, route participation, goal-line-only carries, designed QB runs, and end-zone targets are never inferred.
- The layer is descriptive and read-only. Projection distributions, start/sit identities, legal lineup optimization, waiver logic, and trade logic are unchanged.

## Efficiency calibration status

- Efficiency/skill residual backtesting correctly deferred at the readiness gate: the 2026 sample has 0 completed league observations, 0 unique player-games, 0 unique players, and 0 NFL weeks for QB, RB, WR, and TE.
- Passing, rushing, receiving/after-catch, and separation/coverage efficiency groups are all `insufficient_sample`; no persistence, regression-to-mean, or residual-effect conclusion was attempted.
- No 2025 data was mixed into the 2026 pool, no production weights or projection changes were applied, and no calibration tests were added or run because calibration did not begin.

## Important limits

- Coaching trends describe team results during a verified period. They do not prove the head coach personally called each play.
- Offensive coordinator and game-day play-caller assignments are not connected yet.
- Opponent and coach trends are currently descriptive context, not numerical projection adjustments.
- Projection probabilities are explainable heuristics, not fully calibrated guarantees.
- Playoff-schedule value and comprehensive live-news monitoring remain future parts.

## Verification

- The focused secondary-odds integration and provider tests pass 23/23 using mocks only.
- The focused pregame snapshot tests pass 12/12 using fixtures and mocked time only.
- The focused postgame result-attachment tests pass 11/11 using fixtures/mocks only.
- The focused calibration-readiness tests pass 10/10 using fixtures only.
- The focused news-change evaluator tests pass 11/11 using fixtures/mocks only.
- The focused free multi-source news-adapter tests pass 13/13 using mocked source responses only.
- The focused Recommendation Quality tests pass 12/12 using deterministic fixtures only.
- The focused System Self-Evaluation tests pass 14/14 using locked fixtures only.
- The focused Top Actions Today tests pass 12/12 using existing-analysis fixtures only.
- The combined focused verification for Self-Evaluation, snapshots, and the existing historical-check path passes 32/32.
- `npm test` passes 270/270 tests.
- September 6 data-intake check: the existing postgame processor examined all 13 stored Week 1 records; ESPN confirmed all 13 games were not final, so 0 results were attached and no pipeline issue was found. The focused postgame, calibration-readiness, and System Score tests pass 35/35.
- Live 2026 Next Gen verification confirmed the Learning state, separate 2025 reference labels, shared cache hits across two leagues, and read-only/projection-isolation safeguards.
- Live Sleeper analysis verified Ben Johnson / CHI, Week 1 learning state, and read-only safeguards.
- Live ESPN analysis verified John Harbaugh / NYG and the Week 1 learning state.
- The site should remain bound only to `127.0.0.1:4173`.

## Best next small parts

Choose only one per session:

1. Add a short “Top actions today” list that combines lineup, waiver, and injury priorities.
2. Connect verified offensive coordinators/play callers without guessing, then separate their periods from head-coach periods.
3. Expand descriptive coach/team evidence from the key starter to every relevant starter while keeping requests cached and fast.
4. Add playoff-schedule strength as a clearly labeled rest-of-season planning signal.
5. Add a quiet news-change monitor that only alerts when a recommendation meaningfully changes.

## Main files

- `src/analysis-service.js` — assembles the weekly decision report.
- `src/context-service.js` — game, injury, usage, coach, team-trend, and opponent context.
- `src/providers/espn-nfl-coaches.js` — current head-coach identity provider.
- `src/coach-tracker.js` — local coach-period tracking and change resets.
- `src/providers/espn-nfl-team-trends.js` — current-season weekly team tendencies.
- `public/app.js` and `public/styles.css` — dashboard behavior and appearance.
