#!/usr/bin/env bash
# bash scripts/release/publish.sh <ver> <snapshot-dir> — push one release snapshot to the public repo (spec v2.6 §7.8-3).
# The snapshot comes from `bun scripts/release/export.ts <ver> <snapshot-dir>`; its scans run again here (`--check`)
# before anything is staged, so a red or edited snapshot is never pushed.
# Env: CC_SLAVES_GH_ID (required) = the numeric GitHub id of the account, for its noreply address;
#      CC_SLAVES_PUBLIC_REMOTE (optional) = the remote to push to (tests point it at a temp bare repo).
# Author and committer are the GitHub noreply address, never the machine's git config (A11); the commit body
# carries no dev SHA or branch name.
set -euo pipefail

ver="${1:-}"
snap="${2:-}"
user="billphamhypertek"
remote="${CC_SLAVES_PUBLIC_REMOTE:-https://github.com/${user}/cc-slaves.git}"
die() { echo "publish: $*" >&2; exit 1; }

[[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "usage: publish.sh <major.minor.patch[-pre]> <snapshot-dir>"
[ -d "$snap" ] || die "no snapshot dir: $snap"
[ -f "$snap/.github/workflows/release.yml" ] || die "$snap has no .github/workflows/release.yml — nothing would build the release"
[[ "${CC_SLAVES_GH_ID:-}" =~ ^[0-9]+$ ]] || die "CC_SLAVES_GH_ID must be the numeric GitHub id of ${user}"
domain="users.noreply.github.com"
email="${CC_SLAVES_GH_ID}+${user}@${domain}"
snap="$(cd "$snap" && pwd)"
bun "$(dirname "$0")/export.ts" --check "$snap" || die "$snap fails the export scans — nothing pushed"

# No auto gc / maintenance in the work repo: a detached run races the cleanup below. The cleanup never decides the exit
# code: once the push has landed, publish succeeded (a re-run would die on the public tag).
export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=gc.auto GIT_CONFIG_VALUE_0=0 GIT_CONFIG_KEY_1=maintenance.auto GIT_CONFIG_VALUE_1=false
work="$(mktemp -d)"
trap 'rm -rf "$work" || true' EXIT
# The release branch is always main; an empty public repo (first release) has no branch yet.
if [ -n "$(git ls-remote --heads "$remote" main)" ]; then
  git clone -q --depth 1 --branch main "$remote" "$work/repo" 2>&1 | grep -v 'depth is ignored' >&2 || true
  [ -d "$work/repo/.git" ] || die "clone of $remote failed"
else
  git clone -q "$remote" "$work/repo" 2>/dev/null
  git -C "$work/repo" symbolic-ref HEAD refs/heads/main
fi
cd "$work/repo"
git rm -rq --ignore-unmatch .
cp -R "$snap/." .
# -f: the snapshot is exactly the files tracked at the dev tag; its own .gitignore must not drop any (e.g. docs/releases/).
git add -A -f .
unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
id=(-c "user.name=${user}" -c "user.email=${email}" -c commit.gpgsign=false -c tag.gpgsign=false -c core.hooksPath=/dev/null)
git "${id[@]}" commit -q -m "release: ${ver}"
git "${id[@]}" tag "v${ver}"
git push -q --atomic origin main "v${ver}"
echo "publish: v${ver} pushed to ${remote}"
