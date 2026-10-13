// Hosted acceptance for Agent Prompts (`npx forge-test suite <name>`): delivery to the Forge
// development environment, then every unattended lane and runner in a fixed order. It stops at
// the first failure. Fault-injected recovery procedures are not part of any suite.
import './tests/hosted/support/fixture.mjs'; // Registers the second-site fixture profiles.

/** The guarded Forge CLI wrapper (production needs FORGE_ALLOW_PRODUCTION=1). */
export const forge = ['node', 'config/forge.mjs'];

const step = (name, command, env = {}) => ({ name, command, env });
const forgeTest = (...args) => ['npx', 'forge-test', ...args];
const runner = (name, ...args) => ['node', `tests/hosted/verify-${name}.mjs`, ...args];
const setup = (name, env) =>
  step(`Setup runner: ${name}`, runner('setup', 'run'), { NATIVE_SETUP_TESTS: '1', ...env });

const deploy = step('Deploy to development', [
  ...forge,
  'deploy',
  '-e',
  'development',
  '--non-interactive',
]);
const journeys = [
  step('Install or upgrade on the primary site', forgeTest('install')),
  step('Feature suite with real non-admin sessions', forgeTest('lane', 'features'), {
    NATIVE_IDENTITY_TESTS: '1',
  }),
];
const runners = [
  setup('dedicated schemes', {}),
  setup('shared scheme', { NATIVE_SETUP_SHARED: '1' }),
  setup('concurrent first step', { NATIVE_SETUP_FAULT: 'concurrent' }),
  setup('lost browser response', { NATIVE_SETUP_FAULT: 'lost-response' }),
  setup('abandoned configuration, second administrator', { NATIVE_SETUP_ABANDONED: '1' }),
  setup('bulk configuration and setup removal', { NATIVE_SETUP_BULK: '1' }),
  setup('type name taken after review', { NATIVE_SETUP_REJECTED: '1' }),
  step('Access runner', runner('access', 'run'), { NATIVE_ACCESS_TESTS: '1' }),
  step('Rovo runner', runner('rovo'), { NATIVE_ROVO_TESTS: '1' }),
];
const doctor = step('Jira credentials', forgeTest('doctor'));

export const suites = {
  features: [doctor, deploy, ...journeys],
  full: [doctor, deploy, ...journeys, ...runners],
  // Publish deploys its tagged build to development itself, then runs this.
  release: [doctor, ...journeys, ...runners],
};
