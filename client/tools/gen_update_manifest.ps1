# Generates winclaw-update.json for the in-app auto-update flow.
# Called by build_installer.bat after the Inno Setup installer is built.
#
# Output:
#   installer\winclaw-update.json
#   installer\runtimes\runtime-python-<stamp>.zip
#
# Manifest fields: version, url, sha256, notes, mandatory, publishedAt, runtimes[]
# The installer exe is content-only. Environment packs ship beside it and are
# split onto the update platform under /update/runtimes/.

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

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$installerDir = Join-Path $RepoRoot "installer"
$exeName = "Hs-WinClaw-Setup-$Version.exe"
$exePath = Join-Path $installerDir $exeName
if (-not (Test-Path $exePath)) {
    throw "Installer not found: $exePath"
}

$sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $exePath).Hash.ToLower()

$offline = Join-Path $RepoRoot "tools\python-offline"
$embedZip = Join-Path $offline "python-3.12.10-embed-amd64.zip"
if (-not (Test-Path $embedZip)) {
    throw "Missing environment pack source: $embedZip. Run tools\bundle_python.ps1 -SkipLocalExtract first."
}

$stampFile = Join-Path $offline "stamp"
$stamp = "3.12.10-1"
if (Test-Path $stampFile) {
    $stamp = (Get-Content -LiteralPath $stampFile -Raw).Trim()
}
if ([string]::IsNullOrWhiteSpace($stamp)) {
    throw "python-offline stamp file is empty"
}

$runtimeDir = Join-Path $installerDir "runtimes"
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$runtimeFile = "runtime-python-$stamp.zip"
$runtimePath = Join-Path $runtimeDir $runtimeFile
if (Test-Path $runtimePath) {
    Remove-Item -LiteralPath $runtimePath -Force
}
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $offline,
    $runtimePath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false)
$runtimeSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $runtimePath).Hash.ToLower()
$runtimeSize = (Get-Item -LiteralPath $runtimePath).Length

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

$runtime = [ordered]@{
    id     = "python"
    stamp  = $stamp
    file   = $runtimeFile
    url    = "$BaseUrl/runtimes/$runtimeFile"
    sha256 = $runtimeSha
    size   = [int64]$runtimeSize
}

$manifest = [ordered]@{
    version     = $Version
    url         = "$BaseUrl/$exeName"
    sha256      = $sha256
    notes       = ($notes -join "`n")
    mandatory   = $false
    publishedAt = (Get-Date -Format "yyyy-MM-dd")
    runtimes    = @($runtime)
}

$jsonPath = Join-Path $installerDir "winclaw-update.json"
$json = $manifest | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($jsonPath, $json, (New-Object System.Text.UTF8Encoding $false))

Write-Host "Update manifest written: $jsonPath"
Write-Host "  version : $Version"
Write-Host "  sha256  : $sha256"
Write-Host "  url     : $BaseUrl/$exeName"
Write-Host "  runtime : $runtimeFile ($runtimeSha)"
