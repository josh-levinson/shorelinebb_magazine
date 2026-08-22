// Answers two questions for the scheduled runner (scripts/weekly-run.sh) so it
// doesn't have to reimplement the weekly diff in bash:
//
//   1. Are there games finalized since the last snapshot? (i.e. an issue to write)
//   2. Has Hoopsalytics scored all of them yet? (i.e. is it safe to write it)
//
// Prints key=value lines and always exits 0 — the caller reads `ready`.
//
//   new_games  count of games finalized since the previous snapshot = "this week"
//   required   those event ids that should have a Hoopsalytics box score.
//              Forfeits are excluded: the league scores them 2-0 and no box
//              score is ever produced (isForfeitScore in lib.js).
//   missing    required ids with no box score on disk yet
//   ready      yes | no
//   reason     why not, when ready=no
//
// Note this is stricter than requireWeeklyProduction(), which publishes as soon
// as ONE box score exists. That's fine for a normal one-game week but wrong for
// a playoff week with two game days, where it would publish an issue covering
// both games with only the first game's stat lines. The runner waits for all.
//
// Usage:  node src/week-status.js            # latest snapshot
//         node src/week-status.js 2026-08-22 # a specific stamp
import { existsSync, statSync } from "node:fs";
import {
  SNAP_ROOT, listSnapshots, loadSnapshot, newlyFinalGames, isForfeitScore,
} from "./lib.js";

const out = (k, v) => console.log(`${k}=${v}`);

const stamps = listSnapshots();
if (stamps.length === 0) {
  out("new_games", 0);
  out("ready", "no");
  out("reason", "no-snapshots");
  process.exit(0);
}

const target = process.argv[2] || stamps[stamps.length - 1];
const idx = stamps.indexOf(target);
if (idx === -1) {
  out("new_games", 0);
  out("ready", "no");
  out("reason", `snapshot-${target}-not-found`);
  process.exit(0);
}

const curr = loadSnapshot(target);
const prev = idx > 0 ? loadSnapshot(stamps[idx - 1]) : null;
const games = newlyFinalGames(curr, prev);

const required = games.filter((g) => !isForfeitScore(g)).map((g) => g.event_id);
const boxDir = `${SNAP_ROOT}/${target}/hoopsalytics_boxscores`;
const hasBox = (id) => {
  const p = `${boxDir}/${id}.json`;
  return existsSync(p) && statSync(p).size > 2; // "[]" is a scored-but-empty file
};
const missing = required.filter((id) => !hasBox(id));

out("stamp", target);
out("baseline", prev ? "no" : "yes");
out("new_games", games.length);
out("required", required.join(" "));
out("missing", missing.join(" "));

if (games.length === 0) {
  out("ready", "no");
  out("reason", "no-new-games");
} else if (required.length === 0) {
  // Every new game was a forfeit, so no box score will ever appear and
  // requireWeeklyProduction() would throw forever. Needs a human.
  out("ready", "no");
  out("reason", "all-forfeit-week");
} else if (missing.length > 0) {
  out("ready", "no");
  out("reason", "box-scores-pending");
} else {
  out("ready", "yes");
}
