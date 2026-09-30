#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# This test changes installed files and runs a verified upgrade on an isolated host.
[[ "${QFLI_TERMINAL_TEST_HOST:-}" == 1 && "$EUID" == 0 && "$#" == 2 ]] || {
  printf 'Use QFLI_TERMINAL_TEST_HOST=1 as root on a disposable, installed test host: %s SOURCE_DIR BUSINESS_ENV\n' "$0" >&2
  exit 2
}
release_source=$(realpath -- "$1")
business_env=$(realpath -- "$2")
runner=qfli-runner
runner_uid=$(id -u "$runner")
runner_home=$(getent passwd "$runner" | cut -d: -f6)
installed="$runner_home/azurekiln-qfli-terminal"
runner_env="$runner_home/.config/qfli-terminal/runner.env"
as_runner() {
  runuser -u "$runner" -- env -i HOME="$runner_home" USER="$runner" LOGNAME="$runner" \
    PATH=/usr/local/bin:/usr/bin:/bin XDG_RUNTIME_DIR="/run/user/$runner_uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$runner_uid/bus" \
    DOCKER_HOST="unix:///run/user/$runner_uid/docker.sock" "$@"
}
as_runner /usr/local/bin/qfli-node "$installed/deployment/check-health.mjs"
as_runner systemctl --user is-enabled --quiet docker.service qfli-terminal.service
stage=$(mktemp -d /var/tmp/qfli-bootstrap-test.XXXXXXXX)
docs_owner=$(stat -c '%u:%g' "$installed/docs")
docs_mode=$(stat -c '%a' "$installed/docs")
marker="$installed/test/.bootstrap-upgrade-test-$$"
cleanup() {
  chown "$docs_owner" "$installed/docs"
  chmod "$docs_mode" "$installed/docs"
  rm -f -- "$marker"
  for entry in README.md docs/runtime-validation.md; do
    if [[ -f "$stage/source/$entry" ]]; then
      cat "$stage/source/$entry" | as_runner tee "$installed/$entry" >/dev/null
    fi
  done
  [[ "$stage" == /var/tmp/qfli-bootstrap-test.* ]] && rm -rf -- "$stage"
}
trap cleanup EXIT
install -m 0700 "$release_source/deployment/bootstrap.sh" "$stage/bootstrap.sh"
mkdir "$stage/source"
tar -C "$release_source" -cf - src sandbox deployment test docs package.json README.md .env.example |
  tar -C "$stage/source" -xf -
cp "$runner_env" "$stage/runner.env.before"

service_state() {
  as_runner systemctl --user show docker.service qfli-terminal.service \
    -p Id -p MainPID -p ActiveState -p UnitFileState -p ActiveEnterTimestampMonotonic
}
expect_preflight_failure() {
  local label=$1 expected=$2 before after
  before=$(service_state)
  if bash "$stage/bootstrap.sh" --source-dir "$stage/source" --business-env "$business_env" >"$stage/output.log" 2>&1; then
    printf 'FAIL expected preflight rejection: %s\n' "$label" >&2
    exit 1
  fi
  grep -Fq -- "$expected" "$stage/output.log" || { cat "$stage/output.log"; exit 1; }
  after=$(service_state)
  [[ "$before" == "$after" ]] || { printf 'FAIL preflight changed services: %s\n' "$label" >&2; exit 1; }
  cmp -s "$stage/runner.env.before" "$runner_env"
  printf 'PASS %s rejected with both services unchanged\n' "$label"
}

chown root:root "$installed/docs"
chmod 0777 "$installed/docs"
expect_preflight_failure 'writable root-owned directory' "release overwrite blocked at $installed/docs"
chown "$docs_owner" "$installed/docs"
chmod "$docs_mode" "$installed/docs"
install -m 0644 /dev/null "$marker"
expect_preflight_failure 'root-owned nested file' "release overwrite blocked at $marker"
chown "$runner_uid" "$marker"
chmod 0400 "$marker"
expect_preflight_failure 'runner-owned read-only file' "release overwrite blocked at $marker"
rm -f -- "$marker"
ln -s "$stage/source/README.md" "$marker"
expect_preflight_failure 'nested destination symlink' "release overwrite blocked at $marker"
rm -f -- "$marker"
for entry in docs test; do
  mv "$stage/source/$entry" "$stage/$entry.saved"
  expect_preflight_failure "missing $entry source" "source directory is incomplete: missing $stage/source/$entry"
  mv "$stage/$entry.saved" "$stage/source/$entry"
done
as_runner /usr/local/bin/qfli-node "$installed/deployment/check-health.mjs"

for entry in README.md docs/runtime-validation.md; do
  as_runner sh -c 'printf "%s\n" stale-upgrade-fixture > "$1"' sh "$installed/$entry"
done
bash "$stage/bootstrap.sh" --source-dir "$stage/source" --business-env "$business_env"
cmp -s "$stage/source/README.md" "$installed/README.md"
cmp -s "$stage/source/docs/runtime-validation.md" "$installed/docs/runtime-validation.md"
cmp -s "$stage/runner.env.before" "$runner_env"
printf 'PASS upgrade overwrote managed files and preserved runner credentials\n'
before=$(service_state)
bash "$stage/bootstrap.sh" --source-dir "$stage/source" --business-env "$business_env"
[[ "$before" == "$(service_state)" ]]
printf 'PASS repeat installation preserved both services\n'
