import React, { useEffect, useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  DynamicTable,
  Heading,
  Inline,
  Spinner,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  Select,
  Stack,
  Text,
  Textfield,
  useProductContext,
} from '@forge/react';
import { call } from './client';
import { readSpaces } from './space-reads';
import { finished } from './batch-status';
import { createLatch } from './shared/latch.mjs';
import type {
  createConfigurationBatch,
  BatchRecord,
  InventoryProject,
} from './configuration-batch';
import type { createSettings } from './settings';
type Catalog = Awaited<ReturnType<ReturnType<typeof createConfigurationBatch>['catalog']>>;
type Plan = Awaited<ReturnType<ReturnType<typeof createSettings>['preview']>>;
type Reviewed = { id: string; value?: Plan; error?: string };
export function ConfigurationDialog({
  projects,
  initialType,
  onClose,
  onBusy,
}: {
  projects: InventoryProject[];
  initialType?: string;
  onClose: (mutated: boolean) => void;
  onBusy: (value: boolean) => void;
}) {
  const accountId = useProductContext()?.accountId;
  const [catalog, setCatalog] = useState<Catalog>();
  const [ids, setIds] = useState(projects.map((p) => p.id));
  const [mode, setMode] = useState('existing');
  const [type, setType] = useState('');
  const [name, setName] = useState('');
  const [refreshAfterSave, setRefreshAfterSave] = useState(false);
  const [plans, setPlans] = useState<Reviewed[]>([]);
  const [record, setRecord] = useState<BatchRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState('');
  const [sharedAck, setSharedAck] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [abandonedAck, setAbandonedAck] = useState(false);
  // UI Kit can deliver a second click before the disabled tree reaches the host.
  const latch = useRef(createLatch()).current;
  const active = !!record && !finished(record.data.status);
  const foreignRun = !!accountId && !!record && record.data.actor !== accountId;
  const input =
    mode === 'unlink'
      ? { unlink: true }
      : { ...(mode === 'existing' ? { type } : { name }), refreshAfterSave };
  const shared = [
    ...new Map(
      plans
        .filter((p) => p.value?.attach && p.value.scheme.projectIds.length > 1)
        .map((p) => [p.value!.scheme.id, p.value!.scheme]),
    ).values(),
  ];
  const affectedLabel = (scheme: Plan['scheme'], id: string) => {
    const p =
      scheme.projects?.find((p) => p.id === id) ?? catalog?.projects.find((p) => p.id === id);
    return p?.key ? `${p.key}${p.name ? ` — ${p.name}` : ''}` : `Space ID ${id}`;
  };

  function run(fn: () => Promise<void>) {
    return latch.run(async () => {
      setBusy(true);
      onBusy(true);
      setMessage('');
      try {
        await fn();
      } catch (e) {
        setMessage(
          e instanceof Error ? e.message : 'Configuration could not finish. Check saved progress.',
        );
      } finally {
        setBusy(false);
        onBusy(false);
      }
    });
  }
  useEffect(() => {
    void run(async () => {
      await Promise.all([
        (async () => {
          try {
            const c = await call<Catalog>('configuration-catalog', {});
            setCatalog(c);
            setType(
              c.types.find((t) => t.id === initialType)?.id ??
                c.types.find((t) => t.name === 'Prompt')?.id ??
                '',
            );
          } catch {
            setCatalog({
              projects,
              incomplete: true,
              inventoryAvailable: false,
              typesAvailable: false,
              types: [],
            });
          }
        })(),
        (async () => {
          try {
            const current = await call<BatchRecord | null>('configuration-status', {});
            setRecord(current);
            setAttempted(!!current && !finished(current.data.status));
          } catch {
            setUncertain(true);
            setMessage(
              'Saved progress could not be checked. Check saved progress before continuing.',
            );
          }
        })(),
      ]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Catalog is loaded once per modal; subsequent recovery is explicitly read-only.
  }, []);
  // A space outside the loaded inventory (or the stand-in used when the inventory failed, whose
  // key is its ID) is labelled by ID rather than shown as a bare number.
  const label = (id: string) => {
    const p = catalog?.projects.find((p) => p.id === id) ?? projects.find((p) => p.id === id);
    return p && p.key !== p.id ? `${p.key} — ${p.name}` : `Space ID ${id}`;
  };
  async function observe() {
    const current = await call<BatchRecord | null>('configuration-status', {});
    setRecord(current);
    if (current && !finished(current.data.status)) setAttempted(true);
    setUncertain(false);
    setPlans([]);
    setSharedAck(false);
    setAbandonedAck(false);
    if (!current) setMessage('No saved configuration run. Review changes before applying.');
  }
  async function advance(start: BatchRecord) {
    let current = start;
    while (current.data.status === 'ready') {
      const next = await call<BatchRecord>('configuration-advance', {
        id: current.data.id,
        revision: current.revision,
      });
      setRecord(next);
      // A step that applied nothing (a brief outage before its claim) leaves the batch ready at
      // the same space. Stop instead of retrying it automatically: Continue reviewed changes
      // is the explicit way on.
      if (next.data.status === 'ready' && next.data.index === current.data.index) {
        setMessage(next.data.entries[next.data.index]?.message ?? next.data.message ?? '');
        return;
      }
      current = next;
    }
  }
  async function apply() {
    setAttempted(true);
    setUncertain(true);
    const current = await call<BatchRecord>('configuration-start', {
      ...input,
      ...(shared.length && sharedAck ? { allowShared: true } : {}),
      entries: plans.map((p) => ({ projectId: p.id, fingerprint: p.value!.fingerprint })),
      revision: record?.revision ?? 0,
    });
    setRecord(current);
    setPlans([]);
    setSharedAck(false);
    await advance(current);
    setUncertain(false);
  }
  const done = attempted && !!record && finished(record.data.status);
  return (
    <Modal
      width="large"
      onClose={() => {
        if (!busy) onClose(attempted);
      }}
      shouldScrollInViewport={false}
    >
      <ModalHeader>
        <ModalTitle>
          {active || uncertain
            ? 'Configuration progress'
            : done
              ? 'Configuration results'
              : `Configure ${ids.length} space${ids.length === 1 ? '' : 's'}`}
        </ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.150">
          {catalog && !active && !uncertain && !done && (
            <>
              {!catalog.typesAvailable && (
                <Text>
                  Work types could not be loaded. You can still remove setup from the selected
                  spaces. Reopen this dialog to retry type configuration.
                </Text>
              )}
              {!catalog.inventoryAvailable && (
                <Text>
                  The space inventory could not be refreshed. Changes are limited to the spaces you
                  selected before opening this dialog.
                </Text>
              )}
              <Label labelFor="configuration-mode">Prompt work type</Label>
              <Select
                inputId="configuration-mode"
                isDisabled={busy}
                options={[
                  {
                    value: 'existing',
                    label: 'Use an existing type',
                    isDisabled: !catalog.typesAvailable,
                  },
                  {
                    value: 'create',
                    label: 'Create a new type',
                    isDisabled: !catalog.typesAvailable,
                  },
                  { value: 'unlink', label: 'Remove setup from selected spaces' },
                ]}
                value={{
                  value: mode,
                  label:
                    mode === 'existing'
                      ? 'Use an existing type'
                      : mode === 'unlink'
                        ? 'Remove setup from selected spaces'
                        : 'Create a new type',
                }}
                onChange={(o) => {
                  if (o && !Array.isArray(o)) {
                    setMode(o.value);
                    setPlans([]);
                    setSharedAck(false);
                  }
                }}
              />
              {mode === 'existing' ? (
                <>
                  <Label labelFor="configuration-type">Existing type</Label>
                  <Select
                    inputId="configuration-type"
                    isSearchable
                    isDisabled={busy || !catalog.typesAvailable}
                    options={catalog.types.map((t) => ({ value: t.id, label: t.name }))}
                    value={
                      catalog.types
                        .filter((t) => t.id === type)
                        .map((t) => ({ value: t.id, label: t.name }))[0] ?? null
                    }
                    onChange={(o) => {
                      if (o && !Array.isArray(o)) {
                        setType(o.value);
                        setPlans([]);
                        setSharedAck(false);
                      }
                    }}
                  />
                </>
              ) : mode === 'create' ? (
                <>
                  <Label labelFor="configuration-name">New type name</Label>
                  <Textfield
                    id="configuration-name"
                    value={name}
                    isDisabled={busy || !catalog.typesAvailable}
                    onChange={(e) => {
                      setName(e.target.value);
                      setPlans([]);
                      setSharedAck(false);
                    }}
                  />
                  <Text>
                    Creates one global Jira work type. Review its availability in default/shared
                    schemes; other spaces may be affected.
                  </Text>
                </>
              ) : (
                <Text>
                  Clears the app’s setup and preferences for the selected spaces. Work items, their
                  selected prompts, copied instructions and Jira work types stay in place.
                </Text>
              )}
              {mode !== 'unlink' && (
                <Checkbox
                  label="Reload work item after saving prompts"
                  isChecked={refreshAfterSave}
                  isDisabled={busy}
                  onChange={(event) => {
                    setRefreshAfterSave(event.target.checked === true);
                    setPlans([]);
                    setSharedAck(false);
                  }}
                />
              )}
              <Heading as="h3" size="small">
                {plans.length ? 'Review changes' : 'Selected spaces'}
              </Heading>
              <DynamicTable
                label="Configuration review"
                rowsPerPage={5}
                head={{
                  cells: [
                    { key: 'project', content: 'Space' },
                    { key: 'change', content: plans.length ? 'Proposed change' : 'Selection' },
                  ],
                }}
                rows={ids.map((id) => {
                  const p = plans.find((p) => p.id === id);
                  return {
                    key: id,
                    cells: [
                      { content: <Text>{label(id)}</Text> },
                      {
                        content: (
                          <Text>
                            {p?.error
                              ? `Blocked: ${p.error}`
                              : p?.value
                                ? mode === 'unlink'
                                  ? 'Remove setup and preferences'
                                  : `${p.value.typeName}${p.value.attach ? ` — add to ${p.value.scheme.name}` : ' — already in this space'}`
                                : 'Selected'}
                          </Text>
                        ),
                      },
                    ],
                  };
                })}
              />
              {shared.length > 0 && (
                <>
                  <Heading as="h3" size="small">
                    Shared scheme changes
                  </Heading>
                  {shared.map((scheme) => (
                    <Text key={scheme.id}>
                      {scheme.name} · {scheme.projectIds.length} spaces ·{' '}
                      {scheme.projectIds.filter((id) => ids.includes(id)).length} selected ·{' '}
                      {scheme.projectIds.filter((id) => !ids.includes(id)).length} additional spaces
                      affected
                    </Text>
                  ))}
                  <Text>
                    The prompt type will become available in every listed space. Agent Prompts
                    configuration changes only for your selected spaces. Each shared scheme is
                    updated once.
                  </Text>
                  <DynamicTable
                    label="Shared scheme impact"
                    rowsPerPage={5}
                    head={{
                      cells: [
                        { key: 'scheme', content: 'Scheme' },
                        { key: 'project', content: 'Affected space' },
                        { key: 'effect', content: 'Change' },
                      ],
                    }}
                    rows={shared.flatMap((scheme) =>
                      scheme.projectIds.map((id) => ({
                        key: `${scheme.id}-${id}`,
                        cells: [
                          { content: <Text>{scheme.name}</Text> },
                          { content: <Text>{affectedLabel(scheme, id)}</Text> },
                          {
                            content: (
                              <Text>
                                {ids.includes(id)
                                  ? 'Type available + app configuration'
                                  : 'Type available only'}
                              </Text>
                            ),
                          },
                        ],
                      })),
                    )}
                  />
                  <Checkbox
                    label="I approve the shared scheme changes for all listed affected spaces."
                    isChecked={sharedAck}
                    isDisabled={busy}
                    onChange={(e) => setSharedAck(e.target.checked === true)}
                  />
                </>
              )}
              {plans.some((p) => p.error) && (
                <>
                  <Text>
                    Resolve or exclude blocked spaces before applying. No changes have been made.
                  </Text>
                  <Button
                    isDisabled={busy}
                    onClick={() => {
                      setIds(plans.filter((p) => p.value).map((p) => p.id));
                      setPlans([]);
                      setSharedAck(false);
                    }}
                  >
                    Exclude blocked spaces
                  </Button>
                </>
              )}
              {plans.length > 0 && mode !== 'unlink' && (
                <>
                  <Text>
                    Reload after saving: {refreshAfterSave ? 'On' : 'Off'} for all selected spaces.
                    All work items of this type become prompts. Prompts of a previous type stay
                    selected where they are already used but cannot be added again. Existing work
                    items, descriptions, workflows and screens are not changed.
                  </Text>
                  {plans
                    .filter((p) => p.value?.old && p.value.old !== p.value.type)
                    .map((p) => (
                      <Text key={p.id}>
                        {label(p.id)}: visible prompts of the previous type
                        {p.value!.promptIncomplete ? ' (incomplete)' : ''}:{' '}
                        {p.value!.promptKeys.join(', ') || 'None returned'}. Work items using them
                        {p.value!.usingIncomplete ? ' (incomplete)' : ''}:{' '}
                        {p.value!.usingKeys.join(', ') || 'None returned'}. Hidden work items are
                        not counted.
                      </Text>
                    ))}
                  <Text>
                    Changes use your Jira administrator permissions and apply one space at a time.
                    If interrupted, inspect saved progress before continuing.
                  </Text>
                </>
              )}
            </>
          )}
          {(active || uncertain || done) && (
            <>
              {record && (
                <>
                  <Heading as="h3" size="small">
                    {record.data.status === 'complete'
                      ? 'Configuration complete'
                      : record.data.status === 'stopped'
                        ? 'Configuration ended'
                        : 'Saved progress'}
                  </Heading>
                  <Text>
                    {record.data.input.unlink
                      ? `Setup removed from ${record.data.index} of ${record.data.entries.length} spaces.`
                      : `${record.data.index} of ${record.data.entries.length} spaces configured.`}
                  </Text>
                  {record.data.input.name && record.data.type && (
                    <Text>
                      Created work type: {record.data.input.name}. Use it when setting up more
                      spaces.
                    </Text>
                  )}
                  <DynamicTable
                    label="Configuration results"
                    rowsPerPage={5}
                    head={{
                      cells: [
                        { key: 'project', content: 'Space' },
                        { key: 'status', content: 'Result' },
                      ],
                    }}
                    rows={record.data.entries.map((e, i) => ({
                      key: e.projectId,
                      cells: [
                        { content: <Text>{label(e.projectId)}</Text> },
                        {
                          content: (
                            <Text>
                              {e.status === 'done'
                                ? record.data.input.unlink
                                  ? 'Setup removed'
                                  : 'Configured'
                                : e.projectId === record.data.inspectProject ||
                                    (i === record.data.index &&
                                      ['running', 'attention'].includes(record.data.status))
                                  ? 'Outcome needs inspection'
                                  : 'Not yet configured'}
                            </Text>
                          ),
                        },
                      ],
                    }))}
                  />
                  {record.data.message && <Text>{record.data.message}</Text>}
                </>
              )}
              {!done && (
                <Button isDisabled={busy} onClick={() => void run(observe)}>
                  Check saved progress
                </Button>
              )}
              {!uncertain && !foreignRun && record?.data.status === 'ready' && (
                <Button
                  isDisabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setUncertain(true);
                      await advance(record);
                      setUncertain(false);
                    })
                  }
                >
                  Continue reviewed changes
                </Button>
              )}
              {active && foreignRun && (
                <>
                  <Text>
                    Only the administrator who reviewed this configuration can continue its changes.
                    If that administrator is unavailable, inspect the saved results and any affected
                    space in Jira before releasing the abandoned configuration. An uncertain or
                    in-flight step requires a two-minute wait; releasing it cannot stop a delayed
                    Jira request. Completed changes and space recovery records are kept.
                  </Text>
                  <Checkbox
                    label="I confirmed this configuration is abandoned and inspected its affected Jira changes."
                    isChecked={abandonedAck}
                    isDisabled={busy}
                    onChange={(event) => setAbandonedAck(event.target.checked === true)}
                  />
                  <Button
                    isDisabled={busy || !abandonedAck}
                    onClick={() =>
                      void run(async () => {
                        setAttempted(true);
                        setUncertain(true);
                        setRecord(
                          await call<BatchRecord>('configuration-stop', {
                            id: record.data.id,
                            revision: record.revision,
                            acknowledged: abandonedAck,
                          }),
                        );
                        setUncertain(false);
                        setAbandonedAck(false);
                      })
                    }
                  >
                    Release abandoned configuration
                  </Button>
                </>
              )}
              {record && !foreignRun && ['running', 'attention'].includes(record.data.status) && (
                <Text>
                  Close this dialog and reload Space configuration to cancel your interrupted
                  configuration automatically. Completed changes are kept. Inspect the affected
                  space using View details; a Jira request already in progress may still finish.
                </Text>
              )}
            </>
          )}
          {busy && (
            <Inline space="space.100" alignBlock="center">
              <Spinner size="small" label="Configuration in progress" />
              <Text>
                {!catalog
                  ? 'Loading configuration…'
                  : active || uncertain
                    ? 'Applying reviewed configuration…'
                    : 'Checking configuration…'}
              </Text>
            </Inline>
          )}
          {message && <Text>{message}</Text>}
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button isDisabled={busy} onClick={() => onClose(attempted)}>
          {done ? 'Done' : active || uncertain ? 'Close' : 'Cancel'}
        </Button>
        {catalog &&
          !active &&
          !uncertain &&
          !done &&
          (plans.length === ids.length && plans.length > 0 && !plans.some((p) => !p.value) ? (
            <Button
              appearance="primary"
              isDisabled={busy || (shared.length > 0 && !sharedAck)}
              onClick={() => void run(apply)}
            >
              Apply changes
            </Button>
          ) : (
            <Button
              appearance="primary"
              isDisabled={
                busy ||
                !ids.length ||
                (mode !== 'unlink' && !catalog.typesAvailable) ||
                (mode === 'existing' ? !type : mode === 'create' ? !name.trim() : false)
              }
              onClick={() =>
                void run(async () => {
                  setPlans([]);
                  setSharedAck(false);
                  setPlans(
                    await readSpaces(
                      ids,
                      (id) => call<Plan>('configuration-preview', { projectId: id, ...input }),
                      () => {},
                    ),
                  );
                })
              }
            >
              Review changes
            </Button>
          ))}
      </ModalFooter>
    </Modal>
  );
}
