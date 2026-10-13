import {
  markers,
  siteFor,
  activeTarget,
  fixtureProject,
} from '@srcplugins/atlassian-forge-test-framework/core';
import { registerProfile } from '@srcplugins/atlassian-forge-test-framework/jira';

// Agent Prompts' fixture identity predates its agent-prompts slug. On-site space markers and
// run journals, including the retained scale journal, keep this name.
export const agentPromptsFixture = 'native-prompt-links';

/** The marker of an empty project created by the setup runner. */
export const setupRunSpace = (runId, index) =>
  markers.acceptance('setup run', `${runId}/${index}. Empty synthetic space only.`);

// Second-site fixture profiles (see verify-lifecycle.mjs). Recovery uses the profile saved in a
// run's journal, so every entry point that may open or recover such a run imports this module.
registerProfile('tenant-isolation', {
  project: () => fixtureProject('tenant-isolation'),
  marker: () => markers.browserProject('tenant-isolation'),
  allow: ({ app, host }) => {
    if (
      app !== agentPromptsFixture ||
      process.env.NATIVE_TENANT_ISOLATION !== '1' ||
      ![siteFor('primary'), siteFor('isolation')].includes(host)
    )
      throw Error('Explicit owned tenant isolation required');
  },
  missing: 'Marked tenant isolation fixture required; follow second-site acceptance preflight.',
});
registerProfile('lifecycle-secondary', {
  project: () => fixtureProject('forge-sandbox'),
  marker: () => markers.browserProject('forge-sandbox'),
  allow: ({ app }) => {
    if (app !== agentPromptsFixture || activeTarget().host !== siteFor('isolation'))
      throw Error('Secondary lifecycle fixture requires Agent Prompts on the isolation site');
  },
  missing: 'Owned isolated fixture space required. Run prepare.',
});
