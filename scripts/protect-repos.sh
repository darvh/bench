#!/usr/bin/env bash
# Apply darvh's standard branch protection to a repo's main branch.
# GitHub has no org-wide default, so this script is the general mechanism —
# run it for every darvh repo that should be PR-only.
#
#   scripts/protect-repos.sh [repo ...]      # default: signal bench
#
<<<<<<< HEAD
# Policy: main requires a pull request (1 review) with admins EXEMPT (the
# owner can open/merge/close their own PRs), linear history, no force pushes,
# no deletions.
=======
# Policy: main requires a pull request (review), linear history, no force
# pushes, no deletions, admins included.
>>>>>>> main
set -euo pipefail

REPOS=("${@:-signal bench}")

body() {
  cat <<'JSON'
{
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
<<<<<<< HEAD
  "required_status_checks": null,
  "restrictions": null,
  "enforce_admins": false,
=======
  "enforce_admins": true,
>>>>>>> main
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
}

for repo in "${REPOS[@]}"; do
  echo "protecting darvh/$repo main..."
<<<<<<< HEAD
  if gh api -X PUT "repos/darvh/$repo/branches/main/protection" \
    -H "Accept: application/vnd.github+json" \
    --input - <<< "$(body)" >/dev/null 2>&1; then
    echo "  protected: admins-exempt, PR-only, linear, no force-push"
  else
    echo "  FAILED to protect $repo" >&2
  fi
=======
  gh api -X PUT "repos/darvh/$repo/branches/main/protection" \
    -H "Accept: application/vnd.github+json" \
    --input - <<< "$(body)" >/dev/null
  echo "  protected: linear_history=$(gh api "repos/darvh/$repo/branches/main/protection" --jq '.required_linear_history.enabled' 2>/dev/null)"
>>>>>>> main
done
echo "done"
