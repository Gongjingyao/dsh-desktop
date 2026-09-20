# Install the agent-role plugin into a dsh home (idempotent; safe to re-run).
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI unless the file
# carries a UTF-8 BOM, and a BOM-less UTF-8 script with non-ASCII text fails to parse.
# The Chinese notes for this script live in the plugin README instead.
#
# It does two things:
#   1. make the package resolvable by the name `agent-role`;
#   2. insert the plugin row into the user-level patch layer ~/.dsh/cordis.patch.yml.
#
# The row `name` MUST equal the plugin package.json `name`: dsh-client-modules
# compares the loader specifier against the nearest manifest name and silently
# skips the browser half on a mismatch (see the plugin README).

[CmdletBinding()]
param(
    [string]$DshHome = '',
    [string]$PluginDir = ''
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# Windows PowerShell 5.1 may not have $PSScriptRoot during parameter binding.
if ($DshHome -eq '') { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
if ($PluginDir -eq '') {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $PluginDir = Join-Path $scriptDir '..\plugins\dsh-plugin-agent-role'
}

function Write-Step([string]$Message) { Write-Host "==> $Message" }
function Write-Done([string]$Message) { Write-Host "    $Message" }

$plugin = (Resolve-Path -LiteralPath $PluginDir).Path
$profileRoot = Join-Path $DshHome 'profiles'
# The loader row's `name` MUST equal the plugin package name (client-modules matches
# them, and silently drops the browser half on a mismatch).
$rowName = 'agent-role'
# The row's `id` is what the Settings > Plugins list shows as the entry identity, so it
# is deliberately Chinese. Spelled as code points because Windows PowerShell 5.1 reads a
# BOM-less .ps1 as ANSI, and a literal would be written to the patch file as mojibake.
$rowId = -join ([char]0x4F1A, [char]0x8BDD, [char]0x89D2, [char]0x8272)

if (-not (Test-Path -LiteralPath (Join-Path $plugin 'package.json'))) {
    throw "No package.json in plugin directory: $plugin"
}

$profiles = @(Get-ChildItem -LiteralPath $profileRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne 'node_modules' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'cordis.yml')) })

if ($profiles.Count -eq 0) {
    throw "No dsh profile found under $profileRoot - start the desktop app or the dsh CLI once to initialize it"
}

$spec = 'file:' + ($plugin -replace '\\', '/')

# 0. The plugin is linked into the profile, so Node dereferences to this real path and
#    resolves the plugin's OWN dependencies against the workspace, not the profile.
#    Give the plugin a local node_modules link for each declared dependency, sourced
#    from the installation's dependency closure.
$pluginManifest = Get-Content -LiteralPath (Join-Path $plugin 'package.json') -Raw | ConvertFrom-Json
$sharedModules = Join-Path $profileRoot 'node_modules'
if ($null -ne $pluginManifest.dependencies) {
    foreach ($property in $pluginManifest.dependencies.PSObject.Properties) {
        $dep = $property.Name
        $target = Join-Path $sharedModules ($dep -replace '/', '\')
        if (-not (Test-Path -LiteralPath $target)) {
            Write-Host "    warn: dependency $dep not found in $sharedModules; skipping its link"
            continue
        }
        $depLink = Join-Path $plugin (Join-Path 'node_modules' ($dep -replace '/', '\'))
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $depLink) | Out-Null
        $current = Get-Item -LiteralPath $depLink -ErrorAction SilentlyContinue
        if ($null -ne $current) {
            $targets = @()
            if ($null -ne $current.Target) { $targets = @($current.Target) }
            if ($targets -contains $target) {
                Write-Done "plugin dep $dep already linked"
                continue
            }
            cmd /c rmdir "$depLink" | Out-Null
        }
        cmd /c mklink /J "$depLink" "$target" | Out-Null
        Write-Step "linked plugin dependency $dep -> $target"
    }
}

foreach ($profile in $profiles) {
    # 1. Declare the dependency in the profile manifest.
    $manifestPath = Join-Path $profile.FullName 'package.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $existing = $null
    if ($null -ne $manifest.dependencies) { $existing = $manifest.dependencies.$rowName }
    if ($existing -ne $spec) {
        $dependencies = [ordered]@{}
        if ($null -ne $manifest.dependencies) {
            foreach ($property in $manifest.dependencies.PSObject.Properties) {
                $dependencies[$property.Name] = $property.Value
            }
        }
        $dependencies[$rowName] = $spec
        if ($null -eq $manifest.dependencies) {
            $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]$dependencies)
        }
        else {
            $manifest.dependencies = [pscustomobject]$dependencies
        }
        $json = $manifest | ConvertTo-Json -Depth 20
        [System.IO.File]::WriteAllText($manifestPath, $json + "`n", $utf8NoBom)
        Write-Step "$($profile.Name): declared $rowName = $spec in package.json"
    }
    else {
        Write-Done "$($profile.Name): package.json already declares it"
    }

    # 2. Project the package into the profile's node_modules (what npm would link).
    $modules = Join-Path $profile.FullName 'node_modules'
    if (-not (Test-Path -LiteralPath $modules)) { New-Item -ItemType Directory -Path $modules | Out-Null }
    $link = Join-Path $modules $rowName
    $current = Get-Item -LiteralPath $link -ErrorAction SilentlyContinue
    # Windows PowerShell returns a string Target, PowerShell 7 an array; normalize.
    $targets = @()
    if ($null -ne $current -and $null -ne $current.Target) { $targets = @($current.Target) }
    $sameTarget = $false
    foreach ($candidate in $targets) { if ($candidate -eq $plugin) { $sameTarget = $true } }
    if ($null -ne $current -and $current.LinkType -eq 'Junction' -and $sameTarget) {
        Write-Done "$($profile.Name): junction already in place"
    }
    else {
        if ($null -ne $current) {
            # Only remove the link this script manages.
            cmd /c rmdir "$link" | Out-Null
        }
        cmd /c mklink /J "$link" "$plugin" | Out-Null
        Write-Step "$($profile.Name): linked $link -> $plugin"
    }
}

# 3. Insert the plugin row into the user-level patch layer.
$patchPath = Join-Path $DshHome 'cordis.patch.yml'
$patchBlock = @"
- insert:
    - id: $rowId
      name: $rowName
      config:
        defaultRole: my-default
"@

if (-not (Test-Path -LiteralPath $patchPath)) {
    [System.IO.File]::WriteAllText($patchPath, $patchBlock, $utf8NoBom)
    Write-Step "created $patchPath with the plugin row"
}
else {
    $text = Get-Content -LiteralPath $patchPath -Raw
    $hasRow = [regex]::IsMatch($text, '(?m)^\s*name:\s*' + [regex]::Escape($rowName) + '\s*$')
    if ($hasRow -and [regex]::IsMatch($text, '(?m)^\s*id:\s*' + [regex]::Escape($rowId) + '\s*$')) {
        Write-Done "$patchPath already carries the $rowName row"
    }
    elseif ($hasRow) {
        # The row exists under an older id. The id is only the display identity in the
        # Plugins list, so report it instead of rewriting someone else's patch file.
        Write-Host "    note: $patchPath already loads $rowName under a different id; that id is what the Settings > Plugins list shows"
    }
    else {
        $close = $text.LastIndexOf(']')
        if ($close -lt 0) {
            throw "$patchPath is not a patch list (no top-level ']'); append this block by hand:`n$patchBlock"
        }
        $merged = $text.Substring(0, $close).TrimEnd() + "`n" + $patchBlock + $text.Substring($close)
        [System.IO.File]::WriteAllText($patchPath, $merged, $utf8NoBom)
        Write-Step "appended the plugin row to $patchPath"
    }
}

Write-Host ''
Write-Host 'Installed. Restart the desktop app (or the dsh process), then:'
Write-Host '  - type /role in the composer to open the role picker'
Write-Host '  - the default role is the built-in "wo de chang yong jue se"'
