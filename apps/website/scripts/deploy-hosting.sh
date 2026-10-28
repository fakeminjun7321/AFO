#!/usr/bin/env bash
set -euo pipefail
set +x
export -n AFO_FIREBASE_CREDENTIALS

fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ "${GITHUB_EVENT_NAME:-}" == "push" && "${GITHUB_REF:-}" == "refs/heads/main" ]] || fail 'Only a push to main may deploy.'
[[ "${GITHUB_REPOSITORY:-}" == "fakeminjun7321/AFO" ]] || fail 'Unexpected repository.'
[[ "${AFO_HOSTING_AUTODEPLOY:-}" == "enabled" ]] || fail 'Automatic deployment is disabled.'
[[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || fail 'Invalid commit identifier.'
root="$(git rev-parse --show-toplevel)"
cd "$root"
[[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]] || fail 'Checkout does not match the tested commit.'
git diff --quiet && git diff --cached --quiet || fail 'Tracked files changed after checkout; refusing deployment.'

# A later documentation-only commit need not prevent deployment. Any relevant change must
# be tested by its own newer run; never deploy a stale website or workflow over it.
git fetch --no-tags --depth=1 origin refs/heads/main >/dev/null
if ! git diff --quiet "$GITHUB_SHA" FETCH_HEAD -- apps/website firebase packages/engine .github/workflows/website.yml; then
  printf '%s\n' 'A newer relevant main change exists; this deployment is skipped.'
  exit 0
fi
cd "$root/apps/website"
node scripts/check-hosting-build.mjs
[[ -n "${AFO_FIREBASE_CREDENTIALS:-}" ]] || fail 'Deployment credential is not configured.'
[[ -n "${RUNNER_TEMP:-}" && -d "$RUNNER_TEMP" ]] || fail 'Runner temporary directory is unavailable.'
umask 077
credentials="$(mktemp "$RUNNER_TEMP/afo-hosting.XXXXXX")"
trap 'rm -f "$credentials"' EXIT
printf '%s' "$AFO_FIREBASE_CREDENTIALS" > "$credentials"
unset AFO_FIREBASE_CREDENTIALS
AFO_CREDENTIAL_PATH="$credentials" node -e '
  const fs = require("node:fs");
  try {
    const c = JSON.parse(fs.readFileSync(process.env.AFO_CREDENTIAL_PATH, "utf8"));
    if (c.type !== "service_account" || c.project_id !== "afo-hackathon-2026-7321" ||
        c.client_email !== "afo-hosting-cd@afo-hackathon-2026-7321.iam.gserviceaccount.com" ||
        typeof c.private_key !== "string" || !c.private_key.startsWith("-----BEGIN PRIVATE KEY-----")) throw new Error();
  } catch { console.error("Deployment credential does not match the approved service account."); process.exit(1); }
'
export GOOGLE_APPLICATION_CREDENTIALS="$credentials"
node "$root/firebase/node_modules/firebase-tools/lib/bin/firebase.js" deploy \
  --only hosting --project afo-hackathon-2026-7321 --config firebase.json \
  --non-interactive --message "GitHub main ${GITHUB_SHA}"
