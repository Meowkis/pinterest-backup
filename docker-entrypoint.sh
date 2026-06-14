#!/bin/sh
set -eu

data_dir="${DATA_DIR:-/data}"
run_uid="${PUID:-1000}"
run_gid="${PGID:-1000}"

case "$run_uid:$run_gid" in
  *[!0-9:]*|:*|*:) echo "PUID and PGID must be numeric" >&2; exit 1 ;;
esac

mkdir -p "$data_dir" "$data_dir/assets" "$data_dir/tmp" "$data_dir/auth-debug"

# Bind mounts keep host ownership. Files are mostly immutable, so only mutable
# top-level files and directories need ownership correction on every start.
chown "$run_uid:$run_gid" "$data_dir" "$data_dir/assets" "$data_dir/tmp" "$data_dir/auth-debug"
find "$data_dir/assets" "$data_dir/tmp" "$data_dir/auth-debug" -type d \
  \( ! -user "$run_uid" -o ! -group "$run_gid" \) -exec chown "$run_uid:$run_gid" {} +
find "$data_dir" -maxdepth 1 -type f \
  \( ! -user "$run_uid" -o ! -group "$run_gid" \) -exec chown "$run_uid:$run_gid" {} +

exec gosu "$run_uid:$run_gid" "$@"
