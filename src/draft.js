// Draft board generator: turns the cumulative player stats from a snapshot into
// a ranked big board plus a simulated 6-team snake draft.
//
// The valuation model, in order of operation:
//   1. Per-game rates      — GP varies 1..6, so totals would just rank the
//                            players who showed up most. Rates level that.
//                            (Net PPP and TO% come out of Hoopsalytics as
//                            rates already; foul rate is computed here as
//                            Fouls / Def. Poss. for the same reason a raw
//                            per-game foul count would — see below. All
//                            three skip this step.)
//   2. Reliability shrink  — a 30 PPG average over 3 games is less certain than
//                            over 6, so rates regress toward a *replacement
//                            level* baseline with weight K. This is about
//                            *sample noise*.
//
//                            The target is replacement level, not the pool mean,
//                            and that choice matters. Shrinking toward the mean
//                            pulls every small sample upward, so a below-average
//                            player is *rewarded* for having played fewer games:
//                            under the pool-mean target, GP correlated -0.26 with
//                            value across the bottom half of the board. Playing
//                            more made you look worse, which is backwards for a
//                            league that forfeits when teams can't field five.
//                            Replacement level makes the prior "an unknown player
//                            is a marginal player" rather than "an unknown player
//                            is average" — truer, and sign-neutral: that
//                            correlation goes to +0.03. It also makes the result
//                            insensitive to K (the gap between two adjacent
//                            bottom-of-board players moved <0.01 across K=1..3),
//                            which is the signature of the target being right.
//   3. Z-score composite   — each category standardized across the pool and
//                            weighted, so rebounds and assists are comparable.
//   4. Availability mult   — attendance (GP/6) scaled into a firm secondary
//                            factor. This is about *value*, not noise: the
//                            league forfeits when a team can't field players,
//                            so showing up is worth something on its own. Tuned
//                            so it moves players across tiers but never floats
//                            a low producer over an elite one.
//
// Note on the denominator: teams have played 7 games but the stats table only
// carries 6 games' worth of lines, so attendance is measured against 6. A
// 6-GP player is treated as perfect attendance, not 86%. That 6 is derived from
// the data (max GP in the pool) rather than hardcoded, so the board stays
// correct as the season runs on and the gap between scheduled and recorded
// games moves.
//
// Usage:  node src/draft.js [snapshot-stamp] [--teams N] [--rounds N]
import { writeFileSync, mkdirSync } from "node:fs";
import { listSnapshots, loadSnapshot } from "./lib.js";

// ---- tunables --------------------------------------------------------------
const SHRINK_K = 2; // pseudo-games pulled toward replacement level
const REPLACEMENT_PCTILE = 0.25; // "replacement level" = this quantile of the pool
const ATT_BASE = 0.76; // availability multiplier at zero attendance
const ATT_SLOPE = 0.36; // ...plus this much at full attendance → 1.12 at 6/6

// Category weights for the composite. Scoring leads, then rebounding and
// playmaking, then defense; turnovers are a penalty. Two categories draw on
// Hoopsalytics' advanced views rather than the basic box score:
//   - netppp  — team point differential per possession while the player is
//               on court (Off. PPP − Def. PPP). The single best two-way
//               impact number Hoopsalytics exposes, so it earns real weight
//               alongside — not instead of — the counting stats.
//   - deflect — deflections per game. A hustle/defense signal steals and
//               blocks miss entirely (most deflections never become a
//               takeaway), weighted lightly since it's a noisier stat.
// Turnovers moved from a raw per-game count to TO% (turnovers per 100
// plays), since raw count just measures usage — a low-usage player looks
// "safe" purely by touching the ball less. TO% is usage-normalized, so it
// actually separates careless ball-handling from low involvement.
//   - foul_rate — personal fouls per 100 defensive possessions (Fouls /
//                 Def. Poss.), the same usage-normalization applied to TO%
//                 and for the same reason: a bench player fouls less
//                 purely by playing fewer possessions, not by being more
//                 disciplined. Weighted lighter than TO% (-0.25 vs -0.4)
//                 because fouls that result in made free throws are
//                 already partly reflected in Def. PPP — this term is
//                 mainly picking up non-shooting fouls, bonus-trigger
//                 fouls, and foul-out risk that PPP doesn't see.
// Other Hoopsalytics fields (Usage%, Reb%, A/TO, Charges, Tie-Ups, Def.
// Fail/Praise, FTO) were left out: Usage%/Reb%/A/TO are largely redundant
// with categories already here once shrink+z-score normalize them, and
// Charges/Tie-Ups/Def. Fail/Def. Praise/FTO are near-all-zero in this pool
// (see the collector's field notes) — no signal to weight.
const WEIGHTS = {
  pts: 1.0,
  reb: 0.7,
  ast: 0.7,
  stl: 0.5,
  blk: 0.4,
  deflect: 0.3,
  netppp: 0.6,
  ts: 0.4,
  to_pct: -0.4,
  foul_rate: -0.25,
};

const num = (v) => {
  const n = Number(String(v ?? "").replace(/[%,]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(argv[i + 1]);
};
const NUM_TEAMS = flag("teams", 6);
const stampArg = argv.find((a) => !a.startsWith("--") && /^\d{4}-\d{2}-\d{2}$/.test(a));

const stamps = listSnapshots();
if (stamps.length === 0) {
  console.error("No snapshots found. Run `npm run collect` first.");
  process.exit(1);
}
const stamp = stampArg || stamps[stamps.length - 1];
const snap = loadSnapshot(stamp);
if (!snap.hoopsalytics.length) {
  console.error(`Snapshot ${stamp} has no Hoopsalytics stats. Run \`node src/collect-hoopsalytics.js ${stamp}\` first.`);
  process.exit(1);
}
const NUM_ROUNDS = flag("rounds", Math.floor(snap.hoopsalytics.length / NUM_TEAMS));

// Attendance denominator: the stats table lags the schedule (teams have played
// more games than the table carries lines for), so measure attendance against
// the most games any player is credited with rather than against the schedule.
// Deriving it keeps the board honest as the season runs on.
const GAMES_WITH_STATS = Math.max(...snap.hoopsalytics.map((p) => num(p.Games)), 1);

// ---- 1. per-game rates -----------------------------------------------------
// Sourced from Hoopsalytics (src/collect-hoopsalytics.js), the league's stats
// provider — richer than the basic box score TeamLinkt republishes, and it
// carries True Shooting % directly rather than needing it derived here.
const raw = snap.hoopsalytics.map((p) => {
  const gp = Math.max(num(p.Games), 1);
  const madeOf = (s) => num(String(s ?? "").split("/")[0]);
  return {
    name: p.name,
    team_code: p.team,
    team: p.team,
    gp: num(p.Games),
    pts: num(p["Pts."]) / gp,
    reb: num(p.Reb) / gp,
    ast: num(p.Ast) / gp,
    stl: num(p.Stl) / gp,
    blk: num(p.Blk) / gp,
    deflect: num(p.Deflect) / gp,
    to: num(p.TO) / gp, // informational only — TO% (below) drives scoring
    to_pct: num(p["TO%"]),
    netppp: num(p["Net PPP"]),
    ts: num(p["TS%"]),
    foul_rate: num(p["Def. Poss."]) > 0 ? (num(p.Fouls) / num(p["Def. Poss."])) * 100 : 0,
    totals: {
      pts: num(p["Pts."]), reb: num(p.Reb), ast: num(p.Ast),
      stl: num(p.Stl), blk: num(p.Blk), to: num(p.TO), deflect: num(p.Deflect),
      threes: madeOf(p["3Pt/A"]), fouls: num(p.Fouls),
    },
  };
});

const CATS = Object.keys(WEIGHTS);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const stdev = (xs) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) || 1;
};

// ---- 2. shrink rates toward replacement level ------------------------------
// Players with few games get pulled toward a marginal-player baseline, because
// we simply don't know much about them yet and the safe prior on an unknown is
// "replacement", not "average". Weight is gp/(gp+K). See the header note for
// why the target is replacement level rather than the pool mean.
const quantile = (xs, q) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(q * (sorted.length - 1))];
};

const replacement = {};
for (const c of CATS) {
  const xs = raw.map((p) => p[c]);
  // Turnovers are a negative — a replacement-level player commits *more* of
  // them, so take the quantile from the top of the distribution instead.
  replacement[c] = quantile(xs, WEIGHTS[c] < 0 ? 1 - REPLACEMENT_PCTILE : REPLACEMENT_PCTILE);
}

for (const p of raw) {
  p.adj = {};
  for (const c of CATS) {
    p.adj[c] = (p.gp * p[c] + SHRINK_K * replacement[c]) / (p.gp + SHRINK_K);
  }
}

// ---- 3. weighted z-score composite -----------------------------------------
const stat = {};
for (const c of CATS) {
  const xs = raw.map((p) => p.adj[c]);
  stat[c] = { mu: mean(xs), sd: stdev(xs) };
}

for (const p of raw) {
  p.z = {};
  let base = 0;
  for (const c of CATS) {
    p.z[c] = (p.adj[c] - stat[c].mu) / stat[c].sd;
    base += WEIGHTS[c] * p.z[c];
  }
  p.base = base;
  // ---- 4. availability ----
  p.attendance = Math.min(p.gp / GAMES_WITH_STATS, 1);
  p.availability = ATT_BASE + ATT_SLOPE * p.attendance;
  // Shift into positive space before scaling, so the multiplier can't flip the
  // sign of a negative score (which would reward absence for weak players).
  p.value = (p.base + 5) * p.availability - 5;
}

raw.sort((a, b) => b.value - a.value);
raw.forEach((p, i) => (p.rank = i + 1));

// ---- tiers -----------------------------------------------------------------
// Cut on natural gaps in the value curve rather than fixed bucket sizes.
// These thresholds are recalibrated for the wider composite range that comes
// from folding in deflections and Net PPP (roughly -8..+10 now, vs. the old
// seven-category model's -4..+8) — re-tune them if the category set or
// weights change again and the curve's gaps drift from these breaks.
//
// One exception to the gap rule: the Starter/Rotation break at 0.5 is a size
// cut, not a gap cut. The middle of the board is genuinely smooth — no gap
// there exceeds ~0.35 — so a single tier across it would swallow a third of
// the pool and say nothing useful about any of them. Splitting on size keeps
// the tiers legible; don't go looking for the natural seam it implies.
const TIER_NAMES = [
  "MVP", "All-Star", "Core Starter", "Starter", "Rotation", "Bench", "Depth",
];
const tierOf = (p) => {
  const v = p.value;
  if (v >= 8.0) return 0;
  if (v >= 4.0) return 1;
  if (v >= 1.8) return 2;
  if (v >= 0.5) return 3;
  if (v >= -0.6) return 4;
  if (v >= -4.0) return 5;
  return 6;
};
for (const p of raw) p.tier = tierOf(p);

// ---- archetype tag ---------------------------------------------------------
// Every player gets a label that says something true and specific about them.
//
// The old version compared each player to the league in absolute terms, so a
// player below average everywhere cleared no threshold and fell through to
// "Depth" — which happened to 40% of the board and told a reader nothing. The
// fix isn't kinder thresholds (that would just make the tags lie); it's asking
// a better question in three passes:
//
//   1. Distinctions — league-leading or otherwise notable *facts* (top-3 in a
//      category, real 3-point volume, never turns it over, perfect attendance).
//      Rank-based, so they hold regardless of where a player sits on the board.
//   2. Absolute strengths — the original z-score tags. A genuine standout gets
//      called a Scorer, and that still outranks a merely-relative strength.
//   3. Relative strength — for everyone else, the category where the player
//      most exceeds *their own* average z-score across categories. Phrased in
//      role language ("Glass Work", "Ball Mover") rather than praise language,
//      so it stays honest about a fringe player while still being descriptive.
//
// Only the fallback is guaranteed to fire, so "Depth" is gone: the last resort
// is now whatever that player does comparatively best.

// Per-category rank across the pool (1 = best), on *observed* per-game rates
// rather than the shrunk ones the valuation uses. The distinction is
// deliberate: these tags are claims about what a player has actually done, and
// shrink exists to hedge a projection. Ranking the shrunk rates buried the
// league's deflection leader (1.6/gm over 5 games) behind players who'd done
// less but done it more often — true for a draft projection, wrong for a label
// that says "leads the league". The min-GP guards on each check below carry
// the sample-size concern instead. Negative-weighted categories rank ascending.
const catRank = {};
for (const c of CATS) {
  const order = [...raw].sort((a, b) =>
    WEIGHTS[c] < 0 ? a[c] - b[c] : b[c] - a[c]);
  catRank[c] = new Map(order.map((p, i) => [p.name, i + 1]));
}
const rankIn = (p, c) => catRank[c].get(p.name);

// Threes are a totals stat, not one of the model's categories, so rank them
// separately — per game, to stay consistent with everything else on the board.
const threeRate = (p) => (p.gp ? p.totals.threes / p.gp : 0);
const threeOrder = [...raw].sort((a, b) => threeRate(b) - threeRate(a));
const threeRank = new Map(threeOrder.map((p, i) => [p.name, i + 1]));

// Minimum per-game production for a category to count as a player's relative
// strength — the median among players who register the stat at all. Keeps a
// trace amount of a rare stat from outranking real production in a common one.
const relFloor = {};
for (const c of CATS) {
  if (WEIGHTS[c] < 0) continue;
  const doers = raw.map((p) => p[c]).filter((v) => v > 0).sort((a, b) => a - b);
  relFloor[c] = doers.length ? doers[Math.floor(doers.length / 2)] : 0;
}

// Labels for a *relative* strength — the thing this player does best among the
// things they do. Deliberately role-flavored rather than superlative: a fringe
// player who rebounds more than he shoots is doing "Glass Work", not being a
// "Rebounder", and the difference keeps the board credible.
const RELATIVE_LABEL = {
  pts: "Scoring Punch",
  reb: "Glass Work",
  ast: "Ball Mover",
  stl: "Pickpocket",
  blk: "Shot Blocker",
  deflect: "Disruptor",
  netppp: "Plus Minutes",
  ts: "Picks His Spots",
  to_pct: "Sure Hands",
  foul_rate: "Clean Defender",
};

function archetype(p) {
  const tags = [];

  // ---- 1. distinctions ----
  // Facts a reader can check, ordered so the rarest lands first.
  if (rankIn(p, "deflect") <= 3 && p.deflect >= 1) tags.push("Disruptor");
  if (rankIn(p, "blk") <= 3 && p.blk > 0) tags.push("Rim Protector");
  if (rankIn(p, "stl") <= 3 && p.stl >= 1) tags.push("Pickpocket");
  if (threeRank.get(p.name) <= 5 && threeRate(p) >= 1) tags.push("Floor Spacer");
  // Ball security: needs enough usage that "never turns it over" means
  // something — a player who barely touches it isn't being careful.
  if (p.gp >= 3 && p.to_pct <= 8 && p.ast >= 0.5) tags.push("Sure Hands");
  if (p.gp >= 3 && p.z.foul_rate < -1.0) tags.push("Clean Defender");

  // ---- 2. absolute strengths ----
  if (p.z.pts > 1.0) tags.push("Scorer");
  if (p.z.reb > 1.0) tags.push("Rebounder");
  if (p.z.ast > 1.0) tags.push("Playmaker");
  if (p.z.stl > 1.0 || p.z.blk > 1.0 || p.z.deflect > 1.2) tags.push("Defender");
  if (p.z.ts > 0.8 && p.z.pts > -0.3) tags.push("Efficient");
  if (p.z.netppp > 1.2) tags.push("Winner");
  // Attendance is a real contribution in a league that forfeits short-handed,
  // but it's the least interesting thing about a player who has other tags —
  // so it only lands when little else has.
  if (p.attendance >= 1 && tags.length < 2) tags.push("Iron Man");

  // ---- 3. relative strength (always fires) ----
  // Pick the category where the player sits furthest above their own mean
  // z-score. Scoring categories only — a player whose best "skill" is a low
  // foul rate is better described by what they do than by what they avoid,
  // and those cases are already covered as distinctions above.
  if (!tags.length) {
    // A category only qualifies if the player has actually done the thing.
    // Without a floor, blocks won every time for the low-production players:
    // blocks are near-zero pool-wide, so 0.29/gm sits above such a player's own
    // mean and "Shot Blocker" got handed to someone with two blocks all season.
    // The floor is the pool median among players who record the stat at all —
    // derived, so it tracks the league rather than hardcoding a guess.
    const own = CATS.filter((c) => WEIGHTS[c] > 0 && p[c] >= relFloor[c]);
    const pool = own.length ? own : ["reb"]; // reb: everyone rebounds something
    const avg = mean(pool.map((c) => p.z[c]));
    const best = pool.reduce((a, c) => (p.z[c] - avg > p.z[a] - avg ? c : a), pool[0]);
    tags.push(RELATIVE_LABEL[best]);
  }

  // Dedupe — a player can reach the same word by two routes (top-3 steals and
  // a high steal z-score both say "Pickpocket").
  return [...new Set(tags)].slice(0, 2).join(" / ");
}
for (const p of raw) p.archetype = archetype(p);

// ---- snake draft simulation ------------------------------------------------
// Straight value-based selection down the board, snaking the order each round.
// Teams are generic slots (Team 1..N) — this is a redraft of the whole pool.
const board = [...raw];
const rosters = Array.from({ length: NUM_TEAMS }, () => []);
const picks = [];
let pointer = 0;
for (let round = 1; round <= NUM_ROUNDS; round++) {
  const order = round % 2 === 1
    ? [...rosters.keys()]
    : [...rosters.keys()].reverse();
  for (const slot of order) {
    if (pointer >= board.length) break;
    const player = board[pointer++];
    rosters[slot].push({ ...player, round });
    picks.push({ round, slot, overall: pointer, player });
  }
}

// ---- render ----------------------------------------------------------------
const fmtDate = (s) =>
  new Date(s + "T12:00:00").toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });

const out = [];
const w = (s = "") => out.push(s);
const sign = (n) => (n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2));

w(`# Shoreline Basketball — Draft Board`);
w();
w(`_${NUM_TEAMS}-team redraft · ${raw.length} players · stats through ${fmtDate(stamp)}_`);
w();
w(`## How players are valued`);
w();
w(`Every player is scored on per-game production across ten categories — `
  + `points, rebounds, assists, steals, blocks, deflections, Net PPP `
  + `(on-court point differential per possession), True Shooting %, `
  + `turnover rate, and foul rate — standardized against the league pool `
  + `so rebounds and assists carry comparable weight. Deflections, Net PPP, `
  + `and foul rate come from Hoopsalytics' advanced views rather than the `
  + `basic box score. Two adjustments sit on top:`);
w();
w(`- **Reliability.** Rate stats regress toward a replacement-level baseline `
  + `(the ${Math.round(REPLACEMENT_PCTILE * 100)}th percentile of the pool) based `
  + `on games played (K=${SHRINK_K}). A 30-point average over three games is a `
  + `weaker claim than the same average over six, and the board reflects that. `
  + `The baseline is replacement level rather than league average on purpose: `
  + `regressing toward the mean quietly rewards a below-average player for `
  + `missing games, which would punish exactly the people who keep showing up.`);
w(`- **Availability.** Attendance is measured against the `
  + `${GAMES_WITH_STATS} games of recorded stats and scaled into the final `
  + `value (×${(ATT_BASE + ATT_SLOPE).toFixed(2)} at perfect attendance, `
  + `×${ATT_BASE.toFixed(2)} at none). Teams forfeit when they can't field a `
  + `roster, so showing up carries real value — but it is deliberately tuned as `
  + `a secondary factor that moves players between tiers without letting a `
  + `role player outrank an elite producer.`);
w();

// ---- big board -------------------------------------------------------------
w(`## The Big Board`);
w();
w(`| # | Player | Team | Tier | GP | PPG | RPG | APG | SPG | BPG | DEFL | PPP | TS% | TO% | FOUL% | Avail | Value |`);
w(`|--:|--------|------|------|---:|----:|----:|----:|----:|----:|-----:|----:|----:|----:|------:|------:|------:|`);
for (const p of raw) {
  w(`| ${p.rank} | **${p.name}** | ${p.team_code} | ${TIER_NAMES[p.tier]} `
    + `| ${p.gp} | ${p.pts.toFixed(1)} | ${p.reb.toFixed(1)} | ${p.ast.toFixed(1)} `
    + `| ${p.stl.toFixed(1)} | ${p.blk.toFixed(1)} | ${p.deflect.toFixed(1)} `
    + `| ${sign(p.netppp)} | ${p.ts.toFixed(1)} | ${p.to_pct.toFixed(1)} | ${p.foul_rate.toFixed(1)} `
    + `| ${Math.round(p.attendance * 100)}% | ${sign(p.value)} |`);
}
w();

// ---- tiers -----------------------------------------------------------------
w(`## Tiers`);
w();
for (let t = 0; t < TIER_NAMES.length; t++) {
  const group = raw.filter((p) => p.tier === t);
  if (!group.length) continue;
  w(`### ${TIER_NAMES[t]}`);
  w();
  for (const p of group) {
    w(`- **${p.name}** (${p.team_code}, ${p.gp} GP) — ${p.archetype} · `
      + `${p.pts.toFixed(1)} pts / ${p.reb.toFixed(1)} reb / ${p.ast.toFixed(1)} ast · `
      + `value ${sign(p.value)}`);
  }
  w();
}

// ---- positional / category leaders ----------------------------------------
w(`## Category Leaders (per game, min 3 GP)`);
w();
const eligible = raw.filter((p) => p.gp >= 3);
const leaderRow = (label, key, digits = 1) => {
  const top = [...eligible].sort((a, b) => b[key] - a[key]).slice(0, 3);
  w(`- **${label}:** ` + top.map((p) => `${p.name} (${p[key].toFixed(digits)})`).join(" · "));
};
leaderRow("Points", "pts");
leaderRow("Rebounds", "reb");
leaderRow("Assists", "ast");
leaderRow("Steals", "stl");
leaderRow("Blocks", "blk");
leaderRow("Deflections", "deflect");
leaderRow("Net PPP", "netppp", 2);
leaderRow("True Shooting", "ts");
w();

// ---- draft results ---------------------------------------------------------
w(`## Simulated Snake Draft`);
w();
w(`Best player available, ${NUM_ROUNDS} rounds, order snaking each round.`);
w();
w(`| Rd | ` + Array.from({ length: NUM_TEAMS }, (_, i) => `Team ${i + 1}`).join(" | ") + ` |`);
w(`|---:|` + Array.from({ length: NUM_TEAMS }, () => "----").join("|") + `|`);
for (let round = 1; round <= NUM_ROUNDS; round++) {
  const cells = Array.from({ length: NUM_TEAMS }, (_, slot) => {
    const pick = rosters[slot].find((x) => x.round === round);
    return pick ? `${pick.name}` : "—";
  });
  w(`| ${round} | ` + cells.join(" | ") + ` |`);
}
w();

w(`### Rosters`);
w();
for (let slot = 0; slot < NUM_TEAMS; slot++) {
  const r = rosters[slot];
  const totalValue = r.reduce((a, p) => a + p.value, 0);
  const avgGP = mean(r.map((p) => p.gp));
  w(`**Team ${slot + 1}** — total value ${sign(totalValue)} · avg GP ${avgGP.toFixed(1)}`);
  w();
  for (const p of r) {
    w(`${p.round}. ${p.name} (${p.team_code}) — ${p.archetype}, `
      + `${p.pts.toFixed(1)} pts / ${p.reb.toFixed(1)} reb / ${p.ast.toFixed(1)} ast`);
  }
  w();
}

w(`---`);
w();
w(`_Generated from the ${stamp} snapshot. Stats are cumulative season totals `
  + `from Hoopsalytics; per-event box scores are not published, so all rates `
  + `are derived from season totals divided by games played._`);

mkdirSync("summaries", { recursive: true });
const path = `summaries/${stamp}-draft.md`;
writeFileSync(path, out.join("\n"));

// Machine-readable board, so downstream renderers (the magazine site, a draft
// page) work from the same computation instead of re-deriving it.
const dataPath = `summaries/${stamp}-draft.json`;
writeFileSync(
  dataPath,
  JSON.stringify(
    {
      stamp,
      teams: NUM_TEAMS,
      rounds: NUM_ROUNDS,
      model: {
        shrink_k: SHRINK_K,
        shrink_target: "replacement",
        replacement_pctile: REPLACEMENT_PCTILE,
        replacement_values: Object.fromEntries(
          CATS.map((c) => [c, +replacement[c].toFixed(3)]),
        ),
        att_base: ATT_BASE,
        att_slope: ATT_SLOPE,
        games_with_stats: GAMES_WITH_STATS,
        weights: WEIGHTS,
      },
      tier_names: TIER_NAMES,
      players: raw.map((p) => ({
        rank: p.rank, name: p.name, team: p.team, team_code: p.team_code,
        gp: p.gp, tier: p.tier, archetype: p.archetype,
        pts: +p.pts.toFixed(2), reb: +p.reb.toFixed(2), ast: +p.ast.toFixed(2),
        stl: +p.stl.toFixed(2), blk: +p.blk.toFixed(2), to: +p.to.toFixed(2),
        deflect: +p.deflect.toFixed(2), netppp: +p.netppp.toFixed(3),
        to_pct: +p.to_pct.toFixed(1), foul_rate: +p.foul_rate.toFixed(2),
        ts: +p.ts.toFixed(1), attendance: +p.attendance.toFixed(3),
        base: +p.base.toFixed(3), value: +p.value.toFixed(3),
        totals: p.totals,
      })),
      rosters: rosters.map((r, i) => ({
        slot: i + 1,
        total_value: +r.reduce((a, p) => a + p.value, 0).toFixed(2),
        avg_gp: +mean(r.map((p) => p.gp)).toFixed(2),
        picks: r.map((p) => ({ round: p.round, name: p.name, team_code: p.team_code, archetype: p.archetype })),
      })),
      standings: snap.standings,
    },
    null,
    2,
  ),
);

// ---- console summary -------------------------------------------------------
console.log(`Draft board written to ${path}`);
console.log(`\nTop ${Math.min(12, raw.length)}:`);
for (const p of raw.slice(0, 12)) {
  console.log(
    `  ${String(p.rank).padStart(2)}. ${p.name.padEnd(22)} ${p.team_code.padEnd(5)} `
    + `${p.gp} GP  ${p.pts.toFixed(1).padStart(5)} pts  value ${sign(p.value)}  ${p.archetype}`,
  );
}
