import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const dockerfile = read('Dockerfile');
const compose = read('docker-compose.yaml');
const buildCompose = read('docker-compose.build.yaml');
const bootstrap = read('deployment/bootstrap.sh');
const unit = read('deployment/qfli-terminal-compose.service');
const config = read('src/config.js');
const docker = read('src/docker.js');
const server = read('src/server.js');
const sessions = read('src/sessions.js');

test('container image resolves the Docker CLI at the path the executor spawns', () => {
  assert.match(dockerfile, /COPY --from=dockercli \/usr\/local\/bin\/docker \/usr\/bin\/docker/);
  assert.match(docker, /spawn\('\/usr\/bin\/docker'/);
  assert.match(dockerfile, /FROM docker:[\d.]+-cli AS dockercli/);
});

test('production compose only pulls images and never builds them', () => {
  for (const body of [compose]) {
    assert.doesNotMatch(body, /^\s+build:/m);
    assert.doesNotMatch(body, /^\s+depends_on:/m);
  }
  assert.match(buildCompose, /^\s+build:/m);
});

test('executor and updater use separate, non-privileged service definitions', () => {
  assert.doesNotMatch(compose, /start-period:/);
  assert.match(compose, /start_period:/);
  assert.match(compose, /watchtower\.scope: qfli-terminal/);
  assert.match(compose, /watchtower\.enable: "\$\{QFLI_TERMINAL_AUTO_UPDATE:-true\}"/);
  assert.doesNotMatch(compose, /privileged:\s*true/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /mem_limit:/);
  assert.match(compose, /pids_limit:/);
  assert.match(compose, /cpus:/);
  assert.match(compose, /healthcheck:/);
});

test('executor shares the host cgroup namespace for host PID membership checks', () => {
  assert.match(compose, /\n\s+cgroup: host\n/);
  assert.match(compose, /\n\s+pid: host\n/);
});

test('only the dedicated rootless socket enters the terminal stack', () => {
  assert.match(compose, /\/run\/user\/\$\{QFLI_RUNNER_HOST_UID\}\/docker\.sock:\/var\/run\/docker\.sock/);
  assert.doesNotMatch(compose, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  assert.match(compose, /\/sys\/fs\/cgroup:\/host\/cgroup:ro/);
  assert.match(compose, /127\.0\.0\.1:3101:3101/);
});

test('container mode proves the rootless mapping and host slice ownership', () => {
  assert.match(config, /QFLI_TERMINAL_CONTAINER/);
  assert.match(config, /uid_map/);
  assert.match(config, /executor_requires_rootless_userns/);
  assert.match(config, /hostUid/);
  assert.match(docker, /user-\$\{this\.config\.hostUid\}\.slice/);
  assert.doesNotMatch(docker, /user-\$\{this\.config\.uid\}\.slice/);
});

test('executor binds wildcard only inside a container and keeps host loopback', () => {
  assert.match(server, /const listenHost = config\.container \? '0\.0\.0\.0' : '127\.0\.0\.1';/);
  assert.match(server, /server\.listen\(3101, listenHost/);
  assert.doesNotMatch(server, /server\.listen\(3101, '127\.0\.0\.1'/);
});

test('health reports bounded capacity counters without identifiers', () => {
  assert.match(sessions, /sessionsLimit: limits\.sessions/);
  assert.match(sessions, /runningLimit: limits\.running/);
  assert.match(sessions, /queueLimit: limits\.waiting/);
  assert.match(server, /capacity: sessions\.capacity\(\)/);
  const capacity = sessions.slice(sessions.indexOf('capacity()'), sessions.indexOf('async initialize'));
  assert.doesNotMatch(capacity, /userId|command|secret/);
});

test('bootstrap pulls images, verifies with the node entrypoint and never builds', () => {
  assert.doesNotMatch(bootstrap, /docker build/);
  assert.match(bootstrap, /docker pull "\$sandbox_image"/);
  assert.match(bootstrap, /docker pull "\$executor_image"/);
  assert.match(bootstrap, /--entrypoint node executor deployment\/verify-runtime\.mjs/);
  assert.match(bootstrap, /io\.qfli\.terminal\.toolchains/);
});

test('executor fences the shared engine with a runtime lock, not a netns port', () => {
  const sessionsSource = read('src/sessions.js');
  const verify = read('deployment/verify-runtime.mjs');
  assert.match(sessionsSource, /import \{ acquireInstanceLock \} from '\.\/lock\.js'/);
  assert.ok(sessionsSource.indexOf('acquireInstanceLock(this.config.runtimeDir)') <
    sessionsSource.indexOf('validateEngine'), 'the fence must precede engine reconciliation');
  assert.match(sessionsSource, /releaseLock\?\.\(\)/);
  assert.match(read('src/config.js'), /executor_requires_host_pid_namespace/);
  assert.doesNotMatch(verify, /createServer|listen\(3101/);
  assert.match(verify, /await sessions\.initialize\(\)/);
});

test('rollback pins the previous immutable image IDs recorded before the pull', () => {
  const record = bootstrap.indexOf("step 'recording the previous immutable image state'");
  const pull = bootstrap.indexOf("step 'pulling the prebuilt sandbox and executor images'");
  assert.ok(record > 0 && record < pull, 'previous IDs must be recorded before pulling');
  assert.match(bootstrap, /previous_executor_id=\$\{?as_runner docker inspect|previous_executor_id=\$\(as_runner docker inspect/);
  assert.match(bootstrap, /previous_sandbox_id=\$\(as_runner docker image inspect/);
  assert.match(bootstrap, /pinned_service=\$\{previous_executor_id/);
  assert.match(bootstrap, /pinned_sandbox=\$\{previous_sandbox_id/);
});

test('prerelease tags never move latest or the stable sandbox tag', () => {
  const ci = read('.cnb.yml');
  assert.match(ci, /case "\$VERSION" in\s*\n\s*\*-\*\)/);
  assert.match(ci, /if \[ "\$STABLE" = 1 \]; then/);
  const tagStage = ci.slice(ci.indexOf('build-and-push-tag'));
  assert.ok(tagStage.indexOf('$SANDBOX_IMAGE:3') > tagStage.indexOf('if [ "$STABLE" = 1 ]'),
    'the stable sandbox tag is only pushed inside the stable branch');
});

test('installed release keeps every deployment file the rerun needs', () => {
  const declared = bootstrap.slice(bootstrap.indexOf('release_entries=('), bootstrap.indexOf(')', bootstrap.indexOf('release_entries=(')));
  const used = new Set([...bootstrap.matchAll(/compose (?:(?:exec|run)[^\n]*?)(deployment\/[\w.-]+)/g)].map(match => match[1]));
  assert.ok(used.size >= 2, 'expected health and verification entry points');
  for (const entry of used) assert.ok(declared.includes(entry), `release_entries is missing ${entry}`);
});

test('resource limits survive a reboot through a persistent slice drop-in', () => {
  const dropin = '/etc/systemd/system/user-$runner_uid.slice.d/50-qfli-limits.conf';
  assert.ok(bootstrap.includes(dropin), 'bootstrap must write the persistent drop-in');
  const start = bootstrap.indexOf('cat > "/etc/systemd/system/user-$runner_uid.slice.d/50-qfli-limits.conf"');
  const end = bootstrap.indexOf("QFLI_SLICE\nsystemctl daemon-reload");
  assert.ok(start > 0 && end > start, 'bootstrap must write the drop-in before reloading systemd');
  const block = bootstrap.slice(start, end);
  for (const key of ['CPUQuota=100%', 'MemoryMax=1G', 'MemorySwapMax=0', 'TasksMax=1024']) {
    assert.ok(block.includes(key), `drop-in is missing ${key}`);
  }
});

test('every inline sh -c body that reads $1 receives an argv0 placeholder', () => {
  const blocks = [...bootstrap.matchAll(/sh -c '([\s\S]*?)'\s+(\S[^\n]*)/g)];
  for (const [, body, args] of blocks) {
    if (/\$1/.test(body)) {
      assert.match(args.trim(), /^sh\s/, `missing argv0 placeholder before ${args.trim()}`);
    }
  }
});

test('bootstrap preflights before touching services and restarts Docker only on change', () => {
  const preflight = bootstrap.indexOf("step 'preparing the compose project directory'");
  const secret = bootstrap.indexOf('# Resolve the shared executor secret');
  const restart = bootstrap.indexOf('as_runner systemctl --user restart docker.service');
  const stop = bootstrap.indexOf("step 'stopping the previous executor'");
  assert.ok(secret > 0 && preflight > secret, 'secret check must precede the target preflight');
  assert.ok(restart > preflight, 'Docker restart must follow the preflight');
  assert.ok(stop > restart, 'stopping the old stack must follow the Docker checks');
  assert.match(bootstrap, /if \(\(docker_changed\)\) \|\| \(\(!docker_active\)\); then/);
  assert.match(bootstrap, /nothing to change/);
  assert.match(unit, /ExecStart=.*docker compose.*up -d/);
});
