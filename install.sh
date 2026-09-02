#!/bin/sh
# Installs vcx with Bun. Usage:
#   curl -fsSL https://raw.githubusercontent.com/akrupa-appto/vcx/main/install.sh | sh
#
# Environment:
#   VCX_REF   Git ref to install (tag, branch, or commit). Default: latest release.
#   BUN_INSTALL  Where Bun lives or gets installed. Default: ~/.bun
set -eu

REPO="akrupa-appto/vcx"
BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"

say() { printf '%s\n' "$*"; }
fail() { say "vcx install: $*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required."

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) fail "use PowerShell on Windows: bun install --global github:$REPO" ;;
esac

# 1. Bun
if command -v bun >/dev/null 2>&1; then
  BUN="$(command -v bun)"
elif [ -x "$BUN_INSTALL/bin/bun" ]; then
  BUN="$BUN_INSTALL/bin/bun"
else
  command -v bash >/dev/null 2>&1 || fail "bash is required to install Bun."
  say "Installing Bun into $BUN_INSTALL ..."
  curl -fsSL https://bun.sh/install | BUN_INSTALL="$BUN_INSTALL" bash >/dev/null
  BUN="$BUN_INSTALL/bin/bun"
  [ -x "$BUN" ] || fail "Bun install did not produce $BUN."
fi
say "Using Bun $("$BUN" --version) at $BUN"

# 2. Vercel CLI, which vcx wraps
if ! command -v vercel >/dev/null 2>&1; then
  say "Installing Vercel CLI ..."
  "$BUN" install --global vercel >/dev/null
fi

# 3. vcx itself. The github: form avoids Bun 1.4.0's false "unsafe name" error on tarballs.
REF="${VCX_REF:-}"
if [ -z "$REF" ]; then
  REF="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$REF" ] || REF="main"
fi
say "Installing vcx ($REF) ..."
"$BUN" install --global "github:$REPO#$REF" >/dev/null

# 4. Verify
BIN_DIR="$("$BUN" pm bin --global 2>/dev/null || printf '%s' "$BUN_INSTALL/bin")"
[ -x "$BIN_DIR/vcx" ] || fail "expected $BIN_DIR/vcx after install."
say "Installed vcx $("$BIN_DIR/vcx" --version)"

if ! command -v vcx >/dev/null 2>&1; then
  say ""
  say "Add Bun's bin directory to your PATH, then open a new shell:"
  say "  export PATH=\"$BIN_DIR:\$PATH\""
fi
say ""
say "Next: vcx profile login <name>"
