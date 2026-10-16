#!/usr/bin/env bash
# Public-safety gate (AGENTS.md, "Public repository"): fails when a tracked file, or a commit
# message, matches the denylist; a broken pattern fails it too. Development only, not an adt+
# setting, and opt-in: without a denylist it skips (exit 0), unless ADTPLUS_GATE_STRICT=1. The
# denylist names what it guards, so it is never committed: the gitignored `.denylist` in the main checkout's root
# (found from any worktree), or DENYLIST with the same content. One Perl-compatible regex per line,
# matched case-insensitively; blank lines and lines starting with # are skipped; a line
# `allow: <pathspec>` excludes those paths (e.g. `allow: package.json` for the author field).
#
#   dev/gate.sh                 every tracked file
#   dev/gate.sh --staged        the files staged for commit (pre-commit hook)
#   dev/gate.sh --message <f>   a commit message file, without git's comments and diff (commit-msg hook)
set -euo pipefail

main=$(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && pwd)
list="$main/.denylist"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [ -n "${DENYLIST:-}" ]; then
  printf '%s\n' "$DENYLIST" > "$tmp/list"
  list="$tmp/list"
fi
if [ ! -s "$list" ]; then
  # Opt-in: only a maintainer with a denylist runs the gate. ADTPLUS_GATE_STRICT=1 makes a missing one fail.
  if [ -n "${ADTPLUS_GATE_STRICT:-}" ]; then
    echo "gate: no denylist ($list, or DENYLIST)" >&2
    exit 2
  fi
  echo "gate: skipped, no denylist"
  exit 0
fi

grep -vE '^\s*(#|$)' "$list" | grep -vE '^allow:' > "$tmp/patterns" || true
allow=()
while IFS= read -r p; do allow+=(":(exclude)$p"); done < <(sed -nE 's/^allow:[[:space:]]*//p' "$list")

# 0 clean, 1 a hit, anything else (a bad pattern, a git without PCRE) fails the gate too.
verdict() {
  case "$1" in
    0) echo "gate: the lines above name something on the denylist" >&2; exit 1 ;;
    1) echo "gate: clean"; exit 0 ;;
    *) echo "gate: the check itself failed (exit $1); fix the denylist" >&2; exit 2 ;;
  esac
}

if [ "${1:-}" = "--message" ]; then
  # Git's own lines don't count: comments, and the diff below the scissors line (`commit -v`).
  status=0
  perl -e 'open(my $p, "<", shift) or die; my @r = grep { length } map { chomp; $_ } <$p>;
    my @c = map { qr/$_/i } @r; my $hit = 0;
    while (<>) { last if /^# -+ >8 -+$/; next if /^#/; for my $c (@c) { if ($_ =~ $c) { print "$.: $_"; $hit = 1; last } } }
    exit($hit ? 0 : 1)' "$tmp/patterns" "$2" || status=$?
  verdict "$status"
fi

mode=()
files=(.)
if [ "${1:-}" = "--staged" ]; then
  # Only what this commit stages, as staged.
  files=()
  while IFS= read -r -d '' f; do files+=("$f"); done < <(git diff --cached --name-only --diff-filter=ACMR -z)
  [ ${#files[@]} -eq 0 ] && { echo "gate: clean"; exit 0; }
  mode=(--cached)
fi
status=0
git grep ${mode[@]+"${mode[@]}"} -inIP -f "$tmp/patterns" -- "${files[@]}" ${allow[@]+"${allow[@]}"} || status=$?
verdict "$status"
