#!/usr/bin/env bash
# Installs and starts the curator tunnel as the owner's user unit on this host (ADR-0038 §1).
# The unit reads the GPU host's ssh alias from $HOME/.config/purplemux/curator-tunnel.env (CURATOR_TUNNEL_HOST=<alias>).
# The installer refuses before it touches the installed unit when that file or that line is missing or invalid.
set -euo pipefail
unit=purplemux-curator-tunnel.service
src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$unit"
envfile="$HOME/.config/purplemux/curator-tunnel.env"
if [ ! -r "$envfile" ]; then
  echo "install-tunnel: $envfile is missing; write one line CURATOR_TUNNEL_HOST=<ssh alias of the GPU host>, then run again" >&2
  exit 2
fi
host="$(sed -n 's/^CURATOR_TUNNEL_HOST=//p' "$envfile" | tail -n1)"
# No default host: an unset host is a refusal, never a guess.
if [ -z "$host" ]; then
  echo "install-tunnel: CURATOR_TUNNEL_HOST is not set in $envfile; add one line CURATOR_TUNNEL_HOST=<ssh alias of the GPU host>, then run again" >&2
  exit 2
fi
# The same host-name rule as sshArgv (src/lib/remote-host.ts): a letter or digit first, never an ssh option.
if ! [[ "$host" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$ ]]; then
  echo "install-tunnel: CURATOR_TUNNEL_HOST in $envfile is not a valid ssh alias (read: $host); use letters, digits, '.', '_' or '-', starting with a letter or digit" >&2
  exit 2
fi
dest="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$unit"
mkdir -p "$(dirname "$dest")"
install -m 0644 "$src" "$dest"
systemctl --user daemon-reload
systemctl --user enable "$unit"
# restart, not start: a reinstall over a running tunnel must load the new unit text.
systemctl --user restart "$unit"
systemctl --user --no-pager status "$unit" | head -5 || true
echo "tunnel host: $host (from $envfile)"
echo "undo: systemctl --user disable --now $unit && rm -f $dest && systemctl --user daemon-reload"
