import React, { useCallback, useEffect, useRef, useState } from 'react';
import Button from '@atlaskit/button/new';
import Select from '@atlaskit/select';
import Spinner from '@atlaskit/spinner';
import { call } from './client';
import { usePromptSearch } from './prompt-search';
import { SaveRecovery } from './save-recovery-ui';
import { router } from '@forge/bridge';
import type { OtherSection, Prompt, PromptPage, SaveStatus } from './service';
interface Loaded extends PromptPage {
  otherSection?: OtherSection;
  cleanupOnly: boolean;
  refreshAfterSave: boolean;
  loadWarning?: string;
  ids: string[];
  revision: number;
  fingerprint: string;
}
// Keep pointer actions stable while the in-flow menu is open. Blurring on
// mousedown collapses the menu and moves these buttons before mouseup/click.
function retainSearchFocus(event: React.MouseEvent<HTMLButtonElement>) {
  event.preventDefault();
}
// The pressed button was disabled or removed, which leaves keyboard focus on the page.
function focusLost() {
  const active = document.activeElement;
  return !active || active === document.body || active.matches(':disabled');
}
const focusPicker = () => document.getElementById('agent-prompts')?.focus();
export function Field() {
  const search = usePromptSearch();
  // Nothing to show: with a query that means no match; without one, the space has no prompts.
  const empty = !search.busy && !search.error && !search.items.length;
  const retained = useRef(new Map<string, Prompt>());
  const [data, setData] = useState<Loaded>();
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  // The user chose to replace the description's other Agent Prompts section on the next save.
  const [replacing, setReplacing] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [recoveryStatus, setRecoveryStatus] = useState<SaveStatus>();
  const [loadError, setLoadError] = useState('');
  // The button whose save is running.
  const [saving, setSaving] = useState<'' | 'Save' | 'Sync'>('');
  // Set by a button whose work may disable or remove it; focus returns to the picker afterwards.
  const refocus = useRef(false);
  const resetSearch = search.reset;
  // A load resolves the saved selection, so a saved prompt it leaves out is unavailable now. A
  // draft choice it never read keeps the label it was picked with.
  const remember = useCallback((value: Loaded) => {
    for (const id of value.ids) retained.current.delete(id);
    for (const p of value.prompts) retained.current.set(p.id, p);
  }, []);
  const load = useCallback(async () => {
    setBusy(true);
    setLoadError('');
    try {
      const value = await call<Loaded>('load');
      setData(value);
      resetSearch(value);
      remember(value);
      setIds(value.ids);
      setReplacing(false);
      setMessage('');
      setRecovery(false);
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Could not load prompts. Reopen this field.';
      // Only an unresolved earlier save needs saved-state recovery. Configuration, screen and
      // access problems get a plain retry instead.
      const status = await call<SaveStatus>('save-status').catch(() => undefined);
      if (status?.pending) {
        setRecoveryStatus(status);
        setRecovery(true);
        setMessage(error);
      } else setLoadError(error);
    } finally {
      setBusy(false);
    }
  }, [resetSearch, remember]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!refocus.current || busy || recovery || search.busy) return;
    refocus.current = false;
    if (focusLost()) focusPicker();
  }, [busy, recovery, search.busy]);
  async function recovered() {
    // The recovery panel closes, taking its focused button with it.
    refocus.current = true;
    setBusy(true);
    try {
      const value = await call<Loaded>('load');
      setData(value);
      resetSearch(value);
      remember(value);
      // A recovery check must not silently discard an existing draft; without one, show what is
      // saved now (another tab or user may have changed it).
      if (!data || JSON.stringify(ids) === JSON.stringify(data.ids)) setIds(value.ids);
      setRecovery(false);
      setMessage('Saved state checked. Review your selection before saving.');
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : 'Could not load prompts. Check saved state again.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function saved(refresh: boolean, reload: boolean) {
    setMessage(refresh ? '✓ Synced' : 'Saved.');
    if (reload) {
      try {
        await router.reload();
      } catch {
        setMessage('Saved. Reload the work item to see the updated description.');
      }
    }
  }
  async function save(refresh = false) {
    if (!data || busy || recovery) return;
    const replace = replacing && ids.length ? data.otherSection?.replace : undefined;
    const dirty = JSON.stringify(ids) !== JSON.stringify(data.ids) || !!replace;
    if (refresh ? dirty || !data.ids.length : !dirty) return;
    refocus.current = true;
    setMessage('');
    setBusy(true);
    setSaving(refresh ? 'Sync' : 'Save');
    try {
      const value = await call<Pick<Loaded, 'revision' | 'fingerprint' | 'ids'>>('save', {
        ids,
        revision: data.revision,
        fingerprint: data.fingerprint,
        ...(replace ? { replace } : {}),
      });
      // A replaced section is gone; any other stays until the next load.
      const { otherSection, ...rest } = data;
      setData({ ...rest, ...value, ...(replace || !otherSection ? {} : { otherSection }) });
      setReplacing(false);
      setRecovery(false);
      await saved(refresh, data.refreshAfterSave);
    } catch (e) {
      // Reconcile once with a read; never repeat an uncertain Jira write.
      const error = e instanceof Error ? e.message : 'Could not save prompts.';
      try {
        const current = await call<Loaded>('load');
        setData(current);
        remember(current);
        // The choice to replace holds only while it names the same section.
        if (current.otherSection?.replace !== data.otherSection?.replace) setReplacing(false);
        // Keep a real draft. Without one (every Sync), show the saved selection: keeping the old
        // list would turn it into a draft whose Save reverts someone else's newer save.
        if (!dirty) setIds(current.ids);
        // Keep a typed query (the user is still choosing) but refresh its results.
        if (search.query.trim()) void search.refresh();
        else search.reset(current);
        setRecovery(false);
        // The save's own response was lost, but the saved state matches the selection. That is
        // saved, not a confirmed response, so the automatic reload is skipped.
        if (
          !refresh &&
          current.revision > data.revision &&
          JSON.stringify(current.ids) === JSON.stringify(ids)
        )
          setMessage('Saved. Reload the work item to see the updated description.');
        else setMessage(error);
      } catch {
        // Recovery starts from a fresh check, never from an earlier save's status.
        setRecoveryStatus(undefined);
        setRecovery(true);
        setMessage('Could not verify the save. Use Check saved state before saving again.');
      }
    } finally {
      setBusy(false);
      setSaving('');
    }
  }
  const selectedIds = new Set([...ids, ...(data?.ids ?? [])]);
  for (const p of [...(data?.prompts ?? []), ...search.items])
    if (selectedIds.has(p.id)) retained.current.set(p.id, p);
  for (const id of retained.current.keys()) if (!selectedIds.has(id)) retained.current.delete(id);
  const visible = [
    ...new Map([...search.items, ...retained.current.values()].map((p) => [p.id, p])).values(),
  ];
  const options = data
    ? [
        // A prompt the picker never offers (retired, of a previous type, or any prompt on a
        // prompt work item) stays an option while it is saved or still in the draft.
        ...visible
          .filter(
            (p) =>
              (!data.cleanupOnly && !p.selectedOnly) ||
              data.ids.includes(p.id) ||
              ids.includes(p.id),
          )
          .map((p) => ({ label: `${p.key} — ${p.name}`, value: p.id })),
        ...Array.from(new Set([...data.ids, ...ids]))
          .filter((id) => !visible.some((p) => p.id === id))
          .map((id) => ({ label: `Unavailable prompt (${id})`, value: id })),
      ]
    : [];
  const other = data?.otherSection;
  const replacingNow = replacing && !!other?.replace && ids.length > 0;
  const dirty = !!data && (JSON.stringify(ids) !== JSON.stringify(data.ids) || replacingNow);
  // Adds the other section's prompts to the selection, up to five, and replaces it on save.
  function useOther() {
    if (!other) return;
    for (const p of other.prompts) retained.current.set(p.id, p);
    setIds(
      [...ids, ...other.prompts.map((p) => p.id).filter((id) => !ids.includes(id))].slice(0, 5),
    );
    setReplacing(true);
    setMessage('');
  }
  return (
    <div className="prompt-field">
      {data && (
        <>
          <label htmlFor="agent-prompts">Agent Prompts</label>
          <Select<{ label: string; value: string }, true>
            filterOption={null}
            menuShouldScrollIntoView={false}
            maxMenuHeight={240}
            styles={{ menu: (base) => ({ ...base, position: 'relative' }) }}
            noOptionsMessage={() =>
              data.cleanupOnly
                ? 'All prompts on this work item are selected.'
                : search.busy
                  ? 'Searching…'
                  : search.error ||
                    (search.query.trim()
                      ? 'No matching prompts'
                      : // The menu hides selected options, so suggestions can all be hidden.
                        search.items.length
                        ? 'All suggested prompts are selected. Search to find others.'
                        : 'No available prompts in this space yet.')
            }
            isSearchable={!data.cleanupOnly}
            inputValue={search.query}
            onInputChange={(value, meta) => {
              if (meta.action === 'input-change' && !data.cleanupOnly)
                search.change(value.slice(0, 200));
            }}
            isLoading={search.busy}
            inputId="agent-prompts"
            autoFocus
            isMulti
            isDisabled={busy || !!recovery}
            isOptionDisabled={(option) => ids.length >= 5 && !ids.includes(option.value)}
            // A saved prompt the picker never offers (retired, or of a previous type) stays only
            // while selected: once deselected, only Discard changes brings it back.
            options={options.filter(
              (p) =>
                data.cleanupOnly ||
                ids.includes(p.value) ||
                search.items.some((item) => item.id === p.value && !item.selectedOnly),
            )}
            value={ids.map((id) => options.find((o) => o.value === id)!)}
            onChange={(value) => {
              for (const p of visible)
                if (value.some((v) => v.value === p.id)) retained.current.set(p.id, p);
              setIds(value.map((v) => v.value));
              setMessage('');
            }}
            placeholder="Search by name or key…"
          />
        </>
      )}
      {/* A live region from the first render, so a failed or empty search is announced. */}
      <p role="status">
        {data && !data.cleanupOnly
          ? search.error ||
            (empty
              ? search.query.trim()
                ? 'No matching prompts'
                : 'No available prompts in this space yet.'
              : '')
          : ''}
      </p>
      {data && (
        <>
          {!data.cleanupOnly && (
            <>
              {search.error && (
                <Button
                  onMouseDown={retainSearchFocus}
                  isLoading={search.busy}
                  isDisabled={busy}
                  onClick={() => {
                    refocus.current = true;
                    void (search.nextCursor ? search.more() : search.refresh());
                  }}
                >
                  Retry search
                </Button>
              )}
              {!search.query && !search.error && !empty && (
                <p>Newest prompts. Search to find others.</p>
              )}
              {!!search.query.trim() && search.nextCursor && (
                <Button
                  onMouseDown={retainSearchFocus}
                  isLoading={search.busy}
                  isDisabled={busy || recovery}
                  onClick={() => {
                    refocus.current = true;
                    void search.more();
                  }}
                >
                  Load more
                </Button>
              )}
            </>
          )}
          {data.cleanupOnly && (
            <p>
              This work item is now a prompt. You can remove the prompts it already has, but cannot
              add others.
            </p>
          )}
          <p>
            {ids.length}/5 selected{dirty ? ' · Unsaved changes' : ''}
            {ids.length >= 5 && !data.cleanupOnly ? ' · Remove a prompt to add another' : ''}
          </p>
        </>
      )}
      {data && other && (
        <div className="other-section">
          <p>
            {other.count > 1
              ? `This description has ${other.count} Agent Prompts sections the app didn't save.`
              : "This description has an Agent Prompts section the app didn't save."}
          </p>
          {!other.replace ? (
            <p>{other.count > 1 ? 'Delete them' : 'Delete it'} from the description in Jira.</p>
          ) : (
            <>
              {!!other.prompts.length && (
                <>
                  <p>It lists:</p>
                  <ul>
                    {other.prompts.map((p) => (
                      <li key={p.id}>
                        <a
                          href={`/browse/${p.key}`}
                          onClick={(event) => {
                            event.preventDefault();
                            void router.open(`/browse/${p.key}`);
                          }}
                        >
                          {`${p.key} — ${p.name}`}
                        </a>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {!!other.unavailable.length && (
                <p>{`Not prompts this work item can use: ${other.unavailable.join(', ')}.`}</p>
              )}
              {replacingNow ? (
                <p>Saving replaces that section with the app&apos;s own.</p>
              ) : replacing ? (
                <p>Choose a prompt to replace that section with.</p>
              ) : (
                <>
                  <p>
                    Delete it from the description in Jira, or use its prompts here and save to
                    replace it.
                  </p>
                  <Button onMouseDown={retainSearchFocus} isDisabled={busy} onClick={useOther}>
                    {other.prompts.length ? 'Use its prompts' : 'Replace it when saving'}
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      )}
      {data?.loadWarning && <p>{data.loadWarning}</p>}
      {/* Present from the first render so assistive technology announces each outcome. */}
      <p role="status">{loadError || message}</p>
      {/* Pressing it removes it; the picker or a new Try again starts with focus afterwards. */}
      {loadError && !busy && (
        <Button onMouseDown={retainSearchFocus} autoFocus onClick={() => void load()}>
          Try again
        </Button>
      )}
      {recovery && <SaveRecovery onRecovered={recovered} initialStatus={recoveryStatus} />}
      {busy && <Spinner size="small" label={saving ? 'Saving prompts' : 'Loading prompts'} />}
      {data && !recovery && (
        <div className="prompt-actions">
          {/* Loading, not disabled, while it runs, so the pressed button keeps keyboard focus. */}
          <Button
            onMouseDown={retainSearchFocus}
            appearance="primary"
            isLoading={saving === 'Save'}
            isDisabled={(busy && saving !== 'Save') || !dirty || ids.length > 5}
            onClick={() => void save()}
          >
            Save
          </Button>
          <Button
            onMouseDown={retainSearchFocus}
            isLoading={saving === 'Sync'}
            isDisabled={
              (busy && saving !== 'Sync') || dirty || !data.ids.length || data.cleanupOnly
            }
            onClick={() => void save(true)}
          >
            Sync
          </Button>
          {dirty && (
            <Button
              onMouseDown={retainSearchFocus}
              isDisabled={busy}
              onClick={() => {
                focusPicker();
                setIds(data.ids);
                setReplacing(false);
                setMessage('');
              }}
            >
              Discard changes
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
