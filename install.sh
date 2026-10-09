#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  codex-workbuddy-bridge installer
#
#  Lets the OpenAI Codex CLI talk to an OpenAI-compatible gateway that only
#  exposes POST /v1/chat/completions (e.g. workbuddy2api), because Codex
#  >= 0.14x speaks nothing but the Responses API.
#
#  What it does:
#    1. installs a dependency-free Node bridge into ~/.local/share/codex-workbuddy-bridge
#    2. starts it as a service (launchd on macOS, systemd --user on Linux)
#    3. builds ~/.codex/workbuddy-model-catalog.json from the gateway's /v1/models
#    4. points ~/.codex/config.toml at the bridge (with a timestamped backup)
#    5. runs one real 'codex exec' to prove the round trip works
#
#  Usage: ./install.sh [options]        (see --help)
# ---------------------------------------------------------------------------
set -euo pipefail

VERSION="1.0.0"
DEFAULT_BASE_URL="http://100.104.227.113:7863/v1"
DEFAULT_PORT="8799"
DEFAULT_MODEL="cn:deepseek-v4.1-flash"
REPO_SLUG="${REPO_SLUG:-gchan2/codex-workbuddy-bridge}"
REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/$REPO_SLUG/main}"

BASE_URL=""
PORT=""
MODEL=""
API_KEY=""
API_KEY_FILE=""
CODEX_HOME_DIR=""
BRIDGE_DIR="${BRIDGE_DIR:-$HOME/.local/share/codex-workbuddy-bridge}"
LABEL="com.${USER:-user}.codex-workbuddy-bridge"
SERVICE="auto"
DO_CATALOG=1
DO_VERIFY=1
DRY_RUN=0

step() { echo; echo "==> $*"; }
info() { echo "    $*"; }
warn() { echo "!!  $*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
codex-workbuddy-bridge installer

  --api-key KEY        gateway API key (default: WORKBUDDY_API_KEY env, then
                       ~/.dsh/.credentials.yaml, then an interactive prompt)
  --api-key-file FILE  read the API key from a file
  --base-url URL       gateway base url (default: http://100.104.227.113:7863/v1)
  --port PORT          local bridge port (default: 8799)
  --model MODEL        model to write into config.toml (default: cn:deepseek-v4.1-flash)
  --codex-home DIR     codex home (default: $CODEX_HOME or ~/.codex)
  --bridge-dir DIR     where the bridge is installed (default: ~/.local/share/codex-workbuddy-bridge)
  --label LABEL        launchd label (default: com.$USER.codex-workbuddy-bridge)
  --no-service         do not install a service; write start.sh instead
  --launchd            force launchd (macOS)
  --systemd            force systemd --user (Linux)
  --no-catalog         do not (re)generate the codex model catalog
  --no-verify          skip the final 'codex exec' smoke test
  --dry-run            print what would change, write nothing
  -h, --help           this text
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --api-key)       API_KEY="${2:-}"; shift 2 ;;
    --api-key-file)  API_KEY_FILE="${2:-}"; shift 2 ;;
    --base-url)      BASE_URL="${2:-}"; shift 2 ;;
    --port)          PORT="${2:-}"; shift 2 ;;
    --model)         MODEL="${2:-}"; shift 2 ;;
    --codex-home)    CODEX_HOME_DIR="${2:-}"; shift 2 ;;
    --bridge-dir)    BRIDGE_DIR="${2:-}"; shift 2 ;;
    --label)         LABEL="${2:-}"; shift 2 ;;
    --no-service)    SERVICE="none"; shift ;;
    --launchd)       SERVICE="launchd"; shift ;;
    --systemd)       SERVICE="systemd"; shift ;;
    --no-catalog)    DO_CATALOG=0; shift ;;
    --no-verify)     DO_VERIFY=0; shift ;;
    --dry-run)       DRY_RUN=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *)               die "unknown option: $1 (try --help)" ;;
  esac
done

BASE_URL="${BASE_URL:-$DEFAULT_BASE_URL}"
PORT="${PORT:-$DEFAULT_PORT}"
MODEL="${MODEL:-$DEFAULT_MODEL}"
CODEX_HOME_DIR="${CODEX_HOME_DIR:-${CODEX_HOME:-$HOME/.codex}}"

case "$(uname -s)" in
  Darwin) PLATFORM=macos ;;
  Linux)  PLATFORM=linux ;;
  *)      PLATFORM=other ;;
esac
if [ "$SERVICE" = "auto" ]; then
  if [ "$PLATFORM" = "macos" ]; then
    SERVICE=launchd
  elif [ "$PLATFORM" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
    SERVICE=systemd
  else
    SERVICE=none
  fi
fi
if [ "$SERVICE" = "launchd" ] && [ "$PLATFORM" != "macos" ]; then die "--launchd only works on macOS"; fi
if [ "$SERVICE" = "systemd" ] && [ "$PLATFORM" != "linux" ]; then die "--systemd only works on Linux"; fi

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "node >= 18 not found in PATH (install Node.js 20 LTS)"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then die "node >= 18 required (found $("$NODE_BIN" -v))"; fi
CODEX_BIN="$(command -v codex || true)"
if [ -z "$CODEX_BIN" ]; then warn "codex CLI not found in PATH; install it with: npm install -g @openai/codex"; fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"

resolve_key() {
  if [ -n "$API_KEY" ]; then info "api key: --api-key"; return 0; fi
  if [ -n "$API_KEY_FILE" ]; then
    [ -f "$API_KEY_FILE" ] || die "api key file not found: $API_KEY_FILE"
    API_KEY="$(tr -d '[:space:]' < "$API_KEY_FILE")"
    info "api key: $API_KEY_FILE"
    return 0
  fi
  if [ -n "${WORKBUDDY_API_KEY:-}" ]; then
    API_KEY="$WORKBUDDY_API_KEY"
    info "api key: WORKBUDDY_API_KEY environment variable"
    return 0
  fi
  local cred="$HOME/.dsh/.credentials.yaml"
  if [ -f "$cred" ]; then
    API_KEY="$(awk '/^[[:space:]]*WORKBUDDY_API_KEY:/{print $2; exit}' "$cred" | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
    if [ -n "$API_KEY" ]; then info "api key: $cred"; return 0; fi
  fi
  if [ -t 0 ]; then
    printf 'WorkBuddy API key: '
    read -r -s API_KEY
    echo
    if [ -n "$API_KEY" ]; then info "api key: interactive prompt"; return 0; fi
  fi
  die "no API key. Use --api-key, --api-key-file, WORKBUDDY_API_KEY, or ~/.dsh/.credentials.yaml"
}

fetch_asset() {  # fetch_asset <repo-relative-path> <destination>
  local rel="$1" dest="$2"
  if [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/$rel" ]; then
    cp "$SRC_DIR/$rel" "$dest"
    return 0
  fi
  command -v curl >/dev/null 2>&1 || die "curl is required when the installer runs outside a checkout"
  info "downloading $rel"
  curl -fsSL "$REPO_RAW/$rel" -o "$dest" || die "failed to download $rel from $REPO_RAW"
}

port_busy() {  # exits 0 when something already listens on 127.0.0.1:$1
  "$NODE_BIN" -e 'const net=require("net");const s=net.createServer();s.once("error",()=>process.exit(0));s.once("listening",()=>{s.close();process.exit(1);});s.listen(Number(process.argv[1]),"127.0.0.1");' "$1"
}

bridge_health() {  # prints the /health body, empty when nothing answers
  curl -fsS --max-time 3 "http://127.0.0.1:$1/health" 2>/dev/null || true
}

install_launchd() {
  local plist="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  sed -e "s|__LABEL__|$LABEL|g" -e "s|__NODE__|$NODE_BIN|g" -e "s|__SERVER__|$BRIDGE_DIR/server.mjs|g" -e "s|__PORT__|$PORT|g" -e "s|__BASE_URL__|$BASE_URL|g" -e "s|__API_KEY__|$API_KEY|g" -e "s|__LOG_DIR__|$BRIDGE_DIR|g" "$TMP_DIR/plist.template" > "$plist"
  chmod 600 "$plist"
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  info "launchd: $plist (chmod 600, RunAtLoad + KeepAlive)"
}

install_systemd() {
  local unit_dir="$HOME/.config/systemd/user"
  local unit="$unit_dir/codex-workbuddy-bridge.service"
  mkdir -p "$unit_dir"
  cat > "$BRIDGE_DIR/bridge.env" <<ENVFILE
WORKBUDDY_BASE_URL=$BASE_URL
WORKBUDDY_API_KEY=$API_KEY
BRIDGE_PORT=$PORT
NO_PROXY=127.0.0.1,localhost,::1
ENVFILE
  chmod 600 "$BRIDGE_DIR/bridge.env"
  sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__SERVER__|$BRIDGE_DIR/server.mjs|g" -e "s|__BRIDGE_DIR__|$BRIDGE_DIR|g" "$TMP_DIR/systemd.template" > "$unit"
  chmod 600 "$unit"
  systemctl --user daemon-reload
  systemctl --user enable --now codex-workbuddy-bridge.service
  info "systemd: $unit (enable --now)"
  info "hint: run 'loginctl enable-linger $USER' if the bridge should survive logout"
}

install_foreground() {
  cat > "$BRIDGE_DIR/start.sh" <<START
#!/usr/bin/env bash
export WORKBUDDY_BASE_URL="$BASE_URL"
export WORKBUDDY_API_KEY="$API_KEY"
export BRIDGE_PORT="$PORT"
exec "$NODE_BIN" "$BRIDGE_DIR/server.mjs"
START
  chmod 700 "$BRIDGE_DIR/start.sh"
  info "no service installed; start it with: $BRIDGE_DIR/start.sh"
}

step "codex-workbuddy-bridge installer v$VERSION"
info "platform     : $PLATFORM ($SERVICE)"
info "gateway      : $BASE_URL"
info "bridge       : 127.0.0.1:$PORT -> $BRIDGE_DIR/server.mjs"
info "codex home   : $CODEX_HOME_DIR"
info "model        : $MODEL"
if [ "$DRY_RUN" = 1 ]; then info "mode         : dry run (nothing is written)"; fi

resolve_key

if [ "$SERVICE" != "none" ]; then
  case "$API_KEY" in
    *[!A-Za-z0-9._:-]*) die "the API key contains characters that cannot be embedded in a plist unit; rerun with --no-service or use a different key" ;;
  esac
fi

HEALTH="$(bridge_health "$PORT")"
if [ -n "$HEALTH" ]; then
  info "an existing bridge already answers on 127.0.0.1:$PORT"
elif port_busy "$PORT"; then
  die "port $PORT is already in use by another program; rerun with --port <free port>"
fi

step "checking the gateway"
if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 5 -H "Authorization: Bearer $API_KEY" "$BASE_URL/models" -o /dev/null; then
    info "GET $BASE_URL/models -> ok"
  else
    warn "GET $BASE_URL/models failed; continuing anyway"
  fi
fi

if [ "$DRY_RUN" = 1 ]; then
  TMP_DIR="$(mktemp -d)"
  LIB_DIR="$SRC_DIR/lib"
  if [ -z "$SRC_DIR" ] || [ ! -f "$LIB_DIR/merge_config.mjs" ]; then die "--dry-run needs a local checkout ($LIB_DIR)"; fi
else
  step "installing bridge files into $BRIDGE_DIR"
  mkdir -p "$BRIDGE_DIR/lib"
  fetch_asset "bridge/server.mjs" "$BRIDGE_DIR/server.mjs"
  chmod 644 "$BRIDGE_DIR/server.mjs"
  fetch_asset "lib/gen_catalog.mjs" "$BRIDGE_DIR/lib/gen_catalog.mjs"
  fetch_asset "lib/merge_config.mjs" "$BRIDGE_DIR/lib/merge_config.mjs"
  chmod 644 "$BRIDGE_DIR/lib/gen_catalog.mjs" "$BRIDGE_DIR/lib/merge_config.mjs"
  TMP_DIR="$(mktemp -d)"
  fetch_asset "templates/com.codex-workbuddy-bridge.plist.template" "$TMP_DIR/plist.template"
  fetch_asset "templates/codex-workbuddy-bridge.service.template" "$TMP_DIR/systemd.template"
  LIB_DIR="$BRIDGE_DIR/lib"
fi

CATALOG="$CODEX_HOME_DIR/workbuddy-model-catalog.json"
CATALOG_ARG=""
if [ "$DO_CATALOG" = 1 ] && [ "$DRY_RUN" = 0 ]; then
  step "generating the codex model catalog"
  if "$NODE_BIN" "$LIB_DIR/gen_catalog.mjs" --base-url "$BASE_URL" --api-key "$API_KEY" --out "$CATALOG"; then
    CATALOG_ARG="$CATALOG"
  else
    warn "catalog generation failed; codex will use fallback model metadata for $MODEL"
  fi
elif [ "$DO_CATALOG" = 1 ]; then
  CATALOG_ARG="$CODEX_HOME_DIR/workbuddy-model-catalog.json"
fi

step "updating $CODEX_HOME_DIR/config.toml"
MERGE_ARGS=(--config "$CODEX_HOME_DIR/config.toml" --base-url "http://127.0.0.1:$PORT/v1" --key "$API_KEY" --model "$MODEL")
if [ -n "$CATALOG_ARG" ]; then MERGE_ARGS+=(--catalog "$CATALOG_ARG"); fi
if [ "$DRY_RUN" = 1 ]; then MERGE_ARGS+=(--dry-run); fi
"$NODE_BIN" "$LIB_DIR/merge_config.mjs" "${MERGE_ARGS[@]}"

if [ "$DRY_RUN" = 1 ]; then
  step "dry run finished; nothing was written"
  exit 0
fi

step "starting the service"
case "$SERVICE" in
  launchd) install_launchd ;;
  systemd) install_systemd ;;
  *)       install_foreground ;;
esac

step "verifying"
HEALTH=""
if [ "$SERVICE" = "none" ]; then
  # nothing was started for us; only report whether a bridge is already up
  HEALTH="$(bridge_health "$PORT")"
  if [ -n "$HEALTH" ]; then
    info "bridge health: $HEALTH"
  else
    info "no service installed - start the bridge with $BRIDGE_DIR/start.sh"
  fi
else
  i=0
  while [ $i -lt 20 ]; do
    HEALTH="$(bridge_health "$PORT")"
    if [ -n "$HEALTH" ]; then break; fi
    i=$((i + 1))
    sleep 1
  done
  if [ -n "$HEALTH" ]; then
    info "bridge health: $HEALTH"
  else
    warn "no answer on http://127.0.0.1:$PORT/health yet; check the log files"
  fi
fi

if [ "$DO_VERIFY" = 1 ] && [ -n "$CODEX_BIN" ] && [ -n "$HEALTH" ]; then
  step "smoke test: one real codex request through the bridge"
  TEST_CMD=("$CODEX_BIN" exec --skip-git-repo-check "Reply with exactly: BRIDGE-OK")
  if command -v timeout >/dev/null 2>&1; then TEST_CMD=(timeout 180 "${TEST_CMD[@]}"); fi
  OUT="$(cd "$HOME" && CODEX_HOME="$CODEX_HOME_DIR" "${TEST_CMD[@]}" 2>&1)" || true
  if echo "$OUT" | grep -q "BRIDGE-OK"; then
    info "codex answered through the bridge - installation works"
  else
    warn "codex did not print BRIDGE-OK; last lines of its output:"
    echo "$OUT" | tail -20
  fi
fi

step "done"
cat <<SUMMARY
    bridge file : $BRIDGE_DIR/server.mjs
    endpoint    : http://127.0.0.1:$PORT/v1   (upstream: $BASE_URL)
    codex home  : $CODEX_HOME_DIR/config.toml  (backup: config.toml.bak-*)
    catalog     : $CATALOG_ARG
    service     : $SERVICE
SUMMARY
case "$SERVICE" in
  launchd)
    cat <<SUMMARY
    health      : curl -s http://127.0.0.1:$PORT/health
    restart     : launchctl kickstart -k gui/$(id -u)/$LABEL
    stop        : launchctl bootout gui/$(id -u)/$LABEL
    logs        : $BRIDGE_DIR/bridge.out.log , $BRIDGE_DIR/bridge.err.log
SUMMARY
    ;;
  systemd)
    cat <<SUMMARY
    health      : curl -s http://127.0.0.1:$PORT/health
    restart     : systemctl --user restart codex-workbuddy-bridge
    stop        : systemctl --user disable --now codex-workbuddy-bridge
    logs        : journalctl --user -u codex-workbuddy-bridge -f
SUMMARY
    ;;
  *)
    cat <<SUMMARY
    start       : $BRIDGE_DIR/start.sh   (run in the foreground or under your own supervisor)
    health      : curl -s http://127.0.0.1:$PORT/health
SUMMARY
    ;;
esac
echo
echo "    now run: codex"
