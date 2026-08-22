#!/usr/bin/env bash
# Unattended weekly issue runner (driven by scripts/systemd/shorelinebb-weekly.timer).
#
# Games are Wednesday, but Hoopsalytics scores the film anywhere from Wednesday
# night to Friday night — and in playoff weeks the games move to Tuesday and
# Thursday. Rather than encode any of that, this runs EVERY day and works out
# for itself whether there is an issue to publish:
#
#   no games finalized since the last issue  -> quiet no-op
#   games finalized, box scores not all in   -> quiet no-op, try again tomorrow
#   games finalized, every box score present -> build, commit, push (Pages deploys)
#
# WHY IT DELETES THE SNAPSHOT ON A NO-OP
# summarize.js derives "this week" by diffing today's snapshot against the
# PREVIOUS snapshot directory (newlyFinalGames in src/lib.js). A snapshot left
# behind by a run that stopped at the stats gate would become tomorrow's
# baseline — and tomorrow's diff would then report zero new games and silently
# publish an EMPTY issue for a week that actually had games. So any run that
# doesn't publish removes the snapshot it created, preserving the invariant the
# diff depends on: the newest snapshot is the last published issue.
#
# Env:
#   PUBLISH=0   build the issue but don't commit or push (dry run)
#   REPO=...    repo path (default: this script's parent directory)
set -uo pipefail

REPO="${REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PUBLISH="${PUBLISH:-1}"
NODE="${NODE:-/usr/bin/node}"

cd "$REPO" || { echo "cannot cd to $REPO"; exit 1; }

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/shorelinebb"
mkdir -p "$STATE_DIR"
exec > >(tee -a "$STATE_DIR/weekly.log") 2>&1

log() { printf '%s  %s\n' "$(date -Is)" "$*"; }

STAMP="$(date +%F)"
SNAP="data/snapshots/$STAMP"
SNAP_PREEXISTING=0
[ -d "$SNAP" ] && SNAP_PREEXISTING=1

# Remove the snapshot this run created, so it can't become tomorrow's diff
# baseline. A snapshot that was already on disk before this run isn't ours.
discard_snapshot() {
  if [ "$SNAP_PREEXISTING" = 1 ]; then
    log "leaving pre-existing $SNAP in place"
  elif [ -d "$SNAP" ]; then
    rm -rf "$SNAP"
    log "discarded $SNAP (published nothing; keeps the diff baseline intact)"
  fi
}

# Reads week-status.js output into status_* variables.
read_status() {
  status_new_games=0 status_missing="" status_ready="no" status_reason=""
  while IFS='=' read -r k v; do
    case "$k" in
      new_games) status_new_games="$v" ;;
      missing)   status_missing="$v" ;;
      ready)     status_ready="$v" ;;
      reason)    status_reason="$v" ;;
    esac
  done < <("$NODE" src/week-status.js "$STAMP")
}

log "=== weekly run for $STAMP (publish=$PUBLISH) ==="

command -v "$NODE" >/dev/null 2>&1 || { log "FATAL: no node at $NODE"; exit 1; }

# ---- 1. league-administrative data: schedule, scores, standings -------------
if ! "$NODE" src/collect.js "$STAMP"; then
  log "collect failed (TeamLinkt unreachable?) — retrying tomorrow"
  discard_snapshot
  exit 0
fi

# ---- 2. anything new to write about? ---------------------------------------
read_status
if [ "$status_new_games" -eq 0 ] 2>/dev/null; then
  log "no games finalized since the last issue — nothing to do"
  discard_snapshot
  exit 0
fi
log "$status_new_games newly finalized game(s) this week"

# ---- 3. the stat source: Hoopsalytics per-game box scores ------------------
if ! "$NODE" src/collect-hoopsalytics-boxscores.js "$STAMP"; then
  log "box-score collector failed — retrying tomorrow"
  discard_snapshot
  exit 0
fi

read_status
if [ "$status_ready" != "yes" ]; then
  case "$status_reason" in
    all-forfeit-week)
      log "NEEDS ATTENTION: every new game is a forfeit (2-0), so no box score" \
          "will ever exist and the summary step will keep failing. Write this" \
          "week by hand, or skip it."
      ;;
    *)
      log "Hoopsalytics hasn't scored event(s) [$status_missing] yet — retrying tomorrow"
      ;;
  esac
  discard_snapshot
  exit 0
fi

# ---- 4. build the issue ----------------------------------------------------
# Past here the stats are real and complete, so a failure is a genuine fault:
# keep the snapshot and shout, rather than silently retrying.
for step in "src/summarize.js $STAMP" "src/article.js $STAMP" "src/site.js"; do
  # shellcheck disable=SC2086
  if ! "$NODE" $step; then
    log "FAILED at: node $step — snapshot kept at $SNAP for inspection"
    exit 1
  fi
done
log "built summaries/$STAMP.md and summaries/$STAMP-article.md"

# ---- 5. publish ------------------------------------------------------------
if [ "$PUBLISH" != "1" ]; then
  log "PUBLISH=0 — issue built but not committed"
  exit 0
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
  log "on branch '$branch', not main — leaving the issue uncommitted"
  exit 0
fi

# Scoped adds only. The working tree may hold unrelated edits; they are not ours
# to commit.
git add summaries "$SNAP" || { log "git add failed"; exit 1; }
if git diff --cached --quiet; then
  log "nothing staged — already committed?"
  exit 0
fi
if ! git commit -q -m "Issue: week of $STAMP"; then
  log "git commit failed"
  exit 1
fi
if git push -q origin main; then
  log "pushed — the Pages workflow will rebuild and deploy the magazine"
else
  log "PUSH FAILED (remote moved, or no key in this session). The commit is" \
      "made locally; run 'git pull --rebase && git push' when you next look."
fi
log "=== done ==="
