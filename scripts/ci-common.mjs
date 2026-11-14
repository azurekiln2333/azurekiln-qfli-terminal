#!/usr/bin/env node
// Shared CI entry for every platform (CNB, GitHub Actions, GitLab CI, GitCode).
//
// Keeps validation and image-publishing contracts in one zero-dependency module:
//   node scripts/ci-common.mjs verify
//   node scripts/ci-common.mjs publish --platform github --ref refs/heads/main --revision <sha> --repository <owner/repo> --no-login
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { URL, pathToFileURL } from 'node:url';

const PART = '[a-z0-9]+(?:[._-][a-z0-9]+)*';
const NUMBER = '(?:0|[1-9][0-9]*)';
const IDENTIFIER = `(?:${NUMBER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = new RegExp(`^v${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-${IDENTIFIER}(?:\\.${IDENTIFIER})*)?$`);

const PLATFORMS = {
  cnb: { registry: 'docker.cnb.cool', repository: null },
  github: { registry: 'ghcr.io', repository: 'github.repository' },
  gitlab: { registry: 'registry.gitlab.com', repository: 'CI_PROJECT_PATH' },
};

const COMMANDS = {
  verify: [
    ['node', ['scripts/check.mjs']],
    ['node', ['scripts/check-deployment.mjs']],
    ['node', ['--test', 'test/*.test.js']],
    ['bash', ['-n', 'deployment/bootstrap.sh']],
    ['bash', ['-n', 'test/bootstrap-upgrade.sh']],
    ['bash', ['-n', 'sandbox/smoke-languages.sh']],
    ['python3', ['-B', '-m', 'py_compile', 'sandbox/init.py', 'sandbox/cleanup.py', 'sandbox/ready.py', 'sandbox/snapshot.py', 'deployment/smoke-isolation.py']],
  ],
};

export const SANDBOX_CHANNEL_TAG = '3';
const SANDBOX_SMOKE_SCRIPT = [
  'mkdir -p /workspace/.tmp',
  'for lang in c cpp java lua node typescript python php go rust dart ruby shell; do',
  '  /usr/local/lib/qfli/smoke-languages.sh "$lang"',
  'done',
].join('\n');

export function dockerName(repository) {
  return repository.toLowerCase();
}

export function imagePlan({ platform, repository, ref, revision, env = {} }) {
  const known = PLATFORMS[platform];
  if (!known) throw new Error('Platform must be cnb, github or gitlab');
  const host = env.CI_REGISTRY_HOST || known.registry;
  if (!host) throw new Error(`Platform ${platform} has no registry host; pass CI_REGISTRY_HOST`);
  if (!new RegExp(`^${PART}(?:/${PART})+$`, 'i').test(repository || '')) {
    throw new Error('Registry repository path is missing or malformed');
  }
  const name = env.CI_IMAGE_NAME || '';
  if (name && !new RegExp(`^${PART}$`).test(name)) throw new Error('Image name is malformed');
  if (!/^[a-f0-9]{7,40}$/.test(revision || '')) throw new Error('Invalid commit revision');

  const normalizedRepo = dockerName(repository);
  const hash = env.CI_COMMIT_SHORT || revision.slice(0, 12);
  const executorImage = `${host}/${normalizedRepo}${name ? `/${name}` : ''}`;
  const sandboxImage = name ? `${executorImage}-sandbox` : `${executorImage}/sandbox`;

  if (ref === 'refs/heads/main') {
    return {
      platform,
      repository: normalizedRepo,
      executorImage,
      sandboxImage,
      tag: `sha-${hash}`,
      sandboxTag: `sha-${hash}`,
      sandboxChannel: SANDBOX_CHANNEL_TAG,
      latest: true,
      mode: 'main',
    };
  }
  if (!ref.startsWith('refs/tags/')) throw new Error('Publishing is limited to main and v* tags');
  const tag = ref.slice('refs/tags/'.length);
  if (tag.length > 128 || !SEMVER.test(tag)) {
    throw new Error('Tag must be vMAJOR.MINOR.PATCH with an optional semver prerelease');
  }
  const prerelease = tag.includes('-');
  // A prerelease never moves :latest or the stable sandbox :3 tag.
  return {
    platform,
    repository: normalizedRepo,
    executorImage,
    sandboxImage,
    tag,
    sandboxTag: prerelease ? `${tag}-sandbox` : tag,
    sandboxChannel: prerelease ? null : SANDBOX_CHANNEL_TAG,
    latest: !prerelease,
    mode: 'tag',
  };
}

function resolveWindowsBinary(command, env) {
  if (command === 'bash') {
    const candidates = [
      env.GIT_BASH,
      'D:\\ProgramFiles\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ].filter(Boolean);
    const hit = candidates.find(candidate => existsSync(candidate));
    if (hit) return hit;
  }
  if (command === 'python3') return 'python';
  return command;
}

function execute(command, args, options = {}) {
  const binary = process.platform === 'win32'
    ? resolveWindowsBinary(command, options.env || process.env)
    : command;
  const env = command === 'python3'
    ? { PYTHONPYCACHEPREFIX: tmpdir(), ...process.env, ...options.env }
    : options.env;
  const result = spawnSync(binary, args, {
    stdio: 'inherit',
    windowsHide: true,
    ...options,
    ...(env ? { env } : {}),
  });
  if (result.error || result.status !== 0) {
    throw new Error(`CI command failed: ${command} ${args.join(' ')}`);
  }
  return result;
}

export function runVerify(run = execute) {
  for (const [command, args] of COMMANDS.verify) run(command, args);
}

function buildLabels(plan, revision) {
  const labels = ['--label', `org.opencontainers.image.revision=${revision}`];
  if (plan.platform === 'github') {
    labels.push('--label', `org.opencontainers.image.source=https://github.com/${plan.repository}`);
  }
  return labels;
}

function smokeExecutor(run, ref) {
  run('docker', [
    'run', '--rm',
    '--entrypoint', '/bin/sh',
    ref,
    '-c', 'node --version && /usr/bin/docker --version && node --check src/server.js',
  ]);
}

function smokeSandbox(run, ref) {
  run('docker', [
    'image', 'inspect',
    '--format',
    '{{.Config.User}}|{{index .Config.Labels "io.qfli.terminal.image"}}|{{index .Config.Labels "io.qfli.terminal.toolchains"}}|{{json .Config.Entrypoint}}|{{len .Config.Cmd}}',
    ref,
  ]);
  run('docker', [
    'run', '--rm',
    '--network=none',
    '--read-only',
    '--tmpfs', '/workspace:rw,nosuid,nodev,exec,size=256m,mode=0700,uid=65532,gid=65532',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,mode=1777',
    '--env', 'DART_SUPPRESS_ANALYTICS=true',
    '--user', '65532:65532',
    '--entrypoint', '/bin/sh',
    ref,
    '-c', SANDBOX_SMOKE_SCRIPT,
  ]);
}

export function runPublish({
  platform,
  repository,
  ref,
  revision,
  env = process.env,
  run = execute,
  login = true,
  steps = 'all',
  target = 'all',
}) {
  if (!ref || !revision) throw new Error('Publishing needs --ref and --revision');
  if (!['all', 'build', 'push'].includes(steps)) throw new Error('Steps must be all, build or push');
  if (!['all', 'executor', 'sandbox'].includes(target)) throw new Error('Target must be all, executor or sandbox');

  const plan = imagePlan({ platform, repository, ref, revision, env });
  const executorSource = `${plan.executorImage}:${plan.tag}`;
  const sandboxSource = `${plan.sandboxImage}:${plan.sandboxTag}`;
  const buildExecutor = target === 'all' || target === 'executor';
  const buildSandbox = target === 'all' || target === 'sandbox';

  if (steps === 'push') {
    if (!plan.latest) {
      console.log(`${executorSource} is a prerelease; latest and :${SANDBOX_CHANNEL_TAG} stay untouched`);
      return plan;
    }
    if (buildExecutor) {
      const latest = `${plan.executorImage}:latest`;
      run('docker', ['tag', executorSource, latest]);
      run('docker', ['push', latest]);
    }
    if (buildSandbox) {
      const channel = `${plan.sandboxImage}:${plan.sandboxChannel}`;
      const latest = `${plan.sandboxImage}:latest`;
      run('docker', ['tag', sandboxSource, channel]);
      run('docker', ['push', channel]);
      run('docker', ['tag', sandboxSource, latest]);
      run('docker', ['push', latest]);
    }
    return plan;
  }

  if (steps === 'all') runVerify(run);
  if (login) {
    const user = env.CI_REGISTRY_USER || 'gitlab-ci-token';
    if (!env.CI_REGISTRY_PASSWORD) throw new Error('CI_REGISTRY_PASSWORD is required to publish');
    const host = new URL(`https://${plan.executorImage}`).host;
    run('docker', ['login', host, '-u', user, '--password-stdin'], { input: env.CI_REGISTRY_PASSWORD });
  }

  const labels = buildLabels(plan, revision);
  if (buildExecutor) {
    run('docker', ['build', '--pull', ...labels, '--file', 'Dockerfile', '--tag', executorSource, '.']);
    smokeExecutor(run, executorSource);
    run('docker', ['push', executorSource]);
  }
  if (buildSandbox) {
    run('docker', ['build', '--pull', ...labels, '--file', 'sandbox/Dockerfile', '--tag', sandboxSource, 'sandbox']);
    smokeSandbox(run, sandboxSource);
    run('docker', ['push', sandboxSource]);
  }

  if (steps === 'build') return plan;
  if (plan.latest) {
    if (buildExecutor) {
      const latest = `${plan.executorImage}:latest`;
      run('docker', ['tag', executorSource, latest]);
      run('docker', ['push', latest]);
    }
    if (buildSandbox) {
      const channel = `${plan.sandboxImage}:${plan.sandboxChannel}`;
      const latest = `${plan.sandboxImage}:latest`;
      run('docker', ['tag', sandboxSource, channel]);
      run('docker', ['push', channel]);
      run('docker', ['tag', sandboxSource, latest]);
      run('docker', ['push', latest]);
    }
  }
  return plan;
}

function parseArguments(argv) {
  const options = { mode: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument ${key}`);
    const name = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (key === '--no-login') {
      options[name] = 'true';
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    options[name] = value;
    index += 1;
  }
  return options;
}

export function main(argv, env = process.env) {
  const options = parseArguments(argv);
  if (options.mode === 'verify') {
    runVerify();
    console.log('CI validation passed');
    return null;
  }
  if (options.mode === 'publish') {
    const repository = options.repository || env.CI_PROJECT_PATH;
    const revision = options.revision || env.CI_COMMIT_SHA;
    const login = options.noLogin !== 'true';
    const steps = options.steps || 'all';
    const target = options.target || 'all';
    const plan = runPublish({
      platform: options.platform,
      repository,
      ref: options.ref,
      revision,
      env,
      login,
      steps,
      target,
    });
    console.log(
      `Published target=${target} executor=${plan.executorImage}:${plan.tag} sandbox=${plan.sandboxImage}:${plan.sandboxTag}; latest=${plan.latest}`,
    );
    return plan;
  }
  throw new Error('Expected verify or publish as the first argument');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
