// Cross-platform CI contract tests: image names, dual-target tag plans, prerelease safety, and fail-closed ordering.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imagePlan, runPublish, runVerify } from '../scripts/ci-common.mjs';

const revision = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

test('CNB, GitHub, and GitLab images use standalone repository namespaces', () => {
  const cnb = imagePlan({ platform: 'cnb', repository: 'azurekiln/azurekiln-qfli-terminal', ref: 'refs/heads/main', revision });
  const github = imagePlan({ platform: 'github', repository: 'azurekiln2333/azurekiln-qfli-terminal', ref: 'refs/heads/main', revision });
  const gitlab = imagePlan({ platform: 'gitlab', repository: 'azurekiln-team/azurekiln-qfli-terminal', ref: 'refs/heads/main', revision });

  assert.equal(cnb.executorImage, 'docker.cnb.cool/azurekiln/azurekiln-qfli-terminal');
  assert.equal(cnb.sandboxImage, 'docker.cnb.cool/azurekiln/azurekiln-qfli-terminal/sandbox');
  assert.equal(github.executorImage, 'ghcr.io/azurekiln2333/azurekiln-qfli-terminal');
  assert.equal(github.sandboxImage, 'ghcr.io/azurekiln2333/azurekiln-qfli-terminal/sandbox');
  assert.equal(gitlab.executorImage, 'registry.gitlab.com/azurekiln-team/azurekiln-qfli-terminal');
  assert.equal(gitlab.sandboxImage, 'registry.gitlab.com/azurekiln-team/azurekiln-qfli-terminal/sandbox');
  assert.equal(github.tag, 'sha-a1b2c3d4e5f6');
  assert.equal(github.sandboxTag, 'sha-a1b2c3d4e5f6');
  assert.equal(github.sandboxChannel, '3');
  assert.equal(github.latest, true);
});

test('mixed-case repository names are lowercased and overrides are supported', () => {
  const plan = imagePlan({
    platform: 'gitlab',
    repository: 'AzureKiln-Team/Terminal',
    ref: 'refs/heads/main',
    revision,
    env: { CI_REGISTRY_HOST: 'registry.example.com', CI_IMAGE_NAME: 'exec' },
  });
  assert.equal(plan.executorImage, 'registry.example.com/azurekiln-team/terminal/exec');
  assert.equal(plan.sandboxImage, 'registry.example.com/azurekiln-team/terminal/exec-sandbox');
});

test('stable tags move :latest and sandbox :3, prereleases never do', () => {
  const stable = imagePlan({ platform: 'github', repository: 'o/r', ref: 'refs/tags/v1.2.3', revision });
  const pre = imagePlan({ platform: 'github', repository: 'o/r', ref: 'refs/tags/v1.2.3-rc.1', revision });
  assert.equal(stable.tag, 'v1.2.3');
  assert.equal(stable.sandboxTag, 'v1.2.3');
  assert.equal(stable.sandboxChannel, '3');
  assert.equal(stable.latest, true);

  assert.equal(pre.tag, 'v1.2.3-rc.1');
  assert.equal(pre.sandboxTag, 'v1.2.3-rc.1-sandbox');
  assert.equal(pre.sandboxChannel, null);
  assert.equal(pre.latest, false);
});

test('non-main branches, bad semver tags, bad repos, and bad revisions are rejected', () => {
  assert.throws(() => imagePlan({ platform: 'github', repository: 'o/r', ref: 'refs/heads/feature', revision }), /limited to main/);
  assert.throws(() => imagePlan({ platform: 'github', repository: 'o/r', ref: 'refs/tags/1.2.3', revision }), /vMAJOR/);
  assert.throws(() => imagePlan({ platform: 'github', repository: 'o/r', ref: 'refs/tags/v01.2.3', revision }), /vMAJOR/);
  assert.throws(() => imagePlan({ platform: 'github', repository: 'o/r', ref: 'refs/tags/v1.2.3;rm', revision }), /vMAJOR/);
  assert.throws(() => imagePlan({ platform: 'github', repository: 'o', ref: 'refs/heads/main', revision }), /repository path/);
  assert.throws(() => imagePlan({ platform: 'github', repository: 'o/r', ref: 'refs/heads/main', revision: 'HEAD' }), /revision/);
  assert.throws(() => imagePlan({ platform: 'bitbucket', repository: 'o/r', ref: 'refs/heads/main', revision }), /Platform/);
});

test('verify runs lint, deployment checks, unit tests, shell syntax, and python checks in order', () => {
  const calls = [];
  runVerify((command, args) => calls.push(`${command} ${args.join(' ')}`));
  assert.deepEqual(calls, [
    'node scripts/check.mjs',
    'node scripts/check-deployment.mjs',
    'node --test test/*.test.js',
    'bash -n deployment/bootstrap.sh',
    'bash -n test/bootstrap-upgrade.sh',
    'bash -n sandbox/smoke-languages.sh',
    'python3 -B -m py_compile sandbox/init.py sandbox/cleanup.py sandbox/ready.py sandbox/snapshot.py deployment/smoke-isolation.py',
  ]);
});

test('publish validates, builds, smoke-tests, pushes commit tags, and promotes :3 and :latest', () => {
  const calls = [];
  const plan = runPublish({
    platform: 'github',
    repository: 'azurekiln2333/azurekiln-qfli-terminal',
    ref: 'refs/heads/main',
    revision,
    login: false,
    run: (command, args) => calls.push(`${command} ${args.join(' ')}`),
  });
  assert.equal(plan.executorImage, 'ghcr.io/azurekiln2333/azurekiln-qfli-terminal');
  assert.equal(calls[0], 'node scripts/check.mjs');
  const buildIdx = calls.findIndex(line => line.startsWith('docker build --pull') && line.includes('--file Dockerfile'));
  const smokeExecIdx = calls.findIndex(line => line.startsWith('docker run --rm') && line.includes('src/server.js'));
  const pushExecIdx = calls.indexOf('docker push ghcr.io/azurekiln2333/azurekiln-qfli-terminal:sha-a1b2c3d4e5f6');
  const buildSandboxIdx = calls.findIndex(line => line.startsWith('docker build --pull') && line.includes('sandbox/Dockerfile'));
  const smokeSandboxIdx = calls.findIndex(line => line.startsWith('docker run --rm') && line.includes('smoke-languages.sh'));
  const pushSandboxIdx = calls.indexOf('docker push ghcr.io/azurekiln2333/azurekiln-qfli-terminal/sandbox:sha-a1b2c3d4e5f6');

  assert.ok(buildIdx > 0 && smokeExecIdx > buildIdx && pushExecIdx > smokeExecIdx);
  assert.ok(buildSandboxIdx > pushExecIdx && smokeSandboxIdx > buildSandboxIdx && pushSandboxIdx > smokeSandboxIdx);
  assert.ok(calls[buildIdx].includes('org.opencontainers.image.source=https://github.com/azurekiln2333/azurekiln-qfli-terminal'));
  assert.deepEqual(calls.slice(-6), [
    'docker tag ghcr.io/azurekiln2333/azurekiln-qfli-terminal:sha-a1b2c3d4e5f6 ghcr.io/azurekiln2333/azurekiln-qfli-terminal:latest',
    'docker push ghcr.io/azurekiln2333/azurekiln-qfli-terminal:latest',
    'docker tag ghcr.io/azurekiln2333/azurekiln-qfli-terminal/sandbox:sha-a1b2c3d4e5f6 ghcr.io/azurekiln2333/azurekiln-qfli-terminal/sandbox:3',
    'docker push ghcr.io/azurekiln2333/azurekiln-qfli-terminal/sandbox:3',
    'docker tag ghcr.io/azurekiln2333/azurekiln-qfli-terminal/sandbox:sha-a1b2c3d4e5f6 ghcr.io/azurekiln2333/azurekiln-qfli-terminal/sandbox:latest',
    'docker push ghcr.io/azurekiln2333/azurekiln-qfli-terminal/sandbox:latest',
  ]);
});

test('a failing test or smoke test blocks any docker push', () => {
  const calls = [];
  assert.throws(
    () => runPublish({
      platform: 'github',
      repository: 'o/r',
      ref: 'refs/heads/main',
      revision,
      login: false,
      run: (command, args) => {
        const line = `${command} ${args.join(' ')}`;
        calls.push(line);
        if (line.includes('smoke-languages.sh')) throw new Error('sandbox smoke failed');
      },
    }),
    /sandbox smoke failed/,
  );
  assert.equal(calls.some(line => line.startsWith('docker push') && line.includes('/sandbox:')), false);
});

test('target selector scopes build and push to executor or sandbox independently', () => {
  const buildCalls = [];
  runPublish({
    platform: 'github',
    repository: 'o/r',
    ref: 'refs/heads/main',
    revision,
    login: false,
    steps: 'build',
    target: 'executor',
    run: (command, args) => buildCalls.push(`${command} ${args.join(' ')}`),
  });
  assert.equal(buildCalls.some(line => line.includes('sandbox')), false);
  assert.equal(buildCalls.some(line => line.includes(':latest')), false);

  const pushCalls = [];
  runPublish({
    platform: 'github',
    repository: 'o/r',
    ref: 'refs/heads/main',
    revision,
    login: false,
    steps: 'push',
    target: 'sandbox',
    run: (command, args) => pushCalls.push(`${command} ${args.join(' ')}`),
  });
  assert.deepEqual(pushCalls, [
    'docker tag ghcr.io/o/r/sandbox:sha-a1b2c3d4e5f6 ghcr.io/o/r/sandbox:3',
    'docker push ghcr.io/o/r/sandbox:3',
    'docker tag ghcr.io/o/r/sandbox:sha-a1b2c3d4e5f6 ghcr.io/o/r/sandbox:latest',
    'docker push ghcr.io/o/r/sandbox:latest',
  ]);
});

test('prerelease push step promotes neither :latest nor :3', () => {
  const calls = [];
  const plan = runPublish({
    platform: 'github',
    repository: 'o/r',
    ref: 'refs/tags/v1.0.0-rc.1',
    revision,
    login: false,
    steps: 'push',
    run: (command, args) => calls.push(`${command} ${args.join(' ')}`),
  });
  assert.equal(plan.latest, false);
  assert.deepEqual(calls, []);
});

test('publishing without a registry password is refused when login is enabled', () => {
  assert.throws(
    () => runPublish({ platform: 'cnb', repository: 'o/r', ref: 'refs/heads/main', revision, env: {}, run: () => {} }),
    /CI_REGISTRY_PASSWORD/,
  );
});
