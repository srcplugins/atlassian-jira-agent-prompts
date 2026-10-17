// Hosted acceptance for Agent Prompts (`npx forge-test suite <name> [--only a,b]`): delivery to
// the Forge development environment, then every unattended lane and runner in a fixed order. A
// failed delivery step stops it; a failed lane or runner is cleaned up and the suite moves on,
// unless that cleanup refuses. Fault-injected recovery procedures are not part of any suite.
import './tests/hosted/support/fixture.mjs'; // Registers the second-site fixture profiles.

/** The guarded Forge CLI wrapper (production needs FORGE_ALLOW_PRODUCTION=1). */
export const forge = ['node', 'config/forge.mjs'];

const step = (name, command, env = {}, more = {}) => ({ name, command, env, ...more });
const prerequisite = (name, command) => step(name, command, {}, { prerequisite: true });
const forgeTest = (...args) => ['npx', 'forge-test', ...args];
const runner = (name, ...args) => ['node', `tests/hosted/verify-${name}.mjs`, ...args];
// A journaling runner is cleaned up by its own guarded cleanup; the suite appends the run ID.
const journaled = (name, label, env) =>
  step(label, runner(name, 'run'), env, { cleanup: runner(name, 'cleanup') });
// Each mode's key names it for `--only` and a "Hosted:" commit line; no key is part of another
// step's name.
const setup = (key, description, env) =>
  journaled('setup', `Setup ${key}: ${description}`, { NATIVE_SETUP_TESTS: '1', ...env });
// Lanes and the Rovo runner write only through fixture runs, which always clean up.
const fixtures = (name, command, env) => step(name, command, env, { cleanup: 'fixtures' });

const deploy = prerequisite('Deploy to development', [
  ...forge,
  'deploy',
  '-e',
  'development',
  '--non-interactive',
]);
const journeys = [
  prerequisite('Install or upgrade on the primary site', forgeTest('install')),
  fixtures('Feature suite with real non-admin sessions', forgeTest('lane', 'features'), {
    NATIVE_IDENTITY_TESTS: '1',
  }),
];
const runners = [
  setup('dedicated', 'a work type scheme per space', {}),
  setup('shared', 'one work type scheme for three spaces', { NATIVE_SETUP_SHARED: '1' }),
  setup('concurrent', 'first step started twice at once', { NATIVE_SETUP_FAULT: 'concurrent' }),
  setup('lost-response', 'browser loses the reply', { NATIVE_SETUP_FAULT: 'lost-response' }),
  setup('abandoned', 'second administrator takes over', { NATIVE_SETUP_ABANDONED: '1' }),
  setup('bulk', 'two spaces, then setup removal', { NATIVE_SETUP_BULK: '1' }),
  setup('rejected', 'type name taken after review', { NATIVE_SETUP_REJECTED: '1' }),
  setup('screens', 'three spaces use one space’s screens', { NATIVE_SETUP_SCREENS: '1' }),
  setup('steps', 'twenty screen changes over several apply steps', { NATIVE_SETUP_STEPS: '1' }),
  journaled('access', 'Access runner', { NATIVE_ACCESS_TESTS: '1' }),
  fixtures('Rovo runner', runner('rovo'), { NATIVE_ROVO_TESTS: '1' }),
  fixtures('Rovo runner: team-managed space', runner('rovo'), {
    NATIVE_ROVO_TESTS: '1',
    NATIVE_ROVO_SPACE: 'team-managed',
  }),
];
const doctor = prerequisite('Jira credentials', forgeTest('doctor'));

export const suites = {
  features: [doctor, deploy, ...journeys],
  full: [doctor, deploy, ...journeys, ...runners],
  // Publish deploys its tagged build to development itself, then runs this.
  release: [doctor, ...journeys, ...runners],
};
