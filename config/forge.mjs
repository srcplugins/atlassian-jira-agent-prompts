// Shared srcplugins file, synchronized across repositories.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Runs this repository's verified Forge CLI (config/prepare-forge-cli.mjs) with account
// credentials from the environment. Guards: any environment other than development needs
// FORGE_ALLOW_PRODUCTION=1, a registered app is never registered again, and the UI is rebuilt
// before build, deploy, lint and tunnel.

/**
 * Every environment the arguments name, read the way Forge's option parser (commander) reads
 * them: `-e X`, `-eX`, `-e=X`, `--environment X`, `--environment=X` and `-e` after other short
 * flags (`-fe X`). The environments command's option takes several values. With none, Forge uses
 * development.
 */
function environments(args, variadic) {
  const named = [];
  for (let i = 0; i < args.length; i++) {
    const option = args[i].match(/^(?:--environment|-[a-zA-Z]*?e)(?:=?(.+))?$/s);
    if (!option) continue;
    let taken = option[1] !== undefined;
    if (taken) named.push(option[1]);
    while ((variadic || !taken) && i + 1 < args.length && !/^-./s.test(args[i + 1])) {
      named.push(args[++i]);
      taken = true;
    }
  }
  return named;
}

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
let commandIndex = 0;
while (['--verbose', '--no-color'].includes(args[commandIndex])) commandIndex++;
const command = args[commandIndex];

const owned = environments(args, command === 'environments').find((name) => name !== 'development');
if (owned && process.env.FORGE_ALLOW_PRODUCTION !== '1')
  throw Error(
    `Only the development environment runs by default; ${owned} needs a maintainer to set FORGE_ALLOW_PRODUCTION=1.`,
  );
if (
  command === 'register' &&
  !readFileSync(`${root}/manifest.yml`, 'utf8').includes(
    'ari:cloud:ecosystem::app/00000000-0000-0000-0000-000000000000',
  )
)
  throw Error('This app is already registered. Never register an existing app again.');

// Environment first; locally the test framework's configuration may name a Keychain item.
let email = process.env.FORGE_EMAIL || process.env.JIRA_EMAIL;
let token = process.env.FORGE_API_TOKEN || process.env.JIRA_API_KEY;
if (!email || !token) {
  try {
    const { atlassianCredentials } =
      await import('@srcplugins/atlassian-forge-test-framework/core');
    const credentials = atlassianCredentials();
    email ||= credentials.forgeEmail;
    token ||= credentials.forgeToken;
  } catch {
    // No framework configuration: only the environment applies.
  }
}
if (!email || !token) {
  console.error('Set FORGE_EMAIL and FORGE_API_TOKEN (or JIRA_EMAIL and JIRA_API_KEY).');
  process.exit(1);
}
if (['build', 'deploy', 'lint', 'tunnel'].includes(command)) {
  const build = spawnSync('npm', ['run', 'build:ui', '--if-present'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const result = spawnSync(`${root}/node_modules/.bin/forge`, args.length ? args : ['--help'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, FORGE_EMAIL: email, FORGE_API_TOKEN: token },
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
