// Shared srcplugins file, synchronized across repositories.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Runs this repository's verified Forge CLI (config/prepare-forge-cli.mjs) with account
// credentials from the environment. Guards: production needs FORGE_ALLOW_PRODUCTION=1, a
// registered app is never registered again, and the UI is rebuilt before build, deploy, lint
// and tunnel.
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
let commandIndex = 0;
while (['--verbose', '--no-color'].includes(args[commandIndex])) commandIndex++;
const command = args[commandIndex];

const production = args.some(
  (arg, i) =>
    /^--?(?:e|environment)=production$/.test(arg) ||
    (arg === 'production' && ['-e', '--environment'].includes(args[i - 1])),
);
if (production && process.env.FORGE_ALLOW_PRODUCTION !== '1')
  throw Error('Production is owner-run. Set FORGE_ALLOW_PRODUCTION=1 yourself to proceed.');
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
