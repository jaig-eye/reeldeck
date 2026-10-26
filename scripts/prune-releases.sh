#!/usr/bin/env bash
# Delete every published release except the current one.
#
# WHY: every APK attached to a release before v1.0.31 contains the mirror table, because
# that table used to be compiled into app.js. Anyone could download a release and unzip
# the URLs straight out of it. v1.0.31 is the first build that does not carry them, so
# the older binaries are the last easily-grabbed copy.
#
# WHAT IT DOES NOT DO: the table is still in this repository's git HISTORY. Deleting a
# release removes the binaries, not the commits. Purging history needs a filter-repo
# rewrite and a force-push, which is a separate decision.
#
# Tags are KEPT. `gh release delete` leaves them alone unless asked, and removing them
# would not hide anything -- every commit in between still has the old file.
#
# Run from the repository root:   bash scripts/prune-releases.sh
set -u

KEEP="v1.0.31"
REPO="jaig-eye/reeldeck"

command -v gh >/dev/null 2>&1 || {
  echo "gh CLI not found. Install it first:"
  echo "    winget install --id GitHub.cli"
  echo "    gh auth login"
  exit 1
}
gh auth status >/dev/null 2>&1 || { echo "gh is installed but not signed in. Run: gh auth login"; exit 1; }

# ---- refuse to delete anything unless the keeper is genuinely intact ----------------
echo "Checking $KEEP before deleting anything..."
ASSETS=$(gh release view "$KEEP" --repo "$REPO" --json assets --jq '.assets | length' 2>/dev/null) || {
  echo "ABORT: $KEEP has no release. Nothing will be deleted."; exit 1; }
HAS_APK=$(gh release view "$KEEP" --repo "$REPO" --json assets --jq '[.assets[].name] | map(endswith(".apk")) | any')
if [ "$ASSETS" -lt 14 ] || [ "$HAS_APK" != "true" ]; then
  echo "ABORT: $KEEP looks incomplete ($ASSETS assets, apk=$HAS_APK). Nothing will be deleted."
  exit 1
fi
echo "  $KEEP is complete: $ASSETS assets, APK present."
echo

TAGS=$(gh release list --repo "$REPO" --limit 200 --json tagName --jq ".[].tagName | select(. != \"$KEEP\")")
COUNT=$(printf '%s\n' "$TAGS" | grep -c . || true)
echo "About to delete $COUNT releases (keeping $KEEP). Tags are left in place."
printf '%s\n' "$TAGS" | tr '\n' ' '; echo; echo
read -r -p "Type DELETE to proceed: " ANSWER
[ "$ANSWER" = "DELETE" ] || { echo "Cancelled. Nothing was deleted."; exit 0; }

OK=0; FAIL=0
for t in $TAGS; do
  if gh release delete "$t" --repo "$REPO" --yes >/dev/null 2>&1; then
    echo "  deleted $t"; OK=$((OK+1))
  else
    echo "  FAILED  $t"; FAIL=$((FAIL+1))
  fi
done

echo
echo "Deleted $OK, failed $FAIL."
echo "Remaining releases:"
gh release list --repo "$REPO" --limit 20
