import './typescript-loader.mjs';
import { readSpaces } from '../src/space-reads.ts';
import { finished } from '../src/batch-status.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { hookHost, load, standIns, view } from './support/ui-harness.mjs';
function fixture(failInventory = false, progress = null, viewer = 'admin', beforeHealth, props) {
  const calls = [];
  const projects = Array.from({ length: 100 }, (_, i) => ({
    id: String(i + 1),
    key: `PR${i + 1}`,
    name: `Project ${i + 1}`,
  }));
  const call = async (name, p) => {
    calls.push({ name, p });
    if (name === 'settings-projects') {
      if (failInventory)
        throw failInventory instanceof Error ? failInventory : Error('Inventory unavailable');
      return { projects, incomplete: false };
    }
    if (name === 'configuration-status' || name === 'configuration-cancel-interrupted') {
      if (progress instanceof Error) throw progress;
      return progress;
    }
    assert.equal(name, 'settings-health');
    if (beforeHealth) await beforeHealth(p);
    if (p.projectId === '2') throw Error('Access denied');
    return {
      project: projects.find((x) => x.id === p.projectId),
      state: { revision: 1, data: p.projectId === '3' ? {} : { type: '7' } },
      types: [{ id: '7', name: 'Prompt' }],
      checks: [{ ok: p.projectId !== '4', label: 'Type', detail: 'Available' }],
    };
  };
  const hooks = hookHost();
  const { HealthProjects } = load('health-ui.tsx', {
    react: hooks.react,
    './space-reads': { readSpaces },
    './batch-status': { finished },
    './settings-ui': { Settings: 'Settings' },
    './configuration-dialog': { ConfigurationDialog: 'ConfigurationDialog' },
    '@forge/react': {
      xcss: (v) => v,
      useProductContext: () => ({ accountId: viewer }),
      ...standIns(
        'SectionMessage',
        'Modal',
        'ModalHeader',
        'ModalTitle',
        'ModalBody',
        'ModalFooter',
        'Button',
        'Box',
        'Label',
        'Checkbox',
        'DynamicTable',
        'Heading',
        'Inline',
        'Lozenge',
        'Spinner',
        'Stack',
        'Text',
        'Textfield',
      ),
    },
    './client': { call },
  });
  const v = view(hooks, () => HealthProjects(props ?? (failInventory ? { projectId: '1' } : {})));
  return {
    ...v,
    calls,
    check(label, value) {
      // UI Kit associates a Label with its control through labelFor ↔ id (both host-prefixed).
      const id = v.nodes('Label').find((l) => l.props.children[0] === label)?.props.labelFor;
      const c = v.nodes('Checkbox').find((c) => c.props.id === id);
      assert.equal(c?.props['aria-labelledby'], undefined);
      assert.ok(c);
      c.props.onChange({ target: { checked: value } });
      v.render();
    },
    search(value) {
      v.nodes('Textfield')[0].props.onChange({ target: { value } });
      v.render();
    },
  };
}
test('opening 100 spaces makes no health calls; checks only explicitly selected spaces', async () => {
  const f = fixture();
  await f.mount();
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ['settings-projects', 'configuration-cancel-interrupted'],
  );
  assert.equal(f.nodes('DynamicTable')[0].props.rows.length, 100);
  assert.equal(
    f.nodes('Button').find((b) => b.props.children[0] === 'Check selected').props.isDisabled,
    true,
  );
  assert.ok(f.nodes('Lozenge').every((n) => n.props.children[0] === 'Not checked'));
  for (const id of ['1', '2', '3', '4']) f.check(`Select PR${id}`, true);
  assert.equal(f.calls.length, 2, 'selection alone never reads health');
  await f.click('Check selected');
  assert.deepEqual(
    f.calls
      .filter((c) => c.name === 'settings-health')
      .map((c) => c.p.projectId)
      .sort(),
    ['1', '2', '3', '4'],
  );
  assert.deepEqual(
    f
      .nodes('Lozenge')
      .slice(0, 3)
      .map((n) => n.props.children[0]),
    ['Needs attention', 'Check failed', 'Not configured'],
  );
  assert.equal(f.nodes('Lozenge').filter((n) => n.props.children[0] === 'Not checked').length, 96);
  await f.click('Clear selection');
  f.check('Select PR2', true);
  await f.click('Check selected');
  assert.equal(f.calls.filter((c) => c.name === 'settings-health').length, 5);
  assert.equal(
    f.nodes('Lozenge').filter((n) => n.props.children[0] === 'Healthy').length,
    1,
    'other checked results remain cached',
  );
});

test('select all uses all filtered rows across pages, clears on search and sends exact selection to configuration', async () => {
  const f = fixture();
  await f.mount();
  f.check('Select all matching spaces', true);
  await f.click('Configure selected');
  assert.equal(f.nodes('ConfigurationDialog')[0].props.projects.length, 100);
  await f.nodes('ConfigurationDialog')[0].props.onClose();
  await f.settle();
  f.search('PR1');
  assert.equal(
    f.nodes('Button').find((b) => b.props.children[0] === 'Configure selected').props.isDisabled,
    true,
  );
  f.check('Select all matching spaces', true);
  await f.click('Configure selected');
  assert.equal(f.nodes('ConfigurationDialog')[0].props.projects.length, 12);
});
test('opening a space reuses scan data and returning preserves the filtered list', async () => {
  const f = fixture();
  await f.mount();
  f.search('PR10');
  f.check('Select PR10', true);
  await f.click('Check selected');
  const before = f.calls.length;
  await f.click('View details');
  assert.equal(f.nodes('Settings')[0].props.initialHealth.project.id, '10');
  assert.equal(f.calls.length, before);
  assert.equal(f.nodes('Modal').length, 1);
  assert.equal(f.nodes('DynamicTable')[0].props.rows.length, 2);
  await f.click('Close');
  assert.equal(f.nodes('Modal').length, 0);
  assert.equal(f.nodes('DynamicTable')[0].props.rows.length, 2);
});

test('exact-space recovery stays available when space inventory fails', async () => {
  const f = fixture(true);
  await f.mount();
  assert.equal(f.calls.filter((c) => c.name === 'settings-health').length, 0);
  f.check('Select 1', true);
  await f.click('Check selected');
  await f.click('View details');
  assert.equal(f.nodes('Settings')[0].props.projectId, '1');
  assert.equal(f.nodes('Settings')[0].props.initialHealth.state.data.type, '7');
  assert.ok(f.calls.some((c) => c.name === 'settings-health' && c.p.projectId === '1'));
});

test('closing configuration invalidates health without triggering any new checks', async () => {
  const f = fixture();
  await f.mount();
  f.search('PR10');
  f.check('Select PR10', true);
  await f.click('Check selected');
  await f.click('View details');
  const settings = f.nodes('Settings')[0];
  settings.props.configurationAction.props.onClick();
  await f.settle();
  assert.equal(f.nodes('Modal').length, 0);
  assert.equal(f.nodes('ConfigurationDialog').length, 1);
  assert.equal(f.nodes('ConfigurationDialog')[0].props.projects[0].id, '10');
  await f.nodes('ConfigurationDialog')[0].props.onClose(true);
  await f.settle();
  assert.equal(f.nodes('ConfigurationDialog').length, 0);
  assert.equal(f.nodes('Modal').length, 0);
  assert.equal(f.nodes('DynamicTable')[0].props.rows.length, 2);
  assert.ok(f.nodes('Lozenge').every((n) => n.props.children[0] === 'Not checked'));
  assert.equal(f.calls.filter((c) => c.name === 'settings-health').length, 1);
});

test('refresh after a preference save keeps the details editor mounted by space', async () => {
  const f = fixture();
  await f.mount();
  f.search('PR10');
  f.check('Select PR10', true);
  await f.click('Check selected');
  await f.click('View details');
  const settings = f.nodes('Settings')[0];
  const before = f.calls.length;
  const updatedHealth = {
    ...settings.props.initialHealth,
    state: { revision: 2, data: { type: '7', refreshAfterSave: true } },
  };
  const update = settings.props.onUpdated(updatedHealth);
  await f.settle();
  assert.equal(f.nodes('Settings')[0].props.key, settings.props.key);
  await update;
  await f.settle();
  assert.equal(f.calls.length, before);
  assert.equal(f.nodes('Settings')[0].props.initialHealth.state.revision, 2);
  assert.equal(f.nodes('Settings')[0].props.key, settings.props.key);
});

test('Check selected includes matching rows across pagination but never unselected spaces', async () => {
  const f = fixture();
  await f.mount();
  f.search('PR1');
  f.check('Select all matching spaces', true);
  await f.click('Check selected');
  const checked = f.calls.filter((c) => c.name === 'settings-health').map((c) => c.p.projectId);
  assert.equal(checked.length, 12);
  assert.ok(checked.every((id) => id.startsWith('1')));
});

test('unchecked details checks only the opened space and reuses its result on reopening', async () => {
  const f = fixture();
  await f.mount();
  f.search('PR10');
  await f.click('View details');
  assert.deepEqual(
    f.calls.filter((c) => c.name === 'settings-health').map((c) => c.p.projectId),
    ['10'],
  );
  assert.equal(f.nodes('Settings')[0].props.initialHealth.project.id, '10');
  assert.equal(f.nodes('ConfigurationDialog').length, 0);
  await f.click('Close');
  await f.click('View details');
  assert.equal(f.calls.filter((c) => c.name === 'settings-health').length, 1);
});

test('details remains available for an unconfigured space and a failed check can be retried', async () => {
  const f = fixture();
  await f.mount();
  f.search('PR3');
  await f.click('View details');
  assert.equal(f.nodes('Settings')[0].props.initialHealth.state.data.type, undefined);
  assert.equal(f.nodes('ConfigurationDialog').length, 0);
  await f.click('Close');
  f.search('PR2');
  await f.click('View details');
  assert.equal(f.nodes('Settings').length, 0);
  assert.ok(f.nodes('Text').some((n) => n.props.children[0] === 'Access denied'));
  await f.click('Close');
  await f.click('View details');
  assert.equal(
    f.calls.filter((c) => c.name === 'settings-health' && c.p.projectId === '2').length,
    2,
  );
});

test('Configure checks only selected spaces and cancelling preserves selection and cached health', async () => {
  const f = fixture();
  await f.mount();
  f.search('PR10');
  f.check('Select PR10', true);
  await f.click('Configure selected');
  assert.deepEqual(
    f.calls.filter((c) => c.name === 'settings-health').map((c) => c.p.projectId),
    ['10'],
  );
  const before = f.calls.length;
  await f.nodes('ConfigurationDialog')[0].props.onClose(false);
  await f.settle();
  assert.equal(f.calls.length, before);
  assert.ok(f.nodes('Lozenge').some((n) => n.props.children[0] === 'Healthy'));
  assert.equal(
    f.nodes('Button').find((n) => n.props.children[0] === 'Configure selected').props.isDisabled,
    false,
  );
  await f.click('View details');
  assert.equal(f.calls.length, before);
});

test('historical cancellation stays quiet, fresh cancellation is dismissible and unresolved outcomes remain visible', async () => {
  const record = { revision: 2, data: { id: 'old', status: 'stopped', cancelRequested: true } };
  const old = fixture(false, record);
  await old.mount();
  assert.equal(old.nodes('SectionMessage').length, 0);
  const fresh = fixture(false, { ...record, cancelledNow: true });
  await fresh.mount();
  assert.equal(fresh.nodes('SectionMessage')[0].props.title, 'Interrupted configuration cancelled');
  await fresh.click('Dismiss');
  assert.equal(fresh.nodes('SectionMessage').length, 0);
  const pending = fixture(false, { ...record, data: { ...record.data, inspectProject: '1' } });
  await pending.mount();
  assert.equal(pending.nodes('SectionMessage')[0].props.title, 'Space needs an outcome check');
});

test('Configure reuses completed health checks and reads only unchecked or failed spaces', async () => {
  const f = fixture();
  await f.mount();
  for (const id of ['1', '2', '3', '4']) f.check(`Select PR${id}`, true);
  await f.click('Check selected');
  f.check('Select PR5', true);
  const before = f.calls.length;
  await f.click('Configure selected');
  assert.deepEqual(
    f.calls
      .slice(before)
      .filter((c) => c.name === 'settings-health')
      .map((c) => c.p.projectId)
      .sort(),
    ['2', '5'],
  );
  assert.equal(f.nodes('ConfigurationDialog')[0].props.projects.length, 5);
  f.nodes('ConfigurationDialog')[0].props.onClose(false);
  f.render();
  await f.click('Check selected');
  assert.equal(
    f.calls.filter((c) => c.name === 'settings-health').length,
    11,
    'explicit Check selected still refreshes every selected result',
  );
});

test('status check shows a spinner while pending and removes it on completion', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture(false, null, 'admin', () => pending);
  await f.mount();
  assert.equal(f.nodes('Spinner').length, 0);
  f.check('Select PR1', true);
  const check = f.click('Check selected');
  f.render();
  assert.equal(f.nodes('Spinner').length, 1);
  release();
  await check;
  assert.equal(f.nodes('Spinner').length, 0);
});

test('a second Check selected click delivered before the host re-renders is ignored', async () => {
  const f = fixture();
  await f.mount();
  for (const key of ['PR1', 'PR3', 'PR5']) f.check(`Select ${key}`, true);
  const button = f.button('Check selected');
  button.props.onClick();
  button.props.onClick();
  await f.settle();
  assert.equal(f.calls.filter((c) => c.name === 'settings-health').length, 3);
});

test('another administrator’s configuration stuck while cancelling stays reviewable for release', async () => {
  const stuck = {
    revision: 4,
    data: {
      id: 'run',
      actor: 'owner',
      status: 'running',
      cancelRequested: true,
      started: Date.now() - 200_000,
      index: 0,
      entries: [{ projectId: '1', fingerprint: 'f', status: 'waiting' }],
    },
  };
  const foreign = fixture(false, stuck, 'other-admin');
  await foreign.mount();
  assert.match(foreign.text(), /being cancelled. If it does not finish, review it/);
  await foreign.click('Review saved configuration');
  assert.equal(foreign.nodes('ConfigurationDialog').length, 1);
  // The owner's own page waits for the automatic unlock instead.
  const owner = fixture(false, stuck, 'owner');
  await owner.mount();
  assert.equal(owner.button('Review saved configuration'), undefined);
  assert.match(owner.text(), /unlock automatically/);
});

test('permission denial survives a subsequent configuration-progress failure', async () => {
  const denial = 'This needs the Jira permission Administer Jira.';
  const f = fixture(Error(denial), Error(denial), 'ordinary-user');
  await f.mount();
  assert.match(f.text(), /This needs the Jira permission Administer Jira\./);
  assert.doesNotMatch(f.text(), /Saved configuration progress could not be checked/);
  assert.equal(
    f.nodes('Button').find((b) => b.props.children[0] === 'Configure selected').props.isDisabled,
    true,
  );
  assert.equal(f.nodes('ConfigurationDialog').length, 0);
});

test('progress failure remains visible when inventory succeeds', async () => {
  const f = fixture(false, Error('Unavailable'));
  await f.mount();
  assert.match(f.text(), /Saved configuration progress could not be checked/);
  assert.equal(
    f.nodes('Button').find((b) => b.props.children[0] === 'Configure selected').props.isDisabled,
    true,
  );
});

test('the space the page was opened from stays reachable when the inventory misses it', async () => {
  const f = fixture(false, null, 'admin', undefined, { projectId: '500' });
  await f.mount();
  const rows = f.nodes('DynamicTable')[0].props.rows;
  assert.equal(rows.length, 101);
  assert.ok(rows.some((row) => row.key === '500'));
  const listed = fixture(false, null, 'admin', undefined, { projectId: '5' });
  await listed.mount();
  assert.equal(listed.nodes('DynamicTable')[0].props.rows.length, 100);
});

test('a failed affected-space check stays with that space and never locks configuration', async () => {
  const record = {
    revision: 2,
    data: { id: 'old', status: 'stopped', cancelRequested: true, inspectProject: '2' },
  };
  const f = fixture(false, record);
  await f.mount();
  await f.click('Check affected space');
  // The failure is shown once, in that space's details, not as a page-level error.
  assert.equal(f.text().match(/Access denied/g)?.length, 1);
  assert.equal(f.nodes('Modal').length, 1);
  assert.equal(f.nodes('Lozenge').filter((n) => n.props.children[0] === 'Check failed').length, 1);
  f.check('Select PR5', true);
  assert.equal(
    f.nodes('Button').find((b) => b.props.children[0] === 'Configure selected').props.isDisabled,
    false,
  );
});
