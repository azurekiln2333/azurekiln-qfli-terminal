import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'check.mjs');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function run(cwd, script = SCRIPT) {
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'qfli-terminal-lint-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fixture',
    version: '1.0.0',
    type: 'module',
    scripts: { lint: 'node scripts/check.mjs' },
  }, null, 2));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(SCRIPT, join(dir, 'scripts', 'check.mjs'));
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return { dir, script: join(dir, 'scripts', 'check.mjs') };
}

test('npm run lint is declared and passes on the real repository tree', () => {
  assert.equal(MANIFEST.scripts.lint, 'node scripts/check.mjs');
  const result = run(ROOT);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /lint passed/);
});

test('lint rejects syntax errors and missing local imports', () => {
  const brokenImport = `${'imp'}ort './${'does-not-exist'}.js';\n`;
  const badSyntax = fixture({ 'src/broken.js': 'export function ( {}\n' });
  try {
    const res1 = run(badSyntax.dir, badSyntax.script);
    assert.equal(res1.status, 1);
    assert.match(res1.stderr, /syntax check failed/);
  } finally {
    rmSync(badSyntax.dir, { recursive: true, force: true });
  }

  const missingMod = fixture({ 'src/missing.js': brokenImport });
  try {
    const res2 = run(missingMod.dir, missingMod.script);
    assert.equal(res2.status, 1);
    assert.match(res2.stderr, /imports missing module/);
  } finally {
    rmSync(missingMod.dir, { recursive: true, force: true });
  }
});

test('lint rejects invalid package.json or missing script targets', () => {
  const invalidJson = fixture({});
  try {
    writeFileSync(join(invalidJson.dir, 'package.json'), '{ invalid\n');
    const res1 = run(invalidJson.dir, invalidJson.script);
    assert.equal(res1.status, 1);
    assert.match(res1.stderr, /not valid JSON/);
  } finally {
    rmSync(invalidJson.dir, { recursive: true, force: true });
  }

  const missingScript = fixture({});
  try {
    writeFileSync(join(missingScript.dir, 'package.json'), JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      scripts: { start: 'node src/server.js' },
    }));
    const res2 = run(missingScript.dir, missingScript.script);
    assert.equal(res2.status, 1);
    assert.match(res2.stderr, /target does not exist: src\/server\.js/);
  } finally {
    rmSync(missingScript.dir, { recursive: true, force: true });
  }
});
