#!/usr/bin/env bash
# Install pfqa / run / generate as global shell functions.
#
# Usage:
#   bash scripts/install-shell-commands.sh          # auto-detects shell config
#   bash scripts/install-shell-commands.sh ~/.bashrc
#   bash scripts/install-shell-commands.sh ~/.zshrc

set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PFQA_PATH="${PROJECT_DIR}/pfqa"
GENERATE_PATH="${PROJECT_DIR}/generate"

chmod +x "${PFQA_PATH}" "${GENERATE_PATH}" 2>/dev/null || true

# ─── Detect shell config file ───────────────────────────────────────────────
if [[ $# -ge 1 ]]; then
  SHELL_RC="$1"
else
  if [[ "${SHELL:-}" == *zsh* ]]; then
    SHELL_RC="${HOME}/.zshrc"
  else
    SHELL_RC="${HOME}/.bashrc"
  fi
fi

# ─── Function block to inject ───────────────────────────────────────────────
MARKER_START="# >>> playwright-ai-framework shell commands >>>"
MARKER_END="# <<< playwright-ai-framework shell commands <<<"

BLOCK="${MARKER_START}
pfqa() {
  local DIR=\"${PROJECT_DIR}\"
  (cd \"\${DIR}\" && bash pfqa \"\$@\")
}
run() { pfqa \"\$@\"; }
generate() {
  local DIR=\"${PROJECT_DIR}\"
  (cd \"\${DIR}\" && bash generate \"\$@\")
}
export -f pfqa run generate 2>/dev/null || true
${MARKER_END}"

# ─── Remove any existing block ──────────────────────────────────────────────
if [[ -f "${SHELL_RC}" ]]; then
  TMP_FILE="$(mktemp)"
  awk "
    BEGIN { skip=0 }
    /# >>> playwright-ai-framework shell commands >>>/ { skip=1 }
    !skip { print }
    /# <<< playwright-ai-framework shell commands <<</ { skip=0 }
  " "${SHELL_RC}" > "${TMP_FILE}"
  mv "${TMP_FILE}" "${SHELL_RC}"
fi

# ─── Append fresh block ─────────────────────────────────────────────────────
printf '\n%s\n' "${BLOCK}" >> "${SHELL_RC}"

echo ""
echo "✓ Shell commands installed to ${SHELL_RC}"
echo ""
echo "  Reload your shell:"
echo "    source ${SHELL_RC}"
echo ""
echo "  Commands available after reload:"
echo "    pfqa \"run login tests\"             # natural language runner"
echo "    pfqa \"run login tests headed\"       # with browser visible"
echo "    pfqa \"analyze failures\"             # AI failure analysis"
echo "    pfqa \"heal\"                         # auto-heal failing tests"
echo "    pfqa                                # show available commands"
echo "    run  <same as pfqa>"
echo "    generate                            # generate Allure report"
echo ""
