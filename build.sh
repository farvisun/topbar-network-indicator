#!/bin/sh
set -eu
cd "$(dirname "$0")"
glib-compile-schemas --strict schemas
mkdir -p dist
gnome-extensions pack --force \
    --extra-source=network.js --extra-source=chart.js --extra-source=apps.js \
    --extra-source=history.js --extra-source=historyPage.js \
    --extra-source=connections.js --extra-source=connectionMonitor.js \
    --extra-source=connectionDialog.js --extra-source=controllerSecret.js \
    --extra-source=worldMap.js --extra-source=data --out-dir=dist .
