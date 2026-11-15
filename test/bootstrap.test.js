// Behavioral regression tests for deployment/bootstrap.sh.
//
// These tests never run the privileged installer. They exercise the real
// script two ways:
//   1. as a process, for argument parsing and --help (no host access);
//   2. by sourcing it, which only defines functions, and then calling the
//      real implementations with real filesystem fixtures.
//
// Anything that needs root, systemd, cgroups or Docker belongs to the
// installed-host script (test/bootstrap-upgrade.sh), not here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP = join(ROOT, 'deployment', 'bootstrap.sh');

// The release files the installer copies. Mirrors release_entries in the
// script on purpose: a missing entry here must fail loudly, not silently
// pass with a smaller fixture.
const RELEASE_ENTRIES = [
  'docker-compose.yaml',
  '.env.example',
  'deployment/docker-daemon.json',
  'deployment/qfli-terminal-compose.service',
  'deployment/check-health.mjs',
  'deployment/verify-runtime.mjs',
];

const IS_WINDOWS = process.platform === 'win32';

/** Locate a bash that can run the real script. */
function findBash() {
  const candidates = [
    process.env.QFLI_TEST_BASH,
    ...(IS_WINDOWS
      ? [
          'D:/ProgramFiles/Git/bin/bash.exe',
          'C:/Program Files/Git/bin/bash.exe',
          'C:/Program Files (x86)/Git/bin/bash.exe',
        ]
      : []),
    'bash',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-c', 'echo ok'], { encoding: 'utf8' });
    if (result.status === 0 && (result.stdout ?? '').trim() === 'ok') return candidate;
  }
  return null;
}

const BASH = findBash();
const skip = !BASH && `no usable bash found (set QFLI_TEST_BASH); platform ${process.platform}`;

/**
 * Convert a Windows path to the form Git Bash (MSYS) sees, so fixtures can be
 * passed as arguments: D:\\a\\b becomes /d/a/b. Identity elsewhere.
 */
function bashPath(value) {
  const text = String(value);
  if (!IS_WINDOWS) return text;
  const drive = text.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!drive) return text;
  return `/${drive[1].toLowerCase()}/${drive[2].replaceAll('\\', '/')}`;
}

/** Quote a string for safe use inside a bash script. */
const shq = value => `'${bashPath(value).replaceAll("'", `'\\''`)}'`;

/** Convert a bash-visible path (/d/a/b) back to a Node filesystem path. */
function nodePath(value) {
  const text = String(value).trim();
  if (!IS_WINDOWS) return text;
  const msys = text.match(/^\/([A-Za-z])\/(.*)$/);
  if (!msys) return text;
  return `${msys[1].toUpperCase()}:\\${msys[2].replaceAll('/', '\\')}`;
}

/** Bash prints paths as it received them; compare them in one normal form. */
const slashed = value => String(value).trim().replaceAll('\\', '/');

const temps = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** Write a complete, path-marked release checkout. */
function releaseCheckout(entries = RELEASE_ENTRIES) {
  const dir = tempDir('qfli-bootstrap-checkout-');
  for (const entry of entries) {
    const target = join(dir, entry);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `content of ${entry} from ${dir}\n`);
  }
  return dir;
}

/**
 * Run a body of bash that sourced the real bootstrap script.
 *
 * Sourcing must only define functions: the script is expected to guard its
 * top-level flow with the usual `BASH_SOURCE == $0` idiom. The harness
 * restores the invoking environment afterwards because the script sets its
 * own PATH, umask and errexit flags.
 */
function sourced(body, { env = {}, cwd = ROOT } = {}) {
  const harness = join(tempDir('qfli-bootstrap-harness-'), 'exercise.sh');
  writeFileSync(
    harness,
    [
      'set -u',
      'ORIGINAL_PATH=$PATH',
      `BOOTSTRAP=${shq(BOOTSTRAP)}`,
      '. "$BOOTSTRAP"',
      'set +e +u',
      'umask 022',
      'PATH=$ORIGINAL_PATH',
      'export PATH',
      body,
      '',
    ].join('\n'),
  );
  return spawnSync(BASH, ['--noprofile', '--norc', harness], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? process.env.USERPROFILE ?? tmpdir(),
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      ...env,
    },
  });
}

/** Run a body and fail with the captured output when it exits non-zero. */
function sourcedOk(body, options) {
  const result = sourced(body, options);
  assert.equal(result.status, 0, `bash failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** Assert a helper is defined; otherwise say exactly what is missing. */
function requireFunction(name) {
  const probe = sourced(`type -t ${name}`, {});
  if (probe.status !== 0) {
    assert.fail(
      `deployment/bootstrap.sh does not define ${name}(). ` +
        'Sourcing must define functions without running the installer. ' +
        `bash said: ${probe.stderr.trim()}`,
    );
  }
}

function functionOutput(name, body) {
  requireFunction(name);
  return sourcedOk(body).stdout.trim();
}

// ---------------------------------------------------------------------------
// Command line, exercised as a real process
// ---------------------------------------------------------------------------

test('--help exits zero and documents every flag, including the new ones', { skip }, () => {
  const result = spawnSync(BASH, [BOOTSTRAP, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const help = `${result.stdout}${result.stderr}`;
  for (const flag of [
    '--source-dir',
    '--business-env',
    '--registry-mirror',
    '--sandbox-image',
    '--executor-image',
    '--port',
    '--watchtower-image',
    '--no-auto-update',
  ]) {
    assert.match(help, new RegExp(flag.replace('-', '\\-')), `--help must document ${flag}`);
  }
});

test('a flag without its value is rejected before any host work', { skip }, () => {
  for (const flag of ['--port', '--watchtower-image', '--sandbox-image', '--source-dir']) {
    const result = spawnSync(BASH, [BOOTSTRAP, flag], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, `${flag} without a value must fail`);
    assert.match(result.stderr, new RegExp(flag.replaceAll('-', '\\-')), result.stderr);
  }
});

test('an unknown flag is rejected with the usage text', { skip }, () => {
  const result = spawnSync(BASH, [BOOTSTRAP, '--definitely-not-a-flag'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown option/);
  assert.match(result.stderr, /Usage:/);
});

/**
 * Build a copy of the installer whose host guard refuses unconditionally.
 *
 * Real argument parsing and the real port validation still run, but the copy
 * can never install, restart or reconfigure anything: the root check is the
 * last step before any host work, and here it always stops the run. The copy
 * also cannot start real work when the suite itself runs as root.
 */
function guardedInstaller() {
  const dir = tempDir('qfli-bootstrap-guard-');
  const copy = join(dir, 'bootstrap.sh');
  const original = readFileSync(BOOTSTRAP, 'utf8');
  const guard = /^\(\(EUID == 0\)\) \|\| fail '[^']*'$/m;
  const matches = original.match(new RegExp(guard.source, 'gm')) ?? [];
  assert.equal(matches.length, 1, 'the root guard must appear exactly once');
  writeFileSync(copy, original.replace(guard, "fail 'host-guard-reached'"));
  return copy;
}

test('all image, source and port flags are optional', { skip }, () => {
  const result = spawnSync(BASH, [guardedInstaller()], { encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'the test fixture must stop before host work');
  assert.match(result.stderr, /host-guard-reached/);
  assert.doesNotMatch(result.stderr, /requires|--port must|invalid .*image/);
  assert.doesNotMatch(result.stdout, /preparing host packages|starting the dedicated user manager/);
});

// Pure command-line validation runs before the root and OS guards, so these
// cases are observable without privileges on any platform.
test('an out-of-range --port is rejected before the root and OS guards', { skip }, () => {
  const installer = guardedInstaller();
  for (const port of ['1023', '65536', '0', 'abc', '3101a', '']) {
    const result = spawnSync(BASH, [installer, '--port', port], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, `--port ${port} must be rejected`);
    assert.match(
      result.stderr,
      /--port must be an integer between 1024 and 65535/,
      `--port ${port} gave: ${result.stderr}`,
    );
    // The value is refused before anything about the host matters.
    assert.doesNotMatch(
      result.stderr,
      /run this installer as root|host-guard-reached|supported hosts:/,
      `--port ${port}`,
    );
    assert.doesNotMatch(result.stdout, /preparing host packages|starting the dedicated user manager/);
  }
});

test('an in-range --port passes the port check and reaches the host guard', { skip }, () => {
  const installer = guardedInstaller();
  for (const port of ['1024', '3101', '65535']) {
    const result = spawnSync(BASH, [installer, '--port', port], { encoding: 'utf8' });
    assert.doesNotMatch(
      result.stderr,
      /--port must be an integer between 1024 and 65535/,
      `--port ${port} was wrongly rejected: ${result.stderr}`,
    );
    // The value survives validation and the run stops at the host guard, which
    // the fixture turned into an unconditional refusal.
    assert.match(result.stderr, /host-guard-reached/, `--port ${port} did not reach the host guard`);
    assert.doesNotMatch(result.stdout, /preparing host packages|starting the dedicated user manager/);
  }
});

// ---------------------------------------------------------------------------
// Port resolution and persistence
// ---------------------------------------------------------------------------

test('qfli_validate_port accepts the contractual range only', { skip }, () => {
  requireFunction('qfli_validate_port');
  const good = sourcedOk('for value in 1024 3101 65535; do qfli_validate_port "$value" || exit 9; done; echo all-ok');
  assert.equal(good.status, 0);
  assert.match(good.stdout, /all-ok/);
  for (const bad of ['1023', '65536', '0', 'abc', '', '3101 ', '9999999999']) {
    const result = sourced(`qfli_validate_port ${shq(bad)}`);
    assert.notEqual(result.status, 0, `qfli_validate_port ${JSON.stringify(bad)} must fail`);
    assert.equal(result.stdout.trim(), '', `qfli_validate_port ${JSON.stringify(bad)} must stay silent`);
  }
});

test('qfli_host_port prefers the flag, then the installed env, then 3101', { skip }, () => {
  requireFunction('qfli_host_port');
  requireFunction('read_env_value');
  const env = join(tempDir('qfli-port-env-'), '.env');
  writeFileSync(env, 'QFLI_TERMINAL_SECRET=aa\nQFLI_TERMINAL_HOST_PORT=4200\n');

  // Overrides are passed explicitly so the test does not depend on shell
  // globals leaking out of main().
  assert.equal(functionOutput('qfli_host_port', `input_port=5000; qfli_host_port ${shq(env)}`), '5000');
  assert.equal(functionOutput('qfli_host_port', `input_port=''; qfli_host_port ${shq(env)}`), '4200');
  assert.equal(functionOutput('qfli_host_port', "input_port=''; qfli_host_port ''"), '3101');

  const noKey = join(tempDir('qfli-port-nokey-'), '.env');
  writeFileSync(noKey, 'QFLI_TERMINAL_SECRET=aa\n');
  assert.equal(functionOutput('qfli_host_port', `input_port=''; qfli_host_port ${shq(noKey)}`), '3101');

  // A rejected flag value must not silently become the default.
  assert.notEqual(sourced("input_port=1023; qfli_host_port ''").status, 0);
});

test('an invalid installed host port is rejected, not reused', { skip }, () => {
  requireFunction('qfli_host_port');
  const env = join(tempDir('qfli-port-bad-'), '.env');
  writeFileSync(env, 'QFLI_TERMINAL_HOST_PORT=99\nQFLI_TERMINAL_AUTO_UPDATE=true\n');
  const result = sourced(`input_port=''; qfli_host_port ${shq(env)}`);
  assert.notEqual(result.status, 0, 'an out-of-range persisted port must be rejected');
  assert.doesNotMatch(result.stdout, /^99$/m);
});

test('the rendered env carries the persisted host port', { skip }, () => {
  requireFunction('qfli_render_env');
  const secret = 'a'.repeat(64);
  const rendered = functionOutput(
    'qfli_render_env',
    `qfli_render_env ${shq(secret)} registry.example/sandbox:3 registry.example/executor:1 1001 4321 true auto-update nickfedor/watchtower:1.23.2`,
  );
  const parsed = Object.fromEntries(
    rendered
      .split('\n')
      .filter(line => line.includes('='))
      .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  assert.equal(parsed.QFLI_TERMINAL_HOST_PORT, '4321');
  assert.equal(parsed.QFLI_TERMINAL_IMAGE, 'registry.example/sandbox:3');
  assert.equal(parsed.QFLI_TERMINAL_SERVICE_IMAGE, 'registry.example/executor:1');
  assert.equal(parsed.QFLI_TERMINAL_WATCHTOWER_IMAGE, 'nickfedor/watchtower:1.23.2');
  assert.equal(parsed.QFLI_RUNNER_HOST_UID, '1001');
  assert.equal(parsed.QFLI_TERMINAL_AUTO_UPDATE, 'true');
  assert.equal(parsed.COMPOSE_PROFILES, 'auto-update');
  assert.equal(parsed.QFLI_TERMINAL_SECRET, secret);
});

test('the rendered env disables the updater profile when asked', { skip }, () => {
  requireFunction('qfli_render_env');
  const secret = 'b'.repeat(64);
  const rendered = functionOutput(
    'qfli_render_env',
    `qfli_render_env ${shq(secret)} s:3 e:1 1001 3101 false '' w:1`,
  );
  assert.match(rendered, /^QFLI_TERMINAL_AUTO_UPDATE=false$/m);
  assert.match(rendered, /^COMPOSE_PROFILES=$/m);
  // The port keeps its default even when only the updater is disabled.
  assert.match(rendered, /^QFLI_TERMINAL_HOST_PORT=3101$/m);
});

// ---------------------------------------------------------------------------
// Source discovery and staging
// ---------------------------------------------------------------------------

test('qfli_discover_source prefers explicit, then cwd, then the script checkout, then installed', { skip }, () => {
  requireFunction('qfli_discover_source');
  const makeScript = dir => {
    const script = join(dir, 'deployment', 'bootstrap.sh');
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, '# fixture\n');
    return script;
  };
  const explicit = releaseCheckout();
  const cwdCheckout = releaseCheckout();
  const scriptCheckout = releaseCheckout();
  const scriptPath = makeScript(scriptCheckout);
  const installed = releaseCheckout();
  const empty = tempDir('qfli-empty-cwd-');

  const call = (source, cwd, script, fallback) =>
    slashed(
      functionOutput(
        'qfli_discover_source',
        `input_source=${shq(source)}; qfli_discover_source ${shq(cwd)} ${shq(script)} ${shq(fallback)}`,
      ),
    );

  // Explicit wins over every automatic candidate.
  assert.equal(call(explicit, cwdCheckout, scriptPath, installed), slashed(bashPath(explicit)));
  // A complete checkout in the working directory wins over the script's own.
  assert.equal(call('', cwdCheckout, scriptPath, installed), slashed(bashPath(cwdCheckout)));
  // Not a checkout here: the one next to the script is used.
  assert.equal(call('', empty, scriptPath, installed), slashed(bashPath(scriptCheckout)));
  // Neither is usable: the installed project is the last resort.
  assert.equal(
    call('', empty, join(empty, 'deployment', 'bootstrap.sh'), installed),
    slashed(bashPath(installed)),
  );
});

test('qfli_discover_source reports an incomplete explicit source instead of guessing', { skip }, () => {
  requireFunction('qfli_discover_source');
  requireFunction('qfli_release_incomplete');
  const partial = releaseCheckout(RELEASE_ENTRIES.filter(entry => entry !== 'deployment/verify-runtime.mjs'));
  const healthy = releaseCheckout();
  // An explicit source is returned as given; the caller then names the missing
  // entry, so the operator learns what to fix instead of getting a silent
  // fallback to another checkout.
  const chosen = functionOutput(
    'qfli_discover_source',
    `input_source=${shq(partial)}; qfli_discover_source ${shq(healthy)} '' ''`,
  );
  assert.equal(slashed(chosen), slashed(bashPath(partial)));
  const missing = functionOutput('qfli_release_incomplete', `qfli_release_incomplete ${shq(partial)}`);
  assert.equal(missing, 'deployment/verify-runtime.mjs');
  assert.notEqual(
    sourced(`qfli_release_incomplete ${shq(healthy)}`).status,
    0,
    'a complete release must not report a missing entry',
  );
});

test('qfli_discover_source fails when nothing is complete', { skip }, () => {
  requireFunction('qfli_discover_source');
  const empty = tempDir('qfli-empty-all-');
  const result = sourced(`input_source=''; qfli_discover_source ${shq(empty)} ${shq(empty)} ''`);
  assert.notEqual(result.status, 0, 'no complete candidate means no source');
  assert.equal(result.stdout.trim(), '');
});

test('qfli_stage_release copies only the allowlisted release files', { skip }, () => {
  requireFunction('qfli_stage_release');
  const source = releaseCheckout();
  // Files that must never be staged.
  writeFileSync(join(source, '.env'), 'QFLI_TERMINAL_SECRET=leak\n');
  writeFileSync(join(source, 'notes.txt'), 'private\n');
  mkdirSync(join(source, '.git'));
  writeFileSync(join(source, '.git', 'config'), 'private\n');
  mkdirSync(join(source, 'secrets'));
  writeFileSync(join(source, 'secrets', 'key'), 'private\n');

  const printed = functionOutput(
    'qfli_stage_release',
    `qfli_stage_release ${shq(source)} ${shq(tempDir('qfli-stage-parent-'))}`,
  );
  const stagedDir = nodePath(printed.split('\n').pop());
  assert.ok(existsSync(stagedDir), `staged directory missing: ${stagedDir}`);
  temps.push(stagedDir);

  const found = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  walk(stagedDir);
  const relative = found.map(file => file.slice(stagedDir.length + 1).replaceAll('\\', '/')).sort();
  assert.deepEqual(relative, [...RELEASE_ENTRIES].sort());
  // Staged copies are byte-identical to the source, so the runner installs the
  // exact file the operator reviewed.
  for (const entry of RELEASE_ENTRIES) {
    assert.equal(readFileSync(join(stagedDir, entry), 'utf8'), readFileSync(join(source, entry), 'utf8'), entry);
  }
});

test('qfli_stage_release refuses an incomplete source and copies nothing', { skip }, () => {
  requireFunction('qfli_stage_release');
  const partial = releaseCheckout(RELEASE_ENTRIES.filter(entry => entry !== 'docker-compose.yaml'));
  const result = sourced(`qfli_stage_release ${shq(partial)}`);
  assert.notEqual(result.status, 0, 'staging a partial release must fail');
  assert.equal(result.stdout.trim(), '', 'nothing may be printed for a rejected source');
});

// ---------------------------------------------------------------------------
// cgroup delegation
// ---------------------------------------------------------------------------

test('the delegation drop-in asks for cpuset only on systemd 244 or newer', { skip }, () => {
  requireFunction('qfli_delegation_dropin');
  const old = functionOutput('qfli_delegation_dropin', 'qfli_delegation_dropin 239');
  assert.match(old, /\[Service\]/);
  assert.match(old, /Delegate=cpu io memory pids/);
  assert.doesNotMatch(old, /cpuset/, 'systemd 239 rejects cpuset in Delegate=');

  for (const version of ['244', '255']) {
    const modern = functionOutput('qfli_delegation_dropin', `qfli_delegation_dropin ${version}`);
    assert.match(modern, /Delegate=cpu cpuset io memory pids|cpuset/, `systemd ${version} must delegate cpuset`);
  }
});

test('qfli_check_delegation reads the real controller file and names what is missing', { skip }, () => {
  requireFunction('qfli_check_delegation');
  const controllerFile = (root, uid, contents) => {
    const dir = join(root, 'user.slice', `user-${uid}.slice`, `user@${uid}.service`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cgroup.controllers'), contents.endsWith('\n') ? contents : `${contents}\n`);
  };

  const good239 = tempDir('qfli-cgroup-good-');
  controllerFile(good239, 1001, 'cpu io memory pids');
  assert.equal(sourced(`qfli_check_delegation ${shq(good239)} 1001 239`).status, 0);

  const good244 = tempDir('qfli-cgroup-good244-');
  controllerFile(good244, 1001, 'cpu cpuset io memory pids');
  assert.equal(sourced(`qfli_check_delegation ${shq(good244)} 1001 244`).status, 0);

  // cpuset is optional: no affinity limits are used, so a manager without it is
  // still correctly delegated on every systemd version.
  const noCpuset244 = tempDir('qfli-cgroup-nocpuset244-');
  controllerFile(noCpuset244, 1001, 'cpu io memory pids');
  assert.equal(
    sourced(`qfli_check_delegation ${shq(noCpuset244)} 1001 244`).status,
    0,
    'cpuset must be optional even on systemd 244',
  );

  const missingCpu = tempDir('qfli-cgroup-nocpu-');
  controllerFile(missingCpu, 1001, 'io memory pids');
  const cpuResult = sourced(`qfli_check_delegation ${shq(missingCpu)} 1001 239`);
  assert.notEqual(cpuResult.status, 0, 'missing cpu controller must fail');
  assert.match(`${cpuResult.stdout}${cpuResult.stderr}`, /cpu/);

  // Every required controller matters, not just cpu.
  for (const missing of ['io', 'memory', 'pids']) {
    const dir = tempDir(`qfli-cgroup-no${missing}-`);
    controllerFile(dir, 1001, ['cpu', 'io', 'memory', 'pids'].filter(name => name !== missing).join(' '));
    const result = sourced(`qfli_check_delegation ${shq(dir)} 1001 239`);
    assert.notEqual(result.status, 0, `missing ${missing} must fail`);
    assert.match(`${result.stdout}${result.stderr}`, new RegExp(missing), `must name ${missing}`);
  }

  const noFile = tempDir('qfli-cgroup-empty-');
  const absent = sourced(`qfli_check_delegation ${shq(noFile)} 1001 239`);
  assert.notEqual(absent.status, 0, 'a manager without a controllers file must fail');
  assert.match(`${absent.stdout}${absent.stderr}`, /cgroup\.controllers|missing/i);
});

// ---------------------------------------------------------------------------
// Image defaults
// ---------------------------------------------------------------------------

test('the implicit sandbox and executor defaults are qualified published references', { skip }, () => {
  requireFunction('qfli_is_published_image');
  // Only these two may be inherited implicitly; the helper keeps them away from
  // a bare legacy build name such as qfli-terminal:latest.
  for (const name of ['sandbox_image', 'executor_image']) {
    const value = sourcedOk(`printf '%s' "$${name}"`).stdout.trim();
    assert.ok(value.length > 0, `${name} must have a default`);
    assert.equal(
      sourced(`qfli_is_published_image ${shq(value)}`).status,
      0,
      `${name} default is not a registry-qualified reference: ${value}`,
    );
  }
  for (const published of [
    'docker.cnb.cool/azurekiln/azurekiln-qfli-terminal:latest',
    'registry.example:5000/team/sandbox:3',
    'localhost/qfli/sandbox:3',
  ]) {
    assert.equal(sourced(`qfli_is_published_image ${shq(published)}`).status, 0, published);
  }
  // A bare legacy build name must be rejected so it can never become an
  // implicit default after an upgrade.
  for (const legacy of ['qfli-terminal:latest', 'sandbox', 'qfli-terminal:3']) {
    assert.notEqual(
      sourced(`qfli_is_published_image ${shq(legacy)}`).status,
      0,
      `${legacy} must not pass as a published image`,
    );
  }
});

test('the updater has its own pinned default, independent of the image guard', { skip }, () => {
  // The updater is always named explicitly in the stack, so a Docker Hub
  // namespace reference is a valid default and need not satisfy
  // qfli_is_published_image.
  const value = sourcedOk(`printf '%s' "$watchtower_image"`).stdout.trim();
  assert.match(value, /^[a-z0-9._/-]+:[A-Za-z0-9._-]+$/, `unexpected updater default: ${value}`);
  assert.doesNotMatch(value, /^qfli-terminal/, 'the updater must never default to a legacy build name');
  // An explicit override replaces it and reaches the rendered configuration.
  const rendered = functionOutput(
    'qfli_render_env',
    `qfli_render_env ${shq('c'.repeat(64))} s:3 e:1 1001 3101 true auto-update custom/watchtower:2.0.0`,
  );
  assert.match(rendered, /^QFLI_TERMINAL_WATCHTOWER_IMAGE=custom\/watchtower:2\.0\.0$/m);
});

// ---------------------------------------------------------------------------
// Updater preflight
// ---------------------------------------------------------------------------

/** Put a stub `docker` first on PATH; the script must tolerate its failure. */
function stubDocker(body) {
  const dir = tempDir('qfli-stub-');
  writeFileSync(join(dir, 'docker'), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return dir;
}

test('a failed updater pull is reported without discarding the executor', { skip }, () => {
  requireFunction('qfli_updater_preflight');
  const failing = stubDocker('exit 1');
  const failingResult = sourced(
    `qfli_updater_preflight nickfedor/watchtower:1.23.2 docker`,
    { env: { PATH: `${failing}:${process.env.PATH ?? ''}` } },
  );
  assert.notEqual(failingResult.status, 0, 'a failed pull must be reported as failure');
  assert.match(`${failingResult.stdout}${failingResult.stderr}`, /cannot pull the updater image/);

  const working = stubDocker('export STUB_PULLED=1; exit 0');
  const ok = sourced(
    `qfli_updater_preflight nickfedor/watchtower:1.23.2 docker`,
    { env: { PATH: `${working}:${process.env.PATH ?? ''}` } },
  );
  assert.equal(ok.status, 0, ok.stderr);

  // No configured image is a failure too, not a silent success.
  assert.notEqual(sourced(`qfli_updater_preflight '' docker`).status, 0);
});

test('the production pull wrapper forwards the image to docker pull', { skip }, () => {
  // qfli_updater_preflight calls "$pull" pull "$image", so the wrapper receives
  // ('pull', IMAGE). It must reach as_runner as ('docker', 'pull', IMAGE).
  requireFunction('as_runner_pull');
  const result = sourcedOk(
    [
      'as_runner() { printf "argv:%s\\n" "$*"; }',
      'as_runner_pull pull nickfedor/watchtower:1.23.2',
    ].join('\n'),
  );
  const calls = result.stdout
    .split('\n')
    .filter(line => line.startsWith('argv:'))
    .map(line => line.slice('argv:'.length).trim());
  assert.deepEqual(calls, ['docker pull nickfedor/watchtower:1.23.2']);
});

test('the updater preflight drives the real wrapper end to end', { skip }, () => {
  // Combined wiring check: preflight + production wrapper + a mocked as_runner
  // that records what Docker would have been asked to pull.
  requireFunction('qfli_updater_preflight');
  requireFunction('as_runner_pull');
  const image = 'nickfedor/watchtower:1.23.2';
  const result = sourcedOk(
    [
      'as_runner() { printf "argv:%s\\n" "$*"; return 0; }',
      `qfli_updater_preflight ${shq(image)} as_runner_pull`,
    ].join('\n'),
  );
  const calls = result.stdout
    .split('\n')
    .filter(line => line.startsWith('argv:'))
    .map(line => line.slice('argv:'.length).trim());
  assert.deepEqual(calls, [`docker pull ${image}`]);
});

test('a failing production wrapper disables only the updater', { skip }, () => {
  requireFunction('qfli_updater_preflight');
  requireFunction('as_runner_pull');
  const result = sourced(
    [
      'as_runner() { printf "argv:%s\\n" "$*"; return 1; }',
      'qfli_updater_preflight nickfedor/watchtower:1.23.2 as_runner_pull; printf "status:%s\\n" "$?"',
    ].join('\n'),
  );
  assert.match(result.stdout, /^status:1$/m, 'a failed pull must be reported as failure');
  assert.match(result.stderr, /cannot pull the updater image/);
});

test('the updater cannot fail the install: the preflight result only toggles the profile', { skip }, () => {
  const script = readFileSync(BOOTSTRAP, 'utf8');
  // The preflight runs inside a conditional, so `set -e` cannot abort the
  // install when the updater image is unavailable.
  assert.match(script, /if\s+qfli_updater_preflight[^\n]*;\s*then/, 'preflight must be tested by an if');
  assert.match(script, /compose_profiles=auto-update/, 'a usable updater enables the profile');
  assert.match(script, /auto_update=0/, 'an unusable updater disables auto-update');
});
