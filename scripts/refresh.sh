#!/bin/zsh -l
# Install with scripts/install-launchd.sh.
# Weekly job (launchd com.mjaverto.profile-readme). Works in its own clone ($PROFILE_CLONE, default ~/.local/share/profile-readme).
main() {
  export PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.local/share/fnm/aliases/default/bin:$PATH
  set -euo pipefail
  cd "${PROFILE_CLONE:-$HOME/.local/share/profile-readme}"
  # This clone is owned by the job; reset --hard is destructive.
  [ "$(git rev-parse --show-toplevel)" = "$PWD" ] || { echo "not a clone root: $PWD" >&2; exit 1; }
  git remote get-url origin | grep -q 'mjaverto/mjaverto' || { echo "unexpected origin" >&2; exit 1; }
  git fetch -q origin main
  git reset -q --hard origin/main
  GITHUB_TOKEN=$(gh auth token) BLURB_MODEL=${BLURB_MODEL:-anthropic/claude-sonnet-5-5} node scripts/update-contributions.mjs
  unexpected=$(git status --porcelain | grep -vE ' (README\.md|scripts/descriptions\.json)$' || true)
  [ -z "$unexpected" ] || { echo "unexpected changes:" >&2; echo "$unexpected" >&2; exit 1; }
  git diff --quiet && { echo "no changes"; exit 0; }
  git commit -qam "chore: refresh contributions"
  [ -n "${NO_PUSH:-}" ] || git push -q origin HEAD:main
}
main "$@"
