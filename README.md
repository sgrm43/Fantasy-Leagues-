# Fantasy League Analytics

A private, read-only fantasy-football decision system for the configured Sleeper and ESPN leagues. It combines league-specific projections with injuries, recent usage, weather, game context, and descriptive team tendencies, then turns those inputs into explainable weekly and season-planning recommendations.

## Run

```bash
npm start
```

Open [http://localhost:4173](http://localhost:4173). No package installation is needed; the app uses Node.js built-ins.

For private ESPN leagues, copy `.env.example` to `.env.local` and add the `espn_s2` and `SWID` cookies from an already authenticated ESPN browser session. The app never asks for or stores an ESPN password. `.env.local`, cached responses, and snapshots are ignored by Git.

## Commands

```bash
npm test          # normalization, scoring, lineup, and safety checks
npm run dev       # restart when source files change
```

## Current scope

- Read-only connections for the two supplied Sleeper leagues and three ESPN leagues
- Exact platform scoring settings, lineup slots, teams, and current rosters
- A current local cache plus capped six-hour historical snapshots
- Canonical player identity records that preserve platform IDs (names are display labels only)
- Connection health and stale/missing-data indicators
- Floor, median, mean, ceiling, threshold, bust, and spike outcome estimates
- Legal whole-lineup optimization for best-average, safer-floor, and higher-upside approaches
- Matchup win-chance estimates that are withheld when projection coverage is incomplete
- Injury/practice, recent usage, venue/weather, betting context, opponent-by-position response, and current-season team tendencies attached to a verified current head coach
- A local week-by-week coaching-period tracker that resets conservatively when the listed head coach changes and never assigns prior-season team results to a new coach
- Weekly waiver add/drop pairs and broad full-season roster-construction suggestions
- Read-only one-for-one trade analysis for both teams, including lineup and depth impact
- Side-by-side roster player comparisons with league-specific ranges and threshold chances

No endpoint performs lineup changes, claims, drops, or trades. Probabilities are transparent heuristics, not calibrated guarantees. The dashboard now includes a preliminary four-week historical accuracy check. Head-coach identity is connected, but offensive play-caller attribution, coverage/front modeling, playoff-schedule value, and fully leak-free calibration remain future model layers. Team results observed during a coaching period are descriptive and are never presented as proof that a coach caused or called a play.

## API

- `GET /api/health`
- `GET /api/leagues`
- `POST /api/sync` (all configured leagues)
- `POST /api/sync/:leagueKey`
- `GET /api/snapshots/:leagueKey`
- `GET /api/analysis/:leagueKey?teamId=...&objective=mean|floor|ceiling`
- `GET /api/backtest/:leagueKey` (preliminary historical projection accuracy check)
- `POST /api/trade/:leagueKey` (analysis only; never submits a trade)
- `POST /api/project` (statistical scenarios under a league's scoring rules)
