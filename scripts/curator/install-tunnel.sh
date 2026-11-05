#!/usr/bin/env bash
# Installs and starts the curator tunnel as the owner's user unit on this host (ADR-0038 §1).
set -euo pipefail
unit=purplemux-curator-tunnel.service
src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$unit"
dest="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$unit"
mkdir -p "$(dirname "$dest")"
install -m 0644 "$src" "$dest"
systemctl --user daemon-reload
systemctl --user enable "$unit"
# restart, not start: a reinstall over a running tunnel must load the new unit text.
systemctl --user restart "$unit"
systemctl --user --no-pager status "$unit" | head -5 || true
echo "undo: systemctl --user disable --now $unit && rm -f $dest && systemctl --user daemon-reload"
