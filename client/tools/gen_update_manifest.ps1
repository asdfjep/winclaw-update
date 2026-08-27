# Generates winclaw-update.json for the in-app auto-update flow.
# Called by build_installer.bat after the Inno Setup installer is built.
#
# Output: installer\winclaw-update.json
#   { version, url, sha256, notes, mandatory, publishedAt }
#
# notes  : commit subjects since the last git tag (fallback: last 20 commits)
# url    : BaseUrl + installer filename (upload both files to that path)

param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$BaseUrl = "http://10.233.129.67:8091/update"
)

$ErrorActionPreference = "Stop"

# git emits UTF-8; make sure PowerShell captures it as UTF-8 instead of the
# console code page (GBK on zh-CN machines), or commit subjects get mojibake.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$installerDir = Join-Path $RepoRoot "installer"
$exeName = "Hs-WinClaw-Setup-$Version.exe"
$exePath = Join-Path $installerDir $exeName
if (-not (Test-Path $exePath)) {
    throw "Installer not found: $exePath"
}

$sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $exePath).Hash.ToLower()

Push-Location $RepoRoot
try {
    $notes = @()
    $lastTag = git describe --tags --abbrev=0 2>$null
    if ($lastTag) {
        $notes = git log "$lastTag..HEAD" --pretty=format:"- %s" --no-merges
    }
    if (-not $notes) {
        $notes = git log -20 --pretty=format:"- %s" --no-merges
    }
}
finally {
    Pop-Location
}
if (-not $notes) { $notes = @("- Internal build") }

$manifest = [ordered]@{
    version     = $Version
    url         = "$BaseUrl/$exeName"
    sha256      = $sha256
    notes       = ($notes -join "`n")
    mandatory   = $false
    publishedAt = (Get-Date -Format "yyyy-MM-dd")
}

$jsonPath = Join-Path $installerDir "winclaw-update.json"
# Write without BOM (Set-Content -Encoding UTF8 emits a BOM on PS 5.1,
# which some servers/clients do not tolerate in JSON).
$json = $manifest | ConvertTo-Json
[System.IO.File]::WriteAllText($jsonPath, $json, (New-Object System.Text.UTF8Encoding $false))

Write-Host "Update manifest written: $jsonPath"
Write-Host "  version : $Version"
Write-Host "  sha256  : $sha256"
Write-Host "  url     : $BaseUrl/$exeName"
