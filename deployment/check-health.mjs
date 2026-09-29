import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';

try {
  loadEnvFile(join(homedir(), '.config/qfli-terminal/runner.env'));
  const secret = process.env.QFLI_TERMINAL_SECRET;
  if (!/^[\x21-\x7e]{32,256}$/.test(secret ?? '')) {
    throw new Error('runner.env has no valid terminal secret');
  }
  const response = await fetch('http://127.0.0.1:3101/health', {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(5000),
  });
  const result = await response.json();
  if (response.status !== 200 || result?.ready !== true) {
    throw new Error(`executor health returned ${response.status}`);
  }
  console.log('QFLI terminal executor is ready on 127.0.0.1:3101');
} catch (error) {
  console.error(`QFLI terminal health check failed: ${error.message}`);
  process.exitCode = 1;
}
