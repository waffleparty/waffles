#!/usr/bin/env bash
#
# Writes one version into every file listed in .version-bump.json, or checks
# that those files agree.
#
# Usage:
#   scripts/bump-version.sh <version>   Write <version> into every listed field.
#   scripts/bump-version.sh --check     Print each field's version. Exit 1 if
#                                       they differ or a field is missing.
#
# .version-bump.json lists {"path", "field"} pairs. A field is a dotted path;
# a numeric segment is an array index ("plugins.0.version").
#
# semantic-release runs this with the next version (see .releaserc.json), and
# pre-commit runs it with --check.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config="${repo_root}/.version-bump.json"

usage() {
  sed -n '3,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

command -v jq >/dev/null 2>&1 || { echo "error: jq is not on PATH" >&2; exit 1; }
[[ -f "${config}" ]] || { echo "error: ${config} not found" >&2; exit 1; }

# "plugins.0.version" -> ["plugins",0,"version"], for jq getpath/setpath.
jq_path() {
  jq -cn --arg f "$1" '$f | split(".") | map(if test("^[0-9]+$") then tonumber else . end)'
}

entries() {
  jq -r '.files[] | "\(.path)\t\(.field)"' "${config}"
}

check() {
  local status=0 path field file value first=""
  while IFS=$'\t' read -r path field; do
    file="${repo_root}/${path}"
    if [[ ! -f "${file}" ]]; then
      printf '%-40s %s\n' "${path}" "MISSING FILE"
      status=1
      continue
    fi
    value="$(jq -r --argjson p "$(jq_path "${field}")" 'getpath($p) // empty' "${file}")"
    if [[ -z "${value}" ]]; then
      printf '%-40s %s\n' "${path} (${field})" "MISSING FIELD"
      status=1
      continue
    fi
    printf '%-40s %s\n' "${path} (${field})" "${value}"
    if [[ -z "${first}" ]]; then
      first="${value}"
    elif [[ "${value}" != "${first}" ]]; then
      status=1
    fi
  done < <(entries)
  if [[ ${status} -ne 0 ]]; then
    echo "error: versions differ or are missing" >&2
  fi

  # @semantic-release/git commits only the files in its "assets" list. A file
  # that is bumped but not listed would be left out of the release commit.
  local releaserc="${repo_root}/.releaserc.json" missing
  if [[ -f "${releaserc}" ]]; then
    missing="$(jq -r --slurpfile cfg "${config}" '
      ([.plugins[] | select(type == "array" and .[0] == "@semantic-release/git") | .[1].assets[]]) as $assets
      | [$cfg[0].files[].path | select(. as $p | $assets | index($p) | not)] | .[]' "${releaserc}")"
    if [[ -n "${missing}" ]]; then
      echo "error: not in the @semantic-release/git assets in .releaserc.json: ${missing//$'\n'/, }" >&2
      status=1
    fi
  fi
  return ${status}
}

bump() {
  local version="$1" path field file tmp
  if [[ ! "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
    echo "error: '${version}' is not a semantic version (no 'v' prefix)" >&2
    exit 1
  fi
  while IFS=$'\t' read -r path field; do
    file="${repo_root}/${path}"
    [[ -f "${file}" ]] || { echo "error: ${path} not found" >&2; exit 1; }
    tmp="$(mktemp)"
    jq --argjson p "$(jq_path "${field}")" --arg v "${version}" 'setpath($p; $v)' "${file}" >"${tmp}"
    # cat, not mv: keeps the file's mode (mktemp creates 0600).
    cat "${tmp}" >"${file}"
    rm -f "${tmp}"
    echo "${path} (${field}) -> ${version}"
  done < <(entries)
}

case "${1:-}" in
  --check) check ;;
  -h | --help | "") usage ;;
  -*) usage ;;
  *) bump "$1" ;;
esac
