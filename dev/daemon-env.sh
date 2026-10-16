#!/bin/sh
# An adt+ daemon of its own for a worktree or a test session: its own socket,
# a copy of systems.json and its own call log, so it never replaces the user's
# daemon (a client from another build retires the one on its socket) and a
# config edit stays local. Development only, never shipped.
#
#   env=$(dev/daemon-env.sh [name]) && eval "$env" && node dist/cli/index.js status
#   dev/daemon-env.sh --stop [name]
#
# name defaults to the checkout's folder name plus a hash of its path. All of
# it lives in /tmp/adtplus-<name>/: macOS fails unix socket paths over ~104
# chars, so a folder inside the worktree is often too long.
set -eu

usage() {
  echo "usage: dev/daemon-env.sh [--stop] [name]" >&2
  exit 2
}

stop=0
case "${1:-}" in
  --stop) stop=1; shift ;;
  -*) usage ;;
esac
[ $# -le 1 ] || usage
case "${1:-}" in -*) usage ;; esac

repo=$(cd "$(dirname "$0")/.." && pwd)
if [ $# -eq 1 ]; then
  name=$1
else
  name=$(basename "$repo" | cut -c1-24)-$(printf '%s' "$repo" | shasum | cut -c1-8)
fi
case "$name" in
  ''|*[!A-Za-z0-9_-]*) echo "daemon-env: name may hold only letters, digits, - and _: '$name'" >&2; exit 2 ;;
esac
[ ${#name} -le 48 ] || { echo "daemon-env: name longer than 48 chars: '$name'" >&2; exit 2; }
dir=/tmp/adtplus-$name
sock=$dir/adtplus.sock

if [ "$stop" = 1 ]; then
  # lsof also lists clients connected to the socket: kill only the daemon.
  stopped=
  for pid in $(lsof -t "$sock" 2>/dev/null || true); do
    case "$(ps -o command= -p "$pid" 2>/dev/null || true)" in
      *daemon/server*) kill "$pid" 2>/dev/null && stopped="$stopped $pid" ;;
    esac
  done
  if [ -n "$stopped" ]; then echo "stopped daemon$stopped ($sock)" >&2; else echo "no daemon on $sock" >&2; fi
  exit 0
fi

mkdir -p "$dir"
[ -O "$dir" ] || { echo "daemon-env: $dir belongs to another user" >&2; exit 1; }
chmod 700 "$dir"

src=$HOME/.config/adtplus/systems.json
config=$dir/systems.json
if [ ! -f "$config" ]; then
  # Relative extraCaCerts resolve against the config's folder: make them absolute.
  node -e '
    const fs = require("node:fs"), path = require("node:path");
    const [src, dst] = process.argv.slice(1);
    const cfg = JSON.parse(fs.readFileSync(src, "utf8"));
    for (const e of Object.values(cfg)) {
      if (e && Array.isArray(e.extraCaCerts))
        e.extraCaCerts = e.extraCaCerts.map((p) => p === "~" || p.startsWith("~/") ? p : path.resolve(path.dirname(src), p));
    }
    fs.writeFileSync(dst, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  ' "$src" "$config"
elif [ "$src" -nt "$config" ]; then
  echo "daemon-env: $src changed after $config was copied; the copy keeps the old allowlists. Delete it to copy again." >&2
fi

echo "export XDG_RUNTIME_DIR='$dir'"
echo "export ADTPLUS_CONFIG='$config'"
echo "export ADTPLUS_LOG='$dir/calls.jsonl'"
