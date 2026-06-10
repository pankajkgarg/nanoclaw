#!/bin/bash
# Sweep large, settled video assets from the active group workspaces (internal
# disk) to the ColdStore archive. Hybrid storage: the agent always writes to
# the local workspace (external-drive hangs froze the host twice — see log.md
# 2026-05-02 / 2026-06-02), and this job keeps the local working set small.
# ColdStore stays the complete archive (same tree the pre-June-2 workspace
# lives in). Runs from launchd: com.nanoclaw.archive-groups.
#
# Only files >=50MB untouched for 7+ days move; small assets (hero images,
# music, loop tiles, thumbnails) stay local so the agent can still find and
# rebuild past projects. If ColdStore isn't mounted, the run is a silent skip.
set -euo pipefail

GROUPS_DIR="${NANOCLAW_GROUPS_DIR:-/Users/pankaj/work/content/nanoclaw/data/groups-local}"
ARCHIVE_DIR="/Volumes/COLDSTORE/ColdStoreData/nanoclaw-groups"
LOG="/Users/pankaj/work/content/nanoclaw/logs/archive-groups.log"
MIN_SIZE="+50M"
MIN_AGE="+7"   # days since last modification

ts() { date '+%Y-%m-%d %H:%M:%S'; }

if [ ! -d "$ARCHIVE_DIR" ]; then
  echo "[$(ts)] skip: ColdStore not mounted" >> "$LOG"
  exit 0
fi

cd "$GROUPS_DIR"
LIST=$(mktemp /tmp/nanoclaw-archive.XXXXXX)
trap 'rm -f "$LIST"' EXIT

find . -type f -size "$MIN_SIZE" -mtime "$MIN_AGE" \
  ! -path '*/node_modules/*' ! -path '*/.pnpm-store/*' > "$LIST"

COUNT=$(wc -l < "$LIST" | tr -d ' ')
if [ "$COUNT" -eq 0 ]; then
  echo "[$(ts)] nothing to archive" >> "$LOG"
  exit 0
fi

BYTES=$(awk '{print}' "$LIST" | tr '\n' '\0' | xargs -0 stat -f '%z' | awk '{s+=$1} END {print s}')
rsync -a --remove-source-files --files-from="$LIST" . "$ARCHIVE_DIR/" >> "$LOG" 2>&1
echo "[$(ts)] archived $COUNT file(s), $((BYTES / 1048576)) MB -> $ARCHIVE_DIR" >> "$LOG"
