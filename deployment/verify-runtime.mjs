import net from 'node:net';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { configuration } from '../src/config.js';
import { Sessions } from '../src/sessions.js';
import { languages } from '../src/sandbox.js';

const sessions = new Sessions(configuration());
const lock = net.createServer(socket => socket.destroy());
// Use the executor's port lock before reconciling its owned containers.
lock.listen(3101, '127.0.0.1');
await once(lock, 'listening');
try {
  await sessions.initialize();
  const check = async (command, expected, options) => {
    const result = await sessions.execute('installation-verifier', command,
      new AbortController().signal, options);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.exitCode !== 0 || result.stdout.trim() !== expected) {
      throw new Error(`runtime_verification_failed:${expected}:${result.exitCode}`);
    }
  };
  for (const language of languages) {
    const started = Date.now();
    const result = await sessions.execute('installation-verifier',
      `/usr/local/lib/qfli/smoke-languages.sh ${language}`, new AbortController().signal);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.exitCode !== 0 || result.stdout.trim() !== `PASS ${language}`) {
      throw new Error(`toolchain_verification_failed:${language}:${result.exitCode}`);
    }
    console.log(JSON.stringify({ language, durationMs: Date.now() - started, passed: true }));
  }
  const isolation = await readFile(new URL('./smoke-isolation.py', import.meta.url));
  await check('python3 verify.py', 'PASS isolation', {
    files: [{ path: 'verify.py', content: isolation.toString('base64') }],
  });
  await check('sleep 120 & echo $! > /workspace/background.pid; echo PASS background-start', 'PASS background-start');
  await check('if kill -0 "$(cat /workspace/background.pid)" 2>/dev/null; then exit 1; fi; echo PASS cleanup', 'PASS cleanup');
  await check('touch /workspace/reset-proof && echo PASS reset-prepare', 'PASS reset-prepare');
  await sessions.reset('installation-verifier');
  await check('test ! -e /workspace/reset-proof && echo PASS reset', 'PASS reset');
  for (const [command, expected] of [
    ["python3 -c 'print(\"x\" * 110000)'", 'output_limit'],
    ['sleep 65', 'command_timeout'],
  ]) {
    let rejected = false;
    try {
      await sessions.execute('installation-verifier', command, new AbortController().signal);
    } catch (error) {
      if (error.code !== expected) throw error;
      rejected = true;
    }
    if (!rejected || sessions.records.size !== 0) throw new Error(`runtime_limit_failed:${expected}`);
    console.log(`PASS ${expected}`);
  }
} finally {
  const cleaned = await sessions.shutdown();
  await new Promise(resolve => lock.close(resolve));
  if (!cleaned) throw new Error('toolchain_verification_cleanup_failed');
}
