#!/bin/sh
set -eu
restic --retry-lock 10m forget --host scry-production --keep-hourly "${BACKUP_KEEP_HOURLY:-48}" --keep-daily "${BACKUP_KEEP_DAILY:-30}" --keep-weekly "${BACKUP_KEEP_WEEKLY:-12}" --keep-monthly "${BACKUP_KEEP_MONTHLY:-12}" --prune
restic --retry-lock 10m check --read-data-subset="${BACKUP_CHECK_DATA_SUBSET:-5%}"
