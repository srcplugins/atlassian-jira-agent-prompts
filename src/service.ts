import { randomUUID } from 'node:crypto';
import { sourceContent } from './prompt-text';
import { snapshotContent, DescriptionError, synchronizeDescription, hash } from './description';
export { hash };
import { JiraHttpError, UserError, requireSoftwareSpace } from './shared/jira.mjs';
import { sectionLocalId } from './names';
export { UserError };
/** The request never got an HTTP response from Jira. */
export class JiraUnavailable extends UserError {}
/** Forge app storage failed to answer a read. Like JiraUnavailable, an outage, not a defect. */
export class StorageUnavailable extends UserError {}
/** Jira documented that it did not apply this write (see isDefinitiveRejection). */
export class JiraRejected extends UserError {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export function numeric(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value))
    throw new UserError('Invalid Jira identifier.');
  return value;
}
/** Runs `fn` over the items with at most four requests in flight, keeping the order. */
export async function limited<T, R>(items: T[], fn: (item: T) => Promise<R>) {
  const out: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
  return out;
}
export interface Context {
  accountId: string;
  projectId: string;
  issueId?: string;
}
export interface Prompt {
  id: string;
  key: string;
  name: string;
  selectedOnly?: boolean;
}
export interface Issue {
  id: string;
  key: string;
  fields: {
    project: { id: string };
    issuetype: { id: string };
    summary: string;
    description: unknown;
    updated: string;
    status?: { statusCategory?: { key?: unknown } };
    /** The work item's issue security level, when it has one. */
    security?: unknown;
    [key: string]: unknown;
  };
}
/** The saved prompts. */
interface Selection {
  ids: string[];
  /** Their keys when they were saved, so a prompt Jira can no longer find is named by its key. */
  keys?: string[];
  /** Those that had an issue security level when they were last copied. Jira answers "not found"
   * both for a deleted work item and for one the user may not see; for these, it means the user
   * may not see it, so a save stops instead of dropping it. */
  secured?: string[];
}
interface State extends Selection {
  pending?: Receipt & { attemptId: string; phase: 'prepared' | 'submitted'; started: number };
}
/** What a save is about to write, recorded before it is sent so recovery can compare. */
type Receipt = Selection & {
  before: string;
  after: string;
} & (
    | {
        /** Only the Agent Prompts field was written; hashes cover the field alone. */
        scope: 'field';
      }
    | {
        scope?: undefined;
        /** The exact field value sent, and the field's hash before the save. */
        keys: string[];
        beforeField: string;
      }
  );
export interface Stored {
  revision: number;
  data: State;
}
export interface PromptPage {
  prompts: Prompt[];
  incomplete: boolean;
  nextCursor?: string;
  searchError?: string;
}
interface PromptQuery {
  query?: string;
  cursor?: string;
  limit: 10 | 20;
}
function promptQuery(
  input: { query?: unknown; cursor?: unknown } = {},
  limit: PromptQuery['limit'],
): PromptQuery {
  if (
    (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 200)) ||
    (input.cursor !== undefined &&
      (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 8192))
  )
    throw new UserError('Invalid prompt search. Use up to 200 characters.');
  const query = (input.query as string | undefined)?.trim() ?? '';
  return {
    query,
    ...(input.cursor ? { cursor: input.cursor as string } : {}),
    limit,
  };
}
export interface Ports {
  refreshAfterSave(project: string): Promise<boolean>;
  retainedTypes(project: string): Promise<string[]>;
  config(project: string): Promise<string | undefined>;
  project(id: string): Promise<{
    id: string;
    key: string;
    projectTypeKey: string;
    style: string;
    issueTypes: { id: string; name: string; subtask: boolean; hierarchyLevel?: number }[];
  }>;
  allowed(project: string, permission: 'ADMINISTER' | 'EDIT_ISSUES', issue?: string): Promise<void>;
  search(project: string, type: string, input: PromptQuery): Promise<PromptPage>;
  issue(id: string, field?: string): Promise<Issue>;
  field(): Promise<string>;
  update(id: string, fields: Record<string, unknown>): Promise<void>;
  get(id: string): Promise<Stored | undefined>;
  cas(id: string, revision: number, data: State): Promise<void>;
}
const targetHash = (issue: Issue, field: string) =>
  hash([issue.fields.description, issue.fields[field] ?? [], issue.fields.updated]);
const contentHash = (issue: Issue, field: string) =>
  hash([issue.fields.description, issue.fields[field] ?? []]);
const fieldHash = (issue: Issue, field: string) => hash(['field', issue.fields[field] ?? []]);
type Pending = NonNullable<State['pending']>;
/** The hash a receipt's before/after values were computed with. */
const receiptHash = (issue: Issue, field: string, pending: Receipt) =>
  pending.scope === 'field' ? fieldHash(issue, field) : contentHash(issue, field);
const recoveryDelay = 120_000;
function selection({ ids, keys, secured }: Selection): State {
  return { ids, ...(keys ? { keys } : {}), ...(secured?.length ? { secured } : {}) };
}
const withoutPending = selection;
/** The save landed: Jira's field holds exactly the prompt keys it sent, which differ from the
 * field before it. One PUT writes the field and the description together, so the description
 * landed with it, in whatever form Jira stores it; the next Sync rewrites the section anyway. */
function landed(issue: Issue, field: string, pending: Pending) {
  if (pending.phase !== 'submitted') return false;
  const [before, after] =
    pending.scope === 'field'
      ? [pending.before, pending.after]
      : [pending.beforeField, hash(['field', pending.keys])];
  return before !== after && fieldHash(issue, field) === after;
}
const notFound = (error: unknown) => error instanceof JiraHttpError && error.status === 404;
/** "PLS-1", "PLS-1 and PLS-2", "PLS-1, PLS-2 and PLS-3". */
function list(labels: string[]) {
  return labels.length < 2
    ? (labels[0] ?? '')
    : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}
export interface SaveStatus {
  pending: boolean;
  revision?: number;
  fingerprint?: string;
  keys?: string[];
  administrator?: boolean;
  waitSeconds?: number;
}
interface RecoveryInput {
  revision: number;
  fingerprint: string;
  acknowledged: boolean;
}
/** Save sends the chosen `ids` and the `revision` they were chosen at; Sync sends `sync: true`. */
interface SaveInput {
  sync?: boolean;
  ids?: string[];
  revision?: number;
}
export function createService(p: Ports) {
  async function scope(c: Context) {
    numeric(c.projectId);
    const type = await p.config(c.projectId);
    if (!type)
      throw new UserError(
        'This space is not set up for Agent Prompts. Ask a Jira administrator to set it up in Space settings.',
      );
    return numeric(type);
  }
  async function target(c: Context, field: string) {
    if (!c.issueId) throw new UserError('Open Agent Prompts on an existing work item.');
    const issue = await p.issue(numeric(c.issueId), field);
    if (issue.id !== c.issueId || issue.fields.project.id !== c.projectId)
      throw new UserError('Work item context changed. Reopen the field.');
    return issue;
  }
  async function state(issue: Issue, field: string, allowPending = false) {
    let stored = (await p.get(issue.id)) ?? { revision: 0, data: { ids: [] } };
    if (stored.data.pending?.phase === 'prepared') {
      // A sender must win another CAS before issuing its PUT. Cancelling a
      // prepared claim fences that sender, even if its original response arrives late.
      const data = withoutPending(stored.data);
      await p.cas(issue.id, stored.revision, data);
      stored = { revision: stored.revision + 1, data };
    }
    if (stored.data.pending) {
      const pending = stored.data.pending;
      const settled = (i: Issue) =>
        receiptHash(i, field, pending) === pending.after || landed(i, field, pending);
      // `issue` was read before the claim, so a match may be Jira's state before that save:
      // only a read made after the claim settles it.
      const now = settled(issue) ? await p.issue(issue.id, field) : undefined;
      if (!now || !settled(now)) {
        if (allowPending) return stored;
        throw new UserError(
          'The previous save could not be verified. Check saved state; a Jira administrator can investigate an unchanged outcome.',
        );
      }
      const data = selection(pending);
      await p.cas(issue.id, stored.revision, data);
      stored = { revision: stored.revision + 1, data };
    }
    return stored;
  }
  async function releaseUnsent(issueId: string, attemptId: string) {
    // A failed CAS can mean a concurrent writer won. Never release a claim by
    // revision or identical content alone: only this invocation's unique attempt.
    const current = await p.get(issueId);
    if (current?.data.pending?.attemptId === attemptId)
      await p.cas(issueId, current.revision, withoutPending(current.data));
  }
  return {
    async saveStatus(c: Context): Promise<SaveStatus> {
      const field = await p.field();
      const issue = await target(c, field);
      const stored = await state(issue, field, true);
      const pending = stored.data.pending;
      if (!pending) return { pending: false };
      let administrator = false;
      try {
        await p.allowed(c.projectId, 'ADMINISTER');
        await p.allowed(c.projectId, 'EDIT_ISSUES', issue.id);
        administrator = true;
      } catch {
        // Failure to establish administrator/edit rights never enables recovery.
      }
      return {
        pending: true,
        revision: stored.revision,
        fingerprint: targetHash(issue, field),
        // The pending keys are for the administrator who inspects the save, not for every viewer.
        ...(administrator && pending.scope !== 'field' ? { keys: pending.keys } : {}),
        administrator,
        waitSeconds: Math.max(0, Math.ceil((pending.started + recoveryDelay - Date.now()) / 1000)),
      };
    },
    /** Releases a save whose outcome Jira doesn't show (a landed one settles by itself), keeping
     * the last saved selection. It writes only storage; the next Sync rewrites the description. */
    async resolveSave(c: Context, input: RecoveryInput) {
      if (
        !Number.isSafeInteger(input.revision) ||
        input.revision < 0 ||
        typeof input.fingerprint !== 'string' ||
        input.acknowledged !== true
      )
        throw new UserError('Inspect Jira and acknowledge the previous save before releasing it.');
      await p.allowed(c.projectId, 'ADMINISTER');
      const field = await p.field();
      const issue = await target(c, field);
      await p.allowed(c.projectId, 'EDIT_ISSUES', issue.id);
      const stored = await p.get(issue.id);
      const pending = stored?.data.pending;
      if (
        !stored ||
        !pending ||
        pending.phase === 'prepared' ||
        stored.revision !== input.revision ||
        targetHash(issue, field) !== input.fingerprint
      )
        throw new UserError('Saved state changed. Check saved state again.');
      if (Date.now() - pending.started < recoveryDelay)
        throw new UserError('Wait two minutes and check saved state before releasing this save.');
      // Jira shows this save landed: it is settled as saved instead, never reverted.
      if (landed(issue, field, pending))
        throw new UserError('Saved state changed. Check saved state again.');
      await p.cas(issue.id, stored.revision, withoutPending(stored.data));
      return { resolved: true };
    },
    async setup(c: Context) {
      const project = await p.project(c.projectId);
      requireSoftwareSpace(project, c.projectId);
      return { project };
    },
    /** Ten results per picker page; Rovo's assistant asks for twenty. */
    async search(
      c: Context,
      input: Parameters<typeof promptQuery>[0] = {},
      limit: PromptQuery['limit'] = 10,
    ) {
      const query = promptQuery(input, limit);
      return p.search(c.projectId, await scope(c), query);
    },
    async read(c: Context, id: string) {
      const type = await scope(c);
      const issue = await p.issue(id);
      if (issue.fields.project.id !== c.projectId || issue.fields.issuetype.id !== type)
        throw new UserError('This work item is not a prompt in the selected space.');
      return {
        id: issue.id,
        key: issue.key,
        name: issue.fields.summary,
        content: sourceContent({
          type: 'doc',
          version: 1,
          content: snapshotContent(issue.fields.description),
        }),
      };
    },
    async load(c: Context) {
      const type = await scope(c);
      const field = await p.field();
      const issue = await target(c, field);
      const stored = await state(issue, field);
      const cleanupOnly = issue.fields.issuetype.id === type;
      if (cleanupOnly && !stored.data.ids.length)
        throw new UserError(
          'A prompt cannot use other prompts. It can only remove prompts it already has.',
        );
      let retainedUnavailable = false;
      let refreshUnavailable = false;
      const [library, retained, refreshAfterSave] = await Promise.all([
        cleanupOnly
          ? Promise.resolve({ prompts: [] as Prompt[], incomplete: false })
          : p.search(c.projectId, type, { limit: 10 }).catch((): PromptPage => ({
              prompts: [],
              incomplete: true,
              searchError:
                'Could not load prompt suggestions. Your saved selections are still available. Retry search to find prompts.',
            })),
        p.retainedTypes(c.projectId).catch((): string[] => {
          retainedUnavailable = true;
          return [];
        }),
        p.refreshAfterSave(c.projectId).catch(() => {
          refreshUnavailable = true;
          return false;
        }),
      ]);
      for (const id of stored.data.ids.filter(
        (id) => !library.prompts.some((item) => item.id === id),
      )) {
        try {
          const source = await p.issue(id);
          const current = source.fields.issuetype.id === type;
          // Search leaves out prompts in a Done-category status: they are retired, and a work
          // item that already uses one keeps it until a save removes it.
          const retired = current && source.fields.status?.statusCategory?.key === 'done';
          if (
            source.fields.project.id === c.projectId &&
            (current || retained.includes(source.fields.issuetype.id))
          )
            library.prompts.push({
              id,
              key: source.key,
              name: !current
                ? `${source.fields.summary} (previous type)`
                : retired
                  ? `${source.fields.summary} (retired)`
                  : source.fields.summary,
              ...(current && !retired ? {} : { selectedOnly: true }),
            });
        } catch {
          /* Inaccessible sources remain removable without exposing their content. */
        }
      }
      const loadWarning = [
        retainedUnavailable
          ? 'Previous prompt types could not be checked. Saved selections can still be removed.'
          : '',
        refreshUnavailable
          ? 'The work item reload preference could not be checked. Reload the work item manually after saving.'
          : '',
      ]
        .filter(Boolean)
        .join(' ');
      return {
        ...library,
        cleanupOnly,
        refreshAfterSave,
        ...(loadWarning ? { loadWarning } : {}),
        ids: stored.data.ids,
        revision: stored.revision,
      };
    },
    /**
     * Save writes the chosen prompts; Sync (`{ sync: true }`) writes the saved ones again. Both do
     * the same thing: remove every Agent Prompts block in the description and write one section
     * from the prompts' current text, leaving everything else as it is. A prompt that was
     * deleted, never existed, left the space or is no longer a prompt is dropped from the field
     * and the section, and named in `dropped`. Only a prompt the user may not see stops it.
     */
    async save(c: Context, input: SaveInput) {
      const sync = input.sync === true;
      const chosen = input.ids;
      if (
        !sync &&
        (!Array.isArray(chosen) ||
          chosen.length > 5 ||
          new Set(chosen).size !== chosen.length ||
          !Number.isInteger(input.revision))
      )
        throw new UserError('Choose up to five distinct prompts.');
      if (!sync) chosen!.forEach(numeric);
      const type = await scope(c);
      const field = await p.field();
      const issue = await target(c, field);
      await p.allowed(c.projectId, 'EDIT_ISSUES', issue.id);
      const stored = await state(issue, field);
      const ids = sync ? stored.data.ids : chosen!;
      if (!sync) {
        if (ids.includes(issue.id)) throw new UserError('A prompt cannot use itself.');
        if (
          issue.fields.issuetype.id === type &&
          (!stored.data.ids.length || ids.some((id) => !stored.data.ids.includes(id)))
        )
          throw new UserError(
            'A prompt cannot use other prompts. It can only remove prompts it already has.',
          );
        if (stored.revision !== input.revision)
          throw new UserError('The work item changed. Review your selection and save again.');
      }
      // A prompt Jira can no longer find, or finds under another key, is named by the key the
      // user knew.
      const label = (id: string, key?: string) =>
        stored.data.keys?.[stored.data.ids.indexOf(id)] ?? key ?? `the prompt with ID ${id}`;
      const reads = await Promise.all(
        ids.map((id) =>
          p.issue(id).then(
            (source) => ({ id, source }),
            (error: unknown) => {
              if (!notFound(error)) throw error;
              return { id, source: undefined };
            },
          ),
        ),
      );
      const hidden = reads
        .filter((r) => !r.source && stored.data.secured?.includes(r.id))
        .map((r) => label(r.id));
      if (hidden.length)
        throw new UserError(
          `${sync ? 'Nothing was synced' : 'Nothing was saved'}: you can't see ${list(hidden)} in Jira. A Jira administrator manages who can see ${hidden.length > 1 ? 'them' : 'it'}.`,
        );
      const found = reads.filter(
        (r): r is { id: string; source: Issue } =>
          !!r.source && r.source.fields.project.id === c.projectId,
      );
      if (found.some((r) => r.source.id !== r.id))
        throw new UserError('Jira returned a different source. Reopen the field.');
      // A prompt of a previous prompt type stays while it is saved; it can't be added again.
      const retained = found.some(
        (r) => r.source.fields.issuetype.id !== type && stored.data.ids.includes(r.id),
      )
        ? await p.retainedTypes(c.projectId)
        : [];
      const kept = found
        .map((r) => r.source)
        .filter(
          (source) =>
            source.fields.issuetype.id === type ||
            (stored.data.ids.includes(source.id) && retained.includes(source.fields.issuetype.id)),
        );
      const dropped = reads
        .filter((r) => !kept.some((source) => source.id === r.id))
        .map((r) => label(r.id, r.source?.key));
      const prompts = kept.map((source) => {
        try {
          return {
            id: source.id,
            name: `${source.key}: ${source.fields.summary}`,
            content: snapshotContent(source.fields.description),
          };
        } catch (error) {
          if (error instanceof DescriptionError)
            throw new UserError(`${source.key}: ${error.message}`);
          throw error;
        }
      });
      const keptIds = kept.map((source) => source.id);
      const keys = kept.map((source) => source.key);
      const secured = kept.filter((source) => !!source.fields.security).map((source) => source.id);
      // Written over the description as it is now, read after the prompts, so a description edit
      // made while the field was open is kept.
      const fresh = await target(c, field);
      const description = synchronizeDescription(
        fresh.fields.description,
        prompts,
        sectionLocalId(issue.id),
      );
      // When only the field changes, the description isn't sent, so a description edit made
      // meanwhile can't be overwritten.
      const fieldOnly = hash(description) === hash(fresh.fields.description ?? null);
      const fields = fieldOnly ? { [field]: keys } : { description, [field]: keys };
      const pending: Receipt = fieldOnly
        ? {
            before: fieldHash(fresh, field),
            after: hash(['field', keys]),
            ids: keptIds,
            keys,
            secured,
            scope: 'field',
          }
        : {
            before: contentHash(fresh, field),
            after: hash([description, keys]),
            ids: keptIds,
            secured,
            keys,
            beforeField: fieldHash(fresh, field),
          };
      const result = (revision: number) => ({
        revision,
        ids: keptIds,
        ...(dropped.length ? { dropped } : {}),
      });
      // An unchanged write cannot be distinguished from an in-flight write by
      // recovery. Never publish such a claim or send a redundant Jira update.
      if (pending.before === pending.after) {
        const data = selection({ ids: keptIds, keys, secured });
        const changed = hash(data) !== hash(stored.data);
        if (changed) await p.cas(issue.id, stored.revision, data);
        return result(stored.revision + (changed ? 1 : 0));
      }
      const attemptId = randomUUID();
      const prepared = { ...pending, attemptId, phase: 'prepared' as const, started: Date.now() };
      try {
        await p.cas(issue.id, stored.revision, { ...stored.data, pending: prepared });
        await p.cas(issue.id, stored.revision + 1, {
          ...stored.data,
          pending: { ...prepared, phase: 'submitted' },
        });
      } catch {
        try {
          await releaseUnsent(issue.id, attemptId);
        } catch {
          throw new UserError(
            'The save was not sent to Jira, but its storage claim could not be released. Check saved state.',
          );
        }
        throw new UserError('The save was not sent to Jira. Review your selection and save again.');
      }
      try {
        await p.update(issue.id, fields);
      } catch (error) {
        if (error instanceof JiraRejected) {
          try {
            await p.cas(issue.id, stored.revision + 2, stored.data);
          } catch {
            throw new UserError(
              'Jira rejected the save, but its status could not be verified. Reopen this field.',
            );
          }
          throw new UserError(error.message);
        }
        throw new UserError('The save could not be confirmed.');
      }
      // Jira confirmed the write; it may store the description in its own form, which the next
      // Sync rewrites anyway.
      const settled = selection({ ids: keptIds, keys, secured });
      let revision = stored.revision + 3;
      try {
        await p.cas(issue.id, stored.revision + 2, settled);
      } catch (error) {
        // A reader that saw the landed save may have settled it first with this same record.
        const current = await p.get(issue.id).catch(() => undefined);
        if (!current || current.data.pending || hash(current.data) !== hash(settled)) throw error;
        revision = current.revision;
      }
      return result(revision);
    },
  };
}
