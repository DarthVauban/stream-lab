#!/bin/sh
set -eu

backup_name="${1:-}"
if [ -z "$backup_name" ]; then
  echo "Usage: sh scripts/restore-backup.sh <backup-name>" >&2
  exit 2
fi

restart_services() {
  docker compose --profile production up -d --wait --wait-timeout 180
}

trap restart_services EXIT INT TERM
docker compose stop web media-server backup-scheduler
STREAMLAB_RESTORE_CONFIRMED=YES docker compose --profile maintenance run --rm \
  -e STREAMLAB_RESTORE_CONFIRMED=YES backup restore "$backup_name"
trap - EXIT INT TERM
restart_services
