import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';

// The containerized executor receives its secret through the environment.
// Installed host services keep using the dedicated runner env file.
const legacyEnv = join(homedir(), '.config/qfli-terminal/runner.env');
try {
  if (!process.env.QFLI_TERMINAL_SECRET && existsSync(legacyEnv)) loadEnvFile(legacyEnv);
  const secret = process.env.QFLI_TERMINAL_SECRET;
  if (!/^[\x21-\x7e]{32,256}$/.test(secret ?? '')) {
    throw new Error('no valid terminal secret is configured');
  }
  const response = await fetch('http://127.0.0.1:3101/health', {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(5000),
  });
  const result = await response.json();
  if (response.status !== 200 || result?.ready !== true) {
    throw new Error(`executor health returned ${response.status}`);
  }
  const capacity = result.capacity ?? {};
  const bounded = ['sessions', 'running', 'waiting',
    'sessionsLimit', 'runningLimit', 'queueLimit'];
  if (bounded.some(key => !Number.isInteger(capacity[key]) || capacity[key] < 0)) {
    throw new Error('executor health is missing bounded capacity metadata');
  }
  console.log(`QFLI terminal executor is ready on 127.0.0.1:3101 ${JSON.stringify(capacity)}`);
} catch (error) {
  console.error(`QFLI terminal health check failed: ${error.message}`);
  process.exitCode = 1;
}
