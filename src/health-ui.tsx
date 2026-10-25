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
  LoadingButton,
  Lozenge,
  SectionMessage,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  Spinner,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Textfield,
} from '@forge/react';
import { call } from './client';
import { createLatch } from './shared/latch.mjs';
import { readSpaces } from './space-reads';
import { finished } from './batch-status';
import { Settings, type Health } from './settings-ui';
import { appearance, configurationStatus, type Status } from './space-status';
import { ConfigurationDialog } from './configuration-dialog';
import { runKeys } from './run-keys';
import type { InventoryProject, BatchRecord } from './configuration-batch';
type Result = { id: string; value?: Health; error?: string };
/** A listed space. A stand-in added before its first check has no known style yet. */
type Listed = Omit<InventoryProject, 'teamManaged'> & { teamManaged?: boolean };
function projectStatus(row?: Result): Status {
  return !row
    ? 'Not checked'
    : row.error
      ? 'Check failed'
      : !row.value
        ? 'Not configured'
        : configurationStatus(row.value);
}
const hiddenLabel = xcss({ width: '1px', height: '1px', overflow: 'hidden' });
const selectionLabel = (id: string, text: string) => (
  <Box xcss={hiddenLabel}>
    <Label labelFor={id}>{text}</Label>
  </Box>
);
// Cancellation notification metadata belongs to the response, not stored progress.
const priority = ['Needs attention', 'Check failed', 'Not configured', 'Healthy', 'Not checked'];
type Kind = 'company' | 'team';
const kindName = { company: 'company-managed', team: 'team-managed' };
/** The team-managed tab's layout column: the work types whose layout has the field. */
function layoutCell(value?: Health) {
  if (!value || !('layouts' in value)) return '—';
  const on = value.layouts.filter((l) => l.present).map((l) => l.name);
  return on.length
    ? on.join(', ')
    : value.layouts.some((l) => l.present === undefined)
      ? 'Not known'
      : 'None';
}
export function HealthProjects({ projectId }: { projectId?: string }) {
  const [projects, setProjects] = useState<Listed[]>([]),
    [results, setResults] = useState<Result[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState('All spaces'),
    [kind, setKind] = useState<Kind>(),
    [page, setPage] = useState(1),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [incomplete, setIncomplete] = useState(false),
    [unlicensed, setUnlicensed] = useState(false),
    // How many spaces the inventory listed, without spaces this view added to keep them reachable.
    [listed, setListed] = useState(0),
    [inventoryFailed, setInventoryFailed] = useState(false),
    [detail, setDetail] = useState<string>(),
    [configure, setConfigure] = useState<string[]>(),
    // The button whose check or dialog is under way.
    [pressed, setPressed] = useState(''),
    [progress, setProgress] = useState<BatchRecord | null>(null),
    [checked, setChecked] = useState(''),
    [checking, setChecking] = useState<string[]>([]),
    [completed, setCompleted] = useState(0);
  const mounted = useRef(true);
  // UI Kit can deliver a second click before the disabled tree reaches the host.
  const latch = useRef(createLatch()).current;
  const working = (v: boolean) => {
    setBusy(v);
  };
  async function load() {
    working(true);
    setError('');
    try {
      const inventory = await call<{
        projects: InventoryProject[];
        incomplete: boolean;
        licensed: boolean;
      }>('settings-projects', {});
      if (!mounted.current) return;
      // The view opens on the kind of the space it was opened from and stays there until the
      // administrator picks the other tab, so a check never moves the view under a selection.
      setKind(inventory.projects.find((p) => p.id === projectId)?.teamManaged ? 'team' : 'company');
      // A partial inventory can miss the space this page was opened from; keep it reachable.
      setProjects(
        projectId && !inventory.projects.some((p) => p.id === projectId)
          ? [...inventory.projects, { id: projectId, key: projectId, name: 'Current space' }]
          : inventory.projects,
      );
      setIncomplete(inventory.incomplete);
      setUnlicensed(inventory.licensed === false);
      setListed(inventory.projects.length);
      setInventoryFailed(false);
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof Error ? e.message : 'Spaces could not be loaded.');
        setInventoryFailed(true);
        // Inventory failure must not remove the current space's explicit recovery path.
        if (projectId) setProjects([{ id: projectId, key: projectId, name: 'Current space' }]);
      }
    } finally {
      await refreshProgress();
      if (mounted.current) working(false);
    }
  }
  async function refreshProgress() {
    try {
      const value = await call<BatchRecord | null>('configuration-status', {});
      if (mounted.current) setProgress(value);
    } catch {
      if (mounted.current)
        // Keep the inventory error (especially an administration denial) visible when the
        // follow-up progress read fails too. Either failure still disables configuration.
        setError(
          (previous) =>
            previous ||
            'Saved configuration progress could not be checked. Reload this page before configuring spaces.',
        );
    }
  }
  /** Checks these spaces (at most three reads at a time) and merges each result over any earlier
   * one for the same space. `counted` drives the "Checking n of m" progress line. A space whose
   * check shows it is of the other kind than the view shows (a stand-in's kind is not known until
   * checked) leaves the selection, since one dialog configures one kind; returns those spaces. */
  async function checkHealth(ids: string[], { counted }: { counted: boolean }) {
    const read = await readSpaces(
      ids,
      (projectId) => call<Health>('settings-health', { projectId }),
      (updates) => {
        if (!mounted.current) return;
        if (counted) setCompleted(updates.length);
        setResults((previous) => [
          ...previous.filter((row) => !updates.some((update) => update.id === row.id)),
          ...updates,
        ]);
      },
    );
    const moved = read.flatMap((r) =>
      r.value && !!r.value.project.teamManaged !== (shown === 'team') ? [r.id] : [],
    );
    if (moved.length && mounted.current)
      setSelected((previous) => previous.filter((id) => !moved.includes(id)));
    return { read, moved };
  }
  /** Says that `count` checked spaces of the other kind left the selection. */
  const leftOut = (count: number) =>
    `${count === 1 ? '1 space is' : `${count} spaces are`} ${kindName[other]} and ${count === 1 ? 'was' : 'were'} taken out of the selection: ${kindName.company} and ${kindName.team} spaces are configured separately.`;
  async function openDetails(id: string) {
    return latch.run(async () => {
      if (busy) return;
      setPressed(`details-${id}`);
      setDetail(id);
      if (results.some((row) => row.id === id && row.value)) return;
      working(true);
      setChecking([id]);
      try {
        const { moved } = await checkHealth([id], { counted: false });
        if (moved.length && mounted.current) setChecked(leftOut(moved.length));
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
      if (busy || !chosen.length) return;
      const ids = [...chosen];
      setPressed('check');
      working(true);
      setChecking(ids);
      setCompleted(0);
      try {
        const { moved } = await checkHealth(ids, { counted: true });
        if (mounted.current)
          setChecked(
            `Last checked ${ids.length} selected ${ids.length === 1 ? 'space' : 'spaces'} at ${new Date().toLocaleTimeString()}${moved.length ? `. ${leftOut(moved.length)}` : ''}`,
          );
      } finally {
        if (mounted.current) {
          setChecking([]);
          setPressed('');
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Load once per configuration visit; space selection and filtering are local.
  }, []);
  // A check knows the space's style even when the inventory row is a stand-in.
  const rows = projects.map((p) => {
    const result = results.find((r) => r.id === p.id);
    return { ...p, teamManaged: result?.value?.project.teamManaged ?? p.teamManaged, result };
  });
  // Company- and team-managed spaces are set up differently, so each kind has its own tab and is
  // configured on its own. A stand-in whose kind is not known yet is listed as company-managed.
  const teamCount = rows.filter((p) => p.teamManaged).length;
  const split = teamCount > 0 && teamCount < rows.length;
  const shown: Kind = split ? (kind ?? 'company') : teamCount ? 'team' : 'company';
  const other: Kind = shown === 'team' ? 'company' : 'team';
  const kindRows = rows.filter((p) => !!p.teamManaged === (shown === 'team'));
  // Only the shown kind's selected spaces are counted, checked and configured.
  const chosen = selected.filter((id) => kindRows.some((p) => p.id === id));
  const matches = (p: { key: string; name: string }) =>
    `${p.key} ${p.name}`.toLowerCase().includes(query.toLowerCase());
  const elsewhere = query.trim()
    ? rows.filter((p) => !!p.teamManaged !== (shown === 'team') && matches(p)).length
    : 0;
  const showKind = (next: Kind) => {
    setKind(next);
    setSelected([]);
    setFilter('All spaces');
    setPage(1);
  };
  const filtered = kindRows.filter(
    (p) =>
      matches(p) &&
      (filter === 'All spaces' ||
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
    active = progress && !finished(progress.data.status);
  const picked = projects.find((p) => p.id === detail);
  const disabled = busy || !!configure;
  // The button that started a check or opened a dialog stays focusable meanwhile, so focus
  // returns to it when the dialog closes; a disabled button drops focus to the start of the page.
  const keeps = (key: string) => pressed === key && (busy || !!configure || detail !== undefined);
  const loading = (key: string) => pressed === key && busy && !configure;
  async function openConfigure(ids: string[], key: string) {
    return latch.run(async () => {
      if (busy) return;
      setPressed(key);
      const unchecked = ids.filter((id) => !results.some((row) => row.id === id && row.value));
      if (!unchecked.length) {
        setConfigure(ids);
        return;
      }
      working(true);
      setChecking(unchecked);
      setCompleted(0);
      let opened = false;
      try {
        // A space whose kind was unknown can turn out to be the other kind; the check takes it
        // out of the selection, and the administrator reviews what is left before configuring.
        const { moved } = await checkHealth(unchecked, { counted: true });
        if (!mounted.current) return;
        if (moved.length) {
          setChecked(`${leftOut(moved.length)} Review the selection, then configure again.`);
          return;
        }
        setConfigure(ids);
        opened = true;
      } finally {
        if (mounted.current) {
          setChecking([]);
          if (!opened) setPressed('');
          working(false);
        }
      }
    });
  }
  const configureSelected = () => openConfigure([...chosen], 'configure');
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
        // A failed check belongs to this space (its details show it and reopening retries); it
        // never locks configuration of other spaces.
        if (mounted.current) {
          setProjects((previous) =>
            previous.some((p) => p.id === id)
              ? previous
              : [...previous, { id, key: id, name: `Space ID ${id}` }],
          );
          setResults((previous) => [
            ...previous.filter((row) => row.id !== id),
            { id, error: e instanceof Error ? e.message : 'Space could not be checked.' },
          ]);
          setDetail(id);
        }
      } finally {
        if (mounted.current) working(false);
      }
    });
  }
  async function changed() {
    // Shared scheme changes can affect unselected spaces too. Invalidate results,
    // but leave new health requests under explicit Check selected or View details actions.
    setResults([]);
    setChecked('Configuration changed. Select spaces or open details to check again.');
    setDetail(undefined);
    setSelected([]);
    working(true);
    await refreshProgress();
    if (mounted.current) working(false);
  }
  const badge = (status: keyof typeof appearance) => (
    <Lozenge appearance={appearance[status]}>{status}</Lozenge>
  );
  return (
    <Stack space="space.200">
      <Heading as="h2">Space configuration</Heading>
      {unlicensed && (
        <SectionMessage appearance="warning" title="No active subscription">
          <Text>
            Agent Prompts for Jira has no active subscription on this site, so prompts can’t be
            saved or synced and spaces can’t be configured. Removing setup and recovering
            interrupted changes stay available. A site administrator can subscribe in Atlassian
            Administration.
          </Text>
        </SectionMessage>
      )}
      {active ? (
        <SectionMessage appearance="warning" title="Configuration in progress">
          <Text>
            {runKeys.get(progress.data.id)
              ? 'This page’s configuration is unfinished. Review its progress to continue it.'
              : 'A configuration started on another page is unfinished. Review its progress, and release it if it was abandoned, before starting a new one.'}
          </Text>
          <Button
            isDisabled={disabled && !keeps('review')}
            onClick={() => {
              if (disabled) return;
              setPressed('review');
              setConfigure(progress.data.entries.map((e) => e.projectId));
            }}
          >
            Review saved configuration
          </Button>
        </SectionMessage>
      ) : progress?.data.inspectProject ? (
        <SectionMessage appearance="warning" title="Space needs an outcome check">
          <Text>
            One space may have an incomplete change. Check its outcome before configuring it again.
          </Text>
          <Button
            isDisabled={disabled && !keeps('inspect')}
            onClick={() => {
              const id = progress.data.inspectProject;
              if (disabled || !id) return;
              setPressed('inspect');
              void checkAffected(id);
            }}
          >
            Check affected space
          </Button>
        </SectionMessage>
      ) : null}
      {split && (
        <Tabs
          id="space-kind"
          selected={shown === 'team' ? 1 : 0}
          onChange={(index) => {
            if (!disabled) showKind(index === 1 ? 'team' : 'company');
          }}
        >
          <TabList>
            <Tab>{`Company-managed (${rows.length - teamCount})`}</Tab>
            <Tab>{`Team-managed (${teamCount})`}</Tab>
          </TabList>
          <TabPanel>
            <Box paddingBlockStart="space.100">
              <Text color="color.text.subtle">
                The app adds the prompt work type and the Agent Prompts field to these spaces’
                schemes and screens for you.
              </Text>
            </Box>
          </TabPanel>
          <TabPanel>
            <Box paddingBlockStart="space.100">
              <Text color="color.text.subtle">
                You set these spaces up by hand in Jira. The app only records which of each space’s
                work types holds prompts.
              </Text>
            </Box>
          </TabPanel>
        </Tabs>
      )}
      <Inline space="space.100" shouldWrap>
        {['All spaces', 'Not checked', 'Needs attention', 'Not configured', 'Healthy'].map(
          (label) => (
            <Button
              key={label}
              isSelected={filter === label}
              isDisabled={disabled}
              onClick={() => {
                setFilter(label);
                setSelected([]);
                setPage(1);
              }}
            >
              {label} (
              {label === 'All spaces'
                ? kindRows.length
                : kindRows.filter((p) =>
                    label === 'Needs attention'
                      ? ['Needs attention', 'Check failed'].includes(projectStatus(p.result))
                      : projectStatus(p.result) === label,
                  ).length}
              )
            </Button>
          ),
        )}
      </Inline>
      <Label labelFor="project-search">Find a space</Label>
      <Textfield
        id="project-search"
        placeholder="Find a space by name or key"
        value={query}
        isDisabled={disabled}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected([]);
          setPage(1);
        }}
      />
      {split && elsewhere > 0 && (
        <Inline space="space.050" alignBlock="center" shouldWrap>
          <Text color="color.text.subtle">
            {`${elsewhere} ${elsewhere === 1 ? 'match' : 'matches'} in ${kindName[other]} spaces.`}
          </Text>
          <Button appearance="subtle" isDisabled={disabled} onClick={() => showKind(other)}>
            {`Show ${kindName[other]}`}
          </Button>
        </Inline>
      )}
      <Box role="status">
        <Inline space="space.100" alignBlock="center">
          {busy && !detail && !configure && (
            <Spinner size="small" label="Loading space configuration" />
          )}
          <Text color="color.text.subtle">
            {checking.length
              ? `Checking ${completed} of ${checking.length} selected spaces…`
              : busy
                ? 'Loading space configuration…'
                : checked ||
                  'Select spaces, then choose Check selected to check their configuration.'}
          </Text>
        </Inline>
      </Box>
      {incomplete && (
        <Text>
          Showing the first {listed} supported spaces. Selection applies only to this loaded
          inventory.
        </Text>
      )}
      <Inline space="space.100" shouldWrap>
        <Text>{chosen.length} selected</Text>
        <LoadingButton
          appearance="primary"
          isLoading={loading('check')}
          isDisabled={(disabled && !keeps('check')) || !chosen.length}
          onClick={() => void checkSelected()}
        >
          Check selected
        </LoadingButton>
        <LoadingButton
          isLoading={loading('configure')}
          isDisabled={(disabled && !keeps('configure')) || !chosen.length || !!error || !!active}
          onClick={() => void configureSelected()}
        >
          Configure selected
        </LoadingButton>
        <Button isDisabled={disabled || !chosen.length} onClick={() => setSelected([])}>
          Clear selection
        </Button>
      </Inline>
      <DynamicTable
        label="Space configuration"
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
                    <Label labelFor="select-all">Select all matching spaces</Label>
                  </Box>
                </Inline>
              ),
            },
            { key: 'project', content: 'Space' },
            { key: 'status', content: 'Status' },
            { key: 'type', content: 'Prompt type' },
            ...(shown === 'team' ? [{ key: 'layouts', content: 'Agent Prompts on layouts' }] : []),
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
                    {p.teamManaged && !split ? ' · Team-managed' : ''}
                    {p.id === projectId ? ' · Current space' : ''}
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
            ...(shown === 'team' ? [{ content: <Text>{layoutCell(p.result?.value)}</Text> }] : []),
            {
              content: (
                <Button
                  isDisabled={disabled && !keeps(`details-${p.id}`)}
                  onClick={() => void openDetails(p.id)}
                >
                  View details
                </Button>
              ),
            },
          ],
        }))}
        emptyView={<Text>{busy ? 'Loading spaces…' : 'No spaces match your filters.'}</Text>}
      />
      {error && <Text>{error}</Text>}
      {picked && !configure && (
        <Modal
          width="large"
          onClose={() => {
            if (busy) return;
            setDetail(undefined);
            setPressed('');
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
                      isDisabled={(disabled && !keeps('configure-space')) || !!error || !!active}
                      onClick={() => void openConfigure([picked.id], 'configure-space')}
                    >
                      {current.value.state.data.type ? 'Reconfigure space' : 'Configure space'}
                    </Button>
                  }
                  onBusy={working}
                  onUpdated={async (value) => {
                    setResults((previous) =>
                      previous.map((row) =>
                        row.id === picked.id ? { id: picked.id, value } : row,
                      ),
                    );
                  }}
                  onStale={(message) => {
                    // Reopening the details checks the space again.
                    setResults((previous) =>
                      previous.map((row) =>
                        row.id === picked.id ? { id: picked.id, error: message } : row,
                      ),
                    );
                  }}
                />
              ) : (
                <Inline space="space.100" alignBlock="center">
                  {checking.includes(picked.id) && (
                    <Spinner size="small" label="Checking space status" />
                  )}
                  <Text>
                    {checking.includes(picked.id)
                      ? 'Checking space…'
                      : current?.error || 'Checking space…'}
                  </Text>
                </Inline>
              )}
              {active && (
                <Text>
                  {runKeys.get(progress.data.id)
                    ? 'This page’s configuration is unfinished. Close these details to review its progress.'
                    : 'A configuration started on another page is unfinished. Close these details to review its progress.'}
                </Text>
              )}
              {error && <Text>{error}</Text>}
            </Stack>
          </ModalBody>
          <ModalFooter>
            <Button
              isDisabled={busy}
              onClick={() => {
                setDetail(undefined);
                setPressed('');
              }}
            >
              Close
            </Button>
          </ModalFooter>
        </Modal>
      )}
      {configure && (
        <ConfigurationDialog
          projects={rows
            .filter((p) => configure.includes(p.id))
            .map((p) => ({ id: p.id, key: p.key, name: p.name, teamManaged: !!p.teamManaged }))}
          inventory={{ projects, incomplete: incomplete || inventoryFailed }}
          layouts={Object.fromEntries(
            results.flatMap((r) =>
              r.value && 'layouts' in r.value ? [[r.id, r.value.layouts]] : [],
            ),
          )}
          {...(configure.length === 1 &&
          !rows.find((p) => p.id === configure[0])?.teamManaged &&
          results.find((r) => r.id === configure[0])?.value?.state.data.type
            ? { initialType: results.find((r) => r.id === configure[0])!.value!.state.data.type! }
            : {})}
          onBusy={working}
          onClose={(mutated) => {
            setConfigure(undefined);
            setPressed('');
            if (mutated) void changed();
          }}
        />
      )}
    </Stack>
  );
}
