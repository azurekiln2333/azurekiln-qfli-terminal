import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountBudgetValid, readAccountLimits } from '../src/docker.js';

const bounded = { memory: '1073741824\n', swap: '0\n', pids: '1024\n', cpu: '100000 100000\n' };

test('a slice that has not published its limit files fails closed with a clear code', async () => {
  const base = mkdtempSync(join(tmpdir(), 'qfli-slice-'));
  writeFileSync(join(base, 'memory.max'), bounded.memory);
  writeFileSync(join(base, 'memory.swap.max'), bounded.swap);
  writeFileSync(join(base, 'pids.max'), bounded.pids);
  // cpu.max is missing, which happens right after a reboot.
  await assert.rejects(readAccountLimits(base), error => error.code === 'sandbox_resource_controls_missing');
  writeFileSync(join(base, 'cpu.max'), 'max 100000\n');
  const limits = await readAccountLimits(base);
  assert.equal(limits.cpu, 'max 100000\n');
  rmSync(base, { recursive: true, force: true });
});

test('accepts the fixed account-wide CPU, memory, swap and task limits', () => {
  assert.equal(accountBudgetValid(bounded), true);
});

test('rejects absent or ineffective host resource controls', () => {
  for (const values of [
    { memory: 'max' }, { memory: '1073741825' }, { swap: 'max' },
    { pids: 'max' }, { pids: '1025' }, { cpu: 'max 100000' },
    { cpu: '100001 100000' },
  ]) {
    assert.equal(accountBudgetValid({ ...bounded, ...values }), false, JSON.stringify(values));
  }
});
