#!/usr/bin/env sh
# Push the current branch to its remote and set the upstream.
#
#   sh scripts/push-branch.sh https://github.com/you/npi-solar-erp.git   # first run
#   sh scripts/push-branch.sh                                            # every run after
#
# The URL is only needed once — it is recorded as `origin`. Pass it again
# later only to repoint the remote somewhere else.
#
# On Windows, run it from Git Bash, or from PowerShell as:
#   bash scripts/push-branch.sh
#
# Why this exists: this working copy had no remote configured at all, and the
# first attempt to add one recorded the placeholder `<user>/<repo>` from the
# instructions verbatim. That is the failure mode worth guarding — `git remote
# add` accepts it happily and nothing looks wrong until the push 404s, so the
# check below refuses to push while the URL still has angle brackets in it.

set -eu

url="${1:-}"

if [ -n "$url" ]; then
  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "$url"
    echo "origin repointed to $url"
  else
    git remote add origin "$url"
    echo "origin added: $url"
  fi
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "No 'origin' remote configured. Pass the repository URL once:" >&2
  echo "  sh scripts/push-branch.sh https://github.com/you/npi-solar-erp.git" >&2
  exit 1
fi

origin=$(git remote get-url origin)

case "$origin" in
  *'<'* | *'>'*)
    echo "origin is still the placeholder URL, not a real repository:" >&2
    echo "  $origin" >&2
    echo "Replace the <...> parts with the real owner and repo name:" >&2
    echo "  sh scripts/push-branch.sh https://github.com/you/npi-solar-erp.git" >&2
    exit 1
    ;;
esac

branch=$(git rev-parse --abbrev-ref HEAD)

if [ "$branch" = "HEAD" ]; then
  echo "Detached HEAD — check out a branch before pushing." >&2
  exit 1
fi

# Not fatal: `git push` only ever sends commits, so uncommitted work is simply
# left behind rather than corrupted. Worth saying out loud all the same, since
# "I pushed it" and "it is on the remote" stop meaning the same thing here.
if [ -n "$(git status --porcelain)" ]; then
  echo "Note: working tree has uncommitted changes; they will NOT be pushed."
  git status --short
  echo
fi

echo "Pushing $branch -> $origin"
git push -u origin "$branch"

# Convenience only, and deliberately quiet about non-GitHub remotes rather
# than printing a link that would not resolve.
case "$origin" in
  https://github.com/*)
    repo=${origin#https://github.com/}
    repo=${repo%.git}
    echo
    echo "Open a pull request:"
    echo "  https://github.com/$repo/compare/$branch?expand=1"
    ;;
esac
