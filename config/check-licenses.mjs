// Shared srcplugins file, synchronized across repositories.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Production dependencies ship in deployed apps and bundles, so their licenses are release facts.
const permissive = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  'Python-2.0',
]);
// Atlassian's Forge SDK packages are distributed under the Atlassian Developer Terms.
const atlassianTerms = 'SEE LICENSE IN LICENSE.txt';

export function licenseAllowed(name, license) {
  if (name.startsWith('@forge/') && license === atlassianTerms) return true;
  if (typeof license !== 'string' || !license) return false;
  const expression = license.replace(/^\((.*)\)$/, '$1');
  if (expression.includes(' AND '))
    return expression.split(' AND ').every((part) => licenseAllowed(name, part.trim()));
  return expression.split(' OR ').some((part) => permissive.has(part.trim()));
}

function resolve(packages, from, name) {
  for (let base = from; ; base = path.posix.dirname(base)) {
    const prefix = base === '.' || base === '' ? '' : `${base}/`;
    const candidate = `${prefix}node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!prefix) return undefined;
  }
}

// Walk the lockfile's production closure from one workspace, following npm's resolution order.
export function productionClosure(lock, workspace) {
  const { packages } = lock;
  if (!packages[workspace]) throw Error(`Unknown workspace: ${workspace}`);
  const found = new Map();
  const pending = [[workspace, packages[workspace]]];
  while (pending.length) {
    const [location, entry] = pending.pop();
    const names = Object.keys({ ...entry.dependencies, ...entry.optionalDependencies });
    for (const name of names) {
      let resolved = resolve(packages, location, name);
      if (resolved && packages[resolved].link) resolved = packages[resolved].resolved;
      if (!resolved || found.has(resolved)) continue;
      const target = packages[resolved];
      found.set(resolved, {
        name: target.name ?? resolved.slice(resolved.lastIndexOf('node_modules/') + 13),
        version: target.version,
        license: target.license,
      });
      pending.push([resolved, target]);
    }
  }
  return [...found.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

export function licenseFindings(lock, workspaces) {
  const findings = [];
  for (const workspace of workspaces)
    for (const item of productionClosure(lock, workspace))
      if (!licenseAllowed(item.name, item.license))
        findings.push(
          `${workspace}: ${item.name}@${item.version} (${item.license ?? 'no license'})`,
        );
  return [...new Set(findings)];
}

export function notices(lock, workspace) {
  const lines = [
    '# Third-party notices',
    '',
    'Production dependencies included in this app and its UI bundles.',
    '',
  ];
  lines.push('| Package | Version | License |', '|---|---|---|');
  // The same version can be installed at several nested paths; list each package version once.
  const rows = new Set(
    productionClosure(lock, workspace).map(
      (item) => `| ${item.name} | ${item.version} | ${item.license} |`,
    ),
  );
  lines.push(...rows);
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [rootArgument, mode] = process.argv.slice(2);
  const root = rootArgument ?? fileURLToPath(new URL('../', import.meta.url));
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const workspaces = manifest.workspaces
    ? Object.keys(lock.packages).filter((key) => key && !key.includes('node_modules/'))
    : [''];
  const findings = licenseFindings(lock, workspaces);
  for (const finding of findings) console.error(`Disallowed production license: ${finding}`);
  // A standalone app repository publishes its notices; keep them derived from its lockfile.
  const noticesFile = path.join(root, 'THIRD_PARTY_NOTICES.md');
  if (mode === '--write-notices') writeFileSync(noticesFile, notices(lock, ''));
  else if (!manifest.workspaces && readFileSync(noticesFile, 'utf8') !== notices(lock, '')) {
    console.error('THIRD_PARTY_NOTICES.md is stale; run npm run notices.');
    process.exitCode = 1;
  }
  if (findings.length) process.exitCode = 1;
  else if (!process.exitCode)
    console.log(
      `Production dependency licenses allowed for ${workspaces.length} workspace(s); Forge SDK packages use the Atlassian Developer Terms.`,
    );
}
