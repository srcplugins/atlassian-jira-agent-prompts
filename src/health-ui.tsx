import React, { useEffect, useRef, useState } from 'react';
import {
  Button,
  Box,
  Label,
  xcss,
  Checkbox,
  DynamicTable,
  Heading,
  Inline,
  Lozenge,
  SectionMessage,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  Spinner,
  Stack,
  Text,
  Textfield,
  useProductContext,
} from '@forge/react';
import { call } from './client';
import { createLatch } from './shared/latch.mjs';
import { readProjects } from './project-reads';
import { Settings } from './settings-ui';
import { ConfigurationDialog } from './configuration-dialog';
import type { createSettings } from './settings';
import type { WizardProject, WizardRecord } from './wizard';
export type Health = Awaited<ReturnType<ReturnType<typeof createSettings>['health']>>;
export type Result = { id: string; value?: Health; error?: string };
function projectStatus(row?: Result) {
  return !row
    ? 'Not checked'
    : row.error
      ? 'Check failed'
      : row.value?.state.data.pending
        ? 'Needs attention'
        : !row.value?.state.data.type
          ? 'Not configured'
          : row.value.checks.every((c) => c.ok)
            ? 'Healthy'
            : 'Needs attention';
}
const hiddenLabel = xcss({ width: '1px', height: '1px', overflow: 'hidden' });
const selectionLabel = (id: string, text: string) => (
  <Box xcss={hiddenLabel}>
    <Label labelFor={id}>{text}</Label>
  </Box>
);
// Cancellation notification metadata belongs to the response, not stored progress.
type ProgressResponse = WizardRecord & { cancelledNow?: boolean };
const priority = ['Needs attention', 'Check failed', 'Not configured', 'Healthy', 'Not checked'];
export function HealthProjects({
  projectId,
  onBusy,
}: {
  projectId?: string;
  onBusy?: (busy: boolean) => void;
}) {
  const [projects, setProjects] = useState<WizardProject[]>([]),
    [results, setResults] = useState<Result[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState('All projects'),
    [page, setPage] = useState(1),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [incomplete, setIncomplete] = useState(false),
    [detail, setDetail] = useState<string>(),
    [configure, setConfigure] = useState<string[]>(),
    [progress, setProgress] = useState<WizardRecord | null>(null),
    [checked, setChecked] = useState(''),
    [cancelledRun, setCancelledRun] = useState<string>(),
    [checking, setChecking] = useState<string[]>([]),
    [completed, setCompleted] = useState(0);
  const mounted = useRef(true);
  // UI Kit can deliver a second click before the disabled tree reaches the host.
  const latch = useRef(createLatch()).current;
  const accountId = useProductContext()?.accountId;
  const working = (v: boolean) => {
    setBusy(v);
    onBusy?.(v);
  };
  async function load() {
    working(true);
    setError('');
    try {
      const inventory = await call<{ projects: WizardProject[]; incomplete: boolean }>(
        'settings-projects',
        {},
      );
      if (!mounted.current) return;
      setProjects(inventory.projects);
      setIncomplete(inventory.incomplete);
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof Error ? e.message : 'Projects could not be loaded.');
        // Inventory failure must not remove the current project's explicit recovery path.
        if (projectId) setProjects([{ id: projectId, key: projectId, name: 'Current project' }]);
      }
    } finally {
      await refreshProgress(true);
      if (mounted.current) working(false);
    }
  }
  async function refreshProgress(cancelInterrupted = false) {
    try {
      const value = await call<ProgressResponse | null>(
        cancelInterrupted ? 'wizard-cancel-interrupted' : 'wizard-status',
        {},
      );
      if (mounted.current) {
        setProgress(value);
        if (value?.cancelledNow) setCancelledRun(value.data.id);
      }
    } catch {
      if (mounted.current)
        // Keep the inventory error (especially an administration denial) visible when the
        // follow-up progress read fails too. Either failure still disables configuration.
        setError(
          (previous) =>
            previous ||
            'Saved configuration progress could not be checked. Reload this page before configuring projects.',
        );
    }
  }
  async function openDetails(id: string) {
    return latch.run(async () => {
      if (busy) return;
      setDetail(id);
      if (results.some((row) => row.id === id && row.value)) return;
      working(true);
      setChecking([id]);
      try {
        await readProjects(
          [id],
          (projectId) => call<Health>('settings-health', { projectId }),
          (updates) => {
            if (mounted.current)
              setResults((previous) => [...previous.filter((row) => row.id !== id), ...updates]);
          },
        );
      } finally {
        if (mounted.current) {
          setChecking([]);
          working(false);
        }
      }
    });
  }
  async function checkSelected() {
    return latch.run(async () => {
      if (busy || !selected.length) return;
      const ids = [...selected];
      working(true);
      setChecking(ids);
      setCompleted(0);
      try {
        await readProjects(
          ids,
          (id) => call<Health>('settings-health', { projectId: id }),
          (updates) => {
            if (!mounted.current) return;
            setCompleted(updates.length);
            setResults((previous) => [
              ...previous.filter((row) => !updates.some((update) => update.id === row.id)),
              ...updates,
            ]);
          },
        );
        if (mounted.current)
          setChecked(
            `Last checked ${ids.length} selected ${ids.length === 1 ? 'project' : 'projects'} at ${new Date().toLocaleTimeString()}`,
          );
      } finally {
        if (mounted.current) {
          setChecking([]);
          working(false);
        }
      }
    });
  }
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Load once per configuration visit; project selection and filtering are local.
  }, []);
  useEffect(() => {
    if (!progress?.data.cancelRequested || progress.data.status !== 'running') return;
    const timer = setTimeout(() => {
      void refreshProgress(true);
    }, 5000);
    return () => clearTimeout(timer);
    // Poll only an explicitly cancelled in-flight operation; never scan project health.
  }, [progress]);
  const rows = projects.map((p) => ({ ...p, result: results.find((r) => r.id === p.id) }));
  const filtered = rows.filter(
    (p) =>
      `${p.key} ${p.name}`.toLowerCase().includes(query.toLowerCase()) &&
      (filter === 'All projects' ||
        (filter === 'Needs attention' &&
          ['Needs attention', 'Check failed'].includes(projectStatus(p.result))) ||
        projectStatus(p.result) === filter),
  );
  if (!busy)
    filtered.sort(
      (a, b) =>
        priority.indexOf(projectStatus(a.result)) - priority.indexOf(projectStatus(b.result)) ||
        a.name.localeCompare(b.name),
    );
  const current = results.find((r) => r.id === detail),
    active = progress && !['complete', 'stopped'].includes(progress.data.status);
  const picked = projects.find((p) => p.id === detail);
  const disabled = busy || !!configure;
  async function openConfigure(ids: string[]) {
    return latch.run(async () => {
      if (busy) return;
      const unchecked = ids.filter((id) => !results.some((row) => row.id === id && row.value));
      if (!unchecked.length) {
        setConfigure(ids);
        return;
      }
      working(true);
      setChecking(unchecked);
      setCompleted(0);
      try {
        await readProjects(
          unchecked,
          (projectId) => call<Health>('settings-health', { projectId }),
          (updates) => {
            if (mounted.current) {
              setCompleted(updates.length);
              setResults((previous) => [
                ...previous.filter((row) => !updates.some((update) => update.id === row.id)),
                ...updates,
              ]);
            }
          },
        );
        if (mounted.current) setConfigure(ids);
      } finally {
        if (mounted.current) {
          setChecking([]);
          working(false);
        }
      }
    });
  }
  const configureSelected = () => openConfigure([...selected]);
  async function checkAffected(id: string) {
    return latch.run(async () => {
      if (busy) return;
      working(true);
      try {
        const value = await call<Health>('settings-health', { projectId: id });
        if (!mounted.current) return;
        setProjects((previous) =>
          previous.some((p) => p.id === id)
            ? previous
            : [...previous, { id, key: value.project.key, name: value.project.key }],
        );
        setResults((previous) => [...previous.filter((row) => row.id !== id), { id, value }]);
        setDetail(id);
      } catch (e) {
        if (mounted.current)
          setError(e instanceof Error ? e.message : 'Project could not be checked.');
      } finally {
        if (mounted.current) working(false);
      }
    });
  }
  async function changed() {
    // Shared scheme changes can affect unselected projects too. Invalidate results,
    // but leave new health requests under explicit Check selected or View details actions.
    setResults([]);
    setChecked('Configuration changed. Select projects or open details to check again.');
    setDetail(undefined);
    setSelected([]);
    working(true);
    await refreshProgress();
    if (mounted.current) working(false);
  }
  const badge = (status: string) => (
    <Lozenge
      appearance={
        status === 'Healthy'
          ? 'success'
          : status === 'Needs attention'
            ? 'moved'
            : status === 'Check failed'
              ? 'removed'
              : 'default'
      }
    >
      {status}
    </Lozenge>
  );
  return (
    <Stack space="space.200">
      <Heading as="h2">Project configuration</Heading>
      {active ? (
        <SectionMessage
          appearance="warning"
          title={
            progress.data.cancelRequested
              ? 'Cancelling interrupted configuration'
              : 'Configuration in progress'
          }
        >
          <Text>
            {!progress.data.cancelRequested
              ? 'Another administrator has an unfinished configuration. Review its progress before starting a new batch.'
              : progress.data.actor === accountId
                ? 'The current request may still finish. Remaining projects will not be configured. This page will unlock automatically.'
                : 'Another administrator’s configuration is being cancelled. If it does not finish, review it and release the abandoned batch.'}
          </Text>
          {/* Another administrator's batch can be stuck mid-cancellation if its owner left;
              only the dialog's acknowledged release can end it. */}
          {(!progress.data.cancelRequested || progress.data.actor !== accountId) && (
            <Button
              isDisabled={disabled}
              onClick={() => setConfigure(progress.data.entries.map((e) => e.projectId))}
            >
              Review saved configuration
            </Button>
          )}
        </SectionMessage>
      ) : progress?.data.cancelRequested &&
        (cancelledRun === progress.data.id || progress.data.inspectProject) ? (
        <SectionMessage
          appearance={progress.data.inspectProject ? 'warning' : 'information'}
          title={
            cancelledRun === progress.data.id
              ? 'Interrupted configuration cancelled'
              : 'Project needs an outcome check'
          }
        >
          {cancelledRun === progress.data.id && (
            <Text>Completed changes were kept. You can configure projects again.</Text>
          )}
          {!progress.data.inspectProject && (
            <Button appearance="subtle" onClick={() => setCancelledRun(undefined)}>
              Dismiss
            </Button>
          )}
          {progress.data.inspectProject && (
            <>
              <Text>
                One project may have an incomplete change. Check its outcome before configuring it
                again.
              </Text>
              <Button
                isDisabled={disabled}
                onClick={() => {
                  const id = progress.data.inspectProject;
                  if (id) void checkAffected(id);
                }}
              >
                Check affected project
              </Button>
            </>
          )}
        </SectionMessage>
      ) : null}
      <Inline space="space.100" shouldWrap>
        {['All projects', 'Not checked', 'Needs attention', 'Not configured', 'Healthy'].map(
          (label) => (
            <Button
              key={label}
              appearance={filter === label ? 'primary' : 'default'}
              isDisabled={disabled}
              onClick={() => {
                setFilter(label);
                setSelected([]);
                setPage(1);
              }}
            >
              {label} (
              {label === 'All projects'
                ? projects.length
                : rows.filter((p) =>
                    label === 'Needs attention'
                      ? ['Needs attention', 'Check failed'].includes(projectStatus(p.result))
                      : projectStatus(p.result) === label,
                  ).length}
              )
            </Button>
          ),
        )}
      </Inline>
      <Label labelFor="project-search">Find a project</Label>
      <Textfield
        id="project-search"
        placeholder="Find a project by name or key"
        value={query}
        isDisabled={disabled}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected([]);
          setPage(1);
        }}
      />
      <Box role="status">
        <Inline space="space.100" alignBlock="center">
          {busy && !detail && !configure && (
            <Spinner size="small" label="Loading project configuration" />
          )}
          <Text color="color.text.subtle">
            {checking.length
              ? `Checking ${completed} of ${checking.length} selected projects…`
              : busy
                ? 'Loading project configuration…'
                : checked ||
                  'Select projects, then choose Check selected to check their configuration.'}
          </Text>
        </Inline>
      </Box>
      {incomplete && (
        <Text>
          Showing the first 200 supported projects. Selection applies only to this loaded inventory.
        </Text>
      )}
      <Inline space="space.100" shouldWrap>
        <Text>{selected.length} selected</Text>
        <Button
          appearance="primary"
          isDisabled={disabled || !selected.length}
          onClick={() => void checkSelected()}
        >
          Check selected
        </Button>
        <Button
          isDisabled={disabled || !selected.length || !!error || !!active}
          onClick={() => void configureSelected()}
        >
          Configure selected
        </Button>
        <Button isDisabled={disabled || !selected.length} onClick={() => setSelected([])}>
          Clear selection
        </Button>
      </Inline>
      <DynamicTable
        label="Project configuration"
        rowsPerPage={10}
        page={page}
        onSetPage={setPage}
        head={{
          cells: [
            {
              key: 'select',
              content: (
                <Inline>
                  <Checkbox
                    id="select-all"
                    isDisabled={disabled || !filtered.length}
                    isChecked={
                      filtered.length > 0 && filtered.every((p) => selected.includes(p.id))
                    }
                    isIndeterminate={
                      filtered.some((p) => selected.includes(p.id)) &&
                      !filtered.every((p) => selected.includes(p.id))
                    }
                    onChange={(e) => setSelected(e.target.checked ? filtered.map((p) => p.id) : [])}
                  />
                  <Box xcss={hiddenLabel}>
                    <Label labelFor="select-all">Select all matching projects</Label>
                  </Box>
                </Inline>
              ),
            },
            { key: 'project', content: 'Project' },
            { key: 'status', content: 'Status' },
            { key: 'type', content: 'Prompt type' },
            { key: 'action', content: 'Action' },
          ],
        }}
        rows={filtered.map((p) => ({
          key: p.id,
          cells: [
            {
              content: (
                <Inline>
                  <Checkbox
                    id={`select-${p.id}`}
                    isDisabled={disabled}
                    isChecked={selected.includes(p.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, p.id]
                          : selected.filter((id) => id !== p.id),
                      )
                    }
                  />
                  {selectionLabel(`select-${p.id}`, `Select ${p.key}`)}
                </Inline>
              ),
            },
            {
              content: (
                <Stack space="space.050">
                  <Text weight="semibold">{p.name}</Text>
                  <Text>
                    {p.key}
                    {p.id === projectId ? ' · Current project' : ''}
                  </Text>
                </Stack>
              ),
            },
            { content: badge(checking.includes(p.id) ? 'Checking' : projectStatus(p.result)) },
            {
              content: (
                <Text>
                  {p.result?.value?.types.find((t) => t.id === p.result?.value?.state.data.type)
                    ?.name ?? (p.result?.value?.state.data.type ? 'Unavailable' : '—')}
                </Text>
              ),
            },
            {
              content: (
                <Button isDisabled={disabled} onClick={() => void openDetails(p.id)}>
                  View details
                </Button>
              ),
            },
          ],
        }))}
        emptyView={<Text>{busy ? 'Loading projects…' : 'No projects match your filters.'}</Text>}
      />
      {error && <Text>{error}</Text>}
      {picked && !configure && (
        <Modal
          width="large"
          onClose={() => {
            if (!busy) setDetail(undefined);
          }}
        >
          <ModalHeader>
            <ModalTitle>{picked.name}</ModalTitle>
          </ModalHeader>
          <ModalBody>
            <Stack space="space.200">
              <Inline space="space.150" alignBlock="center" shouldWrap>
                <Text color="color.text.subtle">{picked.key}</Text>
                {current?.value && (
                  <Lozenge>
                    {current.value.state.data.type ? 'Configured' : 'Not configured'}
                  </Lozenge>
                )}
              </Inline>
              {current?.value ? (
                <Settings
                  key={picked.id}
                  projectId={picked.id}
                  initialHealth={current.value}
                  configurationAction={
                    <Button
                      isDisabled={disabled || !!error || !!active}
                      onClick={() => void openConfigure([picked.id])}
                    >
                      {current.value.state.data.type ? 'Reconfigure project' : 'Configure project'}
                    </Button>
                  }
                  onBusy={working}
                  onChange={() => {}}
                  onUpdated={async (value) => {
                    setResults((previous) =>
                      previous.map((row) =>
                        row.id === picked.id ? { id: picked.id, value } : row,
                      ),
                    );
                  }}
                />
              ) : (
                <Inline space="space.100" alignBlock="center">
                  {checking.includes(picked.id) && (
                    <Spinner size="small" label="Checking project status" />
                  )}
                  <Text>
                    {checking.includes(picked.id)
                      ? 'Checking project…'
                      : current?.error || 'Checking project…'}
                  </Text>
                </Inline>
              )}
              {active && (
                <Text>
                  {progress.data.cancelRequested
                    ? 'The interrupted batch is being cancelled. Configuration will unlock automatically when its current request finishes.'
                    : 'Another administrator has an unfinished configuration. Close these details to review its progress.'}
                </Text>
              )}
              {error && <Text>{error}</Text>}
            </Stack>
          </ModalBody>
          <ModalFooter>
            <Button isDisabled={busy} onClick={() => setDetail(undefined)}>
              Close
            </Button>
          </ModalFooter>
        </Modal>
      )}
      {configure && (
        <ConfigurationDialog
          projects={projects.filter((p) => configure.includes(p.id))}
          {...(configure.length === 1 &&
          results.find((r) => r.id === configure[0])?.value?.state.data.type
            ? { initialType: results.find((r) => r.id === configure[0])!.value!.state.data.type! }
            : {})}
          onBusy={working}
          onClose={(mutated) => {
            setConfigure(undefined);
            if (mutated) void changed();
          }}
        />
      )}
    </Stack>
  );
}
