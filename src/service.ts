import { randomUUID } from 'node:crypto';
import { sourceContent } from './prompt-text';
import {
  snapshotContent,
  observedManaged,
  matchesShape,
  trackedBlock,
  DescriptionError,
  synchronizeDescription,
  otherSections,
  hash,
  type ManagedBlock,
} from './description';
export { hash };
import { UserError, requireSoftwareSpace } from './shared/jira.mjs';
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
    [key: string]: unknown;
  };
}
interface State {
  ids: string[];
  managed: ManagedBlock | null;
  pending?: Receipt & { attemptId: string; phase: 'prepared' | 'submitted'; started: number };
}
/** What a save is about to write, recorded before it is sent so recovery can compare. */
type Receipt = {
  before: string;
  after: string;
  ids: string[];
  managed: ManagedBlock | null;
} & (
  | {
      /** Only the Agent Prompts field was written; hashes cover the field alone. */
      scope: 'field';
    }
  | {
      scope?: undefined;
      /** Exact field value sent, and the requested block's skeleton (null when removed). */
      keys: string[];
      shape: string | null;
      /** The field and the tracked block before the save, and the requested block (see
       * `untouched`). */
      beforeField: string;
      beforeBlock: string;
      afterBlock: string;
    }
);
export interface Stored {
  revision: number;
  data: State;
}
/** An Agent Prompts section in the description that the field doesn't track. */
export interface OtherSection {
  /** How many there are; only a single top-level one can be replaced. */
  count: number;
  /** The section's hash, which a save sends to replace it. */
  replace?: string;
  /** The prompts its headings name that this work item can use now. */
  prompts: Prompt[];
  /** Keys its headings name that aren't prompts this work item can use. */
  unavailable: string[];
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
function withoutPending(data: State): State {
  return { ids: data.ids, managed: data.managed };
}
/** Jira applied the requested save but returned it in a different representation: the field is
 * exactly what was sent and the one tracked block has the requested text and structure. */
function adoptable(issue: Issue, field: string, pending: Pending) {
  if (
    pending.scope === 'field' ||
    pending.phase === 'prepared' ||
    contentHash(issue, field) === pending.before
  )
    return false;
  if (hash(issue.fields[field] ?? []) !== hash(pending.keys)) return false;
  const localId = pending.managed?.localId ?? sectionLocalId(issue.id);
  try {
    // The block is still exactly the pre-save one: the save never landed (a Sync that changed
    // only attributes, such as a link, has the same skeleton), so it is released, not accepted.
    if (
      pending.afterBlock !== pending.beforeBlock &&
      trackedBlock(issue.fields.description, sectionLocalId(issue.id)) === pending.beforeBlock
    )
      return false;
    return matchesShape(issue.fields.description, localId, pending.shape);
  } catch {
    return false;
  }
}
/** Jira provably never applied this save: the whole work item is as it was, or the field and the
 * tracked block are both still pre-save while the save would have changed at least one of them.
 * Other description edits made since then don't matter. */
function untouched(issue: Issue, field: string, pending: Receipt) {
  if (receiptHash(issue, field, pending) === pending.before) return true;
  if (
    pending.scope === 'field' ||
    (pending.beforeField === hash(['field', pending.keys]) &&
      pending.beforeBlock === pending.afterBlock)
  )
    return false;
  try {
    return (
      fieldHash(issue, field) === pending.beforeField &&
      trackedBlock(issue.fields.description, sectionLocalId(issue.id)) === pending.beforeBlock
    );
  } catch {
    return false;
  }
}
/** No node carries the work item's section identifier, so a later save cannot overwrite text the
 * app does not recognise. An administrator may then release a save whose outcome is unknown, for
 * example one whose section the user deleted after the response was lost. */
function sectionRemoved(issue: Issue) {
  try {
    return trackedBlock(issue.fields.description, sectionLocalId(issue.id)) === hash([]);
  } catch {
    return false;
  }
}
export interface SaveStatus {
  pending: boolean;
  revision?: number;
  fingerprint?: string;
  unchanged?: boolean;
  /** Jira holds the requested save in a different representation; an administrator may accept it. */
  adoptable?: boolean;
  /** The description has no Agent Prompts section; an administrator may release the save. */
  sectionRemoved?: boolean;
  keys?: string[];
  administrator?: boolean;
  waitSeconds?: number;
}
interface RecoveryInput {
  revision: number;
  fingerprint: string;
  acknowledged: boolean;
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
    let stored = (await p.get(issue.id)) ?? { revision: 0, data: { ids: [], managed: null } };
    if (stored.data.pending?.phase === 'prepared') {
      // A sender must win another CAS before issuing its PUT. Cancelling a
      // prepared claim fences that sender, even if its original response arrives late.
      const data = withoutPending(stored.data);
      await p.cas(issue.id, stored.revision, data);
      stored = { revision: stored.revision + 1, data };
    }
    if (stored.data.pending) {
      const pending = stored.data.pending;
      // `issue` was read before the claim, so a match may be Jira's state before that save:
      // only a read made after the claim settles it.
      const now =
        receiptHash(issue, field, pending) === pending.after
          ? await p.issue(issue.id, field)
          : undefined;
      if (!now || receiptHash(now, field, pending) !== pending.after) {
        if (allowPending) return stored;
        throw new UserError(
          'The previous save could not be verified. Check saved state; a Jira administrator can investigate an unchanged outcome.',
        );
      }
      const managed =
        pending.scope === 'field' ? null : observedManaged(now.fields.description, pending.managed);
      await p.cas(issue.id, stored.revision, { ids: pending.ids, managed });
      stored = {
        revision: stored.revision + 1,
        data: { ids: pending.ids, managed },
      };
    }
    return stored;
  }
  /** Shared guards for administrator recovery of an unresolved save: Administer Jira and Edit
   * work items, explicit acknowledgement, the exact revision and work item the administrator
   * inspected, a submitted record, and two minutes since the save started. */
  async function recoveryTarget(c: Context, input: RecoveryInput, action: string) {
    if (
      !Number.isSafeInteger(input.revision) ||
      input.revision < 0 ||
      typeof input.fingerprint !== 'string' ||
      input.acknowledged !== true
    )
      throw new UserError(`Inspect Jira and acknowledge the previous save before ${action} it.`);
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
      throw new UserError(`Wait two minutes and check saved state before ${action} this save.`);
    return { issue, field, stored, pending };
  }
  /** Describes the untracked sections in a work item's description, looking up the prompts a single
   * one names as the user. Reading it never changes it. */
  async function otherSection(
    c: Context,
    issue: Issue,
    managed: ManagedBlock | null,
    type: string,
    cleanupOnly: boolean,
  ): Promise<OtherSection | undefined> {
    let others;
    try {
      others = otherSections(issue.fields.description, managed);
    } catch {
      return undefined;
    }
    const only = others[0];
    if (!only) return undefined;
    if (others.length > 1 || only.index === null || cleanupOnly)
      return { count: others.length, prompts: [], unavailable: [] };
    const keys = only.keys.slice(0, 10);
    const found = await limited(keys, async (key): Promise<Prompt | null> => {
      try {
        const source = await p.issue(key);
        return source.id !== issue.id &&
          source.fields.project.id === c.projectId &&
          source.fields.issuetype.id === type &&
          source.fields.status?.statusCategory?.key !== 'done'
          ? { id: source.id, key: source.key, name: source.fields.summary }
          : null;
      } catch {
        return null;
      }
    });
    return {
      count: 1,
      replace: only.fingerprint,
      prompts: found.filter((prompt): prompt is Prompt => !!prompt),
      unavailable: keys.filter((_, i) => !found[i]),
    };
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
        unchanged: untouched(issue, field, pending),
        adoptable: adoptable(issue, field, pending),
        sectionRemoved: sectionRemoved(issue),
        // The pending keys are for the administrator who inspects the save, not for every viewer.
        ...(administrator && pending.scope !== 'field' ? { keys: pending.keys } : {}),
        administrator,
        waitSeconds: Math.max(0, Math.ceil((pending.started + recoveryDelay - Date.now()) / 1000)),
      };
    },
    async resolveSave(c: Context, input: RecoveryInput) {
      const { issue, field, stored, pending } = await recoveryTarget(c, input, 'releasing');
      // Either outcome keeps the last confirmed selection. When a section the app saved is gone,
      // the next save that copies prompts asks the user to remove them all first, which clears
      // the field.
      if (!untouched(issue, field, pending) && !sectionRemoved(issue))
        throw new UserError(
          'The work item differs from the pre-save state. Delete the Agent Prompts section from the description, then check saved state again; no recovery record was released.',
        );
      await p.cas(issue.id, stored.revision, withoutPending(stored.data));
      return { resolved: true };
    },
    async acceptSave(c: Context, input: RecoveryInput) {
      const { issue, field, stored, pending } = await recoveryTarget(c, input, 'accepting');
      if (!adoptable(issue, field, pending))
        throw new UserError(
          'The work item no longer matches the requested save. Investigate in Jira; nothing was accepted.',
        );
      // Adopt Jira's representation of the requested block; never write Jira here.
      const managed =
        pending.scope !== 'field' && pending.shape
          ? observedManaged(issue.fields.description, pending.managed)
          : null;
      await p.cas(issue.id, stored.revision, { ids: pending.ids, managed });
      return { accepted: true };
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
      const other = await otherSection(c, issue, stored.data.managed, type, cleanupOnly);
      return {
        ...library,
        ...(other ? { otherSection: other } : {}),
        cleanupOnly,
        refreshAfterSave,
        ...(loadWarning ? { loadWarning } : {}),
        ids: stored.data.ids,
        revision: stored.revision,
        fingerprint: targetHash(issue, field),
      };
    },
    async save(
      c: Context,
      input: { ids: string[]; revision: number; fingerprint: string; replace?: string },
    ) {
      if (
        input.replace !== undefined &&
        (typeof input.replace !== 'string' || !/^[0-9a-f]{64}$/.test(input.replace))
      )
        throw new UserError('Invalid section to replace. Reopen the field.');
      if (
        !Array.isArray(input.ids) ||
        input.ids.length > 5 ||
        new Set(input.ids).size !== input.ids.length ||
        !Number.isInteger(input.revision) ||
        typeof input.fingerprint !== 'string'
      )
        throw new UserError('Choose up to five distinct prompts.');
      input.ids.forEach(numeric);
      const type = await scope(c);
      const field = await p.field();
      const issue = await target(c, field);
      await p.allowed(c.projectId, 'EDIT_ISSUES', issue.id);
      if (input.ids.includes(issue.id)) throw new UserError('A prompt cannot use itself.');
      const stored = await state(issue, field);
      if (
        issue.fields.issuetype.id === type &&
        (!stored.data.ids.length || input.ids.some((id) => !stored.data.ids.includes(id)))
      )
        throw new UserError(
          'A prompt cannot use other prompts. It can only remove prompts it already has.',
        );
      if (stored.revision !== input.revision || targetHash(issue, field) !== input.fingerprint)
        throw new UserError('The work item changed. Review your selection and save again.');
      const sources = await Promise.all(input.ids.map((id) => p.issue(id)));
      const needsRetainedType = sources.some(
        (source) =>
          source.fields.project.id === c.projectId &&
          source.fields.issuetype.id !== type &&
          stored.data.ids.includes(source.id),
      );
      const retained = needsRetainedType ? await p.retainedTypes(c.projectId) : [];
      const prompts = sources.map((source) => {
        if (
          source.fields.project.id !== c.projectId ||
          (source.fields.issuetype.id !== type &&
            !(stored.data.ids.includes(source.id) && retained.includes(source.fields.issuetype.id)))
        )
          throw new UserError(
            'A selected prompt moved or changed type. Remove it from your selection.',
          );
        if (source.id !== input.ids[sources.indexOf(source)])
          throw new UserError('Jira returned a different source. Reopen the field.');
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
      const next = synchronizeDescription(
        issue.fields.description,
        prompts,
        stored.data.managed,
        sectionLocalId(issue.id),
        input.replace,
      );
      const keys = sources.map((s) => s.key);
      const fresh = await target(c, field);
      if (targetHash(fresh, field) !== input.fingerprint)
        throw new UserError('The work item changed. Review your selection and save again.');
      // A block the user already deleted is forgotten by clearing only the field: the
      // Description is never rewritten on that path.
      const fields = next.forgotten
        ? { [field]: keys }
        : { description: next.description, [field]: keys };
      const pending: Receipt = next.forgotten
        ? {
            before: fieldHash(issue, field),
            after: hash(['field', keys]),
            ids: input.ids,
            managed: null,
            scope: 'field',
          }
        : {
            before: contentHash(issue, field),
            after: hash([next.description, keys]),
            ids: input.ids,
            managed: next.managed,
            keys,
            shape: next.shape,
            beforeField: fieldHash(issue, field),
            beforeBlock: trackedBlock(issue.fields.description, sectionLocalId(issue.id)),
            afterBlock: trackedBlock(next.description, sectionLocalId(issue.id)),
          };
      // An unchanged write cannot be distinguished from an in-flight write by
      // recovery. Never publish such a claim or send a redundant Jira update.
      if (pending.before === pending.after) {
        const data = { ids: input.ids, managed: next.managed };
        const changed = hash(data) !== hash(stored.data);
        if (changed) await p.cas(issue.id, stored.revision, data);
        return {
          revision: stored.revision + (changed ? 1 : 0),
          fingerprint: targetHash(fresh, field),
          ids: input.ids,
        };
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
      const observed = await target(c, field);
      let managed = pending.managed;
      if (receiptHash(observed, field, pending) !== pending.after) {
        // Jira confirmed the write (2xx) but returned another representation. While this
        // invocation still holds the claim, adopt it if the field and block skeleton match.
        if (!adoptable(observed, field, { ...prepared, phase: 'submitted' }))
          throw new UserError('The saved work item did not match the requested change.');
        managed =
          pending.scope !== 'field' && pending.shape
            ? observedManaged(observed.fields.description, pending.managed)
            : null;
      }
      const settled = { ids: input.ids, managed };
      let revision = stored.revision + 3;
      try {
        await p.cas(issue.id, stored.revision + 2, settled);
      } catch (error) {
        // A reader that saw the landed save may have settled it first with this same record.
        const current = await p.get(issue.id).catch(() => undefined);
        if (!current || current.data.pending || hash(current.data) !== hash(settled)) throw error;
        revision = current.revision;
      }
      return { revision, fingerprint: targetHash(observed, field), ids: input.ids };
    },
  };
}
