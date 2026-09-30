import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Sessions } from '../src/sessions.js';

test('startup isolates supervisor signals and allows executing bounded workspace binaries', async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'qfli-session-test-'));
  try {
    const sessions = new Sessions({ runtimeDir });
    await mkdir(sessions.pendingDir);
    const calls = [];
    sessions.docker = {
      async require(args) {
        calls.push(args);
        return args[0] === 'exec' ? '{"ready":true}' : '';
      },
      async validateContainer() { return 'verified-container'; },
    };
    await sessions.create(sessions.reserve('test-user'));
    const create = calls.find(args => args[0] === 'create');
    assert.equal(create[create.indexOf('--user') + 1], '65533:65533');
    assert.ok(create.includes('/workspace:rw,nosuid,nodev,exec,size=256m,mode=0700,uid=65532,gid=65532'));
    assert.ok(create.includes('/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777'));
    const ready = calls.find(args => args[0] === 'exec');
    assert.equal(ready[ready.indexOf('--user') + 1], '65532:65532');
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('user commands retain the installed SDK paths and bounded compiler environment', async () => {
  const sessions = new Sessions({ runtimeDir: '/unused' });
  const record = sessions.reserve('test-user');
  const calls = [];
  sessions.docker = {
    async validateContainer() {},
    async run(args) {
      calls.push(args);
      return args.includes('/usr/local/lib/qfli/cleanup.py')
        ? { exitCode: 0, stdout: '{"quiescent":true}', stderr: '' }
        : { exitCode: 0, stdout: 'ok', stderr: '' };
    },
  };
  const result = await sessions.executeAdmitted('test-user', 'dart main.dart',
    new AbortController().signal, undefined, async () => {});
  const command = calls.find(args => args.includes('/bin/sh'));
  assert.ok(command.includes('PATH=/opt/node/bin:/opt/dart-sdk/bin:/usr/local/bin:/usr/bin:/bin'));
  assert.ok(command.includes('TMPDIR=/workspace/.tmp'));
  assert.ok(command.includes('GOMAXPROCS=1'));
  assert.ok(command.includes('CARGO_BUILD_JOBS=1'));
  assert.equal(result.stdout, 'ok');
  assert.equal(record.busy, false);
});
