#!/bin/sh
set -eu

backup_root="${BACKUP_ROOT:-/backups}"
data_root="${BACKUP_DATA_ROOT:-/source-data}"
database_host="${POSTGRES_HOST:-postgres}"
database_port="${POSTGRES_PORT:-5432}"
database_name="${POSTGRES_DB:-streamlab}"
database_user="${POSTGRES_USER:-streamlab}"
retention_days="${BACKUP_RETENTION_DAYS:-14}"
interval_seconds="${BACKUP_INTERVAL_SECONDS:-86400}"

export PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"

validate_identifier() {
  case "$1" in
    ''|*[!A-Za-z0-9_]* )
      echo "Invalid PostgreSQL identifier: $1" >&2
      exit 2
      ;;
  esac
}

validate_backup_name() {
  case "$1" in
    ''|*[!A-Za-z0-9_.-]*|.*|*..*)
      echo "Invalid backup name: $1" >&2
      exit 2
      ;;
  esac
}

wait_for_database() {
  attempts=0
  until pg_isready -h "$database_host" -p "$database_port" -U "$database_user" -d "$database_name" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then
      echo "PostgreSQL did not become ready." >&2
      exit 1
    fi
    sleep 2
  done
}

verify_backup() {
  backup_name="$1"
  validate_backup_name "$backup_name"
  target="$backup_root/$backup_name"
  if [ ! -d "$target" ]; then
    echo "Backup not found: $backup_name" >&2
    exit 1
  fi
  (
    cd "$target"
    sha256sum -c SHA256SUMS
    pg_restore --list database.dump >/dev/null
    tar -tzf data.tar.gz >/dev/null
  )
  echo "Backup verified: $backup_name"
}

create_backup() {
  requested_name="${1:-}"
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_name="${requested_name:-streamlab-$timestamp}"
  validate_backup_name "$backup_name"
  target="$backup_root/$backup_name"
  temporary="$backup_root/.creating-$backup_name-$$"

  if [ -e "$target" ]; then
    echo "Backup already exists: $backup_name" >&2
    exit 1
  fi

  mkdir -p "$backup_root" "$temporary"
  trap 'rm -rf "$temporary"' EXIT INT TERM
  wait_for_database

  pg_dump \
    --host "$database_host" \
    --port "$database_port" \
    --username "$database_user" \
    --dbname "$database_name" \
    --format custom \
    --compress 6 \
    --no-owner \
    --no-privileges \
    --file "$temporary/database.dump"

  tar -czf "$temporary/data.tar.gz" \
    --exclude='./uploads/*.part' \
    --exclude='./uploads/*.processing.tmp.mp4' \
    --exclude='./uploads/*.thumbnail.tmp.*' \
    --exclude='./uploads/.trash' \
    --exclude='./promo-assets/*.tmp' \
    --exclude='./promo-assets/*.tmp.webp' \
    --exclude='./*.tmp' \
    -C "$data_root" .

  (
    cd "$temporary"
    sha256sum database.dump data.tar.gz > SHA256SUMS
  )
  cat > "$temporary/manifest.json" <<EOF
{
  "schemaVersion": 1,
  "name": "$backup_name",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "database": "$database_name",
  "includes": ["postgresql", "media", "encrypted integrations", "stream state"]
}
EOF
  (
    cd "$temporary"
    sha256sum -c SHA256SUMS
    pg_restore --list database.dump >/dev/null
    tar -tzf data.tar.gz >/dev/null
  )
  mv "$temporary" "$target"
  trap - EXIT INT TERM
  echo "Backup created and verified: $backup_name"
}

prune_backups() {
  case "$retention_days" in
    ''|*[!0-9]* ) echo "BACKUP_RETENTION_DAYS must be a positive integer." >&2; exit 2 ;;
  esac
  if [ "$retention_days" -lt 1 ]; then
    echo "BACKUP_RETENTION_DAYS must be at least 1." >&2
    exit 2
  fi
  find "$backup_root" -mindepth 1 -maxdepth 1 -type d \
    \( -name 'streamlab-*' -o -name 'pre-restore-*' \) \
    -mtime "+$retention_days" -exec rm -rf -- {} +
}

restore_backup() {
  backup_name="${1:-}"
  validate_backup_name "$backup_name"
  if [ "${STREAMLAB_RESTORE_CONFIRMED:-}" != "YES" ]; then
    echo "Restore refused. Stop StreamLab and set STREAMLAB_RESTORE_CONFIRMED=YES." >&2
    exit 3
  fi
  verify_backup "$backup_name"
  wait_for_database

  safety_name="pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  create_backup "$safety_name"

  psql \
    --host "$database_host" \
    --port "$database_port" \
    --username "$database_user" \
    --dbname postgres \
    --set ON_ERROR_STOP=1 \
    --command "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$database_name' AND pid <> pg_backend_pid();" \
    --command "DROP DATABASE IF EXISTS \"$database_name\";" \
    --command "CREATE DATABASE \"$database_name\" OWNER \"$database_user\";"

  pg_restore \
    --host "$database_host" \
    --port "$database_port" \
    --username "$database_user" \
    --dbname "$database_name" \
    --no-owner \
    --no-privileges \
    --exit-on-error \
    "$backup_root/$backup_name/database.dump"

  find "$data_root" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  tar -xzf "$backup_root/$backup_name/data.tar.gz" -C "$data_root"
  echo "Backup restored: $backup_name"
  echo "Automatic pre-restore safety copy: $safety_name"
}

list_backups() {
  mkdir -p "$backup_root"
  find "$backup_root" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort -r
}

schedule_backups() {
  case "$interval_seconds" in
    ''|*[!0-9]* ) echo "BACKUP_INTERVAL_SECONDS must be a positive integer." >&2; exit 2 ;;
  esac
  if [ "$interval_seconds" -lt 3600 ]; then
    echo "BACKUP_INTERVAL_SECONDS must be at least 3600." >&2
    exit 2
  fi
  while :; do
    # Run each cycle in a fresh shell so `set -e` remains effective even
    # though the command is used as an `if` condition here.
    if /bin/sh "$0" create; then
      /bin/sh "$0" prune || echo "Backup retention cleanup failed." >&2
    else
      echo "Scheduled backup failed; retrying after the configured interval." >&2
    fi
    sleep "$interval_seconds"
  done
}

validate_identifier "$database_name"
validate_identifier "$database_user"

command="${1:-help}"
case "$command" in
  create) create_backup "${2:-}" ;;
  verify) verify_backup "${2:-}" ;;
  restore) restore_backup "${2:-}" ;;
  list) list_backups ;;
  prune) prune_backups ;;
  schedule) schedule_backups ;;
  *)
    echo "Usage: backup-entrypoint.sh create [name] | verify <name> | restore <name> | list | prune | schedule"
    ;;
esac
