import os from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { sandboxImage } from './sandbox.js';

export const requestContext = new AsyncLocalStorage();

export const limits = Object.freeze({
  sessions: 1,
  running: 1,
  waiting: 8,
  queueMs: 20_000,
  commandMs: 60_000,
  managementMs: 10_000,
  outputBytes: 100 * 1024,
  bodyBytes: 384 * 1024,
  snapshotFiles: 64,
  snapshotBytes: 256 * 1024,
  idleMs: 2 * 60_000,
  leaseMs: 30 * 60_000,
  memoryBytes: 1024 * 1024 * 1024,
  pids: 1024,
});

export function configuration() {
  if (process.platform !== 'linux' || !process.getuid || process.getuid() === 0) {
    throw new Error('executor_requires_nonroot_linux');
  }
  const account = os.userInfo();
  if (account.username !== 'qfli-runner') throw new Error('executor_requires_dedicated_account');
  const secret = process.env.QFLI_TERMINAL_SECRET ?? '';
  if (!/^[\x21-\x7e]{32,256}$/.test(secret)) throw new Error('executor_secret_invalid');
  const runtimeDir = `/run/user/${account.uid}`;
  const dockerHost = process.env.DOCKER_HOST ?? `unix://${runtimeDir}/docker.sock`;
  if (dockerHost !== `unix://${runtimeDir}/docker.sock` ||
      (process.env.XDG_RUNTIME_DIR && process.env.XDG_RUNTIME_DIR !== runtimeDir)) {
    throw new Error('executor_requires_local_rootless_socket');
  }
  const image = process.env.QFLI_TERMINAL_IMAGE || sandboxImage;
  if (!/^[a-z0-9][a-z0-9._/:@-]{0,250}$/.test(image)) throw new Error('executor_image_invalid');
  return {
    secret,
    image,
    uid: account.uid,
    socket: `${runtimeDir}/docker.sock`,
    runtimeDir,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: account.homedir,
      DOCKER_HOST: dockerHost, XDG_RUNTIME_DIR: runtimeDir },
  };
}

export class ExecutorError extends Error {
  constructor(code, status = 503) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function validateFiles(files) {
  if (files === undefined) return;
  if (!Array.isArray(files) || !files.length || files.length > limits.snapshotFiles) {
    throw new ExecutorError('invalid_snapshot', 400);
  }
  const paths = new Set();
  let bytes = 0;
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file) ||
        Object.keys(file).some(key => !['path', 'content'].includes(key)) ||
        typeof file.path !== 'string' || !file.path || Buffer.byteLength(file.path) > 512 ||
        Buffer.from(file.path).toString('utf8') !== file.path ||
        /[\\\x00-\x1f\x7f]/.test(file.path) ||
        file.path.split('/').some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255) ||
        file.path.split('/').length > 16 || paths.has(file.path) ||
        typeof file.content !== 'string' || file.content.length > Math.ceil(limits.snapshotBytes / 3) * 4 ||
        file.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)) {
      throw new ExecutorError('invalid_snapshot', 400);
    }
    const decoded = Buffer.from(file.content, 'base64');
    if (decoded.toString('base64') !== file.content) throw new ExecutorError('invalid_snapshot', 400);
    bytes += decoded.length;
    if (bytes > limits.snapshotBytes) throw new ExecutorError('snapshot_limit', 413);
    paths.add(file.path);
  }
  for (const file of files) {
    const parts = file.path.split('/');
    for (let index = 1; index < parts.length; index++) {
      if (paths.has(parts.slice(0, index).join('/'))) throw new ExecutorError('invalid_snapshot', 400);
    }
  }
}

export function log(stage, fields = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), stage,
    requestId: requestContext.getStore()?.requestId, ...fields }));
}
