// Opt-in hosted benchmark. Fixtures remain journaled for supervised manual testing.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import {
  openRun,
  tokenRequest,
  client,
  allIssues,
  installation,
  observeAction,
} from '@srcplugins/atlassian-forge-test-framework/jira';
import { spaceSettings } from './support/space-settings.mjs';
import { activeTarget } from '@srcplugins/atlassian-forge-test-framework/core';
import { agentPromptsFixture } from './support/fixture.mjs';
const host = activeTarget();

if (process.env.NATIVE_SCALE_TESTS !== '1') throw Error('Explicit NATIVE_SCALE_TESTS=1 required');
const [mode = 'run', recover] = process.argv.slice(2);
if (!['run', 'resume', 'saves', 'cleanup'].includes(mode) || (mode !== 'run' && !recover))
  throw Error('Use run, resume RUN_ID, saves RUN_ID, or cleanup RUN_ID');
const request = await tokenRequest();
const owned = await openRun(request, agentPromptsFixture, { recover });
const { run, api } = owned;
const directory = `${host.directory}/native-scale/${run.state.runId}`;
mkdirSync(directory, { recursive: true, mode: 0o700 });
const saveFile = (name, value) =>
  writeFileSync(`${directory}/${name}.json`, JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
  });
const metrics = existsSync(`${directory}/metrics.json`)
  ? JSON.parse(readFileSync(`${directory}/metrics.json`))
  : [];
const record = (scale, operation, started, session) => {
  metrics.push({ scale, operation, ms: Math.round(performance.now() - started), session });
  saveFile('metrics', metrics);
};
console.log(`Scale run ${run.state.runId}; evidence ${directory}`);
let browser;
let released = false;
try {
  if (mode === 'cleanup') {
    await run.cleanup({ concurrency: 4 });
    await owned.cleanup();
    released = true;
    console.log('All exact journaled fixtures removed and confirmed absent.');
  } else {
    assert.ok(
      run.state.resources.every((r) => r.status === 'created'),
      'Resolve ambiguous fixture intents before resuming',
    );
    browser = await chromium.launch({ channel: 'chrome' });
    const contexts = await Promise.all(
      Array.from({ length: 5 }, () => browser.newContext({ storageState: host.auth })),
    );
    for (const context of contexts) {
      context.setDefaultTimeout(45000);
      assert.equal((await client(context.request)('/myself')).accountId, owned.user.accountId);
    }
    const pages = await Promise.all(contexts.map((c) => c.newPage()));
    const t = installation('agent-prompts');
    const setup = await observeAction(
      pages[0],
      'setup',
      () => spaceSettings(pages[0], owned.project.key),
      t,
    );
    assert.match(setup.type, /^[1-9]\d*$/);
    if (!existsSync(`${directory}/baseline.json`))
      saveFile('baseline', await allIssues(api, owned.project.id));
    const baseline = JSON.parse(readFileSync(`${directory}/baseline.json`));
    const term = `Scale${run.state.runId.replaceAll('-', '')}`;
    run.state.scale = {
      count: 1000,
      retainedForManualTesting: true,
      term,
      type: setup.type,
      sessions: 5,
    };
    run.persist();
    const targets = [];
    for (let i = 0; i < 5; i++) {
      const summary = `${term} destination ${i + 1}`;
      const entry =
        run.state.resources.find((r) => r.expected.summary === summary) ??
        (await owned.issue(summary));
      targets.push({ entry, issue: await api(`/issue/${entry.id}?fields=summary,description`) });
    }
    const sourceEntries = () => run.state.resources.filter((r) => r.expected.typeId);
    const frame = (page) =>
      page.frameLocator(`iframe[src*="${t.appId}"][src*="${t.environmentId}"]`);
    const combo = (page) =>
      frame(page).getByRole('combobox', { name: 'Agent Prompts', exact: true });
    const read = (page) =>
      page
        .getByRole('button', { name: /^(Agent Prompts, .*edit|Edit Agent Prompts)$/ })
        .locator('..')
        .locator(
          '[data-component-selector="jira-issue-view-select-inline-edit-read-view-container"]',
        );
    const search = async (page, query, scale, session, operation = 'search-visible') => {
      const started = performance.now();
      const result = await observeAction(page, 'search', () => combo(page).fill(query), t);
      assert.ok(result.prompts.length);
      await combo(page).press('ArrowDown');
      const first = result.prompts[0];
      await expect(
        frame(page).getByText(`${first.key} — ${first.name}`, { exact: true }),
      ).toBeVisible();
      record(scale, operation, started, session);
      return result;
    };
    for (const scale of mode === 'saves' ? [] : [500, 1000]) {
      if (sourceEntries().length > scale) continue;
      let next = sourceEntries().length;
      let failed;
      const started = performance.now();
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (!failed && next < scale) {
            const index = next++;
            try {
              const length = [256, 512, 1024, 3500][index % 4];
              await owned.propertyIssue(
                `${term} prompt ${String(index + 1).padStart(4, '0')}`,
                randomBytes(Math.ceil(length / 2))
                  .toString('hex')
                  .slice(0, length),
                setup.type,
              );
              const count = sourceEntries().filter((r) => r.prepareMs).length;
              if (count % 50 === 0) console.log(`Created and verified ${count}/1000 prompts`);
            } catch (error) {
              failed = error;
            }
          }
        }),
      );
      if (failed) throw failed;
      record(scale, 'seed-batch', started, 0);
      console.log(`Checking indexed inventory at ${scale} prompts`);
      let indexed;
      await expect(async () => {
        indexed = (await allIssues(api, owned.project.id)).filter((x) =>
          x.fields.summary.startsWith(`${term} prompt `),
        );
        assert.equal(indexed.length, scale);
        assert.deepEqual(
          indexed.map((x) => x.id).sort(),
          sourceEntries()
            .map((x) => x.id)
            .sort(),
        );
      }).toPass({ timeout: 120000, intervals: [2000, 5000] });
      // Three rounds, five independent browser contexts, synchronized at each round.
      for (let round = 0; round < 3; round++) {
        const results = await Promise.allSettled(
          pages.map(async (page, session) => {
            await page.goto(`${host.site}/browse/${targets[session].issue.key}`, {
              waitUntil: 'domcontentloaded',
            });
            await expect(read(page)).toBeVisible();
            // Jira can render its read view before attaching the edit handler.
            await page.waitForTimeout(1500);
            const started = performance.now();
            const loaded = await observeAction(
              page,
              'load',
              () => read(page).click({ position: { x: 2, y: 2 } }),
              t,
            );
            await expect(combo(page)).toBeEnabled();
            record(scale, 'picker-open', started, session);
            assert.equal(loaded.prompts.length, 10);
            const found = await search(page, `prompt ${term}`, scale, session);
            assert.equal(found.prompts.length, 10);
            assert.ok(found.nextCursor);
            const moreStarted = performance.now();
            const more = await observeAction(
              page,
              'search',
              () => frame(page).getByRole('button', { name: 'Load more', exact: true }).click(),
              t,
            );
            assert.equal(more.prompts.length, 10);
            assert.equal(new Set([...found.prompts, ...more.prompts].map((x) => x.id)).size, 20);
            record(scale, 'picker-next-page', moreStarted, session);
            const oldest = indexed[session];
            const exact = await search(page, oldest.key, scale, session);
            assert.deepEqual(
              exact.prompts.map((x) => x.id),
              [oldest.id],
            );
          }),
        );
        const failure = results.find((r) => r.status === 'rejected');
        if (failure) {
          saveFile(
            `failures-${scale}-${round}`,
            results.map((r) => (r.status === 'rejected' ? String(r.reason) : 'passed')),
          );
          await Promise.all(
            pages.map((p, i) =>
              p.screenshot({ path: `${directory}/failure-${scale}-${round}-${i}.png` }),
            ),
          );
          throw failure.reason;
        }
        console.log(`${scale} prompts: round ${round + 1}/3 passed in five browser sessions`);
      }
      // Read every picker page to prove discovery reaches the whole space, with no fixed ceiling.
      // The first session's field is still open from the last round.
      const pagingStarted = performance.now();
      let result = await observeAction(pages[0], 'search', () => combo(pages[0]).fill(term), t);
      const ids = result.prompts.map((x) => x.id);
      let pageCount = 1;
      while (result.nextCursor) {
        assert.ok(pageCount < 110);
        result = await observeAction(
          pages[0],
          'search',
          () => frame(pages[0]).getByRole('button', { name: 'Load more', exact: true }).click(),
          t,
        );
        ids.push(...result.prompts.map((x) => x.id));
        pageCount++;
      }
      assert.deepEqual(ids.slice().sort(), indexed.map((x) => x.id).sort());
      assert.equal(new Set(ids).size, scale);
      record(scale, 'picker-all-pages', pagingStarted, 0);
      console.log(
        `${scale} prompts: all ${pageCount} picker pages verified, no missing/duplicate prompts`,
      );
    }
    const field = (await api('/field')).find(
      (f) => f.schema?.custom?.includes(`/${t.appId}/`) && f.name === 'Agent Prompts',
    );
    assert.ok(field);
    const selected = sourceEntries().slice(0, 5);
    const sourceIssues = await Promise.all(
      selected.map((s) => api(`/issue/${s.id}?fields=summary,description`)),
    );
    assert.equal(sourceEntries().length, 1000);
    for (let i = 0; i < sourceIssues.length; i++)
      assert.deepEqual(sourceIssues[i].fields.description, selected[i].expected.description);
    const descriptionFor = (entry, sources) =>
      sources.length
        ? {
            ...entry.expected.description,
            content: [
              ...entry.expected.description.content,
              {
                type: 'expand',
                attrs: { localId: `npl-${entry.id}`, title: 'Agent Prompts' },
                content: sources.flatMap((source) => [
                  {
                    type: 'heading',
                    attrs: { level: 2 },
                    content: [{ type: 'text', text: `${source.key}: ${source.fields.summary}` }],
                  },
                  ...source.fields.description.content,
                ]),
              },
            ],
          }
        : entry.expected.description;
    if (mode === 'saves') sourceIssues.reverse();
    const writes = await Promise.allSettled(
      pages.map(async (page, session) => {
        const { entry, issue } = targets[session];
        const before = (await api(`/issue/${entry.id}?fields=description,${field.id}`)).fields;
        const currentKeys = before[field.id] ?? [];
        if (mode !== 'saves') assert.deepEqual(currentKeys, [], 'Do not repeat a prior save');
        assert.ok(currentKeys.every((key) => sourceIssues.some((x) => x.key === key)));
        assert.equal(new Set(currentKeys).size, currentKeys.length);
        const currentSources = currentKeys.map((key) => sourceIssues.find((x) => x.key === key));
        assert.deepEqual(before.description, descriptionFor(entry, currentSources));
        // Reconcile only a independently derived, exact known-source snapshot before a NEW reordered save.
        run.check(`save-baseline-${session}`, { keys: currentKeys, independentlyVerified: true });
        entry.expected.descriptionVariants = [entry.expected.description, before.description];
        entry.expected.customField = { id: field.id, value: before[field.id] };
        run.persist();
        await page.goto(`${host.site}/browse/${issue.key}`, { waitUntil: 'domcontentloaded' });
        await expect(read(page)).toBeVisible();
        await page.waitForTimeout(1500);
        const loaded = await observeAction(
          page,
          'load',
          () => read(page).click({ position: { x: 2, y: 2 } }),
          t,
        );
        await expect(combo(page)).toBeEnabled();
        assert.equal(loaded.ids.length, currentKeys.length);
        for (const key of currentKeys) {
          await frame(page)
            .getByRole('button', { name: new RegExp(`remove ${key} —`) })
            .click();
        }
        await expect(frame(page).getByText(/^0\/5 selected/)).toBeVisible();
        let selectedCount = 0;
        for (const source of sourceIssues) {
          await search(page, source.key, 1000, session, 'save-source-lookup');
          await frame(page)
            .getByText(`${source.key} — ${source.fields.summary}`, { exact: true })
            .click();
          selectedCount++;
          await expect(
            frame(page).getByText(`${selectedCount}/5 selected · Unsaved changes`, { exact: true }),
          ).toBeVisible();
        }
        const expected = descriptionFor(entry, sourceIssues);
        assert.notDeepEqual(
          before[field.id],
          sourceIssues.map((x) => x.key),
          'Fresh operation must change the ordered selection',
        );
        entry.expected.descriptionVariants = [entry.expected.description, expected];
        entry.expected.customField = { id: field.id, value: sourceIssues.map((x) => x.key) };
        run.persist();
        const started = performance.now();
        const click = () => frame(page).getByRole('button', { name: 'Save', exact: true }).click();
        if (loaded.refreshAfterSave)
          await Promise.all([
            page.waitForEvent('framenavigated', { predicate: (f) => f === page.mainFrame() }),
            click(),
          ]);
        else await observeAction(page, 'save', click, t);
        const actual = (await api(`/issue/${entry.id}?fields=description,${field.id}`)).fields;
        assert.deepEqual(actual.description, expected);
        assert.deepEqual(
          actual[field.id],
          sourceIssues.map((x) => x.key),
        );
        record(1000, 'save-five-confirmed-api', started, session);
        if (loaded.refreshAfterSave) await expect(read(page)).toBeVisible();
        record(1000, 'save-five-work-item-visible', started, session);
        entry.expected.descriptionVariants = [entry.expected.description, actual.description];
        run.persist();
      }),
    );
    const writeFailure = writes.find((r) => r.status === 'rejected');
    if (writeFailure) {
      saveFile(
        'save-failures',
        writes.map((r) => (r.status === 'rejected' ? String(r.reason) : 'passed')),
      );
      await Promise.all(
        pages.map((p, i) => p.screenshot({ path: `${directory}/save-failure-${i}.png` })),
      );
      throw writeFailure.reason;
    }
    console.log(
      'Five simultaneous sessions saved five ordered prompts each; exact field and full Description verified.',
    );
    const after = await allIssues(api, owned.project.id);
    for (const issue of baseline)
      assert.deepEqual(
        after.find((x) => x.id === issue.id),
        issue,
      );
    saveFile(
      'inventory',
      after
        .filter((x) => run.state.resources.some((r) => r.id === x.id))
        .map((x) => ({ id: x.id, key: x.key, summary: x.fields.summary })),
    );
    run.check('scale-benchmark', {
      prompts: sourceEntries().length,
      contexts: 5,
      originalIssuesUnchanged: baseline.length,
      retained: true,
    });
    const summary = {};
    for (const scale of [500, 1000]) {
      summary[scale] = {};
      for (const operation of [...new Set(metrics.map((x) => x.operation))]) {
        const values = metrics
          .filter((x) => x.scale === scale && x.operation === operation)
          .map((x) => x.ms)
          .sort((a, b) => a - b);
        if (values.length)
          summary[scale][operation] = {
            n: values.length,
            median:
              (values[Math.floor((values.length - 1) / 2)] +
                values[Math.floor(values.length / 2)]) /
              2,
            p95: values[Math.ceil(values.length * 0.95) - 1],
            max: values.at(-1),
          };
      }
    }
    saveFile('summary', summary);
    console.log(JSON.stringify(summary, null, 2));
    console.log(
      'Retained 1000 prompts and five synthetic destinations for owner testing. Cleanup requires this exact run ID.',
    );
  }
} finally {
  await browser?.close();
  if (!released) await owned.releaseForRecovery();
  await request.dispose();
}
