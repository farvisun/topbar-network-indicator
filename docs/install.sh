#!/usr/bin/env bash
# Install, update or remove Topbar Network, a GNOME Shell extension, for the current user.
#
#   Install or update:  curl -fsSL https://farvisun.github.io/topbar-network-indicator/install.sh | bash
#   Remove:             curl -fsSL https://farvisun.github.io/topbar-network-indicator/install.sh | bash -s -- --uninstall
#
# The extension is downloaded from the latest GitHub release and its SHA-256
# checksum is verified before anything is installed. No root access is needed.
set -euo pipefail

NAME="Topbar Network"
UUID="topbar-network@farvisun.mindio"
OLD_UUID="topbar-network@farvisun.local"
REPO="farvisun/topbar-network-indicator"
ZIP="$UUID.shell-extension.zip"
BASE="https://github.com/$REPO/releases/latest/download"
EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions"

bold=$'\033[1m'; green=$'\033[32m'; yellow=$'\033[33m'; red=$'\033[31m'; reset=$'\033[0m'
[ -t 1 ] || { bold=; green=; yellow=; red=; reset=; }
step() { printf '%s==>%s %s\n' "$bold" "$reset" "$*"; }
note() { printf '%s!%s %s\n' "$yellow" "$reset" "$*"; }
die() { printf '%serror:%s %s\n' "$red" "$reset" "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run this as your normal user, not with sudo."
for tool in curl sha256sum gnome-extensions gsettings python3; do
    command -v "$tool" >/dev/null 2>&1 || die "'$tool' is required but not installed."
done

# Add or remove a UUID in one of org.gnome.shell's string lists.
edit_list() { # key add|remove uuid
    local current updated
    current=$(gsettings get org.gnome.shell "$1")
    updated=$(python3 -c '
import ast, sys
raw, action, uuid = sys.argv[1:4]
items = [] if raw.startswith("@as") else ast.literal_eval(raw)
items = [i for i in items if i != uuid]
if action == "add":
    items.append(uuid)
sys.stdout.write(repr(items))
' "$current" "$2" "$3")
    [ "$updated" = "$current" ] || gsettings set org.gnome.shell "$1" "$updated"
}
enable() { edit_list disabled-extensions remove "$1"; edit_list enabled-extensions add "$1"; }
disable() { edit_list enabled-extensions remove "$1"; }

remove_extension() {
    local uuid=$1
    if [ -d "$EXT_DIR/$uuid" ] || gnome-extensions info "$uuid" >/dev/null 2>&1; then
        gnome-extensions disable "$uuid" >/dev/null 2>&1 || true
        disable "$uuid"
        gnome-extensions uninstall "$uuid" >/dev/null 2>&1 || rm -rf "${EXT_DIR:?}/$uuid"
        return 0
    fi
    return 1
}


if [ "${1:-}" = "--uninstall" ]; then
    step "Removing $NAME"
    removed=0
    remove_extension "$UUID" && removed=1
    remove_extension "$OLD_UUID" && removed=1
    :
    if [ "$removed" = 1 ]; then
        printf '%s✓%s %s was removed. Log out and back in to clear it from the top bar.\n' "$green" "$reset" "$NAME"
    else
        echo "$NAME is not installed."
    fi
    exit 0
fi

shell_version=$(gnome-shell --version 2>/dev/null | sed -n 's/[^0-9]*\([0-9]*\).*/\1/p')
if [ -n "$shell_version" ] && [ "$shell_version" != "50" ]; then
    note "$NAME is made for GNOME Shell 50; this computer has GNOME Shell $shell_version. It may not load."
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

step "Downloading the latest $NAME release"
curl -fsSL --retry 2 -o "$tmp/$ZIP" "$BASE/$ZIP" || die "Could not download $BASE/$ZIP"
curl -fsSL --retry 2 -o "$tmp/SHA256SUMS" "$BASE/SHA256SUMS" || die "Could not download the release checksums."

step "Verifying the checksum"
( cd "$tmp" && grep -E "  $ZIP\$" SHA256SUMS | sha256sum --check --status ) || die "Checksum mismatch. Nothing was installed."

was_installed=0
[ -d "$EXT_DIR/$UUID" ] && was_installed=1

if remove_extension "$OLD_UUID"; then
    step "Replaced the previous version ($OLD_UUID). Your settings are kept."
    was_installed=1
fi

step "Installing $NAME"
mkdir -p "$EXT_DIR"
gnome-extensions install --force "$tmp/$ZIP"
enable "$UUID"
gnome-extensions enable "$UUID" >/dev/null 2>&1 || true

echo
if [ "$was_installed" = 1 ]; then
    printf '%s✓%s %s is updated.\n' "$green" "$reset" "$NAME"
else
    printf '%s✓%s %s is installed and turned on.\n' "$green" "$reset" "$NAME"
fi
echo "  Log out and back in to load it. GNOME only loads extension code when you log in."
echo "  Settings: gnome-extensions prefs $UUID"
echo "  Remove:   curl -fsSL https://farvisun.github.io/topbar-network-indicator/install.sh | bash -s -- --uninstall"
