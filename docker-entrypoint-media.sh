#!/bin/sh
set -eu

data_dir="${MEDIA_DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$data_dir/uploads"

  # Bind-mounted folders are often created as root on the server. Fix only the
  # writable metadata and partial uploads; completed videos can remain untouched.
  chown node:node "$data_dir" "$data_dir/uploads"
  chmod u+rwx "$data_dir" "$data_dir/uploads"

  for item in \
    "$data_dir/videos.json" \
    "$data_dir/videos.json.tmp" \
    "$data_dir/queue.json" \
    "$data_dir/queue.json.tmp" \
    "$data_dir/settings.json" \
    "$data_dir/settings.json.tmp" \
    "$data_dir/playlists.json" \
    "$data_dir/playlists.json.tmp" \
    "$data_dir/audit-log.json" \
    "$data_dir/audit-log.json.tmp" \
    "$data_dir/stream-presets.enc.json" \
    "$data_dir/stream-presets.enc.json.tmp" \
    "$data_dir/stream-state.enc.json" \
    "$data_dir/stream-state.enc.json.tmp" \
    "$data_dir/youtube-oauth.enc.json" \
    "$data_dir/youtube-oauth.enc.json.tmp" \
    "$data_dir/youtube-stats.json" \
    "$data_dir/youtube-stats.json.tmp" \
    "$data_dir/monitoring.json" \
    "$data_dir/monitoring.json.tmp" \
    "$data_dir/telegram-bot.enc.json" \
    "$data_dir/telegram-bot.enc.json.tmp" \
    "$data_dir/uploads"/*.part \
    "$data_dir/uploads"/*.processing.tmp.mp4 \
    "$data_dir/uploads"/*.thumbnail.tmp.jpg \
    "$data_dir/uploads"/*.thumbnail.jpg
  do
    if [ -e "$item" ]; then
      chown node:node "$item"
      chmod u+rw "$item"
    fi
  done

  exec gosu node "$@"
fi

exec "$@"
