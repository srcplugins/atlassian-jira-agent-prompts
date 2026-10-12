import { definePlaywrightConfig } from '@srcplugins/atlassian-forge-test-framework/core';

// Hosted browser lanes for Agent Prompts. Run them with `npx forge-test lane features`.
export default definePlaywrightConfig({ testDir: 'tests/hosted' });
