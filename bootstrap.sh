#!/bin/sh
# tasks-todo-sync — one-command bootstrap (macOS / Linux)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/simonchai-tw/tasks-todo-sync/main/bootstrap.sh | sh
#
# What it does:
#   1. checks for Node.js >= 22 with npm/npx (mirrors package.json "engines");
#   2. when something is missing, installs it via a supported route or prints
#      the exact commands — it never assumes Homebrew exists;
#   3. hands over to the guided setup (`npx tasks-todo-sync init`), so the user
#      is never dropped back at the docs.
#
# Verification status (honest, per advisory review):
#   - VERIFIED:   `sh -n` syntax check + detection/prompt logic on POSIX shells.
#   - UNVERIFIED: the macOS brew / Homebrew-install / nodejs.org paths and the
#     Linux nvm path on real devices (no Mac in hand). Needs a community smoke
#     test before being called stable — do not market this as "tested on Mac".
#
# Environment override: TTS_VERSION=0.9.5-alpha pins the package version;
# default is `latest`.

set -u

NODE_MIN_MAJOR=22
PACKAGE="tasks-todo-sync"

say() { printf '%s\n' "$*" >&2; }

# Read one line of user input even when stdin is the piped script itself.
# Returns 1 when no interactive input is available (CI / non-tty): callers
# must treat that as "print what to do and exit non-zero", never guess.
ask() {
  if [ -t 0 ]; then
    printf '%s' "$1" >&2
    IFS= read -r REPLY
  elif [ -r /dev/tty ] && { printf '%s' "$1" >/dev/tty; IFS= read -r REPLY </dev/tty; }; then
    :
  else
    return 1
  fi
}

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

have_npm() {
  command -v npm >/dev/null 2>&1 && command -v npx >/dev/null 2>&1
}

case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux) OS=linux ;;
  *)
    say "This bootstrap supports macOS and Linux only."
    say "Windows: download the TasksToDoSync Setup installer from"
    say "https://github.com/simonchai-tw/tasks-todo-sync/releases — Node.js is bundled."
    exit 1
    ;;
esac

major=$(node_major)
if [ "$major" -ge "$NODE_MIN_MAJOR" ] && have_npm; then
  say "Node.js $(node -v) with npm found. OK."
else
  if [ "$major" -eq 0 ]; then
    say "Node.js >= $NODE_MIN_MAJOR was not found."
  elif [ "$major" -lt "$NODE_MIN_MAJOR" ]; then
    say "Node.js v$major is too old (need >= $NODE_MIN_MAJOR)."
  else
    say "Node.js was found but npm/npx is missing."
  fi

  if [ "$OS" = mac ]; then
    if command -v brew >/dev/null 2>&1; then
      if ask "Install Node.js now with Homebrew (brew install node)? [y/N] "; then
        case "$REPLY" in
          y|Y|yes|YES)
            brew install node || exit 1
            ;;
          *)
            say "Cancelled. Install Node.js >= $NODE_MIN_MAJOR yourself, then re-run this script."
            exit 1
            ;;
        esac
      else
        say "No interactive input available. Run: brew install node"
        exit 1
      fi
    else
      say ""
      say "Homebrew was not found. Options:"
      say "  [1] Install Homebrew first (official installer; asks for your password), then Node.js"
      say "  [2] Download the official Node.js installer from https://nodejs.org/ and run it yourself"
      if ask "Choose [1/2]: "; then
        case "$REPLY" in
          1)
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || exit 1
            # brew lands in different prefixes on Apple Silicon vs Intel; make
            # sure this shell can see it before installing node.
            if [ -x /opt/homebrew/bin/brew ]; then
              eval "$(/opt/homebrew/bin/brew shellenv)"
            elif [ -x /usr/local/bin/brew ]; then
              eval "$(/usr/local/bin/brew shellenv)"
            fi
            brew install node || exit 1
            ;;
          2)
            open "https://nodejs.org/" 2>/dev/null || say "Open https://nodejs.org/ in a browser and install the LTS package."
            say "After installing Node.js, re-run this bootstrap command."
            exit 0
            ;;
          *)
            say "Cancelled."
            exit 1
            ;;
        esac
      else
        say "No interactive input available. Do one of:"
        say '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" && brew install node'
        say "  or install Node.js from https://nodejs.org/ then re-run this script."
        exit 1
      fi
    fi
  else
    say ""
    say "Options:"
    say "  [1] Install Node.js via nvm (user-space, no sudo)"
    say "  [2] Show the package-manager command for this distro"
    if ask "Choose [1/2]: "; then
      case "$REPLY" in
        1)
          # Pinned nvm release for reproducibility.
          curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash || exit 1
          export NVM_DIR="$HOME/.nvm"
          # shellcheck disable=SC1091
          [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
          nvm install "$NODE_MIN_MAJOR" || exit 1
          ;;
        2)
          if command -v apt-get >/dev/null 2>&1; then
            say "  curl -fsSL https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x | sudo -E bash - && sudo apt-get install -y nodejs"
          elif command -v dnf >/dev/null 2>&1; then
            say "  sudo dnf install -y nodejs npm"
          elif command -v pacman >/dev/null 2>&1; then
            say "  sudo pacman -S nodejs npm"
          else
            say "  Install Node.js >= $NODE_MIN_MAJOR with your distro's package manager or from https://nodejs.org/"
          fi
          say "Then re-run this bootstrap command."
          exit 0
          ;;
        *)
          say "Cancelled."
          exit 1
          ;;
      esac
    else
      say "No interactive input available. Install Node.js >= $NODE_MIN_MAJOR (e.g. via nvm), then re-run."
      exit 1
    fi
  fi

  # Re-check after installation. A fresh install may only be visible in a new
  # shell session; say so instead of pushing on with a broken environment.
  major=$(node_major)
  if [ "$major" -lt "$NODE_MIN_MAJOR" ] || ! have_npm; then
    say "Node.js >= $NODE_MIN_MAJOR with npm is still not available in this shell."
    say "Open a new terminal and re-run this bootstrap command."
    exit 1
  fi
fi

say ""
say "Environment ready (node $(node -v)). Starting the guided setup..."
exec npx -y "${PACKAGE}@${TTS_VERSION:-latest}" init "$@"
