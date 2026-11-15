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

service_state() {
  as_runner systemctl --user show docker.service qfli-terminal.service \
    -p Id -p MainPID -p ActiveState -p UnitFileState -p ActiveEnterTimestampMonotonic
}
env_value() { grep -E "^$2=" "$1" | tail -n1 | cut -d= -f2-; }
expect_env() {
  local label=$1 file=$2 key=$3 want=$4 got
  got=$(env_value "$file" "$key")
  [[ "$got" == "$want" ]] || {
    printf 'FAIL %s: %s=%s expected %s\n' "$label" "$key" "${got:-<empty>}" "$want" >&2
    exit 1
  }
  printf 'PASS %s: %s=%s\n' "$label" "$key" "$want"
}
secret_before=$(env_value "$project_dir/.env" QFLI_TERMINAL_SECRET)
# Every value the installed env carried before a run must still be there after
# it with the same content. New keys a release adds are ignored; the point is
# that an existing setting is never silently reset.
expect_preserved() {
  local label=$1 snapshot=$2 key want
  while IFS= read -r line; do
    key=${line%%=*}
    want=${line#*=}
    [[ -n "$key" ]] || continue
    [[ "$(env_value "$project_dir/.env" "$key")" == "$want" ]] || {
      printf 'FAIL %s: setting %s changed\n' "$label" "$key" >&2
      exit 1
    }
  done <"$snapshot"
  printf 'PASS %s preserved every existing setting\n' "$label"
}
expect_preflight_failure() {
  local label=$1 expected=$2 before after
  shift 2
  before=$(service_state)
  if bash "$stage/bootstrap.sh" --source-dir "$stage/source" --business-env "$business_env" "$@" >"$stage/output.log" 2>&1; then
    printf 'FAIL expected preflight rejection: %s\n' "$label" >&2
    exit 1
  fi
  grep -Fq -- "$expected" "$stage/output.log" || { cat "$stage/output.log"; exit 1; }
  after=$(service_state)
  [[ "$before" == "$after" ]] || { printf 'FAIL preflight changed services: %s\n' "$label" >&2; exit 1; }
  [[ "$(env_value "$project_dir/.env" QFLI_TERMINAL_SECRET)" == "$secret_before" ]] || {
    printf 'FAIL preflight changed the runner secret: %s\n' "$label" >&2
    exit 1
  }
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
# An impossible loopback port is refused before anything on the host changes.
expect_preflight_failure 'out-of-range port' '--port must be an integer between 1024 and 65535' --port 80
expect_preflight_failure 'privileged port' '--port must be an integer between 1024 and 65535' --port 65536

for entry in docker-compose.yaml .env.example; do
  as_runner sh -c 'printf "%s\n" stale-upgrade-fixture > "$1"' sh "$project_dir/$entry"
done
# The realistic case: the checkout is root-only (as /root/qfli-terminal is), so
# the installer must stage a runner-readable copy instead of chmod-ing it.
root_only=$(mktemp -d "$stage/root-only.XXXXXXXX")
cp -a "$stage/source/." "$root_only/"
chmod 0700 "$root_only"
if as_runner test -r "$root_only/docker-compose.yaml"; then
  printf 'FAIL the root-only fixture is readable by %s; it cannot test staging\n' "$runner" >&2
  exit 1
fi
bash "$stage/bootstrap.sh" --source-dir "$root_only" --business-env "$business_env"
cmp -s "$root_only/docker-compose.yaml" "$project_dir/docker-compose.yaml"
[[ "$(env_value "$project_dir/.env" QFLI_TERMINAL_SECRET)" == "$secret_before" ]] || {
  printf 'FAIL the staged upgrade changed the runner secret\n' >&2
  exit 1
}
# Staging must not loosen the checkout the operator owns.
[[ "$(stat -c %a "$root_only")" == 700 ]] || {
  printf 'FAIL the installer changed the permissions of the source checkout\n' >&2
  exit 1
}
compose exec -T executor node deployment/check-health.mjs
printf 'PASS a root-only checkout was staged for the runner without loosening it\n'

bash "$stage/bootstrap.sh" --source-dir "$stage/source" --business-env "$business_env"
cmp -s "$stage/source/docker-compose.yaml" "$project_dir/docker-compose.yaml"
[[ "$(env_value "$project_dir/.env" QFLI_TERMINAL_SECRET)" == "$secret_before" ]] || {
  printf 'FAIL upgrade changed the runner secret\n' >&2
  exit 1
}
compose exec -T executor node deployment/check-health.mjs
printf 'PASS upgrade overwrote the managed compose file and preserved the secret\n'

# --- dedicated user manager delegation -------------------------------------
uid=$(id -u "$runner")
systemd_version=$(systemctl --version | awk 'NR == 1 { print $2 }')
dropin=$(find "/etc/systemd/system/user@$uid.service.d" -name '*delegation*.conf' -print -quit)
[[ -n "$dropin" && -f "$dropin" ]] || {
  printf 'FAIL no persistent delegation drop-in for user@%s.service\n' "$uid" >&2
  exit 1
}
grep -Fq 'Delegate=' "$dropin" || { printf 'FAIL delegation drop-in has no Delegate=: %s\n' "$dropin" >&2; exit 1; }
for controller in cpu io memory pids; do
  grep -Eq "^Delegate=.*\b$controller\b" "$dropin" || {
    printf 'FAIL delegation drop-in omits %s: %s\n' "$controller" "$dropin" >&2
    exit 1
  }
done
if ((systemd_version >= 244)); then
  grep -Eq '^Delegate=.*\bcpuset\b' "$dropin" || {
    printf 'FAIL systemd %s should accept cpuset delegation\n' "$systemd_version" >&2
    exit 1
  }
else
  ! grep -Eq '^Delegate=.*\bcpuset\b' "$dropin" || {
    printf 'FAIL systemd %s rejects cpuset in Delegate=: %s\n' "$systemd_version" "$dropin" >&2
    exit 1
  }
fi
controllers=$(cat "/sys/fs/cgroup/user.slice/user-$uid.slice/user@$uid.service/cgroup.controllers")
for controller in cpu io memory pids; do
  [[ " $controllers " == *" $controller "* ]] || {
    printf 'FAIL the dedicated manager did not delegate %s (has:%s)\n' "$controller" "$controllers" >&2
    exit 1
  }
done
printf 'PASS delegation drop-in and live controllers cover cpu io memory pids (systemd %s)\n' "$systemd_version"

# --- host port: apply, persist, keep the mapping --------------------------
configured_port=$((30000 + RANDOM % 20000))
bash "$stage/bootstrap.sh" --source-dir "$stage/source" --business-env "$business_env" --port "$configured_port"
expect_env 'requested port persisted' "$project_dir/.env" QFLI_TERMINAL_HOST_PORT "$configured_port"
mapping=$(as_runner docker compose --project-directory "$project_dir" port executor 3101)
[[ "$mapping" == "127.0.0.1:$configured_port" ]] || {
  printf 'FAIL compose publishes %s instead of 127.0.0.1:%s\n' "$mapping" "$configured_port" >&2
  exit 1
}
compose exec -T executor node deployment/check-health.mjs
printf 'PASS --port applied and published on loopback only\n'

# A later run without --port must keep the configured port, not reset 3101,
# and must not disturb the other installed settings.
before=$(service_state)
cp "$project_dir/.env" "$stage/env.snapshot"
bash "$stage/bootstrap.sh" --source-dir "$stage/source" --business-env "$business_env"
expect_env 'port survives a rerun' "$project_dir/.env" QFLI_TERMINAL_HOST_PORT "$configured_port"
expect_env 'rerun keeps the secret' "$project_dir/.env" QFLI_TERMINAL_SECRET "$secret_before"
expect_env 'rerun keeps auto-update on' "$project_dir/.env" QFLI_TERMINAL_AUTO_UPDATE true
expect_env 'rerun keeps the updater profile' "$project_dir/.env" COMPOSE_PROFILES auto-update
expect_preserved 'the rerun without --port' "$stage/env.snapshot"
compose exec -T executor node deployment/check-health.mjs
[[ "$before" == "$(service_state)" ]] || {
  printf 'FAIL an unchanged rerun restarted services\n' >&2
  exit 1
}
printf 'PASS repeat installation preserved the host port and both services\n'

# --- updater unavailable: install continues, executor stays healthy -------
bash "$stage/bootstrap.sh" --source-dir "$stage/source" --business-env "$business_env" \
  --watchtower-image registry.invalid/qfli/updater:0
expect_env 'updater disabled' "$project_dir/.env" QFLI_TERMINAL_AUTO_UPDATE false
expect_env 'updater profile off' "$project_dir/.env" COMPOSE_PROFILES ''
compose exec -T executor node deployment/check-health.mjs
printf 'PASS an unavailable updater left the executor installed and healthy\n'

# An unflagged rerun inherits the persisted false; only the flag re-enables it.
bash "$stage/bootstrap.sh" --source-dir "$stage/source" --business-env "$business_env" \
  --watchtower-image "$(grep -m1 '^watchtower_image=' "$stage/bootstrap.sh" | cut -d= -f2-)"
expect_env 'a plain rerun keeps the updater off' "$project_dir/.env" QFLI_TERMINAL_AUTO_UPDATE false
expect_env 'a plain rerun keeps the port' "$project_dir/.env" QFLI_TERMINAL_HOST_PORT "$configured_port"
printf 'PASS a rerun does not silently re-enable the updater\n'

# Restoring the updater is explicit: the disabled run persisted
# QFLI_TERMINAL_AUTO_UPDATE=false, and an unflagged rerun inherits that value,
# so re-enabling needs both the flag and an image that can be pulled.
bootstrap_defaults=$(grep -m1 '^watchtower_image=' "$stage/bootstrap.sh" | cut -d= -f2-)
bash "$stage/bootstrap.sh" --source-dir "$stage/source" --business-env "$business_env" \
  --auto-update --watchtower-image "$bootstrap_defaults"
expect_env 'updater re-enabled' "$project_dir/.env" QFLI_TERMINAL_AUTO_UPDATE true
expect_env 'updater profile on' "$project_dir/.env" COMPOSE_PROFILES auto-update
compose exec -T executor node deployment/check-health.mjs
printf 'PASS the updater can be re-enabled without touching the executor contract\n'
