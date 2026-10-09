#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  codex-workbuddy-bridge uninstaller
#
#  Default: stop and remove the service, leave files and config.toml alone.
#  --restore-config : put the newest config.toml backup back in place
#  --purge          : also delete the bridge directory and the generated catalog
# ---------------------------------------------------------------------------
set -euo pipefail

BRIDGE_DIR="${BRIDGE_DIR:-$HOME/.local/share/codex-workbuddy-bridge}"
LABEL="com.${USER:-user}.codex-workbuddy-bridge"
CODEX_HOME_DIR=""
RESTORE=0
PURGE=0

step() { echo; echo "==> $*"; }
info() { echo "    $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --codex-home)    CODEX_HOME_DIR="${2:-}"; shift 2 ;;
    --bridge-dir)    BRIDGE_DIR="${2:-}"; shift 2 ;;
    --label)         LABEL="${2:-}"; shift 2 ;;
    --restore-config) RESTORE=1; shift ;;
    --purge)         PURGE=1; shift ;;
    -h|--help)
      echo "usage: uninstall.sh [--codex-home DIR] [--bridge-dir DIR] [--label LABEL] [--restore-config] [--purge]"
      exit 0
      ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
CODEX_HOME_DIR="${CODEX_HOME_DIR:-${CODEX_HOME:-$HOME/.codex}}"

step "stopping the service"
# NOTE: launchd/systemd jobs live in the *account's* service namespace, not under
# BRIDGE_DIR, so only touch them when this installation's own unit file is present
# under $HOME. Without this guard a sandboxed run (e.g. HOME=/tmp/x) would boot out
# the real user's bridge because the default label is derived from $USER.
case "$(uname -s)" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    if [ -f "$PLIST" ]; then
      if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
        launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
        info "launchd job $LABEL booted out"
      else
        info "launchd job $LABEL is not loaded"
      fi
      rm -f "$PLIST"
      info "removed $PLIST"
    else
      info "no launchd job for this installation ($PLIST not found) - leaving launchd alone"
    fi
    ;;
  Linux)
    UNIT="$HOME/.config/systemd/user/codex-workbuddy-bridge.service"
    if command -v systemctl >/dev/null 2>&1 && [ -f "$UNIT" ]; then
      systemctl --user disable --now codex-workbuddy-bridge.service >/dev/null 2>&1 || true
      rm -f "$UNIT"
      systemctl --user daemon-reload >/dev/null 2>&1 || true
      info "removed the systemd --user unit"
    else
      info "no systemd --user unit for this installation - leaving systemd alone"
    fi
    ;;
  *)
    info "nothing to stop on this platform"
    ;;
esac

if [ -n "$(pgrep -f "$BRIDGE_DIR/server.mjs" || true)" ]; then
  pkill -f "$BRIDGE_DIR/server.mjs" >/dev/null 2>&1 || true
  info "stopped a bridge process that was started by hand"
fi

if [ "$RESTORE" = 1 ]; then
  step "restoring config.toml"
  NEWEST="$(ls -1t "$CODEX_HOME_DIR"/config.toml.bak-* 2>/dev/null | head -1 || true)"
  if [ -n "$NEWEST" ]; then
    cp "$NEWEST" "$CODEX_HOME_DIR/config.toml"
    chmod 600 "$CODEX_HOME_DIR/config.toml"
    info "restored $NEWEST -> $CODEX_HOME_DIR/config.toml"
  else
    warn "no config.toml backup found in $CODEX_HOME_DIR"
    if grep -q "workbuddy (gateway via local Responses/chat bridge)" "$CODEX_HOME_DIR/config.toml" 2>/dev/null; then
      warn "config.toml still points at this bridge; edit or delete $CODEX_HOME_DIR/config.toml by hand"
    fi
  fi
fi

if [ "$PURGE" = 1 ]; then
  step "purging files"
  rm -rf "$BRIDGE_DIR"
  info "removed $BRIDGE_DIR"
  rm -f "$CODEX_HOME_DIR/workbuddy-model-catalog.json"
  info "removed $CODEX_HOME_DIR/workbuddy-model-catalog.json"
fi

step "done"
if [ "$RESTORE" = 0 ]; then
  echo "    $CODEX_HOME_DIR/config.toml still points at the bridge."
  echo "    restore the previous provider with: $0 --codex-home $CODEX_HOME_DIR --restore-config"
fi
if [ "$PURGE" = 0 ]; then
  echo "    bridge files kept in $BRIDGE_DIR (remove with --purge)"
fi
