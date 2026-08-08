#!/bin/sh
set -eu

config_dir="${HIGGSFIELD_CONFIG_DIR:-/root/.config/higgsfield}"
credentials_path="$config_dir/credentials.json"

if [ ! -f "$credentials_path" ] && [ -n "${HIGGSFIELD_CREDENTIALS_B64:-}" ]; then
  mkdir -p "$config_dir"
  printf '%s' "$HIGGSFIELD_CREDENTIALS_B64" | base64 -d > "$credentials_path"
  chmod 600 "$credentials_path"
fi

if [ ! -f "$credentials_path" ]; then
  echo "HIGGSFIELD_CREDENTIALS_B64 is required on the first start" >&2
  exit 1
fi

exec node /app/services/higgsfield-worker/server.mjs
