import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imagePlan } from '../scripts/ci-common.mjs';

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
  assert.match(compose, /127\.0\.0\.1:\$\{QFLI_TERMINAL_HOST_PORT:-3101\}:3101/);
});

test('the published host port is configurable while the process port stays 3101', () => {
  const mapping = compose.match(/^\s+- "([^"]*:[^"\n]+)"$/m);
  assert.ok(mapping, 'the executor must publish exactly one port mapping');
  const published = mapping[1];
  assert.match(published, /^127\.0\.0\.1:\$\{QFLI_TERMINAL_HOST_PORT:-3101\}:3101$/);
  // The default must come from `:-`, so an empty value still yields 3101.
  assert.ok(published.includes(':-3101'), 'an empty QFLI_TERMINAL_HOST_PORT must fall back to 3101');
  assert.ok(published.endsWith(':3101'), 'the container port is fixed at 3101');
  assert.doesNotMatch(compose, /QFLI_TERMINAL_HOST_PORT[^\n]*0\.0\.0\.0/);
  // The process keeps listening on 3101 whatever the host port is.
  assert.match(server, /server\.listen\(3101, listenHost/);
  assert.match(read('deployment/check-health.mjs'), /127\.0\.0\.1:3101\/health/);
  assert.doesNotMatch(read('deployment/check-health.mjs'), /QFLI_TERMINAL_HOST_PORT/);
});

test('the updater runs only in the auto-update profile', () => {
  const executor = compose.slice(0, compose.indexOf('  watchtower:'));
  const updater = compose.slice(compose.indexOf('  watchtower:'));
  assert.doesNotMatch(executor, /^\s+profiles:/m, 'the executor must not sit behind a profile');
  assert.match(updater, /^\s+profiles:\s*\n\s+- auto-update\s*$/m);
  // Both stacks keep separate scopes and the updater still gets only the
  // dedicated rootless socket.
  assert.match(updater, /watchtower\.scope: qfli-terminal/);
  assert.match(updater, /\/run\/user\/\$\{QFLI_RUNNER_HOST_UID\}\/docker\.sock:\/var\/run\/docker\.sock/);
});

test('.env.example documents the port default and the updater opt-in', () => {
  const envExample = read('.env.example');
  assert.match(envExample, /^# QFLI_TERMINAL_HOST_PORT=3101$/m);
  assert.match(envExample, /^# COMPOSE_PROFILES=auto-update$/m);
  assert.match(envExample, /^QFLI_RUNNER_HOST_UID=$/m);
});

// --- Compose CLI evidence ---------------------------------------------------
// The static assertions above run everywhere. When a Compose CLI is available,
// also let Compose itself render the project so the real interpolation,
// default and profile gating are proven. Set QFLI_COMPOSE_BIN to a standalone
// `docker-compose` binary; otherwise the `docker compose` plugin is used.

function resolveCompose() {
  const standalone = process.env.QFLI_COMPOSE_BIN;
  if (standalone) {
    try {
      execFileSync(standalone, ['version'], { stdio: 'ignore' });
      return { bin: standalone, prefix: [] };
    } catch {
      return null;
    }
  }
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return { bin: 'docker', prefix: ['compose'] };
  } catch {
    return null;
  }
}

const composeCli = resolveCompose();
const sourceDir = fileURLToPath(new URL('../', import.meta.url));

// Compose needs a real project directory: the stack declares `env_file: .env`
// and Compose refuses to render without it. Build a throwaway fixture that
// holds a copy of the production compose file and a synthetic `.env`.
function fixtureDir(env) {
  const dir = mkdtempSync(path.join(tmpdir(), 'qfli-compose-'));
  copyFileSync(path.join(sourceDir, 'docker-compose.yaml'), path.join(dir, 'docker-compose.yaml'));
  const lines = [
    'QFLI_RUNNER_HOST_UID=1000',
    'QFLI_TERMINAL_SECRET=test-secret-not-real',
    'QFLI_TERMINAL_IMAGE=docker.cnb.cool/azurekiln/azurekiln-qfli-terminal/sandbox:3',
    'QFLI_TERMINAL_SERVICE_IMAGE=docker.cnb.cool/azurekiln/azurekiln-qfli-terminal:latest',
  ];
  if (env.QFLI_TERMINAL_HOST_PORT !== undefined) {
    lines.push(`QFLI_TERMINAL_HOST_PORT=${env.QFLI_TERMINAL_HOST_PORT}`);
  }
  writeFileSync(path.join(dir, '.env'), `${lines.join('\n')}\n`);
  return dir;
}

function composeRun(dir, env, args) {
  const dirEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? process.env.USERPROFILE ?? '',
    // The profile is an environment opt-in, not an .env default.
    ...(env.COMPOSE_PROFILES ? { COMPOSE_PROFILES: env.COMPOSE_PROFILES } : {}),
  };
  return execFileSync(
    composeCli.bin,
    [
      ...composeCli.prefix,
      '--project-directory',
      dir,
      '--env-file',
      path.join(dir, '.env'),
      ...args,
    ],
    { encoding: 'utf8', env: dirEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function withFixture(env, run) {
  const dir = fixtureDir(env);
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function composeConfig(env = {}) {
  return withFixture(env, dir => JSON.parse(composeRun(dir, env, ['config', '--format', 'json'])));
}

function composeServices(env = {}) {
  return withFixture(env, dir => composeRun(dir, env, ['config', '--services']));
}

function publishedPorts(rendered, service) {
  const ports = rendered.services?.[service]?.ports ?? [];
  return ports.map(port => `${port.host_ip}:${port.published}:${port.target}`);
}

test('compose renders the loopback port 3101 by default', { skip: !composeCli }, () => {
  const rendered = composeConfig();
  assert.deepEqual(publishedPorts(rendered, 'executor'), ['127.0.0.1:3101:3101']);
});

test('compose moves only the host port when QFLI_TERMINAL_HOST_PORT is set', { skip: !composeCli }, () => {
  const rendered = composeConfig({ QFLI_TERMINAL_HOST_PORT: '3200' });
  assert.deepEqual(publishedPorts(rendered, 'executor'), ['127.0.0.1:3200:3101']);
});

test('a custom host port reaches the rendered project through .env', { skip: !composeCli }, () => {
  // The installer persists --port in `.env`; Compose must read it from there.
  const rendered = composeConfig({ QFLI_TERMINAL_HOST_PORT: '4100' });
  assert.deepEqual(publishedPorts(rendered, 'executor'), ['127.0.0.1:4100:3101']);
  assert.equal(rendered.services.executor.environment.QFLI_TERMINAL_CGROUP_ROOT, '/host/cgroup');
});

test('compose rejects a non-numeric host port', { skip: !composeCli }, () => {
  assert.throws(() => composeConfig({ QFLI_TERMINAL_HOST_PORT: 'not-a-port' }));
});

test('the updater is absent by default and present with COMPOSE_PROFILES=auto-update', { skip: !composeCli }, () => {
  const off = composeServices();
  const on = composeServices({ COMPOSE_PROFILES: 'auto-update' });
  assert.doesNotMatch(off, /watchtower/);
  assert.match(on, /watchtower/);
  assert.match(on, /executor/);
});

test('the executor and its scopes survive both profile settings', { skip: !composeCli }, () => {
  for (const env of [{}, { COMPOSE_PROFILES: 'auto-update' }]) {
    const rendered = composeConfig(env);
    const executor = rendered.services.executor;
    assert.equal(executor.read_only, true);
    assert.ok(executor.pid === 'host' && executor.cgroup === 'host');
    assert.ok(executor.cap_drop.includes('ALL'));
    assert.equal(executor.labels['com.centurylinklabs.watchtower.scope'], 'qfli-terminal');
    assert.ok(executor.mem_limit && executor.cpus && executor.pids_limit);
    assert.equal(
      executor.volumes.some(volume => volume.source === '/run/user/1000'),
      true,
      'the executor needs the dedicated rootless runtime directory',
    );
    assert.equal(rendered.services.watchtower !== undefined, Boolean(env.COMPOSE_PROFILES));
    if (env.COMPOSE_PROFILES) {
      const updater = rendered.services.watchtower;
      assert.equal(updater.labels['com.centurylinklabs.watchtower.scope'], 'qfli-terminal');
      assert.equal(updater.labels['com.centurylinklabs.watchtower.enable'], 'false');
      assert.equal(updater.volumes[0].source, '/run/user/1000/docker.sock');
      assert.equal(updater.volumes[0].target, '/var/run/docker.sock');
    }
  }
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
  assert.match(ci, /scripts\/ci-common\.mjs publish[\s\S]*--ref "refs\/tags\/\$\{CNB_BRANCH\}"/);
  const pre = imagePlan({
    platform: 'cnb',
    repository: 'azurekiln/azurekiln-qfli-terminal',
    ref: 'refs/tags/v1.0.0-rc.1',
    revision: 'a1b2c3d4e5f6',
  });
  assert.equal(pre.latest, false);
  assert.equal(pre.sandboxChannel, null);
  assert.equal(pre.sandboxTag, 'v1.0.0-rc.1-sandbox');

  const stable = imagePlan({
    platform: 'cnb',
    repository: 'azurekiln/azurekiln-qfli-terminal',
    ref: 'refs/tags/v1.0.0',
    revision: 'a1b2c3d4e5f6',
  });
  assert.equal(stable.latest, true);
  assert.equal(stable.sandboxChannel, '3');
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
