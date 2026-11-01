import { spawn } from 'node:child_process';
import {
  constants, closeSync, existsSync, fstatSync, ftruncateSync, openSync, readFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { ExecutorError } from './config.js';

// Single-instance fence for the shared rootless Docker engine.
//
// Every executor and every `compose run` verification container mounts the same
// runtime directory, but they live in different network and PID namespaces, so a
// port bind or a recorded PID cannot fence them. `flock(2)` locks an open file
// description, which the kernel shares across inherited descriptors and releases
// when the last descriptor closes.
//
// We open the lock file ourselves and keep that descriptor for the whole process
// lifetime. A short-lived `flock -n 3` helper is handed a duplicate of it and
// only performs the lock call; the helper exits immediately. The fence therefore
// belongs to this process's descriptor, not to the helper: there is no helper to
// lose, and no path is reopened between the O_NOFOLLOW check and the lock.
const HELPERS = ['/usr/bin/flock', '/bin/flock', '/usr/sbin/flock'];
const FENCE_FD = 3;
const HELPER_MS = 5000;

let heldInProcess = false;

function helperPath() {
  for (const candidate of HELPERS) {
    if (existsSync(candidate)) return candidate;
  }
  throw new ExecutorError('executor_lock_helper_missing');
}

function processIdentity() {
  const stat = readFileSync('/proc/self/stat', 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  return {
    pid: process.pid,
    startTicks: Number(fields[19]),
    bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
  };
}

// O_NOFOLLOW plus an fstat check rejects symlinks and non-regular files instead
// of following or truncating them.
function openRegular(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code === 'ELOOP' || error.code === 'EISDIR' || error.code === 'ENOTDIR') {
      throw new ExecutorError('executor_lock_invalid');
    }
    throw new ExecutorError('executor_lock_unavailable');
  }
  try {
    if (!fstatSync(fd).isFile()) throw new ExecutorError('executor_lock_invalid');
  } catch (error) {
    closeSync(fd);
    throw error instanceof ExecutorError ? error : new ExecutorError('executor_lock_invalid');
  }
  return fd;
}

// Lock the already-open descriptor in a child, then keep the descriptor open
// here. The kernel keeps the lock on the shared open file description until this
// process closes the descriptor or exits.
function lockDescriptor(helper, fd) {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, ['-n', String(FENCE_FD)], {
      stdio: ['ignore', 'ignore', 'ignore', fd],
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new ExecutorError('executor_lock_unavailable'));
    }, HELPER_MS);
    child.once('error', error => {
      clearTimeout(timer);
      reject(new ExecutorError(error.code === 'ENOENT'
        ? 'executor_lock_helper_missing' : 'executor_lock_unavailable'));
    });
    child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

export async function acquireInstanceLock(directory) {
  if (heldInProcess) throw new ExecutorError('executor_already_running');
  const helper = helperPath();
  const path = join(directory, 'executor.lock');
  const fd = openRegular(path);
  let code;
  try {
    code = await lockDescriptor(helper, fd);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  if (code !== 0) {
    closeSync(fd);
    throw new ExecutorError('executor_already_running');
  }

  // Diagnostics only: the fence is the kernel lock on this descriptor.
  try {
    const metadata = Buffer.from(`${JSON.stringify(processIdentity())}\n`);
    ftruncateSync(fd, 0);
    writeSync(fd, metadata, 0, metadata.length, 0);
  } catch {
    closeSync(fd);
    throw new ExecutorError('executor_lock_unavailable');
  }

  heldInProcess = true;
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    heldInProcess = false;
    closeSync(fd);
  };
}
