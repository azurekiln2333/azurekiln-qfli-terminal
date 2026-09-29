#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
umask 077

runner=qfli-runner
business_env=''
debian_mirror='http://mirrors.tuna.tsinghua.edu.cn'
registry_mirror=''
download_dir=''
node_download_dir=''
node_bin=/usr/local/bin/qfli-node

usage() {
  printf '%s\n' \
    'Usage: bash deployment/bootstrap.sh [--business-env /path/to/backend/.env] [--registry-mirror HTTPS_URL] [--debian-mirror URL]' \
    'Run as root on Ubuntu 24.04 or Alibaba Cloud Linux 3 with cgroup v2.' \
    'An existing backend secret is required.' \
    'Without --business-env, the script prompts for that secret without echoing it.'
}

fail() {
  printf 'QFLI terminal setup: %s\n' "$*" >&2
  exit 1
}

step() {
  printf '\nQFLI terminal setup: %s\n' "$*"
}

cleanup() {
  if [[ -n "$download_dir" ]]; then
    rm -f -- "$download_dir/gvisor.tar.zstd" "$download_dir/gvisor.tar.zstd.sha512"
    rmdir -- "$download_dir" 2>/dev/null || true
  fi
  if [[ "$node_download_dir" == /var/tmp/qfli-node.* ]]; then
    rm -rf -- "$node_download_dir"
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
    --debian-mirror)
      (($# >= 2)) || fail '--debian-mirror requires a URL'
      debian_mirror=$2
      shift 2
      ;;
    --registry-mirror)
      (($# >= 2)) || fail '--registry-mirror requires an HTTPS URL'
      registry_mirror=$2
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
for command in awk cmp curl docker flock getent install loginctl runuser sha256sum sha512sum systemctl tar "$package_manager"; do
  command -v "$command" >/dev/null || fail "missing command: $command"
done
exec 9>/run/lock/qfli-terminal-bootstrap.lock
flock -n 9 || fail 'another terminal installation is already running'
[[ ! -L "$node_bin" ]] || fail 'dedicated Node.js path must not be a symlink'

node_supported() {
  env -i PATH=/usr/bin:/bin "$1" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 22 || (major === 22 && minor >= 9) ? 0 : 1);
  ' >/dev/null 2>&1
}

if [[ ! -e "$node_bin" ]]; then
  for candidate in /usr/bin/node /usr/local/bin/node \
    /www/server/nodejs/v*/bin/node /www/server/nodejs/*/bin/node \
    /www/server/nvm/versions/node/v*/bin/node; do
    if [[ -x "$candidate" ]] && node_supported "$candidate"; then
      step "installing dedicated Node.js from $candidate"
      install -m 0755 "$candidate" "$node_bin"
      break
    fi
  done
fi

if [[ ! -e "$node_bin" ]]; then
  step 'downloading official Node.js 24 for the dedicated executor'
  if ! command -v xz >/dev/null; then
    if [[ "$package_manager" == apt-get ]]; then
      apt-get update
      apt-get install -y xz-utils
    else
      dnf install -y xz
    fi
  fi
  node_download_dir=$(mktemp -d /var/tmp/qfli-node.XXXXXXXX)
  node_release_url='https://nodejs.org/dist/latest-v24.x'
  curl --fail --location --retry 3 --output "$node_download_dir/SHASUMS256.txt" \
    "$node_release_url/SHASUMS256.txt"
  node_archive=$(awk '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ { print $2 }' \
    "$node_download_dir/SHASUMS256.txt")
  [[ "$node_archive" =~ ^node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$ ]] ||
    fail 'official Node.js 24 checksum manifest has no unique Linux x64 archive'
  curl --fail --location --retry 3 --output "$node_download_dir/$node_archive" \
    "$node_release_url/$node_archive"
  node_sha=$(awk -v name="$node_archive" '$2 == name { print $1 }' \
    "$node_download_dir/SHASUMS256.txt")
  [[ "$node_sha" =~ ^[0-9a-f]{64}$ ]] || fail 'official Node.js checksum is invalid'
  (cd "$node_download_dir" && printf '%s  %s\n' "$node_sha" "$node_archive" | sha256sum -c -)
  node_top=${node_archive%.tar.xz}
  xz -dc "$node_download_dir/$node_archive" |
    tar -xf - -C "$node_download_dir" "$node_top/bin/node"
  install -m 0755 "$node_download_dir/$node_top/bin/node" "$node_bin"
fi
[[ -x "$node_bin" ]] && node_supported "$node_bin" ||
  fail 'dedicated Node.js 22.9 or newer is required'

runner_uid=$(id -u "$runner") || fail "missing account: $runner"
runner_home=$(getent passwd "$runner" | cut -d: -f6)
[[ -d "$runner_home" ]] || fail "missing runner home: $runner_home"
source_dir="$runner_home/azurekiln-qfli-terminal"
[[ -f "$source_dir/src/server.js" && -f "$source_dir/deployment/qfli-terminal.service" && \
   -f "$source_dir/deployment/check-health.mjs" && \
   -f "$source_dir/deployment/docker-daemon.json" && -f "$source_dir/sandbox/Dockerfile" ]] ||
  fail "install the current source at $source_dir before running this script"

as_runner() {
  runuser -u "$runner" -- env -i HOME="$runner_home" USER="$runner" LOGNAME="$runner" \
    PATH=/usr/local/bin:/usr/bin:/bin \
    XDG_RUNTIME_DIR="/run/user/$runner_uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$runner_uid/bus" \
    DOCKER_HOST="unix:///run/user/$runner_uid/docker.sock" "$@"
}

runner_env="$runner_home/.config/qfli-terminal/runner.env"
[[ ! -L "$runner_env" ]] || fail 'runner.env must not be a symlink'
read_secret() {
  env -i PATH=/usr/bin:/bin "$node_bin" -e '
    const fs = require("node:fs");
    const { parseEnv } = require("node:util");
    process.stdout.write(parseEnv(fs.readFileSync(process.argv[1], "utf8")).QFLI_TERMINAL_SECRET ?? "");
  ' "$1"
}

if [[ -n "$business_env" ]]; then
  [[ -f "$business_env" && -r "$business_env" ]] || fail "cannot read business env: $business_env"
  business_secret=$(read_secret "$business_env")
  [[ -n "$business_secret" ]] || fail 'business env has no QFLI_TERMINAL_SECRET'
fi

if [[ -f "$runner_env" ]]; then
  secret=$(read_secret "$runner_env")
  [[ -z "${business_secret:-}" || "$business_secret" == "$secret" ]] ||
    fail 'business and runner secrets differ; reconcile them before continuing'
elif [[ -n "${business_secret:-}" ]]; then
  secret=$business_secret
else
  [[ -t 0 ]] || fail 'pass --business-env or run interactively to enter the backend secret'
  read -r -s -p 'Existing backend QFLI_TERMINAL_SECRET: ' secret
  printf '\n'
fi
[[ "$secret" =~ ^[0-9a-fA-F]{64}$ ]] ||
  fail 'the installer requires the recommended 64-character hexadecimal shared secret'
unset business_secret

step 'starting the dedicated user manager'
loginctl enable-linger "$runner"
systemctl start "user@$runner_uid.service"
service_running=0
if as_runner systemctl --user is-active --quiet qfli-terminal.service; then
  service_running=1
  installed_unit="$runner_home/.config/systemd/user/qfli-terminal.service"
  cmp -s "$source_dir/deployment/qfli-terminal.service" "$installed_unit" ||
    fail 'running unit differs from this release; upgrade it during a maintenance window'
fi

step 'installing account resource limits'
systemctl set-property "user-$runner_uid.slice" \
  CPUAccounting=yes MemoryAccounting=yes TasksAccounting=yes \
  CPUQuota=100% MemoryHigh=768M MemoryMax=1G MemorySwapMax=0 TasksMax=1024

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
  curl --fail --location --retry 3 --output "$download_dir/gvisor.tar.zstd" \
    "$release_url/gvisor.tar.zstd"
  curl --fail --location --retry 3 --output "$download_dir/gvisor.tar.zstd.sha512" \
    "$release_url/gvisor.tar.zstd.sha512"
  (cd "$download_dir" && sha512sum -c gvisor.tar.zstd.sha512)
  zstd -dc "$download_dir/gvisor.tar.zstd" | tar -xf - -C /usr/local/bin
fi
[[ -x /usr/local/bin/runsc && -x /usr/local/bin/containerd-shim-runsc-v1 && \
   -d /usr/local/bin/gvisor-bin ]] || fail 'the gVisor release is incomplete'
/usr/local/bin/runsc --version

step 'checking the dedicated rootless Docker configuration'
docker_config="$runner_home/.config/docker/daemon.json"
as_runner install -d -m 0700 "$runner_home/.config/docker"
[[ ! -L "$docker_config" ]] || fail 'Docker daemon.json must not be a symlink'
if [[ ! -e "$docker_config" ]]; then
  as_runner install -m 0644 \
    "$source_dir/deployment/docker-daemon.json" "$docker_config"
else
  as_runner "$node_bin" -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const runtime = data.runtimes?.runsc;
    const args = JSON.stringify(runtime?.runtimeArgs);
    const previous = JSON.stringify(["--rootless=true", "--network=none"]);
    const current = JSON.stringify(["--network=none"]);
    const target = JSON.stringify(["--network=none", "--ignore-cgroups"]);
    if (runtime?.path !== "/usr/local/bin/runsc" ||
        ![previous, current, target].includes(args)) {
      console.error("rootless Docker runsc settings do not match deployment/docker-daemon.json");
      process.exit(1);
    }
    const logs = data["log-opts"];
    const fixLogs = data["log-driver"] === "local" && logs?.["max-file"] === "1" &&
      logs.compress !== "false";
    if (args !== target || fixLogs) {
      if (process.argv[2] === "1") {
        console.error("stop the running executor before migrating its Docker configuration");
        process.exit(1);
      }
      runtime.runtimeArgs = ["--network=none", "--ignore-cgroups"];
      if (fixLogs) logs.compress = "false";
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      fs.renameSync(temp, file);
    }
  ' "$docker_config" "$service_running" ||
    fail 'fix the dedicated Docker configuration first'
fi

if [[ -n "$registry_mirror" ]]; then
  ((service_running == 0)) || fail 'stop the running executor before changing its Docker registry mirror'
  as_runner "$node_bin" -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const url = new URL(process.argv[2]);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.search || url.hash || url.pathname !== "/") {
      throw new Error("registry mirror must be an HTTPS origin without credentials or a path");
    }
    const config = JSON.parse(fs.readFileSync(path, "utf8"));
    const mirrors = config["registry-mirrors"] ?? [];
    if (!Array.isArray(mirrors) || mirrors.some(value => typeof value !== "string")) {
      throw new Error("existing registry-mirrors must be an array of URLs");
    }
    const updated = [url.origin, ...mirrors.filter(value => value !== url.origin)];
    if (JSON.stringify(updated) !== JSON.stringify(mirrors)) {
      config["registry-mirrors"] = updated;
      const temp = `${path}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      fs.renameSync(temp, path);
    }
  ' "$docker_config" "$registry_mirror"
fi

as_runner install -d -m 0755 \
  "$runner_home/.config/systemd/user"
if [[ ! -f "$runner_home/.config/systemd/user/docker.service" ]]; then
  step 'installing rootless Docker for the dedicated account'
  as_runner dockerd-rootless-setuptool.sh install
fi
as_runner systemctl --user daemon-reload
as_runner systemctl --user enable docker.service
if ((service_running == 0)); then
  as_runner systemctl --user restart docker.service
fi
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
  mirror_origin=$(env -i PATH=/usr/bin:/bin "$node_bin" -p 'new URL(process.argv[1]).origin' "$registry_mirror")
  [[ "$(as_runner docker info --format '{{json .RegistryConfig.Mirrors}}')" == *"$mirror_origin"* ]] ||
    fail 'rootless Docker did not load the configured registry mirror'
fi

if ((service_running == 1)); then
  [[ -f "$runner_env" ]] || fail 'running executor has no runner.env'
  as_runner docker image inspect qfli-terminal-sandbox:1 >/dev/null ||
    fail 'running executor has no trusted sandbox image'
  as_runner chmod 0600 "$runner_env"
  as_runner systemctl --user enable qfli-terminal.service
  step 'service already runs; checking health without changing its deployment'
  as_runner "$node_bin" "$source_dir/deployment/check-health.mjs"
  printf 'QFLI terminal setup: installed and enabled at boot\n'
  exit 0
fi

if ! as_runner docker image inspect qfli-terminal-sandbox:1 >/dev/null 2>&1; then
  step 'building the trusted sandbox image; this can take several minutes'
  as_runner docker build --pull --progress=plain \
    --build-arg "DEBIAN_MIRROR=$debian_mirror" \
    -t qfli-terminal-sandbox:1 "$source_dir/sandbox" ||
    fail 'sandbox build failed; if Docker Hub is unreachable, rerun with --registry-mirror and your trusted HTTPS Docker Hub accelerator'
fi

step 'checking gVisor container startup under the bounded rootless account'
as_runner docker run --rm --pull=never --runtime=runsc --network=none \
  --log-driver=none --read-only --user=65532:65532 --cap-drop=ALL \
  --security-opt=no-new-privileges --tmpfs=/workspace:rw,nosuid,nodev,size=256m,mode=0700,uid=65532,gid=65532 \
  --tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777 \
  --entrypoint=/usr/bin/true qfli-terminal-sandbox:1 ||
  fail 'gVisor startup under the dedicated rootless Docker daemon failed'

step 'configuring the executor user service'
config_dir="$runner_home/.config/qfli-terminal"
as_runner install -d -m 0700 "$config_dir"
if [[ ! -f "$runner_env" ]]; then
  printf 'QFLI_TERMINAL_SECRET=%s\nQFLI_TERMINAL_IMAGE=qfli-terminal-sandbox:1\n' \
    "$secret" | as_runner sh -c '
      set -eu
      temp_env=$(mktemp "$HOME/.config/qfli-terminal/runner.env.XXXXXXXX")
      trap "rm -f -- \"$temp_env\"" EXIT
      cat > "$temp_env"
      chmod 0600 "$temp_env"
      mv -T -- "$temp_env" "$HOME/.config/qfli-terminal/runner.env"
    '
fi
as_runner chmod 0600 "$runner_env"
unset secret
as_runner install -m 0644 \
  "$source_dir/deployment/qfli-terminal.service" \
  "$runner_home/.config/systemd/user/qfli-terminal.service"
as_runner systemctl --user daemon-reload
as_runner systemctl --user enable --now qfli-terminal.service

step 'waiting for the authenticated local health check'
for attempt in {1..10}; do
  if as_runner "$node_bin" "$source_dir/deployment/check-health.mjs" >/dev/null 2>&1; then
    as_runner "$node_bin" "$source_dir/deployment/check-health.mjs"
    printf 'QFLI terminal setup: installed and enabled at boot\n'
    exit 0
  fi
  sleep 2
done
as_runner journalctl --user -u qfli-terminal.service -n 80 --no-pager || true
fail 'the executor did not become healthy; inspect the service log above'
