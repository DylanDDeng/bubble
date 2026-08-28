# Bubble installer — Windows.
#
# Usage (PowerShell):
#   powershell -c "irm https://raw.githubusercontent.com/DylanDDeng/bubble/main/install.ps1 | iex"
#
# Ensures Node.js 22.19+ is present, then installs the `bubble` CLI globally
# via npm. Bubble runs on Node only; no other runtime is required.
$ErrorActionPreference = "Stop"

$Package = "@bubblebrain-ai/bubble"
$RequiredNodeMajor = 22

function Info($m) { Write-Host "==>  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "OK   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "WARN $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "ERR  $m" -ForegroundColor Red }

# --- Node.js (Bubble's only runtime) ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Err "Node.js is not installed."
    Err "Bubble needs Node.js $RequiredNodeMajor+ to run."
    Err "Install Node.js first: https://nodejs.org"
    exit 1
}
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt $RequiredNodeMajor) {
    Err "Node.js $nodeMajor is too old; Bubble needs $RequiredNodeMajor+."
    Err "Upgrade Node.js: https://nodejs.org"
    exit 1
}
Ok "Node.js $(node -v)"

# --- Install the bubble CLI ---
Info "Installing $Package globally via npm..."
npm install -g $Package

Ok "Done! Run 'bubble' inside any project directory to start."
