import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireInstanceLock } from '../src/lock.js';

// flock only exists on the Linux executor hosts; the module is not used on Windows.
const linux = process.platform === 'linux';
const moduleUrl = new URL('../src/lock.js', import.meta.url).href;

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'qfli-lock-'));
}

// A child acquires the lock and holds it until its stdin closes.
function holder(dir) {
  const script = `
    import { acquireInstanceLock } from ${JSON.stringify(moduleUrl)};
    try {
      const release = await acquireInstanceLock(${JSON.stringify(dir)});
      console.log('ACQUIRED');
      process.stdin.resume();
      process.stdin.on('end', async () => { await release(); process.exit(0); });
    } catch (error) {
      console.log('REJECTED ' + error.code);
      process.exit(3);
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const first = new Promise(resolve => {
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.includes('\n')) resolve(buffer.split('\n')[0].trim());
    });
    child.once('exit', code => resolve(`EXIT ${code}`));
  });
  return { child, first };
}

test('the same process cannot take the fence twice', { skip: !linux }, async () => {
  const dir = tempDir();
  const release = await acquireInstanceLock(dir);
  await assert.rejects(acquireInstanceLock(dir), error => error.code === 'executor_already_running');
  await release();
  const again = await acquireInstanceLock(dir);
  await again();
  // The lock file stays in place; the kernel lock, not the file, is the fence.
  assert.equal(JSON.parse(readFileSync(join(dir, 'executor.lock'), 'utf8')).pid, process.pid);
  rmSync(dir, { recursive: true, force: true });
});

test('parallel startups admit exactly one holder', { skip: !linux, timeout: 30000 }, async () => {
  const dir = tempDir();
  const contenders = Array.from({ length: 8 }, () => holder(dir));
  const results = await Promise.all(contenders.map(contender => contender.first));
  assert.equal(results.filter(result => result === 'ACQUIRED').length, 1);
  for (const [index, contender] of contenders.entries()) {
    if (results[index] === 'ACQUIRED') contender.child.stdin.end();
    else contender.child.kill('SIGKILL');
  }
  for (const contender of contenders) contender.child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

test('a killed holder releases the fence without a reclaim protocol', { skip: !linux, timeout: 30000 }, async () => {
  const dir = tempDir();
  const first = holder(dir);
  assert.equal(await first.first, 'ACQUIRED');
  first.child.kill('SIGKILL');
  await new Promise(resolve => first.child.once('exit', resolve));
  const second = holder(dir);
  assert.equal(await second.first, 'ACQUIRED');
  second.child.stdin.end();
  await new Promise(resolve => second.child.once('exit', resolve));
  rmSync(dir, { recursive: true, force: true });
});

test('a symlinked or non-regular lock path fails closed', { skip: !linux }, async () => {
  const dir = tempDir();
  const target = join(dir, 'target');
  writeFileSync(target, '{}');
  symlinkSync(target, join(dir, 'executor.lock'));
  await assert.rejects(acquireInstanceLock(dir), error => error.code === 'executor_lock_invalid');
  rmSync(join(dir, 'executor.lock'));
  mkdirSync(join(dir, 'executor.lock'));
  await assert.rejects(acquireInstanceLock(dir), error => error.code === 'executor_lock_invalid');
  assert.equal(readFileSync(target, 'utf8'), '{}', 'the symlink target must stay untouched');
  rmSync(dir, { recursive: true, force: true });
});

function firstLine(child) {
  return new Promise(resolve => {
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.includes('\n')) resolve(buffer.split('\n')[0].trim());
    });
    child.once('exit', code => resolve(`EXIT ${code}`));
  });
}

test('the fence outlives the helper that applied it', { skip: !linux, timeout: 30000 }, async () => {
  const dir = tempDir();
  const script = `
    import { acquireInstanceLock } from ${JSON.stringify(moduleUrl)};
    import { readFileSync } from 'node:fs';
    const release = await acquireInstanceLock(${JSON.stringify(dir)});
    await new Promise(resolve => setTimeout(resolve, 200));
    const children = readFileSync('/proc/' + process.pid + '/task/' + process.pid + '/children', 'utf8').trim();
    console.log('CHILDREN=' + children);
    process.stdin.resume();
    process.stdin.on('end', () => { release(); process.exit(0); });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.equal(await firstLine(child), 'CHILDREN=', 'the helper exits once it applies the lock');
  const contender = holder(dir);
  assert.equal(await contender.first, 'REJECTED executor_already_running');
  contender.child.kill('SIGKILL');
  child.stdin.end();
  await new Promise(resolve => child.once('exit', resolve));
  rmSync(dir, { recursive: true, force: true });
});

test('health and startup wiring use the flock fence', () => {
  const sessions = readFileSync(fileURLToPath(new URL('../src/sessions.js', import.meta.url)), 'utf8');
  assert.match(sessions, /this\.releaseLock = await acquireInstanceLock/);
  assert.match(sessions, /await this\.releaseLock\?\.\(\)/);
});
