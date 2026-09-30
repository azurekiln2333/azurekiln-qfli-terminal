import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration } from '../src/config.js';
import { Docker } from '../src/docker.js';

const config = configuration();
const docker = new Docker(config);
const origin = 'http://127.0.0.1:3101';
const userId = `user_${'a'.repeat(32)}`;
const otherId = `user_${'b'.repeat(32)}`;
const headers = { authorization: `Bearer ${config.secret}`, 'content-type': 'application/json' };
async function request(route, body, method = 'POST') {
  const response = await fetch(`${origin}${route}`, {
    method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.json() };
}
const reset = id => request('/v1/session', { userId: id }, 'DELETE');
async function emptyInventory() {
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await docker.owned()).length === 0) return;
    await delay(100);
  }
  assert.fail('owned sandbox was not removed');
}
async function stream(command, onEvent = () => {}, signal) {
  const response = await fetch(`${origin}/v1/exec/stream`, {
    method: 'POST', headers, body: JSON.stringify({ userId, command }), signal,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const events = [];
  let pending = '';
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const event = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      events.push(event);
      await onEvent(event);
    }
  }
  assert.equal(pending, '');
  return events;
}

assert.equal((await fetch(`${origin}/health`)).status, 401);
for (let attempt = 0; attempt < 30; attempt++) {
  if ((await request('/health', undefined, 'GET')).status === 200) break;
  await delay(1000);
}
assert.equal((await request('/health', undefined, 'GET')).status, 200);
await reset(userId);
await reset(otherId);
await emptyInventory();
assert.equal((await request('/v1/exec', { userId, command: 'true', runtime: 'runc' })).status, 400);
assert.equal((await request('/v1/exec', {
  userId, command: 'true', files: [{ path: '../host-file', content: 'eA==' }],
})).status, 400);
await emptyInventory();
console.log('PASS authentication and request bounds');

for (const language of ['cpp', 'dart']) {
  for (let round = 0; round < 20; round++) {
    const result = await request('/v1/exec', { userId, command: `/usr/local/lib/qfli/smoke-languages.sh ${language}` });
    assert.equal(result.status, 200);
    assert.equal(result.body.exitCode, 0);
    assert.equal(result.body.stdout.trim(), `PASS ${language}`);
  }
  console.log(`PASS 20 consecutive ${language} compile and cleanup operations`);
}
assert.equal((await request('/v1/exec', { userId: otherId, command: 'true' })).body.error, 'session_capacity');
await reset(userId);
await emptyInventory();
console.log('PASS single-session capacity and reset');

const events = await stream(`python3 -c 'import os,time;data=bytes([228,184,173,230,150,135]);os.write(1,data[:2]);time.sleep(.05);os.write(1,data[2:]);os.write(2,b"stderr\\n")'`);
const final = events.at(-1);
assert.equal(final.type, 'result');
assert.equal(final.exitCode, 0);
assert.equal(final.stdout, String.fromCodePoint(0x4e2d, 0x6587));
assert.equal(final.stderr, 'stderr\n');
assert.equal(events.filter(event => event.type === 'stdout').map(event => event.text).join(''), final.stdout);
assert.equal(events.filter(event => event.type === 'stderr').map(event => event.text).join(''), final.stderr);
assert.deepEqual(events.filter(event => event.type === 'progress').map(event => event.stage),
  ['initializing', 'ready', 'running', 'cleaning']);
console.log('PASS streaming progress and split UTF-8');

const controller = new AbortController();
await assert.rejects(stream('sleep 30', event => {
  if (event.stage === 'running') controller.abort();
}, controller.signal), error => error.name === 'AbortError');
await emptyInventory();
console.log('PASS client disconnect destroys session');

let started;
const running = new Promise(resolve => { started = resolve; });
const active = stream('sleep 30', event => { if (event.stage === 'running') started(); });
await running;
assert.equal((await request('/v1/exec', { userId, command: 'true' })).body.error, 'user_command_busy');
assert.equal((await reset(userId)).status, 200);
const cancelled = await active;
assert.equal(cancelled.at(-1).type, 'error');
assert.equal(cancelled.at(-1).message, 'execution_cancelled');
await emptyInventory();
console.log('PASS user exclusivity and active reset');

const snapshot = content => [{ path: 'entry.txt', content: Buffer.from(content).toString('base64') }];
const first = await request('/v1/exec', { userId, command: 'cat entry.txt; pwd', files: snapshot('first\n') });
const second = await request('/v1/exec', { userId, command: 'cat entry.txt; pwd', files: snapshot('second\n') });
assert.equal(first.body.exitCode, 0);
assert.equal(second.body.exitCode, 0);
assert.ok(first.body.stdout.startsWith('first\n/workspace/.qfli-run-'));
assert.ok(second.body.stdout.startsWith('second\n/workspace/.qfli-run-'));
assert.notEqual(first.body.stdout.split('\n')[1], second.body.stdout.split('\n')[1]);
await reset(userId);
await emptyInventory();
console.log('PASS isolated per-run snapshots');
