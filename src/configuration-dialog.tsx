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
import { readProjects } from './project-reads';
import { createLatch } from './shared/latch.mjs';
import type { createWizard, WizardRecord, WizardProject } from './wizard';
import type { createSettings } from './settings';
type Catalog = Awaited<ReturnType<ReturnType<typeof createWizard>['catalog']>>;
type Plan = Awaited<ReturnType<ReturnType<typeof createSettings>['preview']>>;
type Reviewed = { id: string; value?: Plan; error?: string };
export function ConfigurationDialog({
  projects,
  initialType,
  onClose,
  onBusy,
}: {
  projects: WizardProject[];
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
  const [record, setRecord] = useState<WizardRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState('');
  const [sharedAck, setSharedAck] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [abandonedAck, setAbandonedAck] = useState(false);
  // UI Kit can deliver a second click before the disabled tree reaches the host.
  const latch = useRef(createLatch()).current;
  const active = !!record && !['complete', 'stopped'].includes(record.data.status);
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
    return p?.key ? `${p.key}${p.name ? ` — ${p.name}` : ''}` : `Project ID ${id}`;
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
            const c = await call<Catalog>('wizard-catalog', {});
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
            const current = await call<WizardRecord | null>('wizard-status', {});
            setRecord(current);
            setAttempted(!!current && !['complete', 'stopped'].includes(current.data.status));
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
  const label = (id: string) => {
    const p = catalog?.projects.find((p) => p.id === id) ?? projects.find((p) => p.id === id);
    return p ? `${p.key} — ${p.name}` : id;
  };
  async function observe() {
    const current = await call<WizardRecord | null>('wizard-status', {});
    setRecord(current);
    if (current && !['complete', 'stopped'].includes(current.data.status)) setAttempted(true);
    setUncertain(false);
    setPlans([]);
    setSharedAck(false);
    setAbandonedAck(false);
    if (!current) setMessage('No saved configuration run. Review changes before applying.');
  }
  async function advance(start: WizardRecord) {
    let current = start;
    while (current.data.status === 'ready') {
      current = await call<WizardRecord>('wizard-advance', {
        id: current.data.id,
        revision: current.revision,
      });
      setRecord(current);
    }
  }
  async function apply() {
    setAttempted(true);
    setUncertain(true);
    const current = await call<WizardRecord>('wizard-start', {
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
  const done = attempted && !!record && ['complete', 'stopped'].includes(record.data.status);
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
              : `Configure ${ids.length} project${ids.length === 1 ? '' : 's'}`}
        </ModalTitle>
      </ModalHeader>
      <ModalBody>
        <Stack space="space.150">
          {catalog && !active && !uncertain && !done && (
            <>
              {!catalog.typesAvailable && (
                <Text>
                  Ticket types could not be loaded. You can still choose Unlink selected projects.
                  Reopen this dialog to retry type configuration.
                </Text>
              )}
              {!catalog.inventoryAvailable && (
                <Text>
                  The project inventory could not be refreshed. Changes are limited to the projects
                  you selected before opening this dialog.
                </Text>
              )}
              <Label labelFor="configuration-mode">Prompt issue type</Label>
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
                  { value: 'unlink', label: 'Unlink selected projects' },
                ]}
                value={{
                  value: mode,
                  label:
                    mode === 'existing'
                      ? 'Use an existing type'
                      : mode === 'unlink'
                        ? 'Unlink selected projects'
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
                    Creates one global Jira ticket type. Review its availability in default/shared
                    schemes; other projects may be affected.
                  </Text>
                </>
              ) : (
                <Text>
                  Clears Agent Prompts configuration and preferences for the selected projects.
                  Existing issues, prompt links, descriptions and Jira issue types stay in place.
                </Text>
              )}
              {mode !== 'unlink' && (
                <Checkbox
                  label="Reload ticket after saving prompts"
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
                {plans.length ? 'Review changes' : 'Selected projects'}
              </Heading>
              <DynamicTable
                label="Configuration review"
                rowsPerPage={5}
                head={{
                  cells: [
                    { key: 'project', content: 'Project' },
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
                                  ? 'Clear app configuration and preferences'
                                  : `${p.value.typeName}${p.value.attach ? ` — add to ${p.value.scheme.name}` : ' — already available; save mapping'}`
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
                      {scheme.name} · {scheme.projectIds.length} projects ·{' '}
                      {scheme.projectIds.filter((id) => ids.includes(id)).length} selected ·{' '}
                      {scheme.projectIds.filter((id) => !ids.includes(id)).length} additional
                      projects affected
                    </Text>
                  ))}
                  <Text>
                    The prompt type will become available in every listed project. Agent Prompts
                    configuration changes only for your selected projects. Each shared scheme is
                    updated once.
                  </Text>
                  <DynamicTable
                    label="Shared scheme impact"
                    rowsPerPage={5}
                    head={{
                      cells: [
                        { key: 'scheme', content: 'Scheme' },
                        { key: 'project', content: 'Affected project' },
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
                    label="I approve the shared scheme changes for all listed affected projects."
                    isChecked={sharedAck}
                    isDisabled={busy}
                    onChange={(e) => setSharedAck(e.target.checked === true)}
                  />
                </>
              )}
              {plans.some((p) => p.error) && (
                <>
                  <Text>
                    Resolve or exclude blocked projects before applying. No changes have been made.
                  </Text>
                  <Button
                    isDisabled={busy}
                    onClick={() => {
                      setIds(plans.filter((p) => p.value).map((p) => p.id));
                      setPlans([]);
                      setSharedAck(false);
                    }}
                  >
                    Exclude blocked projects
                  </Button>
                </>
              )}
              {plans.length > 0 && mode !== 'unlink' && (
                <>
                  <Text>
                    Reload after saving: {refreshAfterSave ? 'On' : 'Off'} for all selected
                    projects. All tickets of this type become prompt sources. Existing links keep
                    their sources. Tickets, descriptions, workflows and screens are not migrated.
                  </Text>
                  {plans
                    .filter((p) => p.value?.old && p.value.old !== p.value.type)
                    .map((p) => (
                      <Text key={p.id}>
                        {label(p.id)}: visible old-type prompts
                        {p.value!.promptIncomplete ? ' (incomplete)' : ''}:{' '}
                        {p.value!.promptKeys.join(', ') || 'None returned'}. Tickets with links
                        {p.value!.linksIncomplete ? ' (incomplete)' : ''}:{' '}
                        {p.value!.linkedKeys.join(', ') || 'None returned'}. Hidden tickets are not
                        counted.
                      </Text>
                    ))}
                  <Text>
                    Changes use your Jira administrator permissions and apply one project at a time.
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
                    {record.data.index} of {record.data.entries.length} projects{' '}
                    {record.data.input.unlink ? 'unlinked' : 'configured'}.
                  </Text>
                  {record.data.type && (
                    <Text>
                      Ticket type ID: {record.data.type}. Reuse this type for additional projects.
                    </Text>
                  )}
                  <DynamicTable
                    label="Configuration results"
                    rowsPerPage={5}
                    head={{
                      cells: [
                        { key: 'project', content: 'Project' },
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
                                  ? 'Unlinked'
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
                    Only the administrator who reviewed this batch can continue its changes. If that
                    administrator is unavailable, inspect the saved results and any affected project
                    in Jira before releasing the abandoned batch. An uncertain or in-flight step
                    requires a two-minute wait; releasing it cannot stop a delayed Jira request.
                    Completed changes and project recovery records are kept.
                  </Text>
                  <Checkbox
                    label="I confirmed this batch is abandoned and inspected its affected Jira changes."
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
                          await call<WizardRecord>('wizard-stop', {
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
                    Release abandoned batch
                  </Button>
                </>
              )}
              {record && !foreignRun && ['running', 'attention'].includes(record.data.status) && (
                <Text>
                  Close this dialog and reload Project configuration to cancel your interrupted
                  batch automatically. Completed changes are kept. Inspect the affected project
                  using View details; a Jira request already in progress may still finish.
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
                    await readProjects(
                      ids,
                      (id) => call<Plan>('wizard-preview', { projectId: id, ...input }),
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
