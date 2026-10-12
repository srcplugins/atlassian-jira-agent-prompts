import {
  hash,
  numeric,
  JiraRejected,
  JiraUnavailable,
  UserError,
  type Context,
  type Ports,
} from './service';
import { JiraHttpError, requireCompanyManagedSoftware } from './shared/jira.mjs';

/** A configuration step that provably changed nothing in Jira and left no claim in storage.
 * `retryable` means repeating the reviewed step can succeed (a brief outage); otherwise the
 * project needs a new review. */
export class NotApplied extends UserError {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}
const uncertainSetup =
  'Configuration stopped with an uncertain or partial result. Use Check configuration, then Check outcome. No write was retried; do not create another type.';
/** Jira or storage was briefly unavailable rather than refusing the request. */
export function transient(error: unknown) {
  return (
    error instanceof JiraUnavailable ||
    (error instanceof JiraHttpError && (error.status === 429 || error.status >= 500)) ||
    !(error instanceof UserError)
  );
}
function notApplied(error: unknown, retryable: boolean) {
  const reason =
    error instanceof UserError ? error.message : 'Jira or app storage could not be read.';
  return new NotApplied(
    /nothing was changed/i.test(reason) ? reason : `${reason} Nothing was changed.`,
    retryable,
  );
}
export interface TicketType {
  id: string;
  name: string;
  subtask: boolean;
  hierarchyLevel?: number;
  scope?: unknown;
}
function eligible(type: TicketType) {
  return type.hierarchyLevel === 0 && !type.subtask && !type.scope;
}
interface SettingsData {
  refreshAfterSave?: boolean;
  type?: string;
  previousTypes?: string[];
  pending?: { name?: string; type?: string; scheme: string; started: number };
}
export interface SettingsRecord {
  revision: number;
  data: SettingsData;
}
interface Scheme {
  id: string;
  name: string;
  projectIds: string[];
  isDefault: boolean;
  projects?: { id: string; key?: string; name?: string }[];
}
export interface SettingsPorts {
  get(project: string): Promise<SettingsRecord | undefined>;
  cas(project: string, revision: number, data: SettingsData): Promise<void>;
  types(): Promise<TicketType[]>;
  scheme(project: string): Promise<Scheme>;
  create(name: string): Promise<string>;
  attach(scheme: string, type: string): Promise<void>;
  impact(
    project: string,
    type: string,
    field: string,
  ): Promise<{ keys: string[]; incomplete: boolean }>;
  createFields(project: string, type: string): Promise<string[]>;
}
export interface SettingsInput {
  unlink?: boolean;
  refreshAfterSave?: boolean;
  allowShared?: boolean;
  type?: string;
  name?: string;
}
export function createSettings(p: Ports, s: SettingsPorts) {
  async function admin(c: Context) {
    await p.allowed(numeric(c.projectId), 'ADMINISTER');
    const project = await p.project(c.projectId);
    requireCompanyManagedSoftware(project, c.projectId);
    return project;
  }
  async function inspect(c: Context) {
    const project = await admin(c);
    const [record, types, scheme] = await Promise.all([
      s.get(c.projectId),
      s.types(),
      s.scheme(c.projectId),
    ]);
    const state = record ?? { revision: 0, data: {} };
    const selected = types.find((t) => t.id === state.data.type);
    return { project, state, types, selected, scheme };
  }
  async function unlink(c: Context, revision: number) {
    await admin(c);
    const current = (await s.get(c.projectId)) ?? { revision: 0, data: {} };
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      !current ||
      current.revision !== revision
    )
      throw new UserError('Configuration changed. Check configuration again.');
    if (current.data.pending)
      throw new UserError('Resolve the unfinished configuration before unlinking this project.');
    // Keep historical type identities so existing issue links can be recognized
    // if the project is configured again. Never modify Jira issues or shared schemes.
    const previousTypes = Array.from(
      new Set([
        ...(current.data.previousTypes ?? []),
        ...(current.data.type ? [current.data.type] : []),
      ]),
    );
    await s.cas(c.projectId, revision, { previousTypes });
    return { saved: true };
  }
  async function plan(c: Context, input: SettingsInput) {
    if (input.refreshAfterSave !== undefined && typeof input.refreshAfterSave !== 'boolean')
      throw new UserError('Invalid display preference.');
    if (input.unlink) {
      if (
        input.type !== undefined ||
        input.name !== undefined ||
        input.refreshAfterSave !== undefined
      )
        throw new UserError('Unlink cannot include a type or preference change.');
      const project = await admin(c);
      const state = (await s.get(c.projectId)) ?? { revision: 0, data: {} };
      if (state.data.pending)
        throw new UserError('Resolve the unfinished configuration before unlinking this project.');
      const result = {
        unlink: true,
        revision: state.revision,
        old: state.data.type,
        type: undefined,
        name: undefined,
        attach: false,
        scheme: { id: '', name: '', projectIds: [] as string[], isDefault: false } as Scheme,
        project: { id: project.id, key: project.key },
        previousTypes: state.data.previousTypes ?? [],
        promptKeys: [] as string[],
        promptIncomplete: false,
        linkedKeys: [] as string[],
        linksIncomplete: false,
        typeName: 'Unlink project',
      };
      return { ...result, fingerprint: hash([c.accountId, result]) };
    }
    const value = await inspect(c);
    if (value.state.data.pending)
      throw new UserError('An earlier configuration needs an outcome check before another change.');
    const creating = typeof input.name === 'string';
    const name = input.name?.trim();
    if (
      creating &&
      (!name || name.length > 60 || Array.from(name).some((char) => char.charCodeAt(0) < 32))
    )
      throw new UserError('Choose a ticket type name of 1–60 characters.');
    if (creating && input.type) throw new UserError('Create a type or choose an existing one.');
    if (creating && value.types.some((t) => t.name.toLowerCase() === name!.toLowerCase()))
      throw new UserError(
        'That ticket type name already exists. Choose another name or select an eligible existing standard global type.',
      );
    const type = creating ? undefined : numeric(input.type);
    if (type && !value.types.some((t) => t.id === type && eligible(t)))
      throw new UserError('Choose an available standard global ticket type.');
    const attach = creating || !value.project.issueTypes.some((t) => t.id === type);
    if (attach && value.scheme.isDefault)
      throw new UserError(
        'This project uses Jira’s default type scheme. Add the type in Jira settings, then select it here.',
      );
    if (!value.scheme.isDefault && !value.scheme.projectIds.includes(c.projectId))
      throw new UserError(
        'The scheme project association could not be confirmed. Review Jira settings.',
      );
    const old = value.state.data.type;
    const changing = !!old && old !== type;
    const previousTypes = Array.from(
      new Set([...(value.state.data.previousTypes ?? []), ...(changing ? [old!] : [])]),
    ).filter((id) => id !== type);
    if (previousTypes.length > 20)
      throw new UserError(
        'Twenty previous type mappings are retained. Review existing links with an administrator before another replacement.',
      );
    const prompts =
      changing && value.selected
        ? await p.search(c.projectId, old!)
        : { prompts: [], incomplete: !!old && !value.selected };
    const links = changing
      ? await s.impact(c.projectId, old!, await p.field())
      : { keys: [], incomplete: false };
    const result = {
      ...(input.refreshAfterSave !== undefined ? { refreshAfterSave: input.refreshAfterSave } : {}),
      revision: value.state.revision,
      old,
      type,
      name,
      attach,
      scheme: value.scheme,
      project: { id: value.project.id, key: value.project.key },
      previousTypes,
      promptKeys: prompts.prompts.map((t) => t.key),
      promptIncomplete: prompts.incomplete,
      linkedKeys: links.keys,
      linksIncomplete: links.incomplete,
      typeName: name ?? value.types.find((t) => t.id === type)!.name,
    };
    return { ...result, fingerprint: hash([c.accountId, result]) };
  }
  return {
    async preferences(c: Context, input: { revision: number; refreshAfterSave: boolean }) {
      await admin(c);
      if (
        !Number.isSafeInteger(input.revision) ||
        input.revision < 0 ||
        typeof input.refreshAfterSave !== 'boolean'
      )
        throw new UserError('Invalid display preference.');
      const current = (await s.get(c.projectId)) ?? { revision: 0, data: {} };
      if (current.revision !== input.revision || current.data.pending)
        throw new UserError(
          'Configuration changed or is unfinished. Reload Project configuration.',
        );
      await s.cas(c.projectId, current.revision, {
        ...current.data,
        refreshAfterSave: input.refreshAfterSave,
      });
      return { saved: true };
    },
    unlink,
    async health(c: Context) {
      // Diagnostic failures must not hide a durable pending operation or its
      // manual recovery controls. Mutation planning still uses strict inspect.
      const project = await admin(c);
      const state = (await s.get(c.projectId)) ?? { revision: 0, data: {} };
      const [typesResult, schemeResult] = await Promise.allSettled([
        s.types(),
        s.scheme(c.projectId),
      ]);
      const types = typesResult.status === 'fulfilled' ? typesResult.value : undefined;
      const scheme = schemeResult.status === 'fulfilled' ? schemeResult.value : undefined;
      const selected = types?.find((t) => t.id === state.data.type);
      const checks: { label: string; ok: boolean; detail: string }[] = [];
      const available =
        !!selected &&
        eligible(selected) &&
        project.issueTypes.some((t) => t.id === selected.id && !t.subtask);
      checks.push({
        label: 'Ticket type',
        ok: available,
        detail: !types
          ? 'Ticket types could not be checked. Inspect Jira settings before resolving any pending operation, then check configuration again.'
          : !state.data.type
            ? 'Choose or create a ticket type.'
            : !selected || !eligible(selected)
              ? 'The configured type is deleted, unavailable or no longer a standard global type. Choose a replacement.'
              : available
                ? `${selected.name} is available in this project. Renames are supported.`
                : `${selected.name} exists but is missing from this project. Select it below to review a repair.`,
      });
      if (!scheme)
        checks.push({
          label: 'Type scheme',
          ok: false,
          detail:
            'The project type scheme could not be checked completely. Inspect its association in Jira settings; new configuration changes remain blocked until this check succeeds.',
        });
      try {
        await p.field();
        checks.push({
          label: 'Agent Prompts field',
          ok: true,
          detail: 'Agent Prompts field exists.',
        });
      } catch (e) {
        checks.push({
          label: 'Agent Prompts field',
          ok: false,
          detail: e instanceof UserError ? e.message : 'Field could not be checked.',
        });
      }
      if (available) {
        try {
          const fields = await s.createFields(c.projectId, selected!.id);
          const ok = ['summary', 'description'].every((f) => fields.includes(f));
          checks.push({
            label: 'Prompt creation',
            ok,
            detail: ok
              ? 'Summary and Description are available when creating this type.'
              : 'Add Summary and Description to the type’s create screen in Jira settings.',
          });
        } catch {
          checks.push({
            label: 'Prompt creation',
            ok: false,
            detail:
              'Could not verify create fields. Check Create Issues permission and the type’s screen configuration.',
          });
        }
      }
      return {
        project,
        state,
        types: (types ?? []).filter(eligible),
        selected,
        scheme,
        canConfigure: !!types && !!scheme,
        checks,
      };
    },
    preview: plan,
    async apply(c: Context, input: SettingsInput & { fingerprint: string }) {
      // Before the claim nothing is written, so every failure is NotApplied. A retry is only
      // meaningful when Jira or storage was briefly unavailable.
      let preview: Awaited<ReturnType<typeof plan>>;
      try {
        preview = await plan(c, input);
        if (preview.fingerprint !== input.fingerprint)
          throw new UserError(
            'Configuration or its visible impact changed. Review the change again.',
          );
      } catch (error) {
        throw notApplied(error, transient(error));
      }
      // Unlink has one storage write; its failure stays uncertain.
      if (input.unlink) return unlink(c, preview.revision);
      let current: SettingsRecord;
      try {
        if (preview.attach && preview.scheme.projectIds.length > 1 && input.allowShared !== true)
          throw new UserError('Confirm the shared scheme’s affected projects before applying.');
        current = (await s.get(c.projectId)) ?? { revision: 0, data: {} };
        if (current.revision !== preview.revision)
          throw new UserError(
            'Another administrator changed configuration. Check configuration again.',
          );
      } catch (error) {
        throw notApplied(error, transient(error));
      }
      if (!preview.attach) {
        await s.cas(c.projectId, current.revision, {
          ...current.data,
          ...(input.refreshAfterSave !== undefined
            ? { refreshAfterSave: input.refreshAfterSave }
            : {}),
          type: preview.type!,
          previousTypes: preview.previousTypes,
        });
        return { saved: true };
      }
      let revision = current.revision;
      const pending: NonNullable<SettingsData['pending']> = {
        ...(preview.name ? { name: preview.name } : {}),
        ...(preview.type ? { type: preview.type } : {}),
        scheme: preview.scheme.id,
        started: Date.now(),
      };
      // A lost response here may have committed the claim, so failure stays uncertain.
      await s.cas(c.projectId, revision++, { ...current.data, pending });
      const claimed = revision;
      async function verifyScheme() {
        const fresh = await s.scheme(c.projectId);
        if (hash(fresh) !== hash(preview.scheme))
          throw new UserError(
            'The project scheme changed during configuration, before any further Jira write. Review this project again.',
          );
      }
      // Counted before each Jira write: only a failure before the first write, or a documented
      // rejection of that first write, proves Jira is unchanged.
      let sent = 0;
      try {
        // A claim serializes this app, not concurrent changes in Jira settings.
        // Check before the first global side effect as well as before attachment.
        if (!pending.type) {
          await verifyScheme();
          sent++;
          pending.type = await s.create(preview.name!);
          await s.cas(c.projectId, revision++, { ...current.data, pending });
        }
        // Recheck scheme ownership after creation before modifying it.
        await verifyScheme();
        sent++;
        await s.attach(pending.scheme, pending.type);
        const project = await p.project(c.projectId);
        await verifyScheme();
        if (!project.issueTypes.some((t) => t.id === pending.type))
          throw new UserError('Jira has not confirmed the type association.');
        await s.cas(c.projectId, revision, {
          ...current.data,
          ...(input.refreshAfterSave !== undefined
            ? { refreshAfterSave: input.refreshAfterSave }
            : {}),
          type: pending.type,
          previousTypes: preview.previousTypes,
        });
      } catch (error) {
        const unchanged =
          revision === claimed && (sent === 0 || (sent === 1 && error instanceof JiraRejected));
        if (unchanged) {
          try {
            await s.cas(c.projectId, claimed, { ...current.data });
          } catch {
            throw new UserError(uncertainSetup);
          }
          // The revision moved, so the reviewed fingerprint no longer applies: review again.
          throw notApplied(error, false);
        }
        throw new UserError(uncertainSetup);
      }
      return { saved: true };
    },
    async recover(c: Context) {
      const project = await admin(c);
      const pending = (await s.get(c.projectId))?.data.pending;
      if (!pending) return { message: 'No unresolved configuration operation.' };
      if (!pending.type)
        return {
          message:
            'Creation outcome is unknown. Inspect Jira ticket types for the requested name, then acknowledge manual resolution below. Do not create a duplicate.',
        };
      let types: TicketType[];
      try {
        types = await s.types();
      } catch {
        return {
          message:
            'The recorded type could not be checked. Inspect Jira’s type list and the project association before acknowledging resolution. The outcome remains unknown; do not repeat its writes.',
        };
      }
      const type = types.find((t) => t.id === pending.type);
      if (type && !eligible(type))
        return {
          message:
            'The recorded type exists but is no longer an eligible base-level global type. Inspect Jira settings before acknowledging resolution, then choose an eligible replacement. Do not repeat the earlier writes.',
        };
      const attached = project.issueTypes.some((t) => t.id === pending.type);
      return {
        message: type
          ? attached
            ? 'The type exists and is attached. Acknowledge resolution, then select this type and review saving the mapping.'
            : 'The type exists but is not attached. Acknowledge resolution, then select it to review repairing the association.'
          : 'The recorded type is unavailable. Inspect Jira settings before acknowledging resolution.',
      };
    },
    async resolve(c: Context, revision: number) {
      await admin(c);
      const current = await s.get(c.projectId);
      if (!current?.data.pending || current.revision !== revision)
        throw new UserError('Configuration changed. Check configuration again.');
      // Do not unlock an active request. Forge resolver execution is bounded well below this delay.
      if (Date.now() - current.data.pending.started < 120_000)
        throw new UserError(
          'Wait two minutes for the earlier request to finish, then check its outcome.',
        );
      const data = { ...current.data };
      delete data.pending;
      await s.cas(c.projectId, revision, data);
      return { saved: true };
    },
  };
}
