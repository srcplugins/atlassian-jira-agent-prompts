import React, { useEffect, useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  DynamicTable,
  Heading,
  HelperMessage,
  Inline,
  Spinner,
  Label,
  Lozenge,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ProgressBar,
  ProgressTracker,
  SectionMessage,
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
import type { createSettings, ReloadChoice } from './settings';
type Catalog = Awaited<ReturnType<ReturnType<typeof createConfigurationBatch>['catalog']>>;
type Plan = Awaited<ReturnType<ReturnType<typeof createSettings>['preview']>>;
type Options = Awaited<ReturnType<ReturnType<typeof createSettings>['options']>>;
type Reviewed = { id: string; value?: Plan; error?: string };
type ScreenChange = Plan['screens']['changes'][number];
const fieldName = (field: string) =>
  field === 'summary' ? 'Summary' : field === 'description' ? 'Description' : 'Agent Prompts';
type Change = { op: 'Add' | 'Remove' | 'Change' | 'Keep'; text: string };
const appearance = {
  Add: 'success',
  Remove: 'removed',
  Change: 'moved',
  Keep: 'default',
} as const;
/** The changes of one reviewed space, in words; record-only screen changes are not listed. */
function changes(plan: Plan, typeName: (id: string) => string): Change[] {
  const unlink = 'unlink' in plan && plan.unlink;
  return [
    ...(unlink && plan.old ? [{ op: 'Remove', text: 'App setup and preferences' } as Change] : []),
    ...(!unlink && plan.old && plan.old !== plan.type
      ? [{ op: 'Change', text: `Prompt type: ${typeName(plan.old)} → ${plan.typeName}` } as Change]
      : []),
    ...(plan.attach
      ? [{ op: 'Add', text: `${plan.typeName} work type to ${plan.scheme.name}` } as Change]
      : []),
    ...plan.screens.changes.flatMap((c): Change[] =>
      c.action === 'add' || c.action === 'require'
        ? [{ op: 'Add', text: `${fieldName(c.field)} to ${c.screen.name}` }]
        : c.action === 'remove'
          ? [{ op: 'Remove', text: `Agent Prompts from ${c.screen.name}` }]
          : c.action === 'leave'
            ? [
                {
                  op: 'Keep',
                  text: `Agent Prompts on ${c.screen.name} (another configured space uses it)`,
                },
              ]
            : [],
    ),
    ...plan.screens.present.map((screen): Change => ({
      op: 'Keep',
      text: `Agent Prompts on ${screen.name} (added outside the app)`,
    })),
  ];
}
const PAGE = 5;
const pageOf = <T,>(items: T[], page: number) => items.slice(page * PAGE, (page + 1) * PAGE);
export function ConfigurationDialog({
  projects,
  inventory,
  initialType,
  onClose,
  onBusy,
}: {
  projects: InventoryProject[];
  /** Every space the health view loaded, for naming spaces outside the selection; incomplete
   * when the inventory was truncated or could not be read. */
  inventory: { projects: InventoryProject[]; incomplete: boolean };
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
  // Keep is the default, so configuring a space again never changes its reload preference unasked.
  const [reloadAfterSave, setReloadAfterSave] = useState<ReloadChoice>('keep');
  const [plans, setPlans] = useState<Reviewed[]>([]);
  const [record, setRecord] = useState<BatchRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState('');
  const [sharedAck, setSharedAck] = useState(false);
  const [screenAck, setScreenAck] = useState(false);
  // Work types offered per space are read once, when the Work types step first opens; they do
  // not depend on the prompt type, which is left out where they are shown. A choice starts from
  // the space's saved selection.
  const [screenOptions, setScreenOptions] = useState<Record<string, Options['availableTypes']>>({});
  const [screenChoice, setScreenChoice] = useState<Record<string, string[]>>({});
  // Each space's saved selection, from that read, for the "Was:" note.
  const [savedTypes, setSavedTypes] = useState<Record<string, string[]>>({});
  const [bulk, setBulk] = useState<string[]>([]);
  const [bulkApplied, setBulkApplied] = useState<string[]>([]);
  // 1 prompt type, 2 work types (skipped when removing setup), 3 review.
  const [step, setStep] = useState(1);
  const [page, setPage] = useState(0);
  // Spaces reviewed or configured so far in the running request, for the spinner.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [abandonedAck, setAbandonedAck] = useState(false);
  // UI Kit can deliver a second click before the disabled tree reaches the host.
  const latch = useRef(createLatch()).current;
  // Any input change starts a new review revision; a review that returns after one is dropped.
  const reviewRevision = useRef(0);
  const active = !!record && !finished(record.data.status);
  const foreignRun = !!accountId && !!record && record.data.actor !== accountId;
  const input =
    mode === 'unlink'
      ? { unlink: true }
      : { ...(mode === 'existing' ? { type } : { name }), reloadAfterSave };
  const single = ids.length === 1;
  const reloadOptions: { value: ReloadChoice; label: string }[] = [
    { value: 'keep', label: single ? 'Keep this space’s setting' : 'Keep each space’s setting' },
    { value: 'on', label: 'On for all selected spaces' },
    { value: 'off', label: 'Off for all selected spaces' },
  ];
  const shared = [
    ...new Map(
      plans
        .filter((p) => p.value?.attach && p.value.scheme.projectIds.length > 1)
        .map((p) => [p.value!.scheme.id, p.value!.scheme]),
    ).values(),
  ];
  const sharedScreens = [
    ...new Map(
      plans.flatMap((p) =>
        (p.value?.screens.changes ?? [])
          .filter((c) => c.impact?.shared)
          .map(
            (c) =>
              [
                `${c.screen.id}:${c.field}:${c.action}`,
                { change: c, spaces: p.value!.screenProjects[c.screen.id] ?? [] },
              ] as const,
          ),
      ),
    ).values(),
  ];
  const screenEffect = (c: ScreenChange) =>
    c.action === 'remove'
      ? 'Agent Prompts removed'
      : `${fieldName(c.field)} added${c.action === 'require' ? ' (create screen)' : ''}`;
  /** Drops the review of `spaces` only; the acknowledgements cover the whole review, so any
   * change resets them. */
  function dropPlans(spaces: string[]) {
    reviewRevision.current++;
    setPlans((ps) => ps.filter((p) => !spaces.includes(p.id)));
    setSharedAck(false);
    setScreenAck(false);
  }
  function clearReview() {
    reviewRevision.current++;
    setPlans([]);
    setSharedAck(false);
    setScreenAck(false);
  }
  const affectedLabel = (scheme: Plan['scheme'], id: string) => {
    const p =
      scheme.projects?.find((p) => p.id === id) ?? inventory.projects.find((p) => p.id === id);
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
        setProgress(null);
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
            setCatalog({ typesAvailable: false, types: [] });
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
    const p = inventory.projects.find((p) => p.id === id) ?? projects.find((p) => p.id === id);
    return p && p.key !== p.id ? `${p.key} — ${p.name}` : `Space ID ${id}`;
  };
  const typeName = (id: string) =>
    catalog?.types.find((t) => t.id === id)?.name ??
    Object.values(screenOptions)
      .flat()
      .find((t) => t.id === id)?.name ??
    `Work type ID ${id}`;
  /** Reviews `spaces` with the current input, keeping the other spaces' reviews; false when the
   * input changed meanwhile. */
  async function review(spaces: string[]) {
    dropPlans(spaces);
    const started = reviewRevision.current;
    setProgress({ done: 0, total: spaces.length });
    const reviewed = await readSpaces(
      spaces,
      (id) =>
        call<Plan>('configuration-preview', {
          projectId: id,
          ...input,
          // The prompt type itself is never offered for its own screens.
          ...(mode !== 'unlink' && screenChoice[id]
            ? {
                screenTypes: screenChoice[id].filter((t) => mode !== 'existing' || t !== type),
              }
            : {}),
        }),
      (results) => setProgress({ done: results.length, total: spaces.length }),
    );
    if (started !== reviewRevision.current) {
      setMessage('The selection changed during the review. Review changes again.');
      return false;
    }
    setPlans((ps) => [
      ...ps.filter((p) => !spaces.includes(p.id)),
      ...reviewed.map((p) =>
        p.value && 'blocked' in p.value && p.value.blocked
          ? { id: p.id, error: p.value.blocked }
          : p,
      ),
    ]);
    return true;
  }
  /** Reads the work types `spaces` offer, keeping what was read before; false when one could not
   * be read, so the step stays where it is and a later Next reads only what is missing. */
  async function readOptions(spaces: string[]) {
    if (!spaces.length) return true;
    setProgress({ done: 0, total: spaces.length });
    const read = await readSpaces(
      spaces,
      (id) => call<Options>('configuration-options', { projectId: id }),
      (results) => setProgress({ done: results.length, total: spaces.length }),
    );
    const fresh = read.filter((p) => p.value);
    setScreenOptions((o) => ({
      ...o,
      ...Object.fromEntries(fresh.map((p) => [p.id, p.value!.availableTypes])),
    }));
    const saved = Object.fromEntries(fresh.map((p) => [p.id, p.value!.screenTypes]));
    setScreenChoice((c) => ({ ...saved, ...c }));
    setSavedTypes((s) => ({ ...saved, ...s }));
    const failed = read.find((p) => !p.value);
    if (failed) {
      setMessage(`Work types could not be read for ${label(failed.id)}: ${failed.error}`);
      return false;
    }
    return true;
  }
  /**
   * Moves to `next`. The Work types step needs only each space's work types, read once per
   * dialog; the Review step reviews the spaces whose review a change dropped (all of them at
   * first) and keeps the rest.
   */
  const goTo = (next: number) => {
    void run(async () => {
      const unreviewed = ids.filter((id) => !plans.some((p) => p.id === id));
      const ok =
        next === 2
          ? await readOptions(ids.filter((id) => !screenOptions[id]))
          : unreviewed.length === 0 || (await review(unreviewed));
      if (ok) {
        setPage(0);
        setStep(next);
      }
    });
  };
  async function observe() {
    const current = await call<BatchRecord | null>('configuration-status', {});
    setRecord(current);
    if (current && !finished(current.data.status)) setAttempted(true);
    setUncertain(false);
    clearReview();
    setStep(1);
    setAbandonedAck(false);
    if (!current) setMessage('No saved configuration run. Review changes before applying.');
  }
  async function advance(start: BatchRecord) {
    let current = start;
    const total = start.data.entries.length;
    setProgress({ done: start.data.index, total });
    while (current.data.status === 'ready') {
      const next = await call<BatchRecord>('configuration-advance', {
        id: current.data.id,
        revision: current.revision,
      });
      setRecord(next);
      setProgress({ done: next.data.index, total });
      // A step that applied nothing (a brief outage before its claim) leaves the batch ready at
      // the same space. Stop instead of retrying it automatically: Continue reviewed changes
      // is the explicit way on. A step that made part of a space's screen changes moves on.
      const at = (r: BatchRecord) => r.data.entries[r.data.index]?.applied ?? 0;
      if (
        next.data.status === 'ready' &&
        next.data.index === current.data.index &&
        at(next) === at(current)
      ) {
        setMessage(next.data.entries[next.data.index]?.message ?? next.data.message ?? '');
        return;
      }
      current = next;
    }
  }
  async function apply() {
    setAttempted(true);
    setUncertain(true);
    setProgress({ done: 0, total: plans.length });
    const current = await call<BatchRecord>('configuration-start', {
      ...input,
      ...(shared.length && sharedAck ? { allowShared: true } : {}),
      ...(sharedScreens.length && screenAck ? { allowSharedScreens: true } : {}),
      entries: plans.map((p) => ({
        projectId: p.id,
        fingerprint: p.value!.fingerprint,
        ...(mode === 'unlink' ? {} : { screenTypes: p.value!.screenTypes }),
      })),
      revision: record?.revision ?? 0,
    });
    setRecord(current);
    clearReview();
    await advance(current);
    setUncertain(false);
  }
  const done = attempted && !!record && finished(record.data.status);
  const steps =
    mode === 'unlink' ? ['Prompt type', 'Review'] : ['Prompt type', 'Work types', 'Review'];
  const stepIndex = step === 3 ? steps.length - 1 : step - 1;
  const ready = plans.length === ids.length && plans.length > 0 && !plans.some((p) => !p.value);
  // Apply to all offers every work type of the selected spaces except the prompt type.
  const bulkOptions = [
    ...new Map(
      ids
        .flatMap((id) => screenOptions[id] ?? [])
        .filter((t) => mode !== 'existing' || t.id !== type)
        .map((t) => [t.id, { value: t.id, label: t.name }]),
    ).values(),
  ];
  const pages = Math.ceil(ids.length / PAGE);
  // Buttons rather than Pagination: in Jira, Pagination's onChange did not deliver a usable page
  // number, which emptied the list.
  const pager = pages > 1 && (
    <Inline space="space.100" alignBlock="center">
      <Button isDisabled={busy || page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
        Previous spaces
      </Button>
      <Text>{`Spaces ${page * PAGE + 1}–${Math.min(ids.length, (page + 1) * PAGE)} of ${ids.length}`}</Text>
      <Button
        isDisabled={busy || page >= pages - 1}
        onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
      >
        Next spaces
      </Button>
    </Inline>
  );
  return (
    <Modal
      width="large"
      // One height for every step, so the footer buttons stay in place; it fits the tallest step
      // (Work types with five spaces and their notes). Jira caps it at the window and the body scrolls.
      height={960}
      // Clicking outside the dialog or pressing Escape would discard the inputs and review; only the
      // footer button closes it.
      onClose={() => {}}
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
              <ProgressTracker
                label="Configuration steps"
                items={steps.map((s, i) => ({
                  id: s,
                  label: s,
                  percentageComplete: i < stepIndex ? 100 : 0,
                  status: i < stepIndex ? 'visited' : i === stepIndex ? 'current' : 'unvisited',
                }))}
              />
              {step === 1 && (
                <>
                  {!catalog.typesAvailable && (
                    <Text>
                      Work types could not be loaded. You can still remove setup from the selected
                      spaces. Reopen this dialog to retry type configuration.
                    </Text>
                  )}
                  {inventory.incomplete && (
                    <Text>
                      The space inventory is incomplete. Changes are limited to the spaces you
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
                        clearReview();
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
                            clearReview();
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
                          clearReview();
                        }}
                      />
                      <Text>
                        Creates one global Jira work type. Review its availability in default/shared
                        schemes; other spaces may be affected.
                      </Text>
                    </>
                  ) : (
                    <Text>
                      Clears the app’s setup and preferences for the selected spaces and removes the
                      Agent Prompts field from screens the app added it to, unless another
                      configured space still uses that screen. Work items, their selected prompts,
                      copied instructions and Jira work types stay in place.
                    </Text>
                  )}
                  {mode !== 'unlink' && (
                    <>
                      <Label labelFor="configuration-reload">
                        Reload work item after saving prompts
                      </Label>
                      <Select
                        inputId="configuration-reload"
                        isDisabled={busy}
                        options={reloadOptions}
                        value={reloadOptions.find((o) => o.value === reloadAfterSave)}
                        onChange={(o) => {
                          if (o && !Array.isArray(o)) {
                            setReloadAfterSave(o.value);
                            clearReview();
                          }
                        }}
                      />
                      <HelperMessage>
                        Reloading can discard other unsaved edits on the work item.
                      </HelperMessage>
                    </>
                  )}
                  <Heading as="h3" size="small">
                    Selected spaces
                  </Heading>
                  <DynamicTable
                    label="Selected spaces"
                    rowsPerPage={PAGE}
                    head={{ cells: [{ key: 'project', content: 'Space' }] }}
                    rows={ids.map((id) => ({
                      key: id,
                      cells: [{ content: <Text>{label(id)}</Text> }],
                    }))}
                  />
                </>
              )}
              {step === 2 && (
                <>
                  <Heading as="h3" size="small">
                    Add Agent Prompts to screens
                  </Heading>
                  <Text>
                    Choose the work types that show the Agent Prompts field in each space.
                  </Text>
                  {ids.length > 1 && bulkOptions.length > 0 && (
                    <Stack space="space.050">
                      <Label labelFor="bulk-types">Set all selected spaces to</Label>
                      <Select
                        inputId="bulk-types"
                        isMulti
                        isSearchable
                        isDisabled={busy}
                        placeholder="Choose work types"
                        options={bulkOptions}
                        value={bulkOptions.filter((o) => bulk.includes(o.value))}
                        onChange={(value: { value: string }[] | null) =>
                          setBulk((value ?? []).map((o) => o.value))
                        }
                      />
                      <Inline>
                        <Button
                          isDisabled={busy || !bulk.length}
                          onClick={() => {
                            const next = Object.fromEntries(
                              ids
                                .filter((id) => screenOptions[id])
                                .map((id) => [
                                  id,
                                  bulk.filter((t) => screenOptions[id]!.some((o) => o.id === t)),
                                ]),
                            );
                            setScreenChoice((c) => ({ ...c, ...next }));
                            setBulkApplied(bulk);
                            // Only the spaces whose choice changes lose their review.
                            const same = (a: string[], b: string[]) =>
                              a.length === b.length &&
                              [...a].sort().every((t, i) => t === [...b].sort()[i]);
                            const changed = Object.keys(next).filter(
                              (id) => !same(screenChoice[id] ?? [], next[id] ?? []),
                            );
                            if (changed.length) dropPlans(changed);
                          }}
                        >
                          Apply to all
                        </Button>
                      </Inline>
                      <Text size="small" color="color.text.subtlest">
                        Each space gets the chosen types it has. You can still change a space below.
                      </Text>
                    </Stack>
                  )}
                  {pageOf(ids, page).map((id) => {
                    // Every listed space has its work types: Next opens this step only once they
                    // are read. The prompt type is never offered for its own screens.
                    const offered = screenOptions[id] ?? [];
                    const options = offered
                      .filter((t) => mode !== 'existing' || t.id !== type)
                      .map((t) => ({ value: t.id, label: t.name }));
                    const chosen = options.filter((o) =>
                      (screenChoice[id] ?? []).includes(o.value),
                    );
                    const saved = (savedTypes[id] ?? []).filter(
                      (t) => mode !== 'existing' || t !== type,
                    );
                    const missing = bulkApplied.filter((t) => !offered.some((o) => o.id === t));
                    const notes = [
                      [...chosen.map((o) => o.value)].sort().join() !== [...saved].sort().join()
                        ? `Was: ${saved.map(typeName).join(', ') || 'none'}`
                        : '',
                      missing.length
                        ? `${missing.map(typeName).join(', ')} ${missing.length === 1 ? 'isn’t' : 'aren’t'} in this space`
                        : '',
                    ].filter(Boolean);
                    return (
                      <Stack key={id} space="space.050">
                        <Label
                          labelFor={`screen-types-${id}`}
                        >{`Work types for ${label(id)}`}</Label>
                        <Select
                          inputId={`screen-types-${id}`}
                          isMulti
                          isSearchable
                          isDisabled={busy}
                          placeholder="No work types"
                          options={options}
                          value={chosen}
                          onChange={(value: { value: string }[] | null) => {
                            setScreenChoice((c) => ({
                              ...c,
                              [id]: (value ?? []).map((o) => o.value),
                            }));
                            dropPlans([id]);
                          }}
                        />
                        {notes.length > 0 && (
                          <Text size="small" color="color.text.subtlest">
                            {notes.join(' · ')}
                          </Text>
                        )}
                      </Stack>
                    );
                  })}
                  {pager}
                </>
              )}
              {step === 3 && (
                <>
                  {mode === 'unlink' ? (
                    <Text>Remove setup from the selected spaces.</Text>
                  ) : (
                    <Inline space="space.400" shouldWrap>
                      <Stack space="space.025">
                        <Text size="small" color="color.text.subtlest">
                          Prompt work type
                        </Text>
                        <Text>
                          {mode === 'create'
                            ? `${name.trim()} (new)`
                            : (catalog.types.find((t) => t.id === type)?.name ?? '')}
                        </Text>
                        <Text size="small" color="color.text.subtlest">
                          Every work item of this type can be selected as a prompt.
                        </Text>
                      </Stack>
                      <Stack space="space.025">
                        <Text size="small" color="color.text.subtlest">
                          Reload after saving
                        </Text>
                        <Text>
                          {reloadAfterSave === 'keep'
                            ? reloadOptions[0]!.label
                            : reloadAfterSave === 'on'
                              ? 'On'
                              : 'Off'}
                        </Text>
                      </Stack>
                    </Inline>
                  )}
                  <Heading as="h3" size="small">
                    Changes
                  </Heading>
                  {plans.length > 0 &&
                    pageOf(ids, page).map((id) => {
                      const p = plans.find((p) => p.id === id);
                      const lines = p?.value ? changes(p.value, typeName) : [];
                      return (
                        <Stack key={id} space="space.075">
                          <Text weight="semibold">{label(id)}</Text>
                          {p?.error ? (
                            <Text color="color.text.danger">{`Blocked: ${p.error}`}</Text>
                          ) : lines.length ? (
                            lines.map((line, i) => (
                              <Inline key={i} space="space.100" alignBlock="center">
                                <Lozenge appearance={appearance[line.op]}>{line.op}</Lozenge>
                                <Text>{line.text}</Text>
                              </Inline>
                            ))
                          ) : (
                            <Text color="color.text.subtlest">No changes</Text>
                          )}
                        </Stack>
                      );
                    })}
                  {plans.length > 0 && pager}
                  {shared.length > 0 && (
                    <>
                      <Heading as="h3" size="small">
                        Shared scheme changes
                      </Heading>
                      {shared.map((scheme) => (
                        <Text key={scheme.id}>
                          {scheme.name} · {scheme.projectIds.length} spaces ·{' '}
                          {scheme.projectIds.filter((id) => ids.includes(id)).length} selected ·{' '}
                          {scheme.projectIds.filter((id) => !ids.includes(id)).length} additional
                          spaces affected
                        </Text>
                      ))}
                      <Text>
                        The prompt type will become available in every listed space. Agent Prompts
                        configuration changes only for your selected spaces. Each shared scheme is
                        updated once.
                      </Text>
                      <DynamicTable
                        label="Shared scheme impact"
                        rowsPerPage={PAGE}
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
                  {sharedScreens.length > 0 && (
                    <>
                      <Heading as="h3" size="small">
                        Shared screen impact
                      </Heading>
                      <Text>
                        These screens are used by more than one space, so the change shows in every
                        listed space.
                      </Text>
                      <DynamicTable
                        label="Shared screen impact"
                        rowsPerPage={PAGE}
                        head={{
                          cells: [
                            { key: 'screen', content: 'Screen' },
                            { key: 'project', content: 'Affected space' },
                            { key: 'effect', content: 'Change' },
                          ],
                        }}
                        rows={sharedScreens.flatMap(({ change, spaces }) =>
                          spaces.map((space) => ({
                            key: `${change.screen.id}-${change.field}-${change.action}-${space.id}`,
                            cells: [
                              { content: <Text>{change.screen.name}</Text> },
                              {
                                content: (
                                  <Text>
                                    {space.key
                                      ? `${space.key}${space.name ? ` — ${space.name}` : ''}`
                                      : `Space ID ${space.id}`}
                                  </Text>
                                ),
                              },
                              { content: <Text>{screenEffect(change)}</Text> },
                            ],
                          })),
                        )}
                      />
                      <Checkbox
                        label="I approve the shared screen changes for all listed affected spaces."
                        isChecked={screenAck}
                        isDisabled={busy}
                        onChange={(e) => setScreenAck(e.target.checked === true)}
                      />
                    </>
                  )}
                  {plans.some((p) => p.error) && (
                    <>
                      <Text>
                        Resolve or exclude blocked spaces before applying. No changes have been
                        made.
                      </Text>
                      <Button
                        isDisabled={busy}
                        onClick={() => {
                          const kept = plans.filter((p) => p.value).map((p) => p.id);
                          setIds(kept);
                          setPage(0);
                          // The kept spaces are reviewed again against the smaller selection.
                          clearReview();
                          void run(async () => {
                            await review(kept);
                          });
                        }}
                      >
                        Exclude blocked spaces
                      </Button>
                    </>
                  )}
                  {ready && (
                    <Text size="small" color="color.text.subtlest">
                      {plans.some((p) => p.value?.old && p.value.old !== p.value.type) &&
                      mode !== 'unlink'
                        ? 'Prompts of the old type stay where they’re already selected but can’t be added again. '
                        : ''}
                      Nothing else changes: work items, descriptions and workflows stay as they are.
                      Spaces are updated one at a time; if something interrupts, you can pick up
                      where it stopped.
                    </Text>
                  )}
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
                                  : e.applied
                                    ? `${e.applied} of ${e.applied + (e.remaining?.length ?? 0)} screen changes made`
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
              {/* Until the product context names the viewer, the run cannot be known to be theirs. */}
              {!!accountId && !uncertain && !foreignRun && record?.data.status === 'ready' && (
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
            <Stack space="space.100">
              <Inline space="space.100" alignBlock="center">
                <Spinner size="small" label="Configuration in progress" />
                <Text>
                  {!catalog
                    ? 'Loading configuration…'
                    : active || uncertain
                      ? 'Applying reviewed configuration…'
                      : 'Checking configuration…'}
                  {progress && progress.total > 1
                    ? ` ${progress.done} of ${progress.total} spaces`
                    : ''}
                </Text>
              </Inline>
              {progress && progress.total > 1 && (
                <ProgressBar
                  value={progress.done / progress.total}
                  ariaLabel={`${progress.done} of ${progress.total} spaces`}
                />
              )}
              {(active || uncertain) && (
                <SectionMessage appearance="warning">
                  <Text>
                    Keep this page open until the changes finish. Reloading or leaving cancels the
                    remaining spaces; completed changes are kept.
                  </Text>
                </SectionMessage>
              )}
            </Stack>
          )}
          {message && <Text>{message}</Text>}
        </Stack>
      </ModalBody>
      <ModalFooter>
        {catalog && !active && !uncertain && !done && step > 1 && (
          <Button
            isDisabled={busy}
            onClick={() => {
              setPage(0);
              setStep(step === 3 && mode !== 'unlink' ? 2 : 1);
            }}
          >
            Back
          </Button>
        )}
        <Button isDisabled={busy} onClick={() => onClose(attempted)}>
          {done ? 'Done' : active || uncertain ? 'Close' : 'Cancel'}
        </Button>
        {catalog &&
          !active &&
          !uncertain &&
          !done &&
          (step === 1 ? (
            <Button
              appearance="primary"
              isDisabled={
                busy ||
                !ids.length ||
                (mode !== 'unlink' && !catalog.typesAvailable) ||
                (mode === 'existing' ? !type : mode === 'create' ? !name.trim() : false)
              }
              onClick={() => goTo(mode === 'unlink' ? 3 : 2)}
            >
              {mode === 'unlink' ? 'Review changes' : 'Next'}
            </Button>
          ) : step === 2 || !plans.length ? (
            <Button appearance="primary" isDisabled={busy} onClick={() => goTo(3)}>
              Review changes
            </Button>
          ) : (
            ready && (
              <Button
                appearance="primary"
                isDisabled={
                  busy ||
                  (shared.length > 0 && !sharedAck) ||
                  (sharedScreens.length > 0 && !screenAck)
                }
                onClick={() => void run(apply)}
              >
                Apply changes
              </Button>
            )
          ))}
      </ModalFooter>
    </Modal>
  );
}
