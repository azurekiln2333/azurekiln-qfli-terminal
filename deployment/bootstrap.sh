#!/usr/bin/env bash
# Image-only installer for the isolated terminal executor container.
# It prepares the host, pulls prebuilt images, verifies real gVisor sessions,
# then starts the executor stack. It never builds or runs Node on the host.
set -Eeuo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077

runner=qfli-runner
business_env=''
input_source=''
registry_mirror=''
sandbox_image=docker.cnb.cool/azurekiln/azurekiln-qfli-terminal/sandbox:3
executor_image=docker.cnb.cool/azurekiln/azurekiln-qfli-terminal:latest
sandbox_image_set=0
release_entries=(docker-compose.yaml .env.example deployment/docker-daemon.json \
  deployment/qfli-terminal-compose.service deployment/check-health.mjs \
  deployment/verify-runtime.mjs)

usage() {
  printf '%s\n' \
    'Usage: bash deployment/bootstrap.sh [--source-dir PATH] [--business-env PATH]' \
    '       [--registry-mirror HTTPS_URL] [--sandbox-image IMAGE] [--executor-image IMAGE]' \
    'Run as root on Ubuntu 24.04 or Alibaba Cloud Linux 3 with cgroup v2.' \
    'The sandbox and executor images are pulled; nothing is built on the server.' \
    'An existing backend secret is required.'
}

fail() {
  printf 'QFLI terminal setup: %s\n' "$*" >&2
  exit 1
}

step() {
  printf '\nQFLI terminal setup: %s\n' "$*"
}

cleanup() {
  if [[ -n "${download_dir:-}" ]]; then
    rm -f -- "$download_dir/gvisor.tar.zstd" "$download_dir/gvisor.tar.zstd.sha512"
    rmdir -- "$download_dir" 2>/dev/null || true
  fi
}
trap cleanup EXIT

while (($#)); do
  case "$1" in
    --business-env)
      (($# >= 2)) || fail '--business-env requires a path'
      business_env=$2
      shift 2
      ;;
    --source-dir)
      (($# >= 2)) || fail '--source-dir requires a path'
      input_source=$2
      shift 2
      ;;
    --registry-mirror)
      (($# >= 2)) || fail '--registry-mirror requires an HTTPS URL'
      registry_mirror=$2
      shift 2
      ;;
    --sandbox-image)
      (($# >= 2)) || fail '--sandbox-image requires an image reference'
      sandbox_image=$2
      sandbox_image_set=1
      shift 2
      ;;
    --executor-image)
      (($# >= 2)) || fail '--executor-image requires an image reference'
      executor_image=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown option: $1"
      ;;
  esac
done

((EUID == 0)) || fail 'run this installer as root'
[[ -r /etc/os-release ]] || fail '/etc/os-release is missing'
# This file is supplied by the operating system, not by the project checkout.
. /etc/os-release
case "${ID:-}:${VERSION_ID:-}" in
  ubuntu:24.04*) package_manager=apt-get ;;
  alinux:3*) package_manager=dnf ;;
  *) fail 'supported hosts: Ubuntu 24.04 or Alibaba Cloud Linux 3' ;;
esac
[[ "$(uname -m)" == x86_64 ]] || fail 'this installer expects x86_64'
systemd_version=$(systemctl --version | awk 'NR == 1 { print $2 }')
[[ "$systemd_version" =~ ^[0-9]+$ ]] || fail 'cannot determine the host systemd version'
((systemd_version >= 239)) || fail 'systemd 239 or newer is required for the dedicated user slice'
[[ "$(stat -fc %T /sys/fs/cgroup)" == cgroup2fs ]] ||
  fail 'cgroup v2 is not active; follow README.md to enable it and reboot first'
for command in awk flock systemctl "$package_manager"; do
  command -v "$command" >/dev/null || fail "missing command: $command"
done
exec 9>/run/lock/qfli-terminal-bootstrap.lock
flock -n 9 || fail 'another terminal installation is already running'

configure_al3_docker_repo() {
  printf '%s\n' '[docker-ce-stable]' 'name=Docker CE Stable - x86_64' \
    'baseurl=https://mirrors.tuna.tsinghua.edu.cn/docker-ce/linux/centos/8/x86_64/stable https://download.docker.com/linux/centos/8/x86_64/stable' \
    'enabled=1' 'gpgcheck=1' 'gpgkey=https://download.docker.com/linux/centos/gpg' \
    > /etc/yum.repos.d/qfli-docker.repo
}
if [[ "$package_manager" == dnf && -f /etc/yum.repos.d/qfli-docker.repo ]]; then
  configure_al3_docker_repo
fi

step 'preparing host packages for rootless Docker'
needs_packages=0
for command in curl newuidmap newgidmap dbus-daemon slirp4netns fuse-overlayfs xz zstd \
  tar cmp getent install loginctl runuser sha256sum sha512sum realpath find sort xargs useradd usermod passwd ps ip python3; do
  command -v "$command" >/dev/null || needs_packages=1
done
if ((needs_packages)); then
  if [[ "$package_manager" == apt-get ]]; then
    apt-get --error-on=any update
    apt-get install -y ca-certificates curl uidmap dbus-user-session \
      slirp4netns fuse-overlayfs xz-utils zstd tar coreutils util-linux findutils passwd procps iproute2
  else
    dnf install -y ca-certificates curl shadow-utils dbus-daemon \
      slirp4netns fuse-overlayfs xz zstd tar coreutils util-linux findutils passwd procps-ng iproute
  fi
fi
if [[ "$package_manager" == dnf ]] && ! slirp4netns --version >/dev/null 2>&1; then
  step 'updating glib2 required by the AL3 libslirp package'
  dnf upgrade -y glib2
fi
slirp4netns --version >/dev/null || fail 'slirp4netns is installed but cannot run'
fuse-overlayfs --version >/dev/null || fail 'fuse-overlayfs is installed but cannot run'

install_docker_packages() {
  if [[ "$package_manager" == apt-get ]]; then
    install -d -m 0755 /etc/apt/keyrings
    curl --fail --location --retry 3 --output /etc/apt/keyrings/qfli-docker.asc \
      https://download.docker.com/linux/ubuntu/gpg
    chmod 0644 /etc/apt/keyrings/qfli-docker.asc
    printf '%s\n' 'deb [arch=amd64 signed-by=/etc/apt/keyrings/qfli-docker.asc] https://download.docker.com/linux/ubuntu noble stable' \
      > /etc/apt/sources.list.d/qfli-docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-ce-rootless-extras
  else
    configure_al3_docker_repo
    dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-ce-rootless-extras
  fi
}
if ! command -v docker >/dev/null; then
  step 'installing Docker and the Compose plugin from signed repositories'
  install_docker_packages
elif ! command -v dockerd-rootless-setuptool.sh >/dev/null; then
  step 'installing the missing rootless Docker extras'
  if [[ "$package_manager" == apt-get ]]; then
    apt-get install -y docker-compose-plugin docker-ce-rootless-extras
  else
    configure_al3_docker_repo
    dnf install -y docker-compose-plugin docker-ce-rootless-extras
  fi
fi
for command in docker dockerd-rootless-setuptool.sh newuidmap newgidmap; do
  command -v "$command" >/dev/null || fail "rootless Docker prerequisite is missing: $command"
done
docker compose version >/dev/null 2>&1 || fail 'the Docker Compose plugin is missing'

if ! id "$runner" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$runner"
  passwd -l "$runner" >/dev/null
fi
[[ "$(id -u "$runner")" != 0 ]] || fail 'the runner must be non-root'
for mapping in /etc/subuid /etc/subgid; do
  if ! awk -F: -v user="$runner" '$1 == user && $3 >= 65536 { found=1 } END { exit !found }' "$mapping"; then
    first=$(awk -F: 'BEGIN { next_id=100000 } $2+$3 > next_id { next_id=$2+$3 } END { print next_id }' "$mapping")
    last=$((first + 65535))
    ((last < 2147483647)) || fail 'no available subordinate ID range'
    if [[ "$mapping" == /etc/subuid ]]; then
      usermod --add-subuids "$first-$last" "$runner"
    else
      usermod --add-subgids "$first-$last" "$runner"
    fi
  fi
done

runner_uid=$(id -u "$runner") || fail "missing account: $runner"
runner_home=$(getent passwd "$runner" | cut -d: -f6)
[[ -d "$runner_home" ]] || fail "missing runner home: $runner_home"
project_dir="$runner_home/qfli-terminal"
legacy_env="$runner_home/.config/qfli-terminal/runner.env"
backup_dir="$runner_home/.config/qfli-terminal"
installed_receipt="$backup_dir/installed.json"

as_runner() {
  # runuser keeps the caller's cwd; an unreadable one such as /root breaks find.
  (
    cd "$runner_home" || exit
    exec runuser -u "$runner" -- env -i HOME="$runner_home" USER="$runner" LOGNAME="$runner" \
      PATH=/usr/local/bin:/usr/bin:/bin \
      XDG_RUNTIME_DIR="/run/user/$runner_uid" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$runner_uid/bus" \
      DOCKER_HOST="unix:///run/user/$runner_uid/docker.sock" "$@"
  )
}

compose() {
  as_runner docker compose --project-directory "$project_dir" "$@"
}

read_env_value() {
  local file=$1 key=$2 line
  [[ -f "$file" ]] || return 0
  line=$(grep -m1 "^${key}=" "$file" 2>/dev/null || true)
  printf '%s' "${line#*=}" | tr -d '\r'
}

[[ "$sandbox_image" =~ ^[a-z0-9][a-z0-9._/:@-]{0,250}$ ]] || fail 'invalid sandbox image reference'
[[ "$executor_image" =~ ^[a-z0-9][a-z0-9._/:@-]{0,250}$ ]] || fail 'invalid executor image reference'

# Resolve the release source that provides docker-compose.yaml.
if [[ -n "$input_source" ]]; then
  input_source=$(realpath -- "$input_source")
fi
release_source=${input_source:-}
if [[ -z "$release_source" ]]; then
  if [[ -f "$project_dir/docker-compose.yaml" ]]; then
    release_source=$project_dir
  else
    fail 'pass --source-dir with a directory that contains docker-compose.yaml'
  fi
fi
for entry in "${release_entries[@]}"; do
  [[ -f "$release_source/$entry" ]] || fail "source is incomplete: missing $release_source/$entry"
done

step 'starting the dedicated user manager'
loginctl enable-linger "$runner"
systemctl start "user@$runner_uid.service"

step 'installing account resource limits'
# A transient `set-property` drop-in lives under /run and disappears on reboot,
# which drops CPUQuota after a restart. Write a persistent slice drop-in first,
# then apply the same values for immediate effect.
install -d -m 0755 "/etc/systemd/system/user-$runner_uid.slice.d"
cat > "/etc/systemd/system/user-$runner_uid.slice.d/50-qfli-limits.conf" <<'QFLI_SLICE'
[Slice]
CPUAccounting=yes
MemoryAccounting=yes
TasksAccounting=yes
CPUQuota=100%
MemoryHigh=768M
MemoryMax=1G
MemorySwapMax=0
TasksMax=1024
QFLI_SLICE
systemctl daemon-reload
systemctl set-property "user-$runner_uid.slice" \
  CPUAccounting=yes MemoryAccounting=yes TasksAccounting=yes \
  CPUQuota=100% MemoryHigh=768M MemoryMax=1G MemorySwapMax=0 TasksMax=1024
# The persistent drop-in must exist for the limits to survive a reboot.
[[ -s "/etc/systemd/system/user-$runner_uid.slice.d/50-qfli-limits.conf" ]] ||
  fail 'the persistent account limit drop-in was not written'

if [[ ! -x /usr/local/bin/runsc || ! -x /usr/local/bin/containerd-shim-runsc-v1 || \
      ! -d /usr/local/bin/gvisor-bin ]]; then
  step 'downloading and checking the official gVisor release'
  if ! command -v zstd >/dev/null; then
    if [[ "$package_manager" == apt-get ]]; then
      apt-get update
      apt-get install -y zstd
    else
      dnf install -y zstd
    fi
  fi
  download_dir=$(mktemp -d /var/tmp/qfli-gvisor.XXXXXXXX)
  release_url='https://storage.googleapis.com/gvisor/releases/release/latest/x86_64'
  curl --fail --location --ipv4 --tls-max 1.2 --retry 3 --retry-max-time 900 \
    --connect-timeout 15 --max-time 600 --output "$download_dir/gvisor.tar.zstd" \
    "$release_url/gvisor.tar.zstd"
  curl --fail --location --ipv4 --tls-max 1.2 --retry 3 --retry-max-time 90 \
    --connect-timeout 15 --max-time 60 --output "$download_dir/gvisor.tar.zstd.sha512" \
    "$release_url/gvisor.tar.zstd.sha512"
  (cd "$download_dir" && sha512sum -c gvisor.tar.zstd.sha512)
  zstd -dc "$download_dir/gvisor.tar.zstd" | tar -xf - -C /usr/local/bin
fi
[[ -x /usr/local/bin/runsc && -x /usr/local/bin/containerd-shim-runsc-v1 && \
   -d /usr/local/bin/gvisor-bin ]] || fail 'the gVisor release is incomplete'
/usr/local/bin/runsc --version

# Resolve the shared executor secret from the installed stack, a legacy host
# install, the business env, or hidden input. The business environment is never
# copied to the runner.
if [[ -n "$business_env" ]]; then
  business_env=$(realpath -e -- "$business_env") || fail "business env does not exist: $business_env"
  [[ -f "$business_env" ]] || fail "business env must be a regular file: $business_env"
  business_secret=$(read_env_value "$business_env" QFLI_TERMINAL_SECRET)
  [[ -n "$business_secret" ]] || fail 'business env has no QFLI_TERMINAL_SECRET'
fi
current_secret=''
if [[ -f "$project_dir/.env" ]]; then
  current_secret=$(read_env_value "$project_dir/.env" QFLI_TERMINAL_SECRET)
elif [[ -f "$legacy_env" ]]; then
  current_secret=$(read_env_value "$legacy_env" QFLI_TERMINAL_SECRET)
  legacy_sandbox=$(read_env_value "$legacy_env" QFLI_TERMINAL_IMAGE)
  if ((!sandbox_image_set)) && [[ -n "$legacy_sandbox" ]]; then
    sandbox_image=$legacy_sandbox
  fi
fi
if [[ -n "${business_secret:-}" && -n "$current_secret" && "$business_secret" != "$current_secret" ]]; then
  fail 'business and runner secrets differ; reconcile them before continuing'
fi
secret=${current_secret:-${business_secret:-}}
if [[ -z "$secret" ]]; then
  [[ -t 0 ]] || fail 'pass --business-env or run interactively to enter the backend secret'
  read -r -s -p 'Existing backend QFLI_TERMINAL_SECRET: ' secret
  printf '\n'
fi
[[ "$secret" =~ ^[0-9a-fA-F]{64}$ ]] ||
  fail 'the installer requires the recommended 64-character hexadecimal shared secret'
unset business_secret current_secret legacy_sandbox

step 'preparing the compose project directory'
[[ ! -L "$project_dir" ]] || fail "compose project must not be a symlink: $project_dir"
if [[ -e "$project_dir" ]]; then
  [[ -d "$project_dir" ]] || fail "compose project must be a directory: $project_dir"
  as_runner test -O "$project_dir" && as_runner test -w "$project_dir" && as_runner test -x "$project_dir" ||
    fail "compose project must be owned and writable by $runner: $project_dir"
  blocked=$(as_runner find "$project_dir" -xdev \
    \( -type l -o ! -uid "$runner_uid" -o ! -writable -o \( -type d ! -executable \) \) \
    -print -quit) || fail "cannot inspect compose project as $runner"
  [[ -z "$blocked" ]] || fail "compose project path is not writable by $runner: $blocked"
else
  as_runner install -d -m 0755 "$project_dir" || fail "cannot create $project_dir"
fi

step 'checking the dedicated rootless Docker configuration'
docker_config="$runner_home/.config/docker/daemon.json"
docker_changed=0
docker_config_before=$(sha256sum "$docker_config" 2>/dev/null || true)
as_runner install -d -m 0700 "$runner_home/.config/docker"
[[ ! -L "$docker_config" ]] || fail 'Docker daemon.json must not be a symlink'
if [[ ! -e "$docker_config" ]]; then
  as_runner install -m 0644 "$release_source/deployment/docker-daemon.json" "$docker_config"
else
  as_runner python3 - "$docker_config" <<'PY'
import json, os, sys
file = sys.argv[1]
with open(file, encoding="utf-8") as handle:
    data = json.load(handle)
runtime = data.get("runtimes", {}).get("runsc", {})
allowed = [
    ["--network=none", "--ignore-cgroups"],
    ["--network=none"],
    ["--rootless=true", "--network=none"],
]
target = ["--network=none", "--ignore-cgroups"]
if runtime.get("path") != "/usr/local/bin/runsc" or runtime.get("runtimeArgs") not in allowed:
    raise SystemExit("rootless Docker runsc settings do not match deployment/docker-daemon.json")
logs = data.get("log-opts")
fix_logs = data.get("log-driver") == "local" and logs.get("max-file") == "1" and logs.get("compress") != "false"
if runtime.get("runtimeArgs") != target or fix_logs:
    runtime["runtimeArgs"] = target
    if fix_logs:
        logs["compress"] = "false"
    temp = f"{file}.{os.getpid()}.tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")
    os.chmod(temp, 0o600)
    os.replace(temp, file)
PY
fi

if [[ -n "$registry_mirror" ]]; then
  as_runner python3 - "$docker_config" "$registry_mirror" <<'PY'
import json, os, sys
from urllib.parse import urlsplit
file, raw = sys.argv[1], sys.argv[2]
parts = urlsplit(raw)
if parts.scheme != "https" or parts.username or parts.password or parts.query or parts.fragment or parts.path not in ("", "/"):
    raise SystemExit("registry mirror must be an HTTPS origin without credentials or a path")
origin = f"{parts.scheme}://{parts.netloc}"
with open(file, encoding="utf-8") as handle:
    config = json.load(handle)
mirrors = config.get("registry-mirrors", [])
if not isinstance(mirrors, list) or any(not isinstance(value, str) for value in mirrors):
    raise SystemExit("existing registry-mirrors must be an array of URLs")
updated = [origin, *(value for value in mirrors if value != origin)]
if updated != mirrors:
    config["registry-mirrors"] = updated
    temp = f"{file}.{os.getpid()}.tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=2)
        handle.write("\n")
    os.chmod(temp, 0o600)
    os.replace(temp, file)
PY
fi
docker_config_after=$(sha256sum "$docker_config" 2>/dev/null || true)
[[ "$docker_config_before" == "$docker_config_after" ]] || docker_changed=1

as_runner install -d -m 0755 "$runner_home/.config/systemd/user"
if [[ ! -f "$runner_home/.config/systemd/user/docker.service" ]]; then
  step 'installing rootless Docker for the dedicated account'
  as_runner dockerd-rootless-setuptool.sh install
  docker_changed=1
fi
as_runner systemctl --user daemon-reload
as_runner systemctl --user enable docker.service
docker_active=0
as_runner systemctl --user is-active --quiet docker.service && docker_active=1
if ((docker_changed)) || ((!docker_active)); then
  step 'restarting the dedicated rootless Docker for the pending configuration change'
  as_runner systemctl --user restart docker.service
fi
docker_ready=0
for attempt in {1..10}; do
  if as_runner docker info --format '{{.CgroupVersion}}' >/dev/null 2>&1; then docker_ready=1; break; fi
  sleep 2
done
((docker_ready)) || fail 'the dedicated rootless Docker did not become reachable'
[[ "$(as_runner docker info --format '{{.CgroupVersion}}')" == 2 ]] ||
  fail 'rootless Docker is not using cgroup v2'
[[ "$(as_runner docker info --format '{{.CgroupDriver}}')" == systemd ]] ||
  fail 'rootless Docker must use the systemd cgroup driver for account-wide limits'
security_options=$(as_runner docker info --format '{{json .SecurityOptions}}')
[[ "$security_options" == *'name=rootless'* && \
   "$security_options" == *'name=seccomp,profile=builtin'* ]] ||
  fail 'rootless Docker or default seccomp is unavailable'
[[ "$(as_runner docker info --format '{{if index .Runtimes "runsc"}}yes{{end}}')" == yes ]] ||
  fail 'rootless Docker has not registered runsc'
if [[ -n "$registry_mirror" ]]; then
  mirror_origin=$(python3 -c 'import sys; from urllib.parse import urlsplit; p=urlsplit(sys.argv[1]); print(f"{p.scheme}://{p.netloc}")' "$registry_mirror")
  [[ "$(as_runner docker info --format '{{json .RegistryConfig.Mirrors}}')" == *"$mirror_origin"* ]] ||
    fail 'rootless Docker did not load the configured registry mirror'
fi

step 'recording the previous immutable image state'
legacy_unit=0
if [[ -f "$runner_home/.config/systemd/user/qfli-terminal.service" ]] && \
   grep -q 'qfli-node' "$runner_home/.config/systemd/user/qfli-terminal.service"; then
  legacy_unit=1
fi
previous_executor_id=''
previous_service_ref=''
if [[ -f "$project_dir/.env" ]]; then
  previous_service_ref=$(read_env_value "$project_dir/.env" QFLI_TERMINAL_SERVICE_IMAGE)
fi
if [[ -f "$project_dir/docker-compose.yaml" ]]; then
  previous_container=$(compose ps -q executor 2>/dev/null || true)
  if [[ -n "$previous_container" ]]; then
    previous_executor_id=$(as_runner docker inspect --format '{{.Image}}' "$previous_container" 2>/dev/null || true)
  fi
fi
previous_sandbox_ref=''
if [[ -f "$project_dir/.env" ]]; then
  previous_sandbox_ref=$(read_env_value "$project_dir/.env" QFLI_TERMINAL_IMAGE)
elif [[ -f "$legacy_env" ]]; then
  previous_sandbox_ref=$(read_env_value "$legacy_env" QFLI_TERMINAL_IMAGE)
fi
previous_sandbox_id=''
if [[ -n "$previous_sandbox_ref" ]]; then
  previous_sandbox_id=$(as_runner docker image inspect --format '{{.Id}}' "$previous_sandbox_ref" 2>/dev/null || true)
fi
if [[ -n "$previous_executor_id" || -n "$previous_sandbox_id" ]]; then
  as_runner install -d -m 0700 "$backup_dir"
  printf '{"executorId":"%s","sandboxId":"%s"}\n' "$previous_executor_id" "$previous_sandbox_id" |
    as_runner sh -c 'umask 077; cat > "$1"' sh "$backup_dir/images.previous.json"
fi

step 'pulling the prebuilt sandbox and executor images'
as_runner docker pull "$sandbox_image"
as_runner docker pull "$executor_image"
as_runner docker image inspect -- "$executor_image" >/dev/null ||
  fail 'the executor image could not be pulled'

sandbox_user=$(as_runner docker image inspect --format '{{.Config.User}}' "$sandbox_image")
sandbox_label=$(as_runner docker image inspect --format '{{index .Config.Labels "io.qfli.terminal.image"}}' "$sandbox_image")
sandbox_toolchains=$(as_runner docker image inspect --format '{{index .Config.Labels "io.qfli.terminal.toolchains"}}' "$sandbox_image")
sandbox_entry=$(as_runner docker image inspect --format '{{json .Config.Entrypoint}}' "$sandbox_image")
sandbox_cmd=$(as_runner docker image inspect --format '{{len .Config.Cmd}}' "$sandbox_image")
sandbox_volumes=$(as_runner docker image inspect --format '{{len .Config.Volumes}}' "$sandbox_image")
expected_entry='["/usr/bin/python3","-I","/usr/local/lib/qfli/init.py"]'
[[ "$sandbox_label" == 1 && "$sandbox_toolchains" == 3 && "$sandbox_user" == 65533:65533 &&
   "$sandbox_entry" == "$expected_entry" && "$sandbox_cmd" == 0 && "$sandbox_volumes" == 0 ]] ||
  fail "sandbox image contract mismatch: $sandbox_image"

sandbox_id=$(as_runner docker image inspect --format '{{.Id}}' "$sandbox_image")
executor_id=$(as_runner docker image inspect --format '{{.Id}}' "$executor_image")
[[ "$sandbox_id" =~ ^sha256:[a-f0-9]{64}$ && "$executor_id" =~ ^sha256:[a-f0-9]{64}$ ]] ||
  fail 'pulled images do not expose immutable IDs'

# An unchanged rerun must not restart Docker or replace running sandboxes.
desired_env=$(printf 'QFLI_TERMINAL_SECRET=%s\nQFLI_TERMINAL_IMAGE=%s\nQFLI_TERMINAL_SERVICE_IMAGE=%s\nQFLI_RUNNER_HOST_UID=%s' \
  "$secret" "$sandbox_image" "$executor_image" "$runner_uid")
current_env=$(cat "$project_dir/.env" 2>/dev/null || true)
current_receipt=$(cat "$installed_receipt" 2>/dev/null || true)
if [[ -f "$project_dir/.env" && -f "$project_dir/docker-compose.yaml" ]] && \
   cmp -s "$release_source/docker-compose.yaml" "$project_dir/docker-compose.yaml" && \
   [[ "$current_env" == "$desired_env" ]] && \
   [[ "$current_receipt" == *"\"sandboxId\":\"$sandbox_id\""* ]] && \
   [[ "$current_receipt" == *"\"executorId\":\"$executor_id\""* ]] && \
   compose exec -T executor node deployment/check-health.mjs >/dev/null 2>&1; then
  step 'installed images, compose file and secret already match; nothing to change'
  compose exec -T executor node deployment/check-health.mjs
  exit 0
fi

# Preserve the previous stack so a failed release can be restored.
previous_env=''
previous_compose=''
as_runner install -d -m 0700 "$backup_dir"
if [[ -f "$project_dir/.env" ]]; then
  as_runner install -m 0600 "$project_dir/.env" "$backup_dir/env.previous"
  previous_env="$backup_dir/env.previous"
fi
if [[ -f "$project_dir/docker-compose.yaml" ]]; then
  as_runner install -m 0644 "$project_dir/docker-compose.yaml" "$backup_dir/docker-compose.previous.yaml"
  previous_compose="$backup_dir/docker-compose.previous.yaml"
fi

stack_was_running=0
if [[ -f "$project_dir/docker-compose.yaml" ]] && \
   [[ -n "$(compose ps -q 2>/dev/null || true)" ]]; then
  stack_was_running=1
fi

restore_previous() {
  if [[ -n "$previous_env" ]]; then
    step 'restoring the previous image stack pinned to its immutable image IDs'
    if [[ -n "$previous_executor_id" || -n "$previous_sandbox_id" ]]; then
      pinned_service=${previous_executor_id:-$(read_env_value "$previous_env" QFLI_TERMINAL_SERVICE_IMAGE)}
      pinned_sandbox=${previous_sandbox_id:-$(read_env_value "$previous_env" QFLI_TERMINAL_IMAGE)}
      {
        grep -v -E '^(QFLI_TERMINAL_SERVICE_IMAGE|QFLI_TERMINAL_IMAGE)=' "$previous_env" || true
        printf 'QFLI_TERMINAL_SERVICE_IMAGE=%s\nQFLI_TERMINAL_IMAGE=%s\n' "$pinned_service" "$pinned_sandbox"
      } | as_runner sh -c '
        set -eu
        umask 077
        temp=$(mktemp "$1/.env.XXXXXXXX")
        trap "rm -f -- \"$temp\"" EXIT
        cat > "$temp"
        chmod 0600 "$temp"
        mv -T -- "$temp" "$1/.env"
      ' sh "$project_dir"
    else
      as_runner install -m 0600 "$previous_env" "$project_dir/.env"
    fi
    [[ -z "$previous_compose" ]] || as_runner install -m 0644 "$previous_compose" "$project_dir/docker-compose.yaml"
    compose up -d --remove-orphans || true
  elif ((legacy_unit)); then
    step 'restoring the previous host-service executor with its immutable sandbox image'
    if [[ -n "$previous_sandbox_id" ]]; then
      as_runner install -m 0600 "$legacy_env" "$backup_dir/runner.env.previous"
      {
        grep -v '^QFLI_TERMINAL_IMAGE=' "$legacy_env" || true
        printf 'QFLI_TERMINAL_IMAGE=%s\n' "$previous_sandbox_id"
      } | as_runner sh -c '
        set -eu
        umask 077
        temp=$(mktemp "$1.XXXXXXXX")
        trap "rm -f -- \"$temp\"" EXIT
        cat > "$temp"
        chmod 0600 "$temp"
        mv -T -- "$temp" "$1"
      ' sh "$legacy_env"
    fi
    as_runner systemctl --user enable --now qfli-terminal.service || true
  else
    step 'no previous executor stack exists; leaving the new stack stopped'
  fi
}

step 'stopping the previous executor'
if ((stack_was_running)); then
  compose down --remove-orphans || fail 'the previous image stack did not stop cleanly'
fi
if ((legacy_unit)) && as_runner systemctl --user is-active --quiet qfli-terminal.service; then
  as_runner systemctl --user disable --now qfli-terminal.service
fi

printf 'QFLI_TERMINAL_SECRET=%s\nQFLI_TERMINAL_IMAGE=%s\nQFLI_TERMINAL_SERVICE_IMAGE=%s\nQFLI_RUNNER_HOST_UID=%s\n' \
  "$secret" "$sandbox_image" "$executor_image" "$runner_uid" |
  as_runner sh -c '
    set -eu
    umask 077
    temp=$(mktemp "$1/.env.XXXXXXXX")
    trap "rm -f -- \"$temp\"" EXIT
    cat > "$temp"
    chmod 0600 "$temp"
    mv -T -- "$temp" "$1/.env"
  ' sh "$project_dir"
as_runner install -m 0644 "$release_source/docker-compose.yaml" "$project_dir/docker-compose.yaml"
unset secret

step 'verifying all toolchains in actual bounded gVisor sessions'
if ! compose run --rm --no-deps --entrypoint node executor deployment/verify-runtime.mjs; then
  restore_previous
  fail 'runtime/toolchain verification failed; the previous stack was restored'
fi

step 'starting the executor and updater stack'
compose up -d --remove-orphans || { restore_previous; fail 'the executor stack failed to start'; }

step 'waiting for the authenticated local health check'
healthy=0
for attempt in {1..15}; do
  if compose exec -T executor node deployment/check-health.mjs >/dev/null 2>&1; then
    compose exec -T executor node deployment/check-health.mjs
    healthy=1
    break
  fi
  sleep 2
done
if ((!healthy)); then
  compose logs --tail=80 executor || true
  compose down --remove-orphans || true
  restore_previous
  fail 'the executor did not become healthy; the previous stack was restored'
fi

if ((legacy_unit)); then
  as_runner cp -p "$runner_home/.config/systemd/user/qfli-terminal.service" \
    "$runner_home/.config/systemd/user/qfli-terminal.service.legacy"
fi
as_runner install -m 0644 "$release_source/deployment/qfli-terminal-compose.service" \
  "$runner_home/.config/systemd/user/qfli-terminal.service"
as_runner systemctl --user daemon-reload
as_runner systemctl --user enable qfli-terminal.service

fingerprint=$(sha256sum "$project_dir/docker-compose.yaml" | cut -d ' ' -f1)
printf '{"executorImage":"%s","executorId":"%s","sandboxImage":"%s","sandboxId":"%s","composeSha256":"%s","verifiedAt":"%s"}\n' \
  "$executor_image" "$executor_id" "$sandbox_image" "$sandbox_id" "$fingerprint" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" |
  as_runner sh -c 'umask 077; cat > "$1"' sh "$installed_receipt"
if [[ "$release_source" != "$project_dir" ]]; then
  as_runner install -m 0644 "$release_source/.env.example" "$project_dir/.env.example"
fi

printf 'QFLI terminal setup: installed, verified and enabled at boot\n'