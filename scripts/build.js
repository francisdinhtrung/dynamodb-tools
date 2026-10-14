// Build standalone `ddb` executables (no Node/npm needed on the target machine) using `deno compile`.
// Usage: node scripts/build.js [target ...]   (default: all targets). Requires Deno 2.x and `npm ci`.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const TARGETS = {
  'windows-x64': 'x86_64-pc-windows-msvc',
  'macos-arm64': 'aarch64-apple-darwin',
  'macos-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
};

const wanted = process.argv.slice(2);
for (const name of wanted) {
  if (!TARGETS[name]) throw new Error(`Unknown target "${name}". Known: ${Object.keys(TARGETS).join(', ')}`);
}

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
const sums = [];
for (const name of wanted.length ? wanted : Object.keys(TARGETS)) {
  const file = `ddb-${name}${name.startsWith('windows') ? '.exe' : ''}`;
  console.log(`Building dist/${file}`);
  execFileSync(
    'deno',
    ['compile', '-A', '--no-check', '--quiet', '--target', TARGETS[name], '--output', `dist/${file}`, 'bin/ddb.js'],
    { stdio: 'inherit' },
  );
  sums.push(`${createHash('sha256').update(readFileSync(`dist/${file}`)).digest('hex')}  ${file}`);
}
writeFileSync('dist/SHA256SUMS', sums.join('\n') + '\n');
console.log('Done:\n' + sums.join('\n'));
