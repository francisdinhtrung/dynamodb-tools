# Install / update / uninstall the `ddb` CLI and its agent skill (Windows PowerShell 5.1+ / PowerShell 7).
#
#   irm https://raw.githubusercontent.com/francisdinhtrung/dynamodb-tools/main/install.ps1 | iex
#
# With options (download first):
#   .\install.ps1 [-Uninstall] [-NoSkill] [-ClaudeSkill]
#
# Env overrides:
#   DDB_TOOLS_DIR  where the repo is cloned      (default $HOME\.dynamodb-tools)
#   DDB_BIN_DIR    where ddb.cmd goes            (default $HOME\.dynamodb-tools-bin)
#   DDB_SKILL_DIR  Copilot personal skills dir   (default $HOME\.copilot\skills)
#   DDB_REPO_URL   git URL                       (default GitHub repo)
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$NoSkill,
    [switch]$ClaudeSkill
)

$ErrorActionPreference = 'Stop'

function Get-Setting($name, $default) {
    $v = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrEmpty($v)) { $default } else { $v }
}

$RepoUrl        = Get-Setting 'DDB_REPO_URL'  'https://github.com/francisdinhtrung/dynamodb-tools.git'
$ToolsDir       = Get-Setting 'DDB_TOOLS_DIR' (Join-Path $HOME '.dynamodb-tools')
$BinDir         = Get-Setting 'DDB_BIN_DIR'   (Join-Path $HOME '.dynamodb-tools-bin')
$SkillDir       = Get-Setting 'DDB_SKILL_DIR' (Join-Path $HOME '.copilot\skills')
$ClaudeSkillDir = Join-Path $HOME '.claude\skills'

function Info($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Die($msg)  { Write-Host "error: $msg" -ForegroundColor Red; throw $msg }

function Remove-FromUserPath($dir) {
    $p = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($p) {
        $parts = $p.Split(';') | Where-Object { $_ -and ($_.TrimEnd('\') -ne $dir.TrimEnd('\')) }
        [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
    }
}

if ($Uninstall) {
    Info 'Uninstalling ddb'
    foreach ($d in @($BinDir, (Join-Path $SkillDir 'dynamodb'), (Join-Path $ClaudeSkillDir 'dynamodb'), $ToolsDir)) {
        if (Test-Path $d) { Remove-Item -Recurse -Force $d }
    }
    Remove-FromUserPath $BinDir
    Info 'Done. Open a new terminal for PATH changes to apply.'
    return
}

# --- prerequisites ---
foreach ($cmd in 'git', 'node', 'npm') {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Die "$cmd is required (Node.js >= 22: https://nodejs.org, git: https://git-scm.com)"
    }
}
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) { Die "Node.js >= 22 required, found $(node -v)" }

# --- clone or update ---
if (Test-Path (Join-Path $ToolsDir '.git')) {
    Info "Updating $ToolsDir"
    git -C $ToolsDir pull --ff-only --quiet
    if ($LASTEXITCODE -ne 0) { Die 'git pull failed' }
} else {
    if (Test-Path $ToolsDir) { Die "$ToolsDir exists and is not a git clone; remove it or set DDB_TOOLS_DIR" }
    Info "Cloning into $ToolsDir"
    git clone --quiet --depth 1 $RepoUrl $ToolsDir
    if ($LASTEXITCODE -ne 0) { Die 'git clone failed' }
}

Info 'Installing dependencies'
Push-Location $ToolsDir
try {
    npm ci --omit=dev --no-audit --no-fund --silent
    if ($LASTEXITCODE -ne 0) { Die 'npm ci failed' }
} finally {
    Pop-Location
}

# --- ddb.cmd shim on PATH (works from PowerShell and cmd; no execution-policy issues) ---
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$entry = Join-Path $ToolsDir 'bin\ddb.js'
Set-Content -Path (Join-Path $BinDir 'ddb.cmd') -Encoding ASCII -Value "@echo off`r`nnode `"$entry`" %*"
Info "Installed $(Join-Path $BinDir 'ddb.cmd')"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$onPath = $userPath -and ($userPath.Split(';') | Where-Object { $_.TrimEnd('\') -eq $BinDir.TrimEnd('\') })
if (-not $onPath) {
    $newPath = if ($userPath) { "$userPath;$BinDir" } else { $BinDir }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Info "Added $BinDir to user PATH (new terminals will pick it up)"
}
if (-not ($env:Path.Split(';') -contains $BinDir)) { $env:Path = "$env:Path;$BinDir" }

# --- agent skill ---
function Install-Skill($target) {
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    $dest = Join-Path $target 'dynamodb'
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    Copy-Item -Recurse (Join-Path $ToolsDir '.github\skills\dynamodb') $dest
    Info "Installed agent skill to $dest"
}
if (-not $NoSkill) { Install-Skill $SkillDir }
if ($ClaudeSkill) { Install-Skill $ClaudeSkillDir }

# --- smoke test ---
node $entry --help | Out-Null
if ($LASTEXITCODE -ne 0) { Die 'ddb failed to start' }

Write-Host @"

ddb installed. Try:
  ddb --help
  ddb list-tables --profile <your-profile> --region <region>

Recommended (current session; use [Environment]::SetEnvironmentVariable(...,'User') to persist):
  `$env:AWS_PROFILE = '<read-only-profile>'
  `$env:DDB_ALLOWED_TABLES = 'app-dev-*'
  `$env:DDB_REDACT = 'email,phone'

Get one item (no JSON quoting needed):
  ddb get my-table --key pk=USER#1,sk=PROFILE
"@
