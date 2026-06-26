// Shared helpers: load snapshots, diff cumulative player stats into weekly
// production. The whole movers-and-shakers idea rests on diffing two snapshots,
// since the league only exposes season totals.
import { readdirSync, readFileSync, existsSync } from "node:fs";

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
    standings: readJSON(`${dir}/standings.json`, []),
    games: readJSON(`${dir}/games.json`, []),
    players: readJSON(`${dir}/player_stats.json`, []),
    leaders: readJSON(`${dir}/leaders.json`, []),
    manifest: readJSON(`${dir}/manifest.json`, {}),
  };
}

// Per-player weekly production. If there's no previous snapshot, the current
// cumulative totals *are* the week (baseline week 1). Returns a map keyed by
// player name → { name, team_id, weekly:{stat:delta}, cumulative:{stat:val}, gp_week }.
export function weeklyProduction(curr, prev) {
  const prevByName = new Map((prev?.players ?? []).map((p) => [p.Name, p]));
  return curr.players.map((p) => {
    const before = prevByName.get(p.Name);
    const weekly = {};
    for (const s of COUNT_STATS) {
      weekly[s] = num(p[s]) - (before ? num(before[s]) : 0);
    }
    const cumulative = {};
    for (const s of COUNT_STATS) cumulative[s] = num(p[s]);
    return {
      name: p.Name,
      team_id: p.team_id,
      team_code: p.Team,
      weekly,
      cumulative,
      gp_week: weekly.GP,
      played_this_week: weekly.GP > 0 || Object.values(weekly).some((v) => v > 0),
    };
  });
}

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
