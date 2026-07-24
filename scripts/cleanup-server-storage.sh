#!/bin/sh
set -eu

project_root="$(pwd -P)"
uploads_root="$project_root/data/uploads"

if [ ! -f "$project_root/compose.yaml" ] || [ ! -d "$project_root/.git" ]; then
  echo "Storage cleanup must run from the StreamLab project root." >&2
  exit 2
fi

print_storage() {
  label="$1"
  echo "===== StreamLab storage: $label ====="
  df -h "$project_root"
  du -sh "$project_root/data" "$project_root/backups" 2>/dev/null || true
  if [ -d "$uploads_root" ]; then
    find "$uploads_root" -maxdepth 1 -type f \
      \( -name '*.stream.mp4' -o -name '*.source.*' -o -name '*.part' -o -name '*.processing.tmp.mp4' \) \
      -printf '%s %f\n' 2>/dev/null |
      awk '
        /\.stream\.mp4$/ { stream += $1; stream_count += 1; next }
        /\.source\./ { source += $1; source_count += 1; next }
        /\.part$/ { partial += $1; partial_count += 1; next }
        /\.processing\.tmp\.mp4$/ { temporary += $1; temporary_count += 1 }
        END {
          printf "Prepared videos: %d files, %.2f GiB\n", stream_count, stream / 1073741824;
          printf "Original uploads: %d files, %.2f GiB\n", source_count, source / 1073741824;
          printf "Partial uploads: %d files, %.2f GiB\n", partial_count, partial / 1073741824;
          printf "Processing files: %d files, %.2f GiB\n", temporary_count, temporary / 1073741824;
        }
      '
  fi
  docker system df || true
}

prune_ready_sources() {
  [ -d "$uploads_root" ] || return 0
  find "$uploads_root" -maxdepth 1 -type f -name '*.source.*' -print |
  while IFS= read -r source_path; do
    source_name="$(basename "$source_path")"
    video_id="${source_name%%.source.*}"
    prepared_path="$uploads_root/$video_id.stream.mp4"
    if [ ! -s "$prepared_path" ]; then
      continue
    fi
    rm -f -- "$source_path"
    echo "Removed duplicate source with a prepared copy: $source_name"
  done
}

command="${1:-audit}"
case "$command" in
  audit)
    print_storage "audit"
    ;;
  cleanup)
    print_storage "before cleanup"
    prune_ready_sources
    docker image prune -af
    docker builder prune -af || echo "Docker build cache cleanup was skipped." >&2
    print_storage "after cleanup"
    ;;
  *)
    echo "Usage: cleanup-server-storage.sh audit | cleanup" >&2
    exit 2
    ;;
esac
