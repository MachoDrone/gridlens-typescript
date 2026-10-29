#!/usr/bin/env bash
# Rendered with the tested release's exact binary checksum by build-coordinator.ts.
set -euo pipefail
umask 077
release_tag='@RELEASE_TAG@'
coordinator_name='@COORDINATOR_NAME@'
coordinator_sha256='@COORDINATOR_SHA256@'
case "$release_tag" in @*) printf '%s\n' 'This modern installer source is an unpublished candidate. Use a reviewed, signed release launcher.' >&2; exit 1;; esac
if [[ ! -r /dev/tty || ! -w /dev/tty ]]; then
  printf '%s\n' 'GridLens setup needs a controlling terminal. Open a terminal and run the command again.' >&2
  exit 1
fi
for required in docker curl sha256sum mktemp uname; do
  command -v "$required" >/dev/null || { printf 'GridLens needs existing %s; setup installs no host packages.\n' "$required" >&2; exit 1; }
done
[[ "$(uname -s)" == Linux ]] || { printf '%s\n' 'This coordinator supports Linux only.' >&2; exit 1; }
case "$(uname -m):$coordinator_name" in
  x86_64:*-linux-x64|aarch64:*-linux-arm64) ;;
  *) printf '%s\n' 'Choose the signed launcher for this CPU architecture.' >&2; exit 1;;
esac
workdir=$(mktemp -d)
trap 'rm -rf -- "$workdir"' EXIT
curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location --max-time 300 \
  "https://github.com/MachoDrone/gridlens-typescript/releases/download/$release_tag/$coordinator_name" -o "$workdir/coordinator"
printf '%s  %s\n' "$coordinator_sha256" "$workdir/coordinator" | sha256sum --check --status || { printf '%s\n' 'Coordinator checksum verification failed.' >&2; exit 1; }
chmod 700 "$workdir/coordinator"
"$workdir/coordinator" --release "https://github.com/MachoDrone/gridlens-typescript/releases/download/$release_tag/" "$@" </dev/tty
