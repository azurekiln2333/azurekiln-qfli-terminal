import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration } from '../src/config.js';
import { Docker } from '../src/docker.js';

const config = configuration();
const docker = new Docker(config);
const base = `/sys/fs/cgroup/user.slice/user-${config.uid}.slice`;
const userId = `user_${'c'.repeat(32)}`;
const headers = { authorization: `Bearer ${config.secret}`, 'content-type': 'application/json' };
async function request(route, body, method = 'POST') {
  const response = await fetch(`http://127.0.0.1:3101${route}`, {
    method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(85000),
  });
  return { status: response.status, body: await response.json() };
}
async function healthy() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await request('/health', undefined, 'GET')).status === 200) return; } catch {}
    await delay(1000);
  }
  assert.fail('executor did not recover');
}
const execute = command => request('/v1/exec', { userId, command });
async function reset() {
  assert.equal((await request('/v1/session', { userId }, 'DELETE')).status, 200);
  assert.equal((await docker.owned()).length, 0);
}
async function counters(file) {
  return Object.fromEntries((await readFile(`${base}/${file}`, 'utf8')).trim().split('\n')
    .map(line => { const [key, value] = line.split(/\s+/); return [key, Number(value)]; }));
}

await healthy();
await reset();
await docker.validateAccountBudget();
const beforeCpu = await counters('cpu.stat');
assert.equal((await execute(`python3 -c 'import subprocess,time;children=[subprocess.Popen(["python3","-c","while True: pass"]) for _ in range(2)];time.sleep(3)'`)).body.exitCode, 0);
const afterCpu = await counters('cpu.stat');
assert.ok(afterCpu.nr_throttled > beforeCpu.nr_throttled);
console.log('PASS account CPU throttling', JSON.stringify({ beforeCpu, afterCpu }));
await reset();

const storage = await execute(`python3 -c 'import errno;f=open("/tmp/full","wb");ok=False
try:
 for _ in range(65): f.write(bytes(1024*1024));f.flush()
except OSError as error: ok=error.errno==errno.ENOSPC
assert ok
print("PASS tmpfs bound")'`);
assert.equal(storage.body.exitCode, 0);
assert.equal(storage.body.stdout.trim(), 'PASS tmpfs bound');
console.log('PASS real tmpfs storage bound');
await reset();

const storm = await execute(`python3 -c 'import threading,time;threads=[]
try:
 for _ in range(80):
  thread=threading.Thread(target=lambda:time.sleep(30),daemon=True);thread.start();threads.append(thread)
except RuntimeError: print("TASK_CAP",len(threads),flush=True)
time.sleep(.3)'`);
console.log('TASK_STORM', JSON.stringify(storm));
if (storm.status === 200) {
  assert.match(storm.body.stdout, /TASK_CAP \d+/);
  assert.ok(Number(storm.body.stdout.trim().split(' ')[1]) < 64);
} else {
  assert.ok([409, 503].includes(storm.status));
  assert.ok(['sandbox_resource_terminated', 'sandbox_not_quiescent', 'sandbox_configuration_invalid', 'container_cleanup_pending']
    .includes(storm.body.error));
}
await healthy();
await reset();
console.log('PASS guest task storm is bounded or destroys the session');

if (process.argv.includes('--memory')) {
  const allocation = `python3 -c 'import time;chunks=[]
while True:
 chunk=bytearray(16*1024*1024);chunk[::4096]=b"x"*4096;chunks.append(chunk);time.sleep(.01)'`;
  for (const [name, command] of [['direct', allocation], ['outer-ignore', `${allocation}; echo outer-survived`]]) {
    const before = await counters('memory.events');
    let result;
    try { result = await execute(command); } catch (error) { result = { connectionError: error.name }; }
    const after = await counters('memory.events');
    console.log('MEMORY_PROBE', JSON.stringify({ name, before, after, result }));
    if (after.oom_kill === before.oom_kill && after.high > before.high &&
        result.body?.error === 'container_cleanup_pending') {
      assert.equal((await request('/health', undefined, 'GET')).status, 503);
      assert.equal((await docker.owned()).length, 1);
      console.log('LIMITATION memory.high pressure retained the sandbox and stopped admission; operator recovery required');
      process.exit(2);
    }
    assert.ok(after.oom_kill > before.oom_kill, 'host account memory ceiling did not produce an OOM kill');
    await healthy();
    await reset();
  }
  console.log('PASS direct and outer-ignore account OOM enforcement and recovery');
}
