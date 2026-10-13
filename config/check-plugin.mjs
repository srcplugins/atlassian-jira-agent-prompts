// Shared srcplugins file, synchronized across repositories.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';

// Self-contained so standalone plugin repositories can run it in their own CI (synchronized
// to config/check-plugin.mjs).

export const requiredSections = ['Usage', 'Permissions', 'Data', 'Rovo control'];

/**
 * Manifest defaults every Forge app must keep unless an explicit review says otherwise.
 * @param {string} source manifest.yml text
 * @param {string} nodeMajor the Node major pinned in .nvmrc
 */
export function manifestFindings(source, nodeMajor) {
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length) return ['Manifest must be valid YAML with unique keys.'];
  const manifest = doc.toJS();
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    return ['Manifest must be an object.'];
  const failures = [];
  for (const key of ['remotes', 'connectModules'])
    if (key in manifest) failures.push(`Unexpected ${key}; explicit architecture review required.`);
  if (manifest.app?.connect) failures.push('Unexpected Connect configuration.');
  if (manifest.permissions?.external)
    failures.push('External egress is outside the default profile.');
  if (manifest.providers?.auth) failures.push('External authentication needs explicit review.');
  if (manifest.app?.runtime?.name !== `nodejs${nodeMajor}.x`)
    failures.push(`Runtime must be nodejs${nodeMajor}.x to match .nvmrc.`);
  return failures;
}

export function dependencyPinFindings(pkg) {
  const failures = [];
  for (const group of ['dependencies', 'devDependencies'])
    for (const [name, version] of Object.entries(pkg[group] ?? {}))
      // Exact versions, the verified local Forge CLI archive, or a GitHub release tag.
      if (
        !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) &&
        !/^file:\.local\/toolchain\/[\w.-]+\.tgz$/.test(version) &&
        !/^github:[\w.-]+\/[\w.-]+#v\d+\.\d+\.\d+$/.test(version)
      )
        failures.push(`package.json: ${name} must use an exact version.`);
  return failures;
}

// Supports the block-list scope convention only; other forms fail closed.
export function manifestScopes(text) {
  const permissions = text.match(/^permissions:\s*\n((?:[ \t]+[^\n]*\n|\n)*)/m)?.[1];
  const scopes = permissions?.match(/^ {2}scopes:\s*\n((?: {4}[^\n]*\n|\n)*)/m)?.[1];
  if (!scopes) throw Error('Use the documented permissions.scopes block-list convention.');
  return scopes
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const match = line.match(/^- ([a-zA-Z0-9:-]+)(?:\s+#.*)?$/);
      if (!match) throw Error('Unsupported manifest scope syntax; extend the checker explicitly.');
      return match[1];
    })
    .sort();
}

const prose = (text) => text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
const anchor = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
    .replace(/\s/g, '-');

/** README structure, local links and an exact scope table. It cannot check factual accuracy. */
export function readmeFindings(appDir) {
  const path = join(appDir, 'README.md');
  if (!existsSync(path)) return ['README.md: missing'];
  const errors = [];
  const text = prose(readFileSync(path, 'utf8'));
  if (!text.trim().startsWith('# ')) errors.push('README.md: missing title');
  if (/\b(?:TODO|TBD|FIXME)\b|__[A-Z_]+__/.test(text))
    errors.push('README.md: unresolved placeholder; state the actual limitation instead');
  for (const heading of requiredSections) {
    const marker = `## ${heading}\n`;
    const start = text.indexOf(marker);
    const body = start < 0 ? '' : text.slice(start + marker.length).split(/^## /m)[0];
    if (body.trim().length < 20) errors.push(`README.md: missing or empty ${heading}`);
  }
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const [relative, hash] = target.split('#');
    const dest = relative ? resolve(dirname(path), relative) : path;
    if (!existsSync(dest)) errors.push(`README.md: broken local link ${target}`);
    else if (hash && dest.endsWith('.md')) {
      const anchors = [...readFileSync(dest, 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map((m) =>
        anchor(m[1]),
      );
      if (!anchors.includes(hash)) errors.push(`README.md: missing local heading ${target}`);
    }
  }
  try {
    const expected = manifestScopes(readFileSync(join(appDir, 'manifest.yml'), 'utf8'));
    const documented = [...text.matchAll(/^\|\s+`([a-zA-Z0-9:-]+)`\s+\|\s+(.+?)\s+\|$/gm)].filter(
      (m) => m[1].includes(':'),
    );
    if (JSON.stringify(documented.map((m) => m[1]).sort()) !== JSON.stringify(expected))
      errors.push('README.md: scope table must match manifest scopes exactly');
    for (const row of documented)
      if (row[2].trim().length < 20) errors.push(`README.md: explain why ${row[1]} is required`);
  } catch (error) {
    errors.push(`manifest.yml: ${error.message}`);
  }
  return errors;
}

// Custom UI must follow the host theme: colours come from ADS tokens (raw values only as token
// fallbacks), a light color-scheme is never forced, and every bundle entry enables theming.
const token = /var\(\s*--ds-[\w-]+\s*(?:,(?:[^()]|\([^()]*\))*)?\)/g;
const rawColour = /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i;
export function cssFindings(css) {
  const findings = [];
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (rawColour.test(withoutComments.replace(token, 'token')))
    findings.push('raw colour outside an ADS token fallback');
  const schemes = [...withoutComments.matchAll(/color-scheme\s*:\s*([^;}]+)/g)].map((m) => m[1]);
  if (schemes.some((s) => /\blight\b/.test(s)) && !schemes.some((s) => /\bdark\b/.test(s)))
    findings.push('light color-scheme without a dark scheme');
  return findings;
}

export function themeFindings(appDir) {
  const manifest = parseDocument(readFileSync(join(appDir, 'manifest.yml'), 'utf8')).toJS();
  // UI Kit resources name a source file; Custom UI resources name a built directory.
  if (!(manifest?.resources ?? []).some((resource) => !/\.[jt]sx?$/.test(resource.path))) return [];
  const findings = [];
  for (const dir of ['ui', 'src'].map((name) => join(appDir, name)).filter(existsSync))
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.css')))
      for (const finding of cssFindings(readFileSync(join(dir, file), 'utf8')))
        findings.push(`${file}: ${finding}`);
  const build = join(appDir, 'build-ui.mjs');
  const entries = existsSync(build)
    ? [
        ...readFileSync(build, 'utf8').matchAll(
          /\$\{directory\}((?:ui|src)\/[\w.-]+\.(?:js|tsx?))`/g,
        ),
      ]
    : [];
  if (!entries.length) findings.push('build-ui.mjs: no discoverable Custom UI entry');
  for (const [, entry] of entries)
    if (!/view\.theme\.enable\(/.test(readFileSync(join(appDir, entry), 'utf8')))
      findings.push(`${entry}: call view.theme.enable() so the UI follows the host theme`);
  return findings;
}

// Hosts that may appear as literals in a built Custom UI bundle without being an egress path.
// The manifest guard already rejects declared egress, so Forge's CSP blocks any real request to
// these; the list exists so a dependency upgrade or new code that adds a host fails review.
export const inertBundleHosts = new Set([
  // XML namespaces, documentation and error-decoder links: never fetched.
  'www.w3.org',
  'reactjs.org',
  'fb.me',
  'github.com',
  'developer.atlassian.com',
  'go.atlassian.com',
  'compiledcssinjs.com',
  'iframe-resizer.com',
  'docs.statsig.com',
  // Atlaskit's feature-gate client (Statsig), pulled in by @atlaskit components. Undeclared, so
  // CSP blocks it; hosted acceptance checks the network and CSP for it.
  'xp.atlassian.com',
  'api.atlassian.com',
  'api.dev.atlassian.com',
  'api.stg.atlassian.com',
  'api.atlassian-us-gov-mod.com',
  'api.stg.atlassian-us-gov-mod.com',
  'atlassian-statsig-proxy-archetype.atl',
  'statsigapi.net',
  'api.statsigcdn.com',
  'featureassets.org',
  'prodregistryv2.org',
  'cloudflare-dns.com',
]);

/** Absolute URL hosts found in a built bundle that are not known to be inert. */
export function bundleHostFindingsIn(text, allowed = inertBundleHosts) {
  const hosts = new Set(
    [...text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase()),
  );
  return [...hosts].filter((host) => !allowed.has(host)).sort();
}

// Scans built Custom UI resource directories (UI Kit bundles are built by Forge at deploy).
// A missing directory means the UI has not been built; `npm run check` builds it first.
export function bundleHostFindings(appDir) {
  const manifest = parseDocument(readFileSync(join(appDir, 'manifest.yml'), 'utf8')).toJS();
  const findings = [];
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name))
        : /\.(?:m?js|html|css)$/.test(entry.name)
          ? [join(dir, entry.name)]
          : [],
    );
  for (const resource of manifest?.resources ?? []) {
    if (/\.[jt]sx?$/.test(resource.path)) continue;
    const dir = join(appDir, resource.path);
    if (!existsSync(dir)) continue;
    for (const file of walk(dir))
      for (const host of bundleHostFindingsIn(readFileSync(file, 'utf8')))
        findings.push(
          `${file.slice(appDir.length + 1)}: unreviewed external host ${host} in the built bundle`,
        );
  }
  return findings;
}

// Every manifest function must point at an exported handler, and every export of a handler
// module must be declared: undeclared exports are unreachable code or a forgotten module.
export function handlerFindings(appDir) {
  const functions =
    parseDocument(readFileSync(join(appDir, 'manifest.yml'), 'utf8')).toJS()?.modules?.function ??
    [];
  const declared = new Set(functions.map((fn) => String(fn.handler)));
  const findings = [];
  for (const file of new Set([...declared].map((handler) => handler.split('.')[0]))) {
    const source = ['ts', 'mjs', 'js']
      .map((extension) => join(appDir, 'src', `${file}.${extension}`))
      .find(existsSync);
    if (!source) {
      findings.push(`manifest.yml: no src/${file} module for its handlers`);
      continue;
    }
    const text = readFileSync(source, 'utf8');
    const exported = new Set(
      [...text.matchAll(/^export\s+(?:async\s+)?(?:const|let|function)\s+([\w$]+)/gm)].map(
        (m) => m[1],
      ),
    );
    for (const [, names] of text.matchAll(/^export\s*\{([^}]*)\}/gm))
      for (const name of names.split(',').map((part) =>
        part
          .trim()
          .split(/\s+as\s+/)
          .pop(),
      ))
        if (name) exported.add(name);
    for (const handler of declared)
      if (handler.startsWith(`${file}.`) && !exported.has(handler.slice(file.length + 1)))
        findings.push(`manifest.yml: handler ${handler} is not exported by src/${file}`);
    for (const name of exported)
      if (!declared.has(`${file}.${name}`))
        findings.push(`src/${file}: export ${name} is not a manifest function handler`);
  }
  return findings;
}

export const nodeMajor = (directory) =>
  readFileSync(join(directory, '.nvmrc'), 'utf8').trim().split('.')[0];

// Plugin repositories are public. Tracked files carry no agent instructions, no Atlassian site
// host (example hosts are fine) and no Atlassian account ID; sites and accounts come from private
// configuration. File names are reported, never the values.
const agentFile =
  /(?:^|\/)(?:CLAUDE\.md|AGENTS\.md|\.claude\/|\.codex\/|\.cursor\/|\.cursorrules$|\.github\/copilot-instructions\.md$)/;
const siteHost = /\b([a-z0-9-]+)\.atlassian\.net\b/g;
const accountId = /\b[0-9]{6}:[0-9a-f-]{36}\b|\b5[0-9a-f]{23}\b/;
export function publicRepositoryFindingsIn(file, text) {
  const findings = [];
  if (agentFile.test(file)) findings.push(`${file}: agent instructions must not be committed`);
  for (const [, name] of text.matchAll(siteHost))
    if (!/example|owned/.test(name)) {
      findings.push(`${file}: names an Atlassian site; use configuration instead`);
      break;
    }
  if (accountId.test(text))
    findings.push(`${file}: contains an Atlassian account ID; use configuration instead`);
  return findings;
}
export function publicRepositoryFindings(appDir) {
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: appDir, encoding: 'utf8' });
  if (tracked.status !== 0) return [];
  return tracked.stdout
    .split('\0')
    .filter((file) => file && existsSync(join(appDir, file)))
    .flatMap((file) => publicRepositoryFindingsIn(file, readFileSync(join(appDir, file), 'utf8')));
}

export function pluginFindings(appDir) {
  return [
    ...manifestFindings(readFileSync(join(appDir, 'manifest.yml'), 'utf8'), nodeMajor(appDir)).map(
      (finding) => `manifest.yml: ${finding}`,
    ),
    ...dependencyPinFindings(JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))),
    ...readmeFindings(appDir),
    ...themeFindings(appDir),
    ...handlerFindings(appDir),
    ...bundleHostFindings(appDir),
    ...publicRepositoryFindings(appDir),
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const findings = pluginFindings(resolve(process.argv[2] ?? '.'));
  for (const finding of findings) console.error(finding);
  if (findings.length) process.exitCode = 1;
  else
    console.log(
      'Manifest defaults and handlers, exact pins, README structure, theme rules, bundle hosts and public-repository rules passed.',
    );
}
