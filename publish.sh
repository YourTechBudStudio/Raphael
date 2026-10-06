#!/usr/bin/env bash
# Publish @yourtechbudstudio/raphael to npm: check, package, verify, then publish that exact tarball.
#
# The version is the root package.json's, as it stands; this never changes it. Change it by hand
# before a release. Authentication, 2FA, and the registry are npm's own configuration.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./publish.sh [--dry-run]

Runs pnpm check and pnpm package, confirms the packaged and verified tarball matches the root
package.json version, then runs npm publish on that tarball.

Options:
  --dry-run   Do everything, but pass --dry-run to npm publish so nothing is uploaded.
  -h, --help  Show this help.
EOF
}

dry_run=false
for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run=true ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n\n' "$argument" >&2
      usage >&2
      exit 2
      ;;
  esac
done

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd -- "$repo_root"

release_helper="$repo_root/apps/cli/packaging/release.ts"

version="$(node "$release_helper" version)"
printf 'Releasing @yourtechbudstudio/raphael %s\n' "$version"

pnpm check
pnpm package

tarball="$(node "$release_helper" artifact "$version")"

publish_arguments=(publish "$tarball" --access public --ignore-scripts)
mode=publish
if [[ "$dry_run" == true ]]; then
  publish_arguments+=(--dry-run)
  mode='dry run (nothing is uploaded)'
fi

printf '\nPackage:  @yourtechbudstudio/raphael\nVersion:  %s\nArtifact: %s\nMode:     %s\n\n' \
  "$version" "$tarball" "$mode"

exec npm "${publish_arguments[@]}"
