#!/bin/sh
# Bubble installer — macOS / Linux.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/DylanDDeng/bubble/main/install.sh | sh
#
# Ensures Node.js 20+ (launcher) and Bun (runtime) are present, then installs
# the `bubble` CLI globally via npm.
set -e

PACKAGE="@bubblebrain-ai/bubble"
REQUIRED_NODE_MAJOR=20

info() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32mOK \033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31mERR \033[0m %s\n' "$*" >&2; }

OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) : ;;
  *) err "Unsupported OS: $OS (this installer supports macOS and Linux)."; exit 1 ;;
esac

info "Bubble installer ($OS)"

# --- Node.js (needed for the launcher + npm) ---
if ! command -v node >/dev/null 2>&1; then
  err "Node.js is not installed."
  err "Bubble needs Node.js $REQUIRED_NODE_MAJOR+ (launcher) and Bun (runtime)."
  err "Install Node.js first: https://nodejs.org"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ] 2>/dev/null; then
  err "Node.js $NODE_MAJOR is too old; Bubble needs $REQUIRED_NODE_MAJOR+."
  err "Upgrade Node.js: https://nodejs.org"
  exit 1
fi
ok "Node.js $(node -v)"

# --- Bun (needed to run the agent) ---
if command -v bun >/dev/null 2>&1; then
  ok "Bun $(bun --version)"
else
  info "Bun not found — installing it now..."
  curl -fsSL https://bun.sh/install | bash
  # bun.sh/install puts bun in ~/.bun/bin and edits the shell rc; make it
  # visible in *this* session too.
  export PATH="$HOME/.bun/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    err "Bun was installed but is not on PATH."
    err "Add $HOME/.bun/bin to your PATH and re-run this installer."
    exit 1
  fi
  ok "Bun $(bun --version)"
fi

# --- Install the bubble CLI ---
info "Installing $PACKAGE globally via npm..."
npm install -g "$PACKAGE"

# --- Verify it landed on PATH ---
if command -v bubble >/dev/null 2>&1; then
  ok "Done! Run \`bubble\` inside any project directory to start."
else
  npm_prefix="$(npm config get prefix 2>/dev/null || echo "$HOME/.npm-global")"
  warn "Installed, but \`bubble\` is not on your PATH yet."
  warn "Add this directory to your PATH, then run \`bubble\`:"
  warn "  $npm_prefix/bin"
fi
