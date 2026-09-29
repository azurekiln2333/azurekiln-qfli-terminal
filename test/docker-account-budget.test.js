import assert from 'node:assert/strict';
import test from 'node:test';
import { accountBudgetValid } from '../src/docker.js';

const bounded = { memory: '1073741824\n', swap: '0\n', pids: '1024\n', cpu: '100000 100000\n' };

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
