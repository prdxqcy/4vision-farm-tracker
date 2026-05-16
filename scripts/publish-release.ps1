param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

function Get-GitHubCli {
  $ghCommand = Get-Command gh -ErrorAction SilentlyContinue
  if ($ghCommand) {
    return $ghCommand.Source
  }

  $defaultGhPath = Join-Path ${env:ProgramFiles} "GitHub CLI\gh.exe"
  if (Test-Path $defaultGhPath) {
    return $defaultGhPath
  }

  throw "GitHub CLI is not installed. Install it with 'winget install --id GitHub.cli -e'."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $repoRoot "package.json"
$releaseDir = Join-Path $repoRoot "release"
$installerPath = Join-Path $releaseDir "FarmTracks-Overlay-Setup.exe"
$latestYamlPath = Join-Path $releaseDir "latest.yml"
$blockmapPath = Join-Path $releaseDir "FarmTracks-Overlay-Setup.exe.blockmap"

$packageJson = Get-Content $packageJsonPath | ConvertFrom-Json
$version = $packageJson.version
$tag = "v$version"
$releaseTitle = "FarmTracks Overlay $version"
$gh = Get-GitHubCli

Write-Host "Checking GitHub CLI authentication..."
& $gh auth status | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "GitHub CLI is installed but not logged in. Run 'gh auth login' once, then rerun this script."
}

if (-not $SkipBuild) {
  Write-Host "Building Windows installer..."
  Push-Location $repoRoot
  try {
    npm run desktop:installer
  }
  finally {
    Pop-Location
  }
}

$assets = @($installerPath, $latestYamlPath)
if (Test-Path $blockmapPath) {
  $assets += $blockmapPath
}

$missingAssets = $assets | Where-Object { -not (Test-Path $_) }
if ($missingAssets.Count -gt 0) {
  throw "Missing release assets: $($missingAssets -join ', ')"
}

Write-Host "Ensuring git tag $tag exists locally..."
Push-Location $repoRoot
try {
  $existingTag = git tag --list $tag
  if (-not $existingTag) {
    git tag $tag
  }
}
finally {
  Pop-Location
}

Write-Host "Creating or updating GitHub release $tag..."
& $gh release view $tag *> $null
if ($LASTEXITCODE -ne 0) {
  & $gh release create $tag $assets --title $releaseTitle --generate-notes --latest
}
else {
  & $gh release upload $tag $assets --clobber
}

Write-Host "Release publish complete for $tag."
