export const sandboxImage = 'qfli-terminal-sandbox:3';
export const toolchainVersion = '3';
export const languages = Object.freeze(['c', 'cpp', 'java', 'lua', 'node', 'typescript', 'python',
  'php', 'go', 'rust', 'dart', 'ruby', 'shell']);
export const sandboxTmpfs = Object.freeze({
  '/workspace': 'rw,nosuid,nodev,exec,size=256m,mode=0700,uid=65532,gid=65532',
  '/tmp': 'rw,nosuid,nodev,noexec,size=64m,mode=1777',
});

export const sandboxEnvironment = Object.freeze({
  HOME: '/workspace',
  LANG: 'C.UTF-8',
  TMPDIR: '/workspace/.tmp',
  PATH: '/opt/node/bin:/opt/dart-sdk/bin:/usr/local/bin:/usr/bin:/bin',
  JAVA_TOOL_OPTIONS: '-Xmx256m -XX:ActiveProcessorCount=1 -XX:ReservedCodeCacheSize=64m -XX:MaxMetaspaceSize=128m',
  GOMAXPROCS: '1',
  GOFLAGS: '-p=1',
  CARGO_BUILD_JOBS: '1',
  DART_SUPPRESS_ANALYTICS: 'true',
});

export const sandboxEnvArgs = Object.freeze(Object.entries(sandboxEnvironment)
  .flatMap(([key, value]) => ['--env', `${key}=${value}`]));
