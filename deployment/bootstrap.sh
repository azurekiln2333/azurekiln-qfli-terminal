#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077

runner=qfli-runner
business_env=''
debian_mirror='http://mirrors.tuna.tsinghua.edu.cn'
registry_mirror=''
base_image=debian:trixie-slim
input_source=''
sandbox_image=qfli-terminal-sandbox:2
download_dir=''
node_download_dir=''
release_stage_dir=''
node_bin=/usr/local/bin/qfli-node
release_entries=(src sandbox deployment test docs package.json README.md .env.example)

usage() {
  printf '%s\n' \
    'Usage: bash deployment/bootstrap.sh [--source-dir PATH] [--business-env PATH] [--registry-mirror HTTPS_URL] [--debian-mirror URL] [--base-image IMAGE]' \
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
  if [[ "$release_stage_dir" == /var/tmp/qfli-release.* ]]; then
    rm -f -- "$release_stage_dir/release.tar"
    rmdir -- "$release_stage_dir" 2>/dev/null || true
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
    --base-image)
      (($# >= 2)) || fail '--base-image requires an administrator-selected trusted image'
      base_image=$2
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
[[ ! -L "$node_bin" ]] || fail 'dedicated Node.js path must not be a symlink'

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
  tar cmp getent install loginctl runuser sha256sum sha512sum realpath find sort xargs useradd usermod passwd ps ip; do
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

if ! command -v docker >/dev/null; then
  step 'installing Docker from its signed official repository'
  if [[ "$package_manager" == apt-get ]]; then
    install -d -m 0755 /etc/apt/keyrings
    curl --fail --location --retry 3 --output /etc/apt/keyrings/qfli-docker.asc \
      https://download.docker.com/linux/ubuntu/gpg
    chmod 0644 /etc/apt/keyrings/qfli-docker.asc
    printf '%s\n' 'deb [arch=amd64 signed-by=/etc/apt/keyrings/qfli-docker.asc] https://download.docker.com/linux/ubuntu noble stable' \
      > /etc/apt/sources.list.d/qfli-docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-ce-rootless-extras
  else
    configure_al3_docker_repo
    dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-ce-rootless-extras
  fi
elif ! command -v dockerd-rootless-setuptool.sh >/dev/null; then
  if [[ "$package_manager" == apt-get ]]; then
    apt-get install -y docker-ce-rootless-extras
  else
    configure_al3_docker_repo
    dnf install -y docker-ce-rootless-extras
  fi
fi
for command in docker dockerd-rootless-setuptool.sh newuidmap newgidmap; do
  command -v "$command" >/dev/null || fail "rootless Docker prerequisite is missing: $command"
done

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
if [[ -n "$input_source" ]]; then
  input_source=$(realpath -- "$input_source")
fi
release_source=${input_source:-$source_dir}
for entry in "${release_entries[@]}"; do
  [[ -e "$release_source/$entry" ]] || fail "source directory is incomplete: missing $release_source/$entry"
done
for entry in src sandbox deployment test docs; do
  [[ -d "$release_source/$entry" ]] || fail "release entry must be a directory: $release_source/$entry"
done
for entry in package.json README.md .env.example src/server.js deployment/qfli-terminal.service \
  deployment/check-health.mjs deployment/verify-runtime.mjs sandbox/smoke-languages.sh \
  deployment/docker-daemon.json sandbox/Dockerfile; do
  [[ -f "$release_source/$entry" ]] || fail "release entry must be a file: $release_source/$entry"
done

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

if [[ "$release_source" != "$source_dir" ]]; then
  step 'checking release overwrite permissions before stopping the executor'
  [[ ! -L "$source_dir" ]] || fail "release directory must not be a symlink: $source_dir"
  if [[ -e "$source_dir" ]]; then
    [[ -d "$source_dir" ]] || fail "release destination must be a directory: $source_dir"
    as_runner test -O "$source_dir" && as_runner test -w "$source_dir" && \
      as_runner test -x "$source_dir" ||
      fail "release directory must be owned and writable by $runner: $source_dir; repair its ownership/permissions and rerun"
    for entry in "${release_entries[@]}"; do
      target="$source_dir/$entry"
      [[ -e "$target" || -L "$target" ]] || continue
      if [[ -d "$release_source/$entry" ]]; then
        [[ -d "$target" && ! -L "$target" ]] || fail "release destination must be a directory: $target"
      else
        [[ -f "$target" && ! -L "$target" ]] || fail "release destination must be a regular file: $target"
      fi
      # Tar changes directory metadata too, even when a root-owned path is writable.
      blocked=$(as_runner find "$target" -xdev \
        \( -type l -o ! -uid "$runner_uid" -o ! -writable -o \( -type d ! -executable \) \) \
        -print -quit) || fail "cannot inspect release destination as $runner: $target"
      [[ -z "$blocked" ]] ||
        fail "release overwrite blocked at $blocked; managed paths must be owned/writable by $runner, directories traversable, and symlinks absent; repair and rerun"
    done
  else
    as_runner install -d -m 0755 "$source_dir" || fail "cannot create release destination as $runner: $source_dir"
  fi
  release_stage_dir=$(mktemp -d /var/tmp/qfli-release.XXXXXXXX)
  tar -C "$release_source" -cf "$release_stage_dir/release.tar" "${release_entries[@]}" ||
    fail 'cannot archive the complete release; executor has not been stopped'
fi

step 'starting the dedicated user manager'
loginctl enable-linger "$runner"
systemctl start "user@$runner_uid.service"
source_fingerprint=$(
  cd "$release_source"
  find "${release_entries[@]}" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d " " -f1
)
receipt="$runner_home/.config/qfli-terminal/validated-source.sha256"
if as_runner systemctl --user is-active --quiet qfli-terminal.service; then
  installed_unit="$runner_home/.config/systemd/user/qfli-terminal.service"
  previous_fingerprint=$(as_runner cat "$receipt" 2>/dev/null || true)
  if [[ "$previous_fingerprint" == "$source_fingerprint" ]] && \
     [[ -z "$registry_mirror" && "$base_image" == debian:trixie-slim && \
        "$debian_mirror" == http://mirrors.tuna.tsinghua.edu.cn ]] && \
     cmp -s "$release_source/deployment/qfli-terminal.service" "$installed_unit"; then
    step 'this release already runs; checking authenticated health'
    as_runner "$node_bin" "$source_dir/deployment/check-health.mjs"
    as_runner systemctl --user enable qfli-terminal.service
    printf 'QFLI terminal setup: installed and enabled at boot\n'
    exit 0
  fi
fi
if as_runner systemctl --user cat qfli-terminal.service >/dev/null 2>&1; then
  step 'stopping the previous executor for verified upgrade'
  as_runner systemctl --user disable --now qfli-terminal.service
fi
if [[ "$release_source" != "$source_dir" ]]; then
  cat "$release_stage_dir/release.tar" | \
    as_runner tar -C "$source_dir" --no-same-owner -xf -
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
      runtime.runtimeArgs = ["--network=none", "--ignore-cgroups"];
      if (fixLogs) logs.compress = "false";
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      fs.renameSync(temp, file);
    }
  ' "$docker_config" ||
    fail 'fix the dedicated Docker configuration first'
fi

if [[ -n "$registry_mirror" ]]; then
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
as_runner systemctl --user restart docker.service
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

image_version=$(as_runner docker image inspect --format '{{index .Config.Labels "io.qfli.terminal.toolchains"}}' \
  "$sandbox_image" 2>/dev/null || true)
image_user=$(as_runner docker image inspect --format '{{.Config.User}}' "$sandbox_image" 2>/dev/null || true)
image_source=$(as_runner docker image inspect --format '{{index .Config.Labels "io.qfli.terminal.sandbox-source"}}' \
  "$sandbox_image" 2>/dev/null || true)
sandbox_fingerprint=$(
  cd "$source_dir"
  find sandbox -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d " " -f1
)
if [[ "$image_version" != 2 || "$image_user" != 65533:65533 || \
      "$image_source" != "$sandbox_fingerprint" ]]; then
  step 'building the trusted sandbox image; this can take several minutes'
  if ! as_runner timeout 300 docker pull "$base_image"; then
    [[ "$base_image" == debian:trixie-slim ]] || fail 'the selected trusted base image could not be pulled'
    step 'Docker Hub unavailable; trying the Google Docker Hub mirror'
    base_image=mirror.gcr.io/library/debian:trixie-slim
    as_runner timeout 300 docker pull "$base_image" || fail 'both official Debian image registries are unreachable'
  fi
  as_runner docker build --pull --progress=plain \
    --label "io.qfli.terminal.sandbox-source=$sandbox_fingerprint" \
    --build-arg "BASE_IMAGE=$base_image" \
    --build-arg "DEBIAN_MIRROR=$debian_mirror" \
    -t "$sandbox_image" "$source_dir/sandbox" ||
    fail 'sandbox build failed; if Docker Hub is unreachable, rerun with --registry-mirror and your trusted HTTPS Docker Hub accelerator'
fi

step 'configuring the executor user service'
config_dir="$runner_home/.config/qfli-terminal"
as_runner install -d -m 0700 "$config_dir"
printf 'QFLI_TERMINAL_SECRET=%s\nQFLI_TERMINAL_IMAGE=%s\n' \
  "$secret" "$sandbox_image" | as_runner sh -c '
      set -eu
      temp_env=$(mktemp "$HOME/.config/qfli-terminal/runner.env.XXXXXXXX")
      trap "rm -f -- \"$temp_env\"" EXIT
      cat > "$temp_env"
      chmod 0600 "$temp_env"
      mv -T -- "$temp_env" "$HOME/.config/qfli-terminal/runner.env"
    '
as_runner chmod 0600 "$runner_env"
unset secret
step 'verifying all toolchains in actual bounded gVisor sessions'
as_runner "$node_bin" --env-file="$runner_env" "$source_dir/deployment/verify-runtime.mjs" ||
  fail 'runtime/toolchain verification failed; executor remains stopped'
as_runner install -m 0644 \
  "$source_dir/deployment/qfli-terminal.service" \
  "$runner_home/.config/systemd/user/qfli-terminal.service"
as_runner systemctl --user daemon-reload
as_runner systemctl --user enable --now qfli-terminal.service

step 'waiting for the authenticated local health check'
for attempt in {1..10}; do
  if as_runner "$node_bin" "$source_dir/deployment/check-health.mjs" >/dev/null 2>&1; then
    as_runner "$node_bin" "$source_dir/deployment/check-health.mjs"
    printf '%s\n' "$source_fingerprint" | as_runner sh -c 'umask 077; cat > "$1"' sh "$receipt"
    printf 'QFLI terminal setup: installed and enabled at boot\n'
    exit 0
  fi
  sleep 2
done
as_runner journalctl --user -u qfli-terminal.service -n 80 --no-pager || true
as_runner systemctl --user disable --now qfli-terminal.service
fail 'the executor did not become healthy; inspect the service log above'
