/**
 * Creates the file "$1", with stdin as its text, only when nothing is at the path: the exclusive create of a
 * platform whose file calls have none (Claude Code's `$.fs`). It makes the folders above the file first.
 *
 * With noclobber (`set -C`), `>` opens a file that is not there with O_CREAT | O_EXCL in bash, dash, and zsh, so
 * the check and the create are one step: of 2 scripts at once, 1 creates the file and the other finds it there.
 * `mkdir` would be atomic too, but it makes a folder, and the Node.js host's create makes a file at the same path:
 * both hosts must take the same lock. The script exits 0 when it wrote the file, 3 when something was at the path,
 * and 1 with the shell's message otherwise. A create that failed for a path that is gone again (its holder removed
 * it at that moment) is tried once more. core/lock.spec.ts runs it with the system's `sh`.
 */
export const CREATE_SCRIPT = `mkdir -p -- "$(dirname -- "$1")" || exit 1
set -C
{ cat > "$1"; } 2>/dev/null && exit 0
[ -e "$1" ] && exit 3
cat > "$1" && exit 0
[ -e "$1" ] && exit 3
exit 1`
