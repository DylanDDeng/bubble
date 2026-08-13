# Bubble installer — Windows.
#
# Usage (PowerShell):
#   powershell -c "irm https://raw.githubusercontent.com/DylanDDeng/bubble/main/install.ps1 | iex"
#
# Ensures Node.js 20+ (launcher) and Bun (runtime) are present, then installs
# the `bubble` CLI globally via npm.
$ErrorActionPreference = "Stop"

$Package = "@bubblebrain-ai/bubble"
$RequiredNodeMajor = 20

function Info($m) { Write-Host "==>  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "OK   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "WARN $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "ERR  $m" -ForegroundColor Red }

# --- Node.js ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Err "Node.js is not installed."
    Err "Bubble needs Node.js 20+ (launcher) and Bun (runtime)."
    Err "Install Node.js first: https://nodejs.org"
    exit 1
}
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt $RequiredNodeMajor) {
    Err "Node.js $nodeMajor is too old; Bubble needs 20+."
    Err "Upgrade Node.js: https://nodejs.org"
    exit 1
}
Ok "Node.js $(node -v)"

# --- Bun ---
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Info "Bun not found - installing it now..."
    irm https://bun.sh/install.ps1 | iex
    $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
        Err "Bun was installed but is not on PATH."
        Err "Reopen your terminal and re-run this installer."
        exit 1
    }
}
Ok "Bun $(bun --version)"

# --- Install the bubble CLI ---
Info "Installing $Package globally via npm..."
npm install -g $Package

Ok "Done! Run 'bubble' inside any project directory to start."
