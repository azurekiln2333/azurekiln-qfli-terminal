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
project_dir="$runner_home/qfli-terminal"
runner_env="$runner_home/.config/qfli-terminal/runner.env"
as_runner() {
  (
    cd "$runner_home" || exit
    exec runuser -u "$runner" -- env -i HOME="$runner_home" USER="$runner" LOGNAME="$runner" \
      PATH=/usr/local/bin:/usr/bin:/bin XDG_RUNTIME_DIR="/run/user/$runner_uid" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$runner_uid/bus" \
      DOCKER_HOST="unix:///run/user/$runner_uid/docker.sock" "$@"
  )
}
compose() {
  as_runner docker compose --project-directory "$project_dir" "$@"
}
compose exec -T executor node deployment/check-health.mjs
as_runner systemctl --user is-enabled --quiet docker.service qfli-terminal.service

stage=$(mktemp -d /var/tmp/qfli-bootstrap-test.XXXXXXXX)
marker="$project_dir/.bootstrap-upgrade-test-$$"
cleanup() {
  rm -f -- "$marker"
  [[ "$stage" == /var/tmp/qfli-bootstrap-test.* ]] && rm -rf -- "$stage"
}
trap cleanup EXIT
install -m 0700 "$release_source/deployment/bootstrap.sh" "$stage/bootstrap.sh"
mkdir "$stage/source"
tar -C "$release_source" -cf - docker-compose.yaml .env.example deployment |
  tar -C "$stage/source" -xf -
cp "$project_dir/.env" "$stage/env.before"

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
  cmp -s "$stage/env.before" "$project_dir/.env"
  printf 'PASS %s rejected with both services unchanged\n' "$label"
}

install -m 0644 /dev/null "$marker"
expect_preflight_failure 'root-owned nested file' "compose project path is not writable by $runner"
rm -f -- "$marker"
ln -s "$stage/source/docker-compose.yaml" "$marker"
expect_preflight_failure 'nested destination symlink' "compose project path is not writable by $runner"
rm -f -- "$marker"
mv "$stage/source/docker-compose.yaml" "$stage/docker-compose.saved"
expect_preflight_failure 'missing compose source' "source is incomplete: missing $stage/source/docker-compose.yaml"
mv "$stage/docker-compose.saved" "$stage/source/docker-compose.yaml"

for entry in docker-compose.yaml .env.example; do
  as_runner sh -c 'printf "%s\n" stale-upgrade-fixture > "$1"' sh "$project_dir/$entry"
done
bash "$stage/bootstrap.sh" --source-dir "$stage/source" --business-env "$business_env"
cmp -s "$stage/source/docker-compose.yaml" "$project_dir/docker-compose.yaml"
cmp -s "$stage/env.before" "$project_dir/.env"
compose exec -T executor node deployment/check-health.mjs
printf 'PASS upgrade overwrote the managed compose file and preserved the secret\n'
before=$(service_state)
bash "$stage/bootstrap.sh" --source-dir "$stage/source" --business-env "$business_env"
[[ "$before" == "$(service_state)" ]]
printf 'PASS repeat installation preserved both services\n'