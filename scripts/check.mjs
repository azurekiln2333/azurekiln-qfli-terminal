// Zero-dependency static check: syntax, parseable package.json, script entries, local ESM imports.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'coverage', '.git', '__pycache__']);
const SOURCE_DIRS = ['src', 'test', 'scripts', 'deployment'];
const CODE_FILE = /\.(js|cjs|mjs)$/;

const failures = [];
let checked = 0;

function walk(directory) {
  let items;
  try {
    items = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const item of items) {
    if (SKIP_DIRS.has(item.name)) continue;
    const target = join(directory, item.name);
    if (item.isDirectory()) files.push(...walk(target));
    else if (CODE_FILE.test(item.name)) files.push(target);
  }
  return files;
}

function relative(target) {
  return target.slice(root.length + 1).replaceAll('\\', '/');
}

function checkSyntax(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  checked += 1;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(0, 6).join('\n');
    failures.push(`${relative(file)} syntax check failed\n${detail}`);
  }
}

function checkPackageJson() {
  const manifestPath = join(root, 'package.json');
  if (!existsSync(manifestPath)) {
    failures.push('package.json is missing');
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    failures.push(`package.json is not valid JSON: ${error.message}`);
    return;
  }
  for (const field of ['name', 'version', 'scripts']) {
    if (!manifest[field]) failures.push(`package.json missing ${field}`);
  }
  if (!/^\d+\.\d+\.\d+/.test(String(manifest.version || ''))) {
    failures.push(`package.json version is not semver: ${manifest.version}`);
  }
  for (const [name, command] of Object.entries(manifest.scripts || {})) {
    for (const token of String(command).split(/\s+/)) {
      if (!/\.(?:js|cjs|mjs)$/.test(token)) continue;
      const candidate = token.replace(/^['"]|['"]$/g, '');
      if (/[*?[\]]/.test(candidate)) continue;
      const entry = join(root, candidate);
      if (!existsSync(entry)) failures.push(`npm run ${name} target does not exist: ${candidate}`);
    }
  }
}

function checkLocalImports(file, text) {
  const specifiers = [
    ...text.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g),
    ...text.matchAll(/\bimport\s+['"](\.[^'"]+)['"]/g),
    ...text.matchAll(/\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g),
  ].map(match => match[1]);
  for (const specifier of specifiers) {
    const target = resolve(dirname(file), specifier);
    const candidates = [target, `${target}.js`, `${target}.mjs`, `${target}.cjs`];
    const found = candidates.some(candidate => existsSync(candidate) && statSync(candidate).isFile());
    if (!found) failures.push(`${relative(file)} imports missing module: ${specifier}`);
  }
}

for (const directory of SOURCE_DIRS) {
  for (const file of walk(join(root, directory))) {
    checkSyntax(file);
    checkLocalImports(file, readFileSync(file, 'utf8'));
  }
}

checkPackageJson();

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`\nlint failed: ${failures.length} issue(s) across ${checked} file(s)`);
  process.exit(1);
}

console.info(`lint passed: checked ${checked} JavaScript file(s) and package.json`);
