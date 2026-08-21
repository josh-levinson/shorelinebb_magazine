// Draft board page generator: renders summaries/<stamp>-draft.json into the
// self-contained HTML board that src/site.js publishes as dist/draft.html.
//
// The board's design (styles, layout, client-side sorting/curve/weight bars)
// was hand-built once and is carried forward as a template: this script takes
// the most recent existing summaries/<date>-draft-board.html, swaps in the new
// week's DATA blob, and refreshes the handful of derived numbers baked into the
// surrounding prose (player/round counts, the recorded-games denominator, the
// availability multiplier table, the GP range, the "Through <date>" line and
// the footer credit). That keeps the page reproducible week to week without
// re-deriving a design that already works.
//
// Two lines on the page are genuinely editorial rather than derived — the value
// curve's note and the "Reading the board" paragraph — so they're passed in
// here and should be rewritten whenever the top of the board changes shape.
//
// Usage:  node src/draft-page.js [snapshot-stamp]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const SUMMARIES = "summaries";

const argStamp = process.argv[2];
const draftFiles = readdirSync(SUMMARIES)
  .map((f) => f.match(/^(\d{4}-\d{2}-\d{2})-draft\.json$/))
  .filter(Boolean)
  .map((m) => m[1])
  .sort();
if (draftFiles.length === 0) {
  console.error("No summaries/<date>-draft.json found. Run `npm run draft` first.");
  process.exit(1);
}
const stamp = argStamp || draftFiles[draftFiles.length - 1];
const draft = JSON.parse(readFileSync(`${SUMMARIES}/${stamp}-draft.json`, "utf8"));

// Template = the newest board that isn't the one we're about to write.
const boards = readdirSync(SUMMARIES)
  .map((f) => f.match(/^(\d{4}-\d{2}-\d{2})-draft-board\.html$/))
  .filter(Boolean)
  .map((m) => m[1])
  .filter((d) => d !== stamp)
  .sort();
if (boards.length === 0) {
  console.error("No previous summaries/<date>-draft-board.html to use as a template.");
  process.exit(1);
}
const templateStamp = boards[boards.length - 1];
let html = readFileSync(`${SUMMARIES}/${templateStamp}-draft-board.html`, "utf8");

// ---- derived numbers --------------------------------------------------------
const players = draft.players;
const gws = draft.model.games_with_stats;
const minGP = Math.min(...players.map((p) => p.gp));
const maxGP = Math.max(...players.map((p) => p.gp));
const catCount = Object.keys(draft.model.weights).length;
const { att_base: base, att_slope: slope } = draft.model;
const mult = (n) => (base + slope * Math.min(n / gws, 1)).toFixed(2);
const fmtDate = (s) =>
  new Date(s + "T12:00:00").toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

// The page reads a compact key schema rather than the draft JSON's verbose one,
// to keep the inlined blob small. Keys map 1:1 — see renderBoard() in the page.
const DATA = {
  stamp: draft.stamp,
  tier_names: draft.tier_names,
  model: draft.model,
  players: players.map((p) => ({
    r: p.rank, n: p.name, t: p.team_code, tm: p.team, g: p.gp, ti: p.tier,
    a: p.archetype, p: p.pts, rb: p.reb, as: p.ast, s: p.stl, b: p.blk,
    dfl: p.deflect, ppp: p.netppp, ts: p.ts, top: p.to_pct, fl: p.foul_rate,
    at: p.attendance, v: p.value, base: p.base,
  })),
  rosters: draft.rosters,
  standings: draft.standings,
};

// ---- swaps ------------------------------------------------------------------
// Warn on a pattern that doesn't match (the template drifted), not on one that
// matched and substituted identical text — an unchanged count is normal.
const replace = (label, pattern, value) => {
  if (!pattern.test(html)) {
    console.warn(`  warn: no match for ${label} — check the template`);
    return;
  }
  html = html.replace(pattern, value);
};

replace("DATA blob", /^const DATA = .*;$/m, () => `const DATA = ${JSON.stringify(DATA)};`);
replace("masthead counts",
  /<span><b>\d+<\/b> players<\/span>\s*\n\s*<span><b>\d+<\/b> teams · \d+ rounds<\/span>\s*\n\s*<span><b>\d+<\/b> games of recorded stats<\/span>\s*\n\s*<span>Through <b>[^<]*<\/b><\/span>/,
  `<span><b>${players.length}</b> players</span>\n`
  + `      <span><b>${draft.teams}</b> teams · ${draft.rounds} rounds</span>\n`
  + `      <span><b>${gws}</b> games of recorded stats</span>\n`
  + `      <span>Through <b>${fmtDate(stamp)}</b></span>`);
replace("GP range", /Games played range from \d+ to \d+/, `Games played range from ${minGP} to ${maxGP}`);
replace("shrink example", /the same average over \w+\./, `the same average over ${WORDS[gws] ?? gws}.`);
const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);
replace("category count", /<b>3 · Composite\.<\/b> \w+ categories/, `<b>3 · Composite.</b> ${titleCase(String(WORDS[catCount] ?? catCount))} categories`);
replace("availability denominator", /Attendance against the \d+ games of recorded stats/, `Attendance against the ${gws} games of recorded stats`);
replace("availability table", /<div class="formula">×[\d.]+ at \d+\/\d+[\s\S]*?<\/div>/,
  `<div class="formula">×${mult(gws)} at ${gws}/${gws}   ×${mult(Math.round(gws / 2))} at ${Math.round(gws / 2)}/${gws}\n`
  + `×${mult(2)} at 2/${gws}   ×${mult(1)} at 1/${gws}</div>`);
replace("curve aria-label", /Composite value for all \d+ players/, `Composite value for all ${players.length} players`);
replace("footer credit", /Generated from the \d{4}-\d{2}-\d{2} snapshot[\s\S]*?(?=\n\s*<\/footer>)/,
  `Generated from the ${stamp} snapshot of hoopsalytics.com · <span class="num">${players.length}</span> `
  + `players · stats are cumulative season totals published by Hoopsalytics, the league's stats provider.`);

// The weights panel labels each category by a lookup table; make sure every
// weighted category has a label, or the panel renders "undefined".
const LBL_EXTRA = { foul_rate: "Foul rate" };
for (const [key, label] of Object.entries(LBL_EXTRA)) {
  if (draft.model.weights[key] != null && !html.includes(`${key}:"`)) {
    html = html.replace(/(const LBL=\{)/, `$1${key}:"${label}",`);
  }
}

// ---- editorial lines --------------------------------------------------------
// Rewrite these when the shape of the top of the board changes.
const t = players;
const curveNote = `Tier cuts follow the natural gaps in the value curve, not fixed bucket sizes. `
  + `${t[0].name} and ${t[1].name} sit alone in the top tier, and the drop from `
  + `${t[1].value.toFixed(1)} to ${t[2].value.toFixed(1)} behind them is the widest gap on the board.`;
const last = (n) => n.split(" ").slice(-1)[0];
const readingNote = `<b>Reading the board.</b> ${t[0].name} takes the top pick from ${t[1].name} `
  + `on a near-identical scoring average — ${t[0].pts.toFixed(1)} to ${t[1].pts.toFixed(1)} — `
  + `because he pairs it with rebounding and defensive numbers ${last(t[1].name)} doesn't match, `
  + `over ${t[0].gp} appearances to ${t[1].gp}. ${last(t[1].name)}'s ${t[1].ts.toFixed(1)}% `
  + `true-shooting is the best mark in the pool and keeps it close, but the composite rewards `
  + `the wider spread.`;

replace("curve note", /<p class="sec-note">Tier cuts follow[^<]*<\/p>/, `<p class="sec-note">${curveNote}</p>`);
replace("reading note", /<b>Reading the board\.<\/b>[^<]*/, `${readingNote}\n  `);

const out = `${SUMMARIES}/${stamp}-draft-board.html`;
writeFileSync(out, html);
console.log(`Draft board page written to ${out} (template: ${templateStamp})`);
