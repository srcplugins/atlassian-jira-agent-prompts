// Shared srcplugins file, synchronized across repositories.
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  renameSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Build a LOCAL security variant; do not publish it as an Atlassian release.
// Source bytes and license stay intact. Only the vendor dependency lock is removed.
const root = fileURLToPath(new URL('../', import.meta.url));
const sourceIntegrity =
  'sha512-ahcvaGo1pyGdMk11WL+GKvOk8Orrpf7dE5oJ6PEKzn4CtFAxopO0hN7Mj2ikR5gBvpwf1MlZJi+moRyPEk4kUQ==';
const directory = path.join(root, '.local/toolchain');
mkdirSync(directory, { recursive: true });
const archive = path.join(directory, 'upstream-cli-14.0.0.tgz');
const output = path.join(directory, 'forge-cli-14.0.0.tgz');
function integrity(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env });
  if (result.status !== 0)
    throw Error(`${command} failed: ${result.stderr || result.error || result.status}`);
  return result.stdout;
}
if (!existsSync(archive)) {
  const response = await fetch('https://registry.npmjs.org/@forge/cli/-/cli-14.0.0.tgz', {
    signal: AbortSignal.timeout(60000),
    redirect: 'error',
  });
  if (!response.ok) throw Error(`CLI download HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (integrity(bytes) !== sourceIntegrity) throw Error('Upstream CLI checksum mismatch.');
  writeFileSync(archive, bytes);
}
if (integrity(readFileSync(archive)) !== sourceIntegrity)
  throw Error('Cached upstream CLI checksum mismatch.');
// The fixed trusted archive is additionally restricted to package-relative entries.
const entries = run('tar', ['-tzf', archive]).trim().split('\n');
if (entries.some((entry) => !entry.startsWith('package/') || entry.split('/').includes('..')))
  throw Error('Unexpected archive path.');
const work = mkdtempSync(path.join(directory, 'build-'));
run('tar', ['-xzf', archive, '-C', work]);
unlinkSync(path.join(work, 'package/npm-shrinkwrap.json'));
const packed = JSON.parse(
  run('npm', [
    'pack',
    path.join(work, 'package'),
    '--ignore-scripts',
    '--cache',
    path.join(root, '.local/npm-cache'),
    '--pack-destination',
    work,
    '--json',
  ]),
);
const candidate = path.join(work, packed[0].filename);
const after = run('tar', ['-tzf', candidate]).trim().split('\n');
const expected = entries.filter((entry) => entry !== 'package/npm-shrinkwrap.json').sort();
if (JSON.stringify(after.sort()) !== JSON.stringify(expected))
  throw Error('Repack changed unexpected package entries.');
// Compare every retained file's bytes, not just the file list.
const verify = path.join(work, 'verify');
mkdirSync(verify);
run('tar', ['-xzf', candidate, '-C', verify]);
for (const entry of after.filter((entry) => !entry.endsWith('/'))) {
  if (!readFileSync(path.join(work, entry)).equals(readFileSync(path.join(verify, entry))))
    throw Error(`Unexpected source change: ${entry}`);
}
const outputIntegrity = integrity(readFileSync(candidate));
// Once a lock exists, a rebuild must reproduce precisely the same archive.
const lockPath = path.join(root, 'package-lock.json');
if (existsSync(lockPath)) {
  const locked = JSON.parse(readFileSync(lockPath)).packages?.['node_modules/@forge/cli'];
  if (
    locked?.resolved === 'file:.local/toolchain/forge-cli-14.0.0.tgz' &&
    locked.integrity !== outputIntegrity
  )
    throw Error('Security archive differs from project lock. Review before updating the lockfile.');
}
renameSync(candidate, output);
writeFileSync(
  path.join(directory, 'provenance.json'),
  JSON.stringify(
    {
      upstreamVersion: '14.0.0',
      sourceIntegrity,
      outputIntegrity,
      removed: ['npm-shrinkwrap.json'],
      retainedFilesByteIdentical: true,
      dependencies: 'Pinned by repository package-lock.json and scoped overrides',
    },
    null,
    2,
  ) + '\n',
);
console.log('Verified local CLI archive: vendor source unchanged; dependency shrinkwrap removed.');
