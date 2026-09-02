#!/bin/sh
# Installs vcx with Bun. Usage:
#   curl -fsSL https://raw.githubusercontent.com/akrupa-appto/vcx/main/install.sh | sh
#
# vcx lives in its own directory (default ~/.vcx) with its own lockfile, so a
# broken Bun global manifest cannot block the install. Bin links go into
# Bun's bin directory, which is already on PATH for Bun users.
#
# Environment:
#   VCX_REF          Git ref to install (tag, branch, or commit). Default: latest release.
#   VCX_INSTALL_DIR  Where vcx and its dependencies live. Default: ~/.vcx
#   BUN_INSTALL      Where Bun lives or gets installed. Default: ~/.bun
set -eu

REPO="akrupa-appto/vcx"
BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
VCX_INSTALL_DIR="${VCX_INSTALL_DIR:-$HOME/.vcx}"

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
# Bun's global bin directory, the one Bun users already have on PATH.
BIN_DIR="$(HOME="$HOME" "$BUN" pm bin --global 2>/dev/null || true)"
[ -n "$BIN_DIR" ] || BIN_DIR="$BUN_INSTALL/bin"

# 2. Resolve the vcx ref. The github: form avoids Bun 1.4.0's false
#    "unsafe name" error on remote tarballs.
REF="${VCX_REF:-}"
if [ -z "$REF" ]; then
  REF="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$REF" ] || REF="main"
fi

# 3. Install vcx and Vercel CLI into a private directory with a fresh manifest.
say "Installing vcx ($REF) into $VCX_INSTALL_DIR ..."
mkdir -p "$VCX_INSTALL_DIR"
cat > "$VCX_INSTALL_DIR/package.json" <<JSON
{
  "name": "vcx-install",
  "private": true,
  "dependencies": {
    "vcx-cli": "github:$REPO#$REF",
    "vercel": "latest"
  }
}
JSON
rm -f "$VCX_INSTALL_DIR/bun.lock" "$VCX_INSTALL_DIR/bun.lockb"
(cd "$VCX_INSTALL_DIR" && "$BUN" install --no-summary >/dev/null)

VCX_BIN="$VCX_INSTALL_DIR/node_modules/vcx-cli/dist/cli.js"
[ -f "$VCX_BIN" ] || fail "expected $VCX_BIN after install."
chmod 755 "$VCX_BIN"

# 4. Bin links. vcx always. vercel only when nothing on PATH provides it.
mkdir -p "$BIN_DIR"
ln -sf "$VCX_BIN" "$BIN_DIR/vcx"
if ! command -v vercel >/dev/null 2>&1; then
  ln -sf "$VCX_INSTALL_DIR/node_modules/vercel/dist/vc.js" "$BIN_DIR/vercel"
fi

say "Installed vcx $("$BIN_DIR/vcx" --version)"

if ! command -v vcx >/dev/null 2>&1; then
  say ""
  say "Add Bun's bin directory to your PATH, then open a new shell:"
  say "  export PATH=\"$BIN_DIR:\$PATH\""
fi
say ""
say "Next: vcx profile login <name>"
