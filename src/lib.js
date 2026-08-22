// Shared helpers: load snapshots and build weekly player production from
// Hoopsalytics per-game box scores.
//
// SOURCING RULE: player statistics for the issue (summary + article) and for
// the draft board come from Hoopsalytics — the league's actual stats provider —
// and never from TeamLinkt. TeamLinkt republishes Hoopsalytics' numbers into a
// cumulative table that lags unpredictably (it sat on identical totals across
// the 2026-08-09 and 2026-08-19 snapshots, then caught up three games at once
// by 2026-08-21), so diffing it smears several games into one "week" — that's
// how a 55-45 game once produced an 81-point line. There is deliberately no
// TeamLinkt stat path left in this file to fall back to. TeamLinkt remains the
// source only for league-administrative data: the schedule, final scores, and
// standings.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

export const SNAP_ROOT = "data/snapshots";

// Counting stats we diff week-over-week. Percentages/ratios are derived, not diffed.
export const COUNT_STATS = [
  "GP", "MIN", "TP", "2PM", "2PA", "3PM", "3PA", "FTM", "FTA",
  "PF", "OR", "DR", "TOTRB", "AST", "STL", "BLK", "TO",
];

export const STAT_LABELS = {
  TP: "pts", TOTRB: "reb", AST: "ast", STL: "stl", BLK: "blk",
  "3PM": "3PM", TO: "TO", OR: "OReb", DR: "DReb", PF: "PF",
};

// The league scores a forfeit as a 2-0 win for whoever showed up — there's no
// real box score for these, so treat them distinctly from "stats not posted yet".
export const isForfeitScore = (g) =>
  (g.home.score === 2 && g.away.score === 0) || (g.home.score === 0 && g.away.score === 2);

const num = (v) => {
  const n = Number(String(v ?? "").replace(/[%,]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

export function listSnapshots() {
  if (!existsSync(SNAP_ROOT)) return [];
  return readdirSync(SNAP_ROOT)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
}

function readJSON(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function loadSnapshot(stamp) {
  const dir = `${SNAP_ROOT}/${stamp}`;
  return {
    stamp,
    // TeamLinkt: league-administrative data only (schedule, scores, standings).
    // Its cumulative player_stats.json is still archived by collect.js, but is
    // deliberately NOT exposed here — see the sourcing rule at the top.
    standings: readJSON(`${dir}/standings.json`, []),
    games: readJSON(`${dir}/games.json`, []),
    leaders: readJSON(`${dir}/leaders.json`, []),
    manifest: readJSON(`${dir}/manifest.json`, {}),
    // Advanced per-player stats from Hoopsalytics (src/collect-hoopsalytics.js) —
    // the draft board's category source. See data/probe/hoopsalytics/ for the
    // field-discovery notes.
    hoopsalytics: readJSON(`${dir}/hoopsalytics_stats.json`, []),
  };
}

// Per-player weekly production, summed from Hoopsalytics per-game box scores
// for exactly the games that went final this week. This is the ONLY stat source
// for the issue — see the sourcing rule at the top of this file.
//
// Returns per-player rows { name, team_id, weekly:{stat:value}, gp_week,
// played_this_week }. Returns null when not one of `games` has a box score on
// disk yet, which callers must treat as "not ready" rather than falling back to
// TeamLinkt — use requireWeeklyProduction() to get that behavior.
export function weeklyProductionFromBoxscores(stamp, games) {
  const dir = `${SNAP_ROOT}/${stamp}/hoopsalytics_boxscores`;
  const byName = new Map();
  let found = 0;

  for (const g of games) {
    const rows = readJSON(`${dir}/${g.event_id}.json`, null);
    if (!rows?.length) continue;
    found++;
    for (const row of rows) {
      const entry = byName.get(row.name) ?? {
        name: row.name,
        team_id: row.team_id,
        weekly: Object.fromEntries(COUNT_STATS.map((s) => [s, 0])),
      };
      // A team plays once a week, but sum rather than assign so this stays
      // correct for a doubleheader or a backfilled multi-game span.
      for (const s of COUNT_STATS) entry.weekly[s] += num(row.weekly?.[s]);
      byName.set(row.name, entry);
    }
  }
  if (found === 0) return null;

  return [...byName.values()].map((p) => ({
    ...p,
    gp_week: p.weekly.GP,
    played_this_week: Object.values(p.weekly).some((v) => v > 0),
  }));
}

// weeklyProductionFromBoxscores() with the "not ready" case turned into a hard
// stop. There is no fallback by design: publishing an issue off TeamLinkt's
// lagging cumulative diff is worse than publishing a day later, so a week whose
// box scores haven't been scored yet fails loudly instead of quietly degrading.
//
// A week with no finalized games is legitimately empty, not unready.
export function requireWeeklyProduction(stamp, games) {
  if (games.length === 0) return [];
  const production = weeklyProductionFromBoxscores(stamp, games);
  if (production) return production;
  throw new Error(
    `No Hoopsalytics box scores in ${SNAP_ROOT}/${stamp}/hoopsalytics_boxscores/ `
    + `for this week's ${games.length} finalized game(s): `
    + `${games.map((g) => g.event_id).join(", ")}.\n`
    + `  Run: node src/collect-hoopsalytics-boxscores.js ${stamp}\n`
    + `  If that reports the games as still "pending", Hoopsalytics hasn't finished\n`
    + `  scoring the film yet — wait and re-run. Stats are never taken from\n`
    + `  TeamLinkt's cumulative table, which lags and smears games together.`,
  );
}

// The credit line shown at the foot of the issue. One source, always.
export const boxscoreSourceNote = (games) =>
  `Player stats from Hoopsalytics per-game box scores for event(s) `
  + `${games.map((g) => g.event_id).join(", ")}.`;

// Games finalized in `curr` that were NOT finalized in `prev` (or no prev) =
// "this week's games".
export function newlyFinalGames(curr, prev) {
  const prevFinal = new Set(
    (prev?.games ?? []).filter((g) => g.final).map((g) => g.event_id),
  );
  return curr.games.filter((g) => g.final && !prevFinal.has(g.event_id));
}

export const teamNameById = (snap) => {
  const m = new Map();
  for (const t of snap.standings) m.set(t.team_id, t.team);
  return m;
};

// Renders the deterministic weekly recap markdown (games, standings, movers &
// shakers) from already-computed inputs. Shared by the live weekly pipeline
// (summarize.js, diffing consecutive snapshots) and the box-score backfill
// (backfill-recaps.js, reconstructing weeks from per-event box scores) so the
// two produce identically-shaped issues.
//
//   target:     stamp used as the issue date / header
//   baseline:   true for a first-week issue (no prior week to diff against)
//   games:      this week's finalized games (home/away {team_id,name,score}, date)
//   standings:  current standings rows ({rank,team,team_id,w,l,pf,pa,diff,streak})
//   prevRank:   Map<team_id, rank> from the prior week, or null
//   production: per-player weekly lines ({name,team_id,weekly:{...},played_this_week})
//   teamOf:     fn(team_id) => team name
//   sourceNote: text for the trailing "Generated from …" credit line
export function renderSummaryMarkdown({
  target, baseline, games, standings, prevRank, production, teamOf, sourceNote,
}) {
  const byTeam = (id) => production.filter((p) => p.team_id === id && p.played_this_week);

  const fmtDate = (s) =>
    new Date(s + "T12:00:00").toLocaleDateString("en-US", {
      month: "long", day: "numeric", year: "numeric",
    });

  const out = [];
  const w = (s = "") => out.push(s);

  // ---- header ----------------------------------------------------------------
  w(`# Shoreline Basketball — Week of ${fmtDate(target)}`);
  w();
  if (baseline) {
    w(`> First snapshot — establishing the baseline. Week-over-week movement and `
      + `weekly stat lines begin with next week's summary.`);
    w();
  }

  // ---- 1. game recaps --------------------------------------------------------
  w(`## 🏀 Games`);
  w();
  if (games.length === 0) {
    w(`_No new final scores since the last snapshot._`);
    w();
  } else {
    for (const g of [...games].sort((a, b) => a.ts - b.ts)) {
      const h = g.home, a = g.away;
      const homeWon = h.score > a.score;
      const winner = homeWon ? h : a;
      const loser = homeWon ? a : h;
      w(`### ${winner.name} ${winner.score}, ${loser.name} ${loser.score}`);
      w(`*${g.date}*`);
      w();
      if (isForfeitScore(g)) {
        w(`- _${loser.name} forfeited; ${winner.name} awarded the win._`);
        w();
        continue;
      }
      // leading scorers, attributed by team (one game per team per week)
      for (const side of [h, a]) {
        const roster = byTeam(side.team_id)
          .filter((p) => p.weekly.TP > 0)
          .sort((x, y) => y.weekly.TP - x.weekly.TP);
        if (roster.length === 0) {
          w(`- **${side.name}** — _no player stats reported_`);
          continue;
        }
        const top = roster[0];
        const line = statLine(top);
        const others = roster.slice(1, 3)
          .map((p) => `${p.name} ${p.weekly.TP}`).join(", ");
        w(`- **${side.name}** — ${top.name} led with ${line}`
          + (others ? ` · also: ${others}` : ""));
      }
      w();
    }
  }

  // ---- 2. standings ----------------------------------------------------------
  w(`## 📊 Standings`);
  w();
  w(`| | Team | W | L | PF | PA | Diff | Streak |`);
  w(`|---|------|---|---|----|----|------|--------|`);
  for (const t of standings) {
    let move = "";
    if (prevRank && prevRank.has(t.team_id)) {
      const d = prevRank.get(t.team_id) - t.rank;
      move = d > 0 ? ` ▲${d}` : d < 0 ? ` ▼${-d}` : "";
    }
    const diff = t.diff > 0 ? `+${t.diff}` : `${t.diff}`;
    w(`| ${t.rank}${move} | ${t.team} | ${t.w} | ${t.l} | ${t.pf} | ${t.pa} | ${diff} | ${t.streak} |`);
  }
  w();

  // ---- 3. movers & shakers ---------------------------------------------------
  w(`## 🔥 Movers & Shakers`);
  w();
  const played = production.filter((p) => p.played_this_week);
  if (played.length === 0) {
    w(`_No player stats reported this week yet (stats post over the weekend)._`);
    w();
  } else {
    const label = baseline ? "this season so far" : "this week";

    // top scorers
    const scorers = [...played].sort((a, b) => b.weekly.TP - a.weekly.TP).slice(0, 5);
    w(`**Top scorers (${label})**`);
    w();
    scorers.forEach((p, i) =>
      w(`${i + 1}. **${p.name}** (${teamOf(p.team_id)}) — ${statLine(p)}`));
    w();

    // category leaders
    const cats = [["TOTRB", "rebounds"], ["AST", "assists"], ["STL", "steals"], ["BLK", "blocks"], ["3PM", "threes made"]];
    const lines = [];
    for (const [stat, word] of cats) {
      const best = [...played].sort((a, b) => b.weekly[stat] - a.weekly[stat])[0];
      if (best && best.weekly[stat] > 0)
        lines.push(`- **${word}:** ${best.name} (${teamOf(best.team_id)}) — ${best.weekly[stat]}`);
    }
    if (lines.length) {
      w(`**Category leaders (${label})**`);
      w();
      lines.forEach(w);
      w();
    }

    // notable lines: double-doubles & big games
    const notable = [];
    for (const p of played) {
      const dd = [["TP", p.weekly.TP], ["TOTRB", p.weekly.TOTRB], ["AST", p.weekly.AST]]
        .filter(([, v]) => v >= 10).length;
      if (dd >= 2) notable.push(`- **${p.name}** (${teamOf(p.team_id)}) posted a double-double: ${statLine(p)}`);
      else if (p.weekly.TP >= 18) notable.push(`- **${p.name}** (${teamOf(p.team_id)}) dropped ${p.weekly.TP}: ${statLine(p)}`);
    }
    if (notable.length) {
      w(`**Notable performances**`);
      w();
      [...new Set(notable)].forEach(w);
      w();
    }
  }

  // ---- footer ------------------------------------------------------------
  const forfeitTeamIds = new Set();
  for (const g of games) {
    if (isForfeitScore(g)) { forfeitTeamIds.add(g.home.team_id); forfeitTeamIds.add(g.away.team_id); }
  }
  const missing = standings
    .filter((t) => !forfeitTeamIds.has(t.team_id))
    .map((t) => t.team)
    .filter((name) => !production.some((p) => teamOf(p.team_id) === name && p.played_this_week));
  if (missing.length) {
    w(`---`);
    w(`_Note: no player stats reported for ${missing.join(", ")} ` +
      `(stats are entered by the league's analytics provider over the weekend)._`);
    w();
  }
  w(`<sub>${sourceNote}</sub>`);

  return out.join("\n") + "\n";
}

function statLine(p) {
  const parts = [`${p.weekly.TP} pts`];
  for (const [stat, lbl] of [["TOTRB", "reb"], ["AST", "ast"], ["STL", "stl"], ["BLK", "blk"]]) {
    if (p.weekly[stat] > 0) parts.push(`${p.weekly[stat]} ${lbl}`);
  }
  return parts.join(", ");
}

// Builds the structured JSON payload the AI article writer (article.js) turns
// into a narrative recap. Shared with the box-score backfill so both a live
// weekly diff and a reconstructed historical week produce the same shape.
//
//   league, venue: static league descriptors passed straight through
//   target, baseline: issue stamp / whether this is the season-opening week
//   games:      this week's finalized games (home/away {team_id,name,score,ts,date})
//   standings:  current standings rows ({rank,team,team_id,w,l,pf,pa,diff,streak})
//   prevRank:   Map<team_id, rank> from the prior week, or null
//   production: per-player weekly lines ({name,team_id,weekly:{...},played_this_week})
//   teamOf:     fn(team_id) => team name
//   note:       freeform hint about how the stats were derived, shown to the model
export function buildArticleData({ league, venue, target, baseline, games, standings, prevRank, production, teamOf, note }) {
  const played = production.filter((p) => p.played_this_week);
  const line = (p) => {
    const parts = [`${p.weekly.TP} pts`];
    for (const [s, l] of [["TOTRB", "reb"], ["AST", "ast"], ["STL", "stl"], ["BLK", "blk"], ["3PM", "3PM"]]) {
      if (p.weekly[s] > 0) parts.push(`${p.weekly[s]} ${l}`);
    }
    return parts.join(", ");
  };

  const gamesOut = [...games].sort((a, b) => a.ts - b.ts).map((g) => {
    const performers = (side) =>
      production
        .filter((p) => p.team_id === side.team_id && p.weekly.TP > 0)
        .sort((a, b) => b.weekly.TP - a.weekly.TP)
        .slice(0, 4)
        .map((p) => ({ name: p.name, statline: line(p) }));
    const homeWon = g.home.score > g.away.score;
    const forfeit = isForfeitScore(g);
    return {
      date: g.date,
      home: { team: g.home.name, score: g.home.score, top: forfeit ? [] : performers(g.home) },
      away: { team: g.away.name, score: g.away.score, top: forfeit ? [] : performers(g.away) },
      winner: (homeWon ? g.home : g.away).name,
      margin: Math.abs(g.home.score - g.away.score),
      forfeit,
    };
  });

  const standingsOut = standings.map((t) => ({
    rank: t.rank, team: t.team, w: t.w, l: t.l,
    points_for: t.pf, points_against: t.pa, diff: t.diff, streak: t.streak,
    rank_change: prevRank && prevRank.has(t.team_id) ? prevRank.get(t.team_id) - t.rank : null,
  }));

  const topScorers = [...played].sort((a, b) => b.weekly.TP - a.weekly.TP).slice(0, 6)
    .map((p) => ({ name: p.name, team: teamOf(p.team_id), statline: line(p) }));
  const catLeader = (stat) => {
    const best = [...played].sort((a, b) => b.weekly[stat] - a.weekly[stat])[0];
    return best && best.weekly[stat] > 0
      ? { name: best.name, team: teamOf(best.team_id), value: best.weekly[stat] } : null;
  };
  const doubleDoubles = played
    .filter((p) => [p.weekly.TP, p.weekly.TOTRB, p.weekly.AST].filter((v) => v >= 10).length >= 2)
    .map((p) => ({ name: p.name, team: teamOf(p.team_id), statline: line(p) }));

  return {
    league, venue, week_of: target, is_first_week: baseline, note,
    games: gamesOut,
    standings: standingsOut,
    stat_leaders: {
      top_scorers: topScorers,
      rebounds: catLeader("TOTRB"),
      assists: catLeader("AST"),
      steals: catLeader("STL"),
      blocks: catLeader("BLK"),
      double_doubles: doubleDoubles,
    },
  };
}

// Calls Claude to turn buildArticleData()'s payload into the ESPN-style
// narrative recap. Requires ANTHROPIC_API_KEY (or an `ant auth login` profile).
// onText, if given, receives streamed text chunks (e.g. to echo progress).
export async function generateArticle(data, { baseline, onText } = {}) {
  const system = `You are a talented sports writer producing a weekly recap for a beer-league
(adult men's recreational) basketball league, in the style of an ESPN or The Athletic column —
lively, knowledgeable, a little playful, but credible. You write clean Markdown.

Hard rules:
- Use ONLY the facts in the provided JSON. These are real, named people — do NOT invent quotes,
  injuries, backstories, hometowns, nicknames, or any stat not present in the data.
- Every number you cite must come from the data. Never round or embellish a score or stat line.
- It's a rec league: keep the tone fun and affectionate, never mocking. Celebrate the players.
- If it's the first week, frame it as the season tip-off and avoid week-over-week "movement" language.
- A game with \`forfeit: true\` had no players show up on the losing side — the 2-0 score is just the
  league's forfeit convention, not a real final. Say plainly that it was a forfeit; do NOT invent a
  shot, a bucket, or any play-by-play for it.
- Avoid stock sportswriter clichés for big performances (e.g. "goes nuclear", "explodes for",
  "erupts for", "torches", "lights it up") — these recur week over week and read as formulaic
  across a season's worth of headlines. Reach for a fresh, specific way to describe the
  performance instead, especially in the headline.`;

  const userPrompt = `Write this week's recap article for the league. Structure it as:

1. A punchy headline (H1) and a one-or-two sentence dek/lede that captures the week.
2. **Around the League** — a short narrative recap of each game (final score, who won, the standout
   performances). Weave the box-score lines in naturally; don't just list them.
3. **The Standings** — a brief narrative on the table${baseline ? "" : ", noting any risers/fallers vs last week"}, followed by the standings as a Markdown table.
4. **Movers & Shakers** — highlight the week's statistical standouts: top scorers, category leaders,
   and any double-doubles. Make it feel like a "stars of the week" segment.

Keep it tight and readable — roughly 500–800 words. Here is the data:

\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\``;

  const client = new Anthropic();
  const stream = client.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system,
    messages: [{ role: "user", content: userPrompt }],
  });
  if (onText) stream.on("text", onText);
  const final = await stream.finalMessage();
  return final.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}
