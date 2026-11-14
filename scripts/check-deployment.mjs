#!/usr/bin/env node
// Static deployment & cross-platform CI contract checks (no Docker daemon needed).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

const dockerfile = read('Dockerfile');
const sandboxDockerfile = read('sandbox/Dockerfile');
const compose = read('docker-compose.yaml');
const buildCompose = read('docker-compose.build.yaml');
const envExample = read('.env.example');
const bootstrap = read('deployment/bootstrap.sh');
const cnbCi = read('.cnb.yml');
const githubCi = read('.github/workflows/build-and-push.yml');
const gitlabCi = read('.gitlab-ci.yml');
const gitcodeCi = read('.gitcode/workflows/verify.yml');
const ciPlatforms = read('deploy/ci-platforms.md');
const ciCommon = read('scripts/ci-common.mjs');

check(/FROM docker:[\d.]+-cli AS dockercli/.test(dockerfile), 'Dockerfile must copy the pinned Docker CLI stage');
check(/FROM node:24\.15\.0-bookworm-slim/.test(dockerfile), 'Dockerfile must pin the Node executor base image');
check(/HEALTHCHECK/.test(dockerfile), 'Dockerfile must keep a HEALTHCHECK');

check(/LABEL io\.qfli\.terminal\.image="1" io\.qfli\.terminal\.toolchains="3"/.test(sandboxDockerfile),
  'sandbox/Dockerfile must expose the expected toolchain labels');
check(/USER 65533:65533/.test(sandboxDockerfile), 'sandbox/Dockerfile must run supervisor as 65533:65533');
check(/ENTRYPOINT \["\/usr\/bin\/python3", "-I", "\/usr\/local\/lib\/qfli\/init\.py"\]/.test(sandboxDockerfile),
  'sandbox/Dockerfile must keep the isolated init entrypoint');

check(!/^\s+build:/m.test(compose), 'production compose must not build');
check(!/^\s+depends_on:/m.test(compose), 'production compose must not declare depends_on');
check(/^\s+build:/m.test(buildCompose), 'docker-compose.build.yaml must contain the development build override');
check(/start_period:/.test(compose) && !/start-period:/.test(compose), 'compose must use start_period');
check(/com\.centurylinklabs\.watchtower\.scope: qfli-terminal/.test(compose), 'compose update scope must be qfli-terminal');
check(/docker\.cnb\.cool\/azurekiln\/azurekiln-qfli-terminal:latest/.test(compose),
  'compose default executor image must target standalone azurekiln-qfli-terminal');
check(!/qflistudio-next/.test(compose + envExample + bootstrap + cnbCi + githubCi + gitlabCi),
  'retired qflistudio-next image paths must be gone');

check(/^QFLI_TERMINAL_SECRET=$/m.test(envExample), '.env.example must keep QFLI_TERMINAL_SECRET empty');
check(/^QFLI_RUNNER_HOST_UID=$/m.test(envExample), '.env.example must keep QFLI_RUNNER_HOST_UID empty');
check(/^QFLI_TERMINAL_IMAGE=docker\.cnb\.cool\/azurekiln\/azurekiln-qfli-terminal\/sandbox:3$/m.test(envExample),
  '.env.example must define the standalone CNB sandbox image');
check(/^QFLI_TERMINAL_SERVICE_IMAGE=docker\.cnb\.cool\/azurekiln\/azurekiln-qfli-terminal:latest$/m.test(envExample),
  '.env.example must define the standalone CNB executor image');
check(/ghcr\.io\/azurekiln2333\/azurekiln-qfli-terminal\/sandbox:3/.test(envExample),
  '.env.example must document the GHCR sandbox fallback');
check(/ghcr\.io\/azurekiln2333\/azurekiln-qfli-terminal:latest/.test(envExample),
  '.env.example must document the GHCR executor fallback');

check(/CNB_REPO_SLUG_LOWERCASE/.test(cnbCi), 'CNB CI must namespace images by CNB_REPO_SLUG_LOWERCASE');
check(/services:\s*\n\s*- docker/.test(cnbCi), 'CNB publish pipeline needs the docker service');
const cnbJobs = cnbCi.split(/(?=^ {4}- name: )/m).filter(chunk => /^ {4}- name: /.test(chunk));
check(cnbJobs.length >= 3, 'CNB CI must declare verify, main publish, and release tag jobs');
const cnbAnchors = Object.fromEntries(
  [...cnbCi.matchAll(/&([\w-]+)\s*\n\s*image:\s*(\S+)/g)].map(match => [match[1], match[2]]),
);
for (const job of cnbJobs) {
  const name = job.match(/^ {4}- name: (.+)$/m)[1].trim();
  if (!/scripts\/ci-common\.mjs/.test(job)) continue;
  const header = job.slice(0, job.indexOf('stages:'));
  const literal = header.match(/image:\s*(\S+)/);
  const alias = header.match(/docker:\s*\*([\w-]+)/);
  const image = literal ? literal[1] : cnbAnchors[alias && alias[1]];
  check(image === 'node:24.15.0-bookworm', `CNB job "${name}" must pin node:24.15.0-bookworm`);
}
check(!/cnbcool\/default-(?:dev|build)-env/.test(cnbCi), 'CNB jobs running ci-common must use the Node image');

for (const [file, text, platform] of [
  ['.cnb.yml', cnbCi, 'cnb'],
  ['.github/workflows/build-and-push.yml', githubCi, 'github'],
  ['.gitlab-ci.yml', gitlabCi, 'gitlab'],
]) {
  check(new RegExp(`scripts/ci-common\\.mjs publish[\\s\\S]*--platform ${platform}`).test(text),
    `${file} must publish via scripts/ci-common.mjs --platform ${platform}`);
  check(/scripts\/ci-common\.mjs verify/.test(text), `${file} must verify via scripts/ci-common.mjs verify`);
}

check(/docker login ghcr\.io/.test(githubCi), 'GitHub workflow must log in to GHCR');
check(/packages: write/.test(githubCi), 'GitHub publish job needs packages: write');
check(/--no-login/.test(githubCi), 'GitHub publish steps must reuse the workflow login');
check(/--steps push/.test(githubCi), 'GitHub workflow must split build and push steps');
check(!/cache:\s*npm/.test(githubCi), 'GitHub workflow must not require npm lockfile cache when none exists');
const verifySection = githubCi.slice(githubCi.indexOf('  verify:'), githubCi.indexOf('  image:'));
check(!/docker login|docker push|packages: write/.test(verifySection), 'GitHub verify job must remain read-only');

check(/--no-login/.test(cnbCi), 'CNB publish steps must reuse the docker service login');
check(/refs\/heads\/\$\{CNB_BRANCH\}/.test(cnbCi), 'CNB main publish must construct refs/heads/${CNB_BRANCH}');
check(!/docker\.login/.test(gitlabCi), 'GitLab CI must rely on predefined CI_REGISTRY_PASSWORD');
check(/services:\s*\n\s*- name: \$DOCKER_DIND_IMAGE/.test(gitlabCi), 'GitLab CI needs dind service');
check(/scripts\/ci-common\.mjs verify/.test(gitcodeCi), 'GitCode validates via ci-common verify');
check(!/docker\s+(build|push)/.test(gitcodeCi), 'GitCode must not build or push images');
check(/Gitee：不加工作流/.test(ciPlatforms) && /GitCode \/ AtomGit：只加校验/.test(ciPlatforms),
  'deploy/ci-platforms.md must document Gitee and GitCode decisions');
check(/smoke-languages\.sh/.test(ciCommon), 'ci-common must smoke-test built sandbox images before pushing');

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`deployment contract OK (${fileURLToPath(root)})`);
}
