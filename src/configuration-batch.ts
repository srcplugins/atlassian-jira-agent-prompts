import { randomUUID } from 'node:crypto';
import {
  createSettings,
  NotApplied,
  transient,
  type SettingsInput,
  type SettingsPorts,
} from './settings';
import { hash, numeric, UserError, type Ports } from './service';
import { finished } from './batch-status';

export interface InventoryProject {
  id: string;
  key: string;
  name: string;
}
export interface BatchData {
  id: string;
  actor: string;
  input: SettingsInput;
  entries: {
    projectId: string;
    fingerprint: string;
    status: 'waiting' | 'done';
    message?: string;
  }[];
  type?: string;
  schemeEffects?: { id: string; fingerprint: string }[];
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
  projects(): Promise<{ projects: InventoryProject[]; incomplete: boolean }>;
  get(): Promise<BatchRecord | undefined>;
  cas(revision: number, data: BatchData): Promise<void>;
}
function batchInput(input: SettingsInput): SettingsInput {
  if (input.unlink !== undefined && typeof input.unlink !== 'boolean')
    throw new UserError('Invalid setup removal option.');
  if (input.refreshAfterSave !== undefined && typeof input.refreshAfterSave !== 'boolean')
    throw new UserError('Invalid display preference.');
  if (input.unlink) {
    if (
      input.name !== undefined ||
      input.type !== undefined ||
      input.refreshAfterSave !== undefined ||
      input.allowShared
    )
      throw new UserError('Removing setup cannot include configuration changes.');
    return { unlink: true };
  }
  const preference =
    input.refreshAfterSave !== undefined ? { refreshAfterSave: input.refreshAfterSave } : {};
  if ((typeof input.name === 'string') === (typeof input.type === 'string'))
    throw new UserError('Create one type or choose one existing type.');
  const shared = input.allowShared === true ? { allowShared: true } : {};
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
      // Neither diagnostic inventory is required to observe a saved run or
      // remove setup from an explicitly selected space. Keep their failures separate.
      const [projects, types] = await Promise.allSettled([w.projects(), s.types()]);
      return {
        ...(projects.status === 'fulfilled'
          ? projects.value
          : { projects: [] as InventoryProject[], incomplete: true }),
        inventoryAvailable: projects.status === 'fulfilled',
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
    async preview(actor: string, projectId: string, input: SettingsInput) {
      await w.admin();
      return settings.preview(
        { accountId: actor, projectId: numeric(projectId) },
        batchInput(input),
      );
    },
    async start(
      actor: string,
      input: SettingsInput,
      entries: { projectId: string; fingerprint: string }[],
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
      const data: BatchData = {
        id: randomUUID(),
        actor,
        input: batchInput(input),
        entries: entries.map((e) => ({
          projectId: numeric(e.projectId),
          fingerprint: e.fingerprint,
          status: 'waiting',
        })),
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
      const input = d.type
        ? {
            type: d.type,
            ...(d.input.allowShared ? { allowShared: true } : {}),
            ...(d.input.refreshAfterSave !== undefined
              ? { refreshAfterSave: d.input.refreshAfterSave }
              : {}),
          }
        : d.input;
      // Nothing is written before the claim below. A refusal here ends the batch, since retrying
      // would repeat it; only a briefly unavailable Jira or storage keeps the batch ready.
      let fresh: Awaited<ReturnType<typeof settings.preview>>;
      try {
        fresh = await settings.preview(c, input);
        const facts = Object.fromEntries(
          Object.entries(fresh).filter(([key]) => key !== 'fingerprint'),
        );
        const effect = d.schemeEffects?.find((e) => e.id === fresh.scheme.id);
        if (effect && (effect.fingerprint !== hash(fresh.scheme) || fresh.attach))
          throw new UserError('The updated shared scheme changed.');
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
        if (fresh.attach && fresh.scheme.projectIds.length > 1 && !d.input.allowShared)
          throw new UserError('Confirm the shared scheme’s affected spaces before applying.');
      } catch (error) {
        if (!(error instanceof UserError) || transient(error)) throw error;
        const stopped: BatchData = {
          ...d,
          entries: d.entries.map((e, i) => (i === d.index ? { ...e, message: error.message } : e)),
          status: 'stopped',
          message: `Nothing was changed for this space: ${error.message} Completed spaces remain configured. Review the remaining spaces again.`,
        };
        await w.cas(revision, stopped);
        return { revision: revision + 1, data: stopped };
      }
      const running: BatchData = { ...d, status: 'running', started: Date.now() };
      const attention: BatchData = {
        ...running,
        status: 'attention',
        message:
          'This space may be partially configured. Use Space configuration to inspect its saved setup and Jira state. No write was retried.',
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
      try {
        await settings.apply(c, { ...input, fingerprint: fresh.fingerprint });
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
                  message: `${error.message} Completed spaces remain configured. Review the remaining spaces again.`,
                },
          );
        }
        return finish(attention);
      }
      try {
        const result = await s.get(entry.projectId);
        if (
          !result ||
          result.data.pending ||
          (d.input.unlink ? !!result.data.type : !result.data.type)
        )
          throw new UserError('Space configuration requires an outcome check.');
        const entries = d.entries.map((e, i) =>
          i === d.index
            ? {
                ...e,
                status: 'done' as const,
                message: d.input.unlink ? 'Setup removed' : 'Configured',
              }
            : e,
        );
        const next: BatchData = {
          ...d,
          entries,
          ...(result.data.type ? { type: result.data.type } : {}),
          schemeEffects: fresh.attach
            ? [...(d.schemeEffects ?? []), { id: fresh.scheme.id, fingerprint: hash(fresh.scheme) }]
            : (d.schemeEffects ?? []),
          index: d.index + 1,
          status: d.index + 1 === entries.length ? 'complete' : 'ready',
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
