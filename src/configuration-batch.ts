import { randomUUID } from 'node:crypto';
import {
  createSettings,
  NotApplied,
  reloadInput,
  screenTypesInput,
  screenWrite,
  sortScreenChanges,
  transient,
  type ScreenChange,
  type SettingsInput,
  type SettingsPorts,
} from './settings';
import { hash, numeric, UserError, type Ports } from './service';
import { finished } from './batch-status';

export interface InventoryProject {
  id: string;
  key: string;
  name: string;
  teamManaged: boolean;
}
export interface BatchData {
  id: string;
  actor: string;
  input: SettingsInput;
  entries: {
    projectId: string;
    fingerprint: string;
    /** The work types reviewed for this space's screens; absent keeps its saved selection. */
    screenTypes?: string[];
    /** A team-managed space's own prompt work type. A run's entries all name one, or none do. */
    type?: string;
    status: 'waiting' | 'done';
    message?: string;
    /** Screen changes already made for this space when one step could not make them all. */
    applied?: number;
    /** The reviewed screen changes a later step still has to make, in reviewed form. */
    remaining?: ScreenChange[];
  }[];
  type?: string;
  schemeEffects?: { id: string; fingerprint: string }[];
  /** The reviewed form of screen changes this run applied to screens other spaces may share. */
  screenEffects?: ScreenChange[];
  index: number;
  status: 'ready' | 'running' | 'attention' | 'complete' | 'stopped';
  started: number;
  message?: string;
  cancelRequested?: boolean;
  inspectProject?: string;
}
export interface BatchRecord {
  revision: number;
  data: BatchData;
}
export interface BatchPorts {
  admin(): Promise<void>;
  get(): Promise<BatchRecord | undefined>;
  cas(revision: number, data: BatchData): Promise<void>;
}
/** `own`: the run's spaces are team-managed and each names its own type, so the run has none. */
function batchInput(input: SettingsInput, own = false): SettingsInput {
  if (input.unlink !== undefined && typeof input.unlink !== 'boolean')
    throw new UserError('Invalid setup removal option.');
  if (input.allowSharedScreens !== undefined && typeof input.allowSharedScreens !== 'boolean')
    throw new UserError('Invalid shared screen approval.');
  // Work types for screens are chosen per space, so they belong to each reviewed space.
  if (input.screenTypes !== undefined)
    throw new UserError('Choose work types for screens per space.');
  const screens = input.allowSharedScreens === true ? { allowSharedScreens: true } : {};
  if (input.unlink) {
    if (
      input.name !== undefined ||
      input.type !== undefined ||
      input.reloadAfterSave !== undefined ||
      input.allowShared
    )
      throw new UserError('Removing setup cannot include configuration changes.');
    return { unlink: true, ...screens };
  }
  // Configure always names its reload choice; keep leaves each space's saved preference.
  const preference = { reloadAfterSave: reloadInput(input.reloadAfterSave) };
  if (own) {
    if (
      input.name !== undefined ||
      input.type !== undefined ||
      input.allowShared ||
      input.allowSharedScreens
    )
      throw new UserError('Team-managed spaces use their own work types and change no schemes.');
    return preference;
  }
  if ((typeof input.name === 'string') === (typeof input.type === 'string'))
    throw new UserError('Create one type or choose one existing type.');
  const shared = {
    ...(input.allowShared === true ? { allowShared: true } : {}),
    ...screens,
  };
  if (input.type !== undefined) return { type: numeric(input.type), ...shared, ...preference };
  const name = input.name!.trim();
  if (!name || name.length > 60 || Array.from(name).some((char) => char.charCodeAt(0) < 32))
    throw new UserError('Choose a work type name of 1–60 characters.');
  return { name, ...shared, ...preference };
}
export function createConfigurationBatch(p: Ports, s: SettingsPorts, w: BatchPorts) {
  const settings = createSettings(p, s);
  const active = (r?: BatchRecord) => !!r && !finished(r.data.status);
  async function current(id: string, revision: number) {
    await w.admin();
    const value = await w.get();
    if (!value || value.data.id !== id || value.revision !== revision)
      throw new UserError(
        'Configuration progress changed. Check saved progress before continuing.',
      );
    return value;
  }
  return {
    async catalog() {
      await w.admin();
      // The work types are not required to observe a saved run or remove setup from an
      // explicitly selected space, so their failure is reported rather than thrown. The space
      // inventory is the one the health view already holds; it is not read again here.
      const [types] = await Promise.allSettled([s.types()]);
      return {
        typesAvailable: types.status === 'fulfilled',
        types:
          types.status === 'fulfilled'
            ? types.value.filter((t) => t.hierarchyLevel === 0 && !t.subtask && !t.scope)
            : [],
      };
    },
    async status() {
      await w.admin();
      return (await w.get()) ?? null;
    },
    /** `only`: a polling view names the batch it is waiting for, so a later batch is never
     * cancelled by an older view's timer. */
    async cancelInterrupted(actor: string, only?: string) {
      await w.admin();
      let r = await w.get();
      if (only !== undefined && r?.data.id !== only)
        return r ? { ...r, cancelledNow: false } : null;
      const id = r?.data.id;
      const cancelling = !!active(r) && r?.data.actor === actor;
      const response = (value?: BatchRecord) =>
        value
          ? {
              ...value,
              cancelledNow:
                cancelling && value.data.id === id && value.data.cancelRequested === true,
            }
          : null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!r || r.data.id !== id || !active(r) || r.data.actor !== actor) return response(r);
        // Keep the lock while the current resolver can still be completing its space.
        const waiting = r.data.status === 'running' && Date.now() - r.data.started < 120_000;
        if (waiting && r.data.cancelRequested) return response(r);
        const uncertain = ['running', 'attention'].includes(r.data.status);
        const project = uncertain ? r.data.entries[r.data.index]?.projectId : undefined;
        const data: BatchData = {
          ...r.data,
          cancelRequested: true,
          status: waiting ? 'running' : 'stopped',
          ...(project ? { inspectProject: project } : {}),
          message: waiting
            ? 'Cancelling the previous configuration. Waiting for the current space to finish.'
            : 'Interrupted configuration cancelled. Completed changes were kept. You can configure spaces again.',
        };
        try {
          await w.cas(r.revision, data);
          return response({ revision: r.revision + 1, data });
        } catch (e) {
          if (attempt === 2) throw e;
          // Reconcile a concurrent completion or lost metadata response. No Jira write
          // is repeated, and a replacement run must never be cancelled by this request.
          r = await w.get();
        }
      }
      return response(r);
    },
    async options(actor: string, projectId: string) {
      await w.admin();
      return settings.options({ accountId: actor, projectId: numeric(projectId) });
    },
    async preview(actor: string, projectId: string, input: SettingsInput) {
      await w.admin();
      const { screenTypes, ...rest } = input;
      const types = screenTypesInput(screenTypes);
      return settings.preview(
        { accountId: actor, projectId: numeric(projectId) },
        { ...batchInput(rest), ...(types ? { screenTypes: types } : {}) },
      );
    },
    async start(
      actor: string,
      input: SettingsInput,
      entries: { projectId: string; fingerprint: string; screenTypes?: string[]; type?: string }[],
      revision: number,
    ) {
      await w.admin();
      const old = await w.get();
      if (active(old))
        throw new UserError(
          'An earlier configuration is unfinished. Check saved progress or resolve it in Space configuration.',
        );
      if ((old?.revision ?? 0) !== revision)
        throw new UserError('Configuration progress changed. Reopen the configuration dialog.');
      if (
        !Array.isArray(entries) ||
        !entries.length ||
        entries.length > 200 ||
        new Set(entries.map((e) => e.projectId)).size !== entries.length ||
        entries.some(
          (e) => !e || typeof e.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(e.fingerprint),
        )
      )
        throw new UserError('Review one to 200 distinct spaces before confirming.');
      // One run configures one kind of space: team-managed spaces each name their own type,
      // company-managed spaces share the run's.
      const typed = entries.filter((e) => e.type !== undefined).length;
      if (typed && typed !== entries.length)
        throw new UserError('Configure company-managed and team-managed spaces separately.');
      const data: BatchData = {
        id: randomUUID(),
        actor,
        input: batchInput(input, typed > 0),
        entries: entries.map((e) => {
          const screenTypes = screenTypesInput(e.screenTypes);
          if (screenTypes && input.unlink)
            throw new UserError('Removing setup cannot include work types for screens.');
          const type = e.type === undefined ? undefined : numeric(e.type);
          if (type && (input.unlink || screenTypes))
            throw new UserError('A team-managed space names only its own prompt work type.');
          return {
            projectId: numeric(e.projectId),
            fingerprint: e.fingerprint,
            ...(screenTypes ? { screenTypes } : {}),
            ...(type ? { type } : {}),
            status: 'waiting' as const,
          };
        }),
        index: 0,
        status: 'ready',
        started: Date.now(),
      };
      await w.cas(revision, data);
      return { revision: revision + 1, data };
    },
    async advance(actor: string, id: string, revision: number) {
      const record = await current(id, revision);
      const d = record.data;
      if (d.actor !== actor)
        throw new UserError(
          'Only the administrator who reviewed this configuration can continue it.',
        );
      if (d.status !== 'ready')
        throw new UserError(
          'Check saved progress. Do not repeat an interrupted configuration step.',
        );
      const entry = d.entries[d.index];
      if (!entry)
        throw new UserError(
          'Saved configuration progress is incomplete. Inspect it before continuing.',
        );
      const c = { accountId: actor, projectId: entry.projectId };
      // For later spaces, compare the newly created type against the original
      // name-based review. Only the known type identity changes; impact and scheme
      // facts must still match. No new spaces are discovered during execution.
      const reload =
        d.input.reloadAfterSave !== undefined ? { reloadAfterSave: d.input.reloadAfterSave } : {};
      // A team-managed space reviewed its own type; a company-managed run shares the run's type.
      const input = entry.type
        ? { type: entry.type, ...reload }
        : {
            ...(d.type
              ? {
                  type: d.type,
                  ...(d.input.allowShared ? { allowShared: true } : {}),
                  ...(d.input.allowSharedScreens ? { allowSharedScreens: true } : {}),
                  ...reload,
                }
              : d.input),
            ...(entry.screenTypes ? { screenTypes: entry.screenTypes } : {}),
          };
      // Nothing is written before the claim below. A refusal here ends the batch, since retrying
      // would repeat it; only a briefly unavailable Jira or storage keeps the batch ready.
      let fresh: Awaited<ReturnType<typeof settings.preview>>;
      let reviewedScreens: typeof fresh.screens;
      try {
        // The saved run's options are checked again, so a run saved in another shape stops here.
        batchInput(
          d.input,
          d.entries.every((e) => e.type !== undefined),
        );
        fresh = await settings.preview(c, input);
        if ('blocked' in fresh && fresh.blocked) throw new UserError(fresh.blocked);
        // The entry's shape must match the space's kind, so a run that names its spaces' own
        // types never reaches a company-managed space's scheme. Removal names no type.
        const teamManaged = 'teamManaged' in fresh && !!fresh.teamManaged;
        if (!d.input.unlink && !!entry.type !== teamManaged)
          throw new UserError(
            teamManaged
              ? 'A team-managed space names its own prompt work type.'
              : 'A company-managed space uses the run’s prompt work type.',
          );
        const facts = Object.fromEntries(
          Object.entries(fresh).filter(([key]) => !['fingerprint', 'screenProjects'].includes(key)),
        );
        // A shared screen this run already changed now shows that change as made: the app's
        // record lists an earlier space, or Summary/Description is already on the create screen.
        // Restore its reviewed form, but only where what remains is a storage-only change, so a
        // Jira write is never applied without its own review. After an earlier write, this space
        // reviewed that same write; after an earlier record-only change, it reviewed its own
        // action against the record revision the earlier space started from.
        const effects = d.screenEffects ?? [];
        const same = (a: ScreenChange, b: ScreenChange) =>
          a.screen.id === b.screen.id && a.field === b.field;
        const screenChanges = fresh.screens.changes.map((ch) => {
          const effect = effects.find((e) => same(e, ch));
          if (!effect || screenWrite(ch)) return ch;
          return screenWrite(effect)
            ? { ...effect, types: ch.types }
            : { ...ch, record: effect.record };
        });
        for (const effect of effects)
          if (
            effect.action === 'require' &&
            effect.screen.id === fresh.screens.promptScreen &&
            !screenChanges.some((ch) => same(ch, effect))
          )
            screenChanges.push(effect);
        reviewedScreens = { ...fresh.screens, changes: sortScreenChanges(screenChanges) };
        facts.screens = reviewedScreens;
        const effect = d.schemeEffects?.find((e) => e.id === fresh.scheme.id);
        if (effect && (effect.fingerprint !== hash(fresh.scheme) || fresh.attach))
          throw new UserError('The updated shared scheme changed.');
        if (entry.remaining) {
          // A later step for the same space: an earlier step of this run already made its type
          // change and part of its screen changes, so what is left must be exactly the reviewed
          // remainder (a change restored from an earlier space's effect was already in place).
          const left = reviewedScreens.changes.filter((ch) =>
            fresh.screens.changes.some((f) => same(f, ch)),
          );
          if (fresh.attach || hash(left) !== hash(entry.remaining))
            throw new UserError('This space changed after review.');
        } else {
          // Only an association committed by this run can explain an attach:true → false change.
          // Keep every other reviewed fact (including all affected spaces) unchanged.
          // The created type's identity is pinned by d.type; its Jira name may be normalized.
          let reviewed =
            d.input.name && d.type
              ? { ...facts, type: undefined, name: d.input.name, typeName: d.input.name }
              : facts;
          if (hash([actor, reviewed]) !== entry.fingerprint && effect)
            reviewed = { ...reviewed, attach: true };
          if (hash([actor, reviewed]) !== entry.fingerprint)
            throw new UserError('This space changed after review.');
        }
        if (fresh.attach && fresh.scheme.projectIds.length > 1 && !d.input.allowShared)
          throw new UserError('Confirm the shared scheme’s affected spaces before applying.');
        if (fresh.screens.changes.some((ch) => ch.impact?.shared) && !d.input.allowSharedScreens)
          throw new UserError('Confirm the shared screens’ affected spaces before applying.');
      } catch (error) {
        if (!(error instanceof UserError) || transient(error)) throw error;
        const stopped: BatchData = {
          ...d,
          entries: d.entries.map((e, i) => (i === d.index ? { ...e, message: error.message } : e)),
          status: 'stopped',
          message: entry.applied
            ? `No further change was made for this space: ${error.message} Its earlier changes and completed spaces remain configured. Review the remaining spaces again.`
            : `Nothing was changed for this space: ${error.message} Completed spaces remain configured. Review the remaining spaces again.`,
        };
        await w.cas(revision, stopped);
        return { revision: revision + 1, data: stopped };
      }
      const running: BatchData = { ...d, status: 'running', started: Date.now() };
      // A team-managed space's only write is its saved setup, so nothing in Jira is in doubt.
      const storageOnly = 'teamManaged' in fresh && !!fresh.teamManaged;
      const uncertain = storageOnly
        ? 'This space’s saved setup may not have been updated; nothing in Jira was changed.'
        : 'This space may be partially configured.';
      const attention: BatchData = {
        ...running,
        status: 'attention',
        message: `${uncertain} Use Space configuration to inspect its saved setup${storageOnly ? '' : ' and Jira state'}. No write was retried.`,
      };
      await w.cas(revision, running);
      async function finish(data: BatchData) {
        const latest = await w.get();
        if (
          !latest ||
          latest.data.id !== id ||
          latest.data.index !== d.index ||
          latest.data.status !== 'running' ||
          (latest.revision !== revision + 1 &&
            !(latest.revision === revision + 2 && latest.data.cancelRequested))
        )
          throw new UserError('Configuration progress changed. No further spaces were configured.');
        const next: BatchData = latest.data.cancelRequested
          ? {
              ...data,
              cancelRequested: true,
              status: 'stopped',
              ...(data.status === 'attention' ? { inspectProject: entry!.projectId } : {}),
              message:
                data.status === 'stopped' && data.message
                  ? data.message
                  : 'Interrupted configuration cancelled. Completed changes were kept. You can configure spaces again.',
            }
          : data;
        await w.cas(latest.revision, next);
        return { revision: latest.revision + 1, data: next };
      }
      let outcome: Awaited<ReturnType<typeof settings.apply>>;
      try {
        // The review above is this step's own, so apply works from it rather than reading again.
        outcome = await settings.apply(c, { ...input, fingerprint: fresh.fingerprint }, fresh);
      } catch (error) {
        if (error instanceof NotApplied) {
          // Jira and the space's configuration are unchanged, so no outcome check is needed.
          const entries = d.entries.map((e, i) =>
            i === d.index ? { ...e, message: error.message } : e,
          );
          return finish(
            error.retryable
              ? {
                  ...running,
                  entries,
                  status: 'ready',
                  started: Date.now(),
                  message: error.message,
                }
              : {
                  ...running,
                  entries,
                  status: 'stopped',
                  message: `${error.message} ${entry.applied ? 'This space’s earlier changes and completed' : 'Completed'} spaces remain configured. Review the remaining spaces again.`,
                },
          );
        }
        // Keep the reason (an uncertain screen change reads differently from an uncertain type
        // change); an unclassified error keeps the generic message.
        if (!(error instanceof UserError)) return finish(attention);
        return finish({
          ...attention,
          entries: d.entries.map((e, i) => (i === d.index ? { ...e, message: error.message } : e)),
          message: `${uncertain} ${error.message}`,
        });
      }
      try {
        const result = await s.get(entry.projectId);
        const left = new Set(outcome.remaining.map((r) => `${r.screen}:${r.field}`));
        const later = (ch: ScreenChange) => left.has(`${ch.screen.id}:${ch.field}`);
        // Removing setup clears the type only with its last screen change.
        const partial = left.size > 0;
        const typed = !!result?.data.type;
        if (!result || result.data.pending || (d.input.unlink ? typed && !partial : !typed))
          throw new UserError('Space configuration requires an outcome check.');
        const remaining = reviewedScreens.changes.filter(later);
        const made = reviewedScreens.changes.filter((ch) => !later(ch));
        const applied = (entry.applied ?? 0) + made.length;
        const entries = d.entries.map((e, i) => {
          if (i !== d.index) return e;
          const rest = {
            projectId: e.projectId,
            fingerprint: e.fingerprint,
            ...(e.screenTypes ? { screenTypes: e.screenTypes } : {}),
            ...(e.type ? { type: e.type } : {}),
            status: e.status,
          };
          return partial
            ? {
                ...rest,
                applied,
                remaining,
                message: `${applied} of ${applied + remaining.length} screen changes made. Continuing with the rest.`,
              }
            : {
                ...rest,
                status: 'done' as const,
                message: d.input.unlink ? 'Setup removed' : 'Configured',
              };
        });
        const next: BatchData = {
          ...d,
          entries,
          // A company-managed space's type becomes the run's type, reused by later spaces; a
          // team-managed run names no type.
          ...(result.data.type && !d.input.unlink && !entry.type ? { type: result.data.type } : {}),
          schemeEffects: fresh.attach
            ? [...(d.schemeEffects ?? []), { id: fresh.scheme.id, fingerprint: hash(fresh.scheme) }]
            : (d.schemeEffects ?? []),
          screenEffects: [
            ...(d.screenEffects ?? []),
            // A screen used only by this space cannot appear in another space's review.
            ...made.filter(
              (ch) =>
                (ch.impact?.shared || !screenWrite(ch)) &&
                !d.screenEffects?.some((e) => e.screen.id === ch.screen.id && e.field === ch.field),
            ),
          ],
          index: partial ? d.index : d.index + 1,
          status: !partial && d.index + 1 === entries.length ? 'complete' : 'ready',
          started: Date.now(),
        };
        return await finish(next);
      } catch {
        // After a successful apply, any failure to confirm or record it needs inspection.
        // If even recording the outcome fails, the durable running claim remains.
        return finish(attention);
      }
    },
    async stop(actor: string, id: string, revision: number, acknowledged: boolean) {
      const r = await current(id, revision);
      if (!active(r)) return r;
      // Releasing another administrator's batch always needs an explicit acknowledgement;
      // an in-flight or uncertain step also needs the two-minute wait.
      if (r.data.actor !== actor && !acknowledged)
        throw new UserError(
          'Acknowledge that this configuration is abandoned before releasing it.',
        );
      if (
        ['running', 'attention'].includes(r.data.status) &&
        (!acknowledged || Date.now() - r.data.started < 120_000)
      )
        throw new UserError(
          'Wait two minutes, inspect the affected space in Space configuration, and acknowledge its outcome before releasing this configuration.',
        );
      const inspectProject = ['running', 'attention'].includes(r.data.status)
        ? r.data.entries[r.data.index]?.projectId
        : undefined;
      const data: BatchData = {
        ...r.data,
        status: 'stopped',
        cancelRequested: true,
        ...(inspectProject ? { inspectProject } : {}),
        message:
          'Configuration released. Completed spaces remain configured. Review unfinished spaces in a new configuration; reuse any type already created.',
      };
      await w.cas(revision, data);
      return { revision: revision + 1, data };
    },
  };
}
