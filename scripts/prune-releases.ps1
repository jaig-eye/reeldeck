# Delete every published release except the current one.  (PowerShell 5.1 compatible)
#
# WHY: every APK attached to a release before v1.0.31 contains the mirror table, because
# that table used to be compiled into app.js. Anyone could download a release and unzip
# the URLs straight out of it. v1.0.31 is the first build that does not carry them, so
# the older binaries are the last easily-grabbed copy.
#
# NOT DONE HERE: the table is still in the repository's git HISTORY. Deleting a release
# removes binaries, not commits. Tags are kept too -- removing them would hide nothing,
# since every commit in between still has the old file.
#
# Run from anywhere:
#     powershell -ExecutionPolicy Bypass -File "C:\Users\disis\moviestream\scripts\prune-releases.ps1"

$ErrorActionPreference = 'Stop'
$KEEP = 'v1.0.31'
$REPO = 'jaig-eye/reeldeck'

function Have($name) { $null -ne (Get-Command $name -ErrorAction SilentlyContinue) }

if (-not (Have 'gh')) {
    Write-Host "GitHub CLI is not installed (or this window predates the install)." -ForegroundColor Yellow
    Write-Host "  1.  winget install --id GitHub.cli"
    Write-Host "  2.  close this window and open a NEW one (PATH only refreshes in new windows)"
    Write-Host "  3.  gh auth login"
    Write-Host "  4.  run this script again"
    exit 1
}

gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "gh is installed but not signed in.  Run:  gh auth login" -ForegroundColor Yellow
    exit 1
}

# ---- refuse to delete anything unless the keeper is genuinely intact -----------------
Write-Host "Checking $KEEP before deleting anything..."
$assetsJson = gh release view $KEEP --repo $REPO --json assets 2>$null
if ($LASTEXITCODE -ne 0 -or -not $assetsJson) {
    Write-Host "ABORT: $KEEP has no release. Nothing deleted." -ForegroundColor Red; exit 1
}
$assets = ($assetsJson | ConvertFrom-Json).assets
$apk = @($assets | Where-Object { $_.name -like '*.apk' }).Count
if ($assets.Count -lt 14 -or $apk -lt 1) {
    Write-Host "ABORT: $KEEP looks incomplete ($($assets.Count) assets, $apk apk). Nothing deleted." -ForegroundColor Red
    exit 1
}
Write-Host "  $KEEP is complete: $($assets.Count) assets, APK present." -ForegroundColor Green
Write-Host ""

$all = (gh release list --repo $REPO --limit 200 --json tagName | ConvertFrom-Json)
$old = @($all | Where-Object { $_.tagName -ne $KEEP } | ForEach-Object { $_.tagName })

if ($old.Count -eq 0) { Write-Host "Nothing to delete."; exit 0 }

Write-Host "About to delete $($old.Count) releases, keeping $KEEP.  Tags are left in place."
Write-Host ("  " + ($old -join ' '))
Write-Host ""
$answer = Read-Host "Type DELETE to proceed"
if ($answer -ne 'DELETE') { Write-Host "Cancelled. Nothing was deleted."; exit 0 }

$ok = 0; $fail = 0
foreach ($t in $old) {
    gh release delete $t --repo $REPO --yes 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Host "  deleted $t"; $ok++ }
    else { Write-Host "  FAILED  $t" -ForegroundColor Red; $fail++ }
}

Write-Host ""
Write-Host "Deleted $ok, failed $fail."
Write-Host "Remaining:"
gh release list --repo $REPO --limit 20
