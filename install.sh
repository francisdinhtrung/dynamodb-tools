#!/usr/bin/env bash
# Install / update / uninstall the `ddb` CLI and its agent skill (macOS, Linux, WSL, Git Bash).
#
#   curl -fsSL https://raw.githubusercontent.com/francisdinhtrung/dynamodb-tools/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --uninstall
#
# Options:
#   --uninstall     Remove the CLI wrapper, skill and cloned repo
#   --no-skill      Do not install the agent skill
#   --claude-skill  Also install the skill for Claude Code (~/.claude/skills)
#
# Env overrides:
#   DDB_TOOLS_DIR  where the repo is cloned       (default ~/.dynamodb-tools)
#   DDB_BIN_DIR    where the `ddb` wrapper goes   (default ~/.local/bin)
#   DDB_SKILL_DIR  Copilot personal skills dir    (default ~/.copilot/skills)
#   DDB_REPO_URL   git URL                        (default GitHub repo)
set -euo pipefail

REPO_URL="${DDB_REPO_URL:-https://github.com/francisdinhtrung/dynamodb-tools.git}"
TOOLS_DIR="${DDB_TOOLS_DIR:-$HOME/.dynamodb-tools}"
BIN_DIR="${DDB_BIN_DIR:-$HOME/.local/bin}"
SKILL_DIR="${DDB_SKILL_DIR:-$HOME/.copilot/skills}"
CLAUDE_SKILL_DIR="$HOME/.claude/skills"

UNINSTALL=0
INSTALL_SKILL=1
CLAUDE_SKILL=0
for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    --no-skill) INSTALL_SKILL=0 ;;
    --claude-skill) CLAUDE_SKILL=1 ;;
    -h|--help) sed -n '2,17p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

if [ "$UNINSTALL" = 1 ]; then
  info "Uninstalling ddb"
  rm -f "$BIN_DIR/ddb"
  rm -rf "$SKILL_DIR/dynamodb" "$CLAUDE_SKILL_DIR/dynamodb" "$TOOLS_DIR"
  info "Done. (PATH line in your shell rc, if added, is left in place; it is harmless.)"
  exit 0
fi

# --- prerequisites ---
command -v git >/dev/null || die "git is required"
command -v node >/dev/null || die "Node.js >= 22 is required (https://nodejs.org)"
command -v npm >/dev/null || die "npm is required"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js >= 22 required, found $(node -v)"

# --- clone or update ---
if [ -d "$TOOLS_DIR/.git" ]; then
  info "Updating $TOOLS_DIR"
  git -C "$TOOLS_DIR" pull --ff-only --quiet
else
  [ -e "$TOOLS_DIR" ] && die "$TOOLS_DIR exists and is not a git clone; remove it or set DDB_TOOLS_DIR"
  info "Cloning into $TOOLS_DIR"
  git clone --quiet --depth 1 "$REPO_URL" "$TOOLS_DIR"
fi

info "Installing dependencies"
(cd "$TOOLS_DIR" && npm ci --omit=dev --no-audit --no-fund --silent)

# --- wrapper on PATH (avoids `npm link`, which often needs sudo) ---
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/ddb" <<EOF
#!/bin/sh
exec node "$TOOLS_DIR/bin/ddb.js" "\$@"
EOF
chmod +x "$BIN_DIR/ddb"
info "Installed $BIN_DIR/ddb"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    case "${SHELL##*/}" in
      zsh) RC="$HOME/.zshrc" ;;
      bash) RC="$HOME/.bashrc"; [ "$(uname)" = Darwin ] && RC="$HOME/.bash_profile" ;;
      *) RC="$HOME/.profile" ;;
    esac
    LINE="export PATH=\"$BIN_DIR:\$PATH\"  # ddb (dynamodb-tools)"
    if ! grep -qF "# ddb (dynamodb-tools)" "$RC" 2>/dev/null; then
      printf '\n%s\n' "$LINE" >> "$RC"
      info "Added $BIN_DIR to PATH in $RC (open a new terminal or run: source $RC)"
    fi
    ;;
esac

# --- agent skill ---
install_skill() {
  mkdir -p "$1"
  rm -rf "$1/dynamodb"
  cp -R "$TOOLS_DIR/.github/skills/dynamodb" "$1/dynamodb"
  info "Installed agent skill to $1/dynamodb"
}
[ "$INSTALL_SKILL" = 1 ] && install_skill "$SKILL_DIR"
[ "$CLAUDE_SKILL" = 1 ] && install_skill "$CLAUDE_SKILL_DIR"

# --- smoke test ---
node "$TOOLS_DIR/bin/ddb.js" --help >/dev/null || die "ddb failed to start"

cat <<EOF

ddb installed. Try:
  ddb --help
  ddb list-tables --profile <your-profile> --region <region>

Recommended (per project or shell profile):
  export AWS_PROFILE=<read-only-profile>
  export DDB_ALLOWED_TABLES="app-dev-*"
  export DDB_REDACT="email,phone"
EOF
