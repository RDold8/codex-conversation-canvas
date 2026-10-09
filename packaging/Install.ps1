param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$bundleRoot = $PSScriptRoot
$manifestPath = Join-Path $bundleRoot 'payload-sha256.json'
if (!(Test-Path -LiteralPath $manifestPath)) { throw 'Missing payload-sha256.json. Extract the entire ZIP first.' }
$inventory = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($entry in $inventory.files) {
    $target = [IO.Path]::GetFullPath((Join-Path $bundleRoot $entry.path))
    $prefix = [IO.Path]::GetFullPath($bundleRoot).TrimEnd('\') + '\'
    if (!$target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Payload path escapes bundle root.' }
    if (!(Test-Path -LiteralPath $target -PathType Leaf)) { throw "Missing payload: $($entry.path)" }
    $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $entry.sha256) { throw "Payload checksum mismatch: $($entry.path)" }
}
$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
$codexCommand = Get-Command codex -CommandType Application -ErrorAction Stop | Select-Object -First 1
$nodeVersion = & $nodeCommand.Source --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.') { throw 'Cannot determine Node version.' }
if ([int]$Matches[1] -lt 24) { throw 'This bundle requires Node 24 or later.' }
Write-Output "Payload checks passed. Node $nodeVersion; Codex CLI: $($codexCommand.Source)"
if ($CheckOnly) {
    Write-Output 'CheckOnly: no installation, configuration changes, or Codex restart.'
    return
}
# Register the extracted directory, then let Codex install its normal plugin payload.
# Keep this directory in place: the local marketplace references it.
& $codexCommand.Source plugin marketplace add $bundleRoot --json
if ($LASTEXITCODE -ne 0) { throw 'Marketplace registration failed. Inspect current state before retrying.' }
& $codexCommand.Source plugin add 'long-conversation-canvas@conversation-canvas-local' --json
if ($LASTEXITCODE -ne 0) { throw 'Plugin installation reported an error. Inspect plugin list before retrying; registration may already have taken effect.' }
& $codexCommand.Source plugin list --marketplace 'conversation-canvas-local' --json
if ($LASTEXITCODE -ne 0) { throw 'Cannot verify plugin installation.' }
Write-Output 'CLI steps completed. Fully reopen Codex to reload its host, then inspect Explore (or More) and pin the entry if available.'
Write-Output 'Sidebar visibility must be verified in the actual Codex UI. This installer does not modify the client or its sidebar cache.'
