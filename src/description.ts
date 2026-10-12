import { createHash } from 'node:crypto';

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}
export interface AdfNode {
  type: string;
  content?: AdfNode[];
  attrs?: JsonObject;
  [key: string]: unknown;
}
export interface AdfDoc extends AdfNode {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}
interface ManagedReference {
  promptId: string;
  localId: string;
  resourceId: string;
  fingerprint: string;
}
// Legacy snapshots are recognized only for a checked, explicit migration on save.
export type ManagedBlock =
  | { localId: string; fingerprint: string }
  | {
      mode: 'synced';
      references: ManagedReference[];
    };
interface ResolvedPrompt {
  id: string;
  name: string;
  content: AdfNode[];
}

export class DescriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DescriptionError';
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Bound traversal before reading or copying an untrusted Jira document. Do not
// normalize it: unfamiliar JSON attributes and nodes belong to the issue owner.
function assertJson(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 100) throw new DescriptionError('The description is too deeply nested.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object')
    throw new DescriptionError('The description contains an unsupported value.');
  if (ancestors.has(value)) throw new DescriptionError('The description is malformed.');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
    throw new DescriptionError('The description is malformed.');
  ancestors.add(value);
  for (const child of Object.values(value)) assertJson(child, ancestors, depth + 1);
  ancestors.delete(value);
}

function assertNode(value: unknown, root = false): asserts value is AdfNode {
  if (!object(value) || typeof value.type !== 'string' || !value.type.trim())
    throw new DescriptionError('The description contains a malformed node.');
  if (!root && value.type === 'doc')
    throw new DescriptionError('The description contains a nested document.');
  if ('attrs' in value && !object(value.attrs))
    throw new DescriptionError('The description contains malformed attributes.');
  if ('content' in value) {
    if (!Array.isArray(value.content))
      throw new DescriptionError('The description contains malformed content.');
    for (const child of value.content) assertNode(child);
  }
  if ('text' in value && typeof value.text !== 'string')
    throw new DescriptionError('The description contains malformed text.');
  if (value.type === 'text' && (typeof value.text !== 'string' || !value.text.length))
    throw new DescriptionError('The description contains malformed text.');
  if ('marks' in value) {
    if (
      !Array.isArray(value.marks) ||
      value.marks.some(
        (mark) =>
          !object(mark) ||
          typeof mark.type !== 'string' ||
          !mark.type.trim() ||
          ('attrs' in mark && !object(mark.attrs)),
      )
    )
      throw new DescriptionError('The description contains malformed formatting.');
  }
}

function assertDoc(value: unknown): asserts value is AdfDoc {
  assertJson(value);
  assertNode(value, true);
  if (value.type !== 'doc' || value.version !== 1 || !Array.isArray(value.content))
    throw new DescriptionError('The description must be a version 1 ADF document.');
  if (JSON.stringify(value).length > 1_000_000)
    throw new DescriptionError('The description is too large to synchronize safely.');
}

export function validateDescription(value: unknown): asserts value is AdfDoc | null {
  if (value !== null) assertDoc(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function fingerprint(node: AdfNode): string {
  return createHash('sha256').update(canonicalJson(node)).digest('hex');
}

/** Structural identity of a block: node types, text and mark types, ignoring every attribute.
 * Jira may add or normalize attributes on save; text and structure must survive unchanged. */
export function blockShape(node: AdfNode): string {
  function skeleton(n: AdfNode): JsonValue {
    return {
      type: n.type,
      ...(typeof n.text === 'string' ? { text: n.text } : {}),
      marks: ((n.marks as { type: string }[] | undefined) ?? []).map((mark) => mark.type),
      content: (n.content ?? []).map(skeleton),
    };
  }
  return createHash('sha256')
    .update(canonicalJson(skeleton(node)))
    .digest('hex');
}

/** Whether the observed Description holds exactly the requested managed block, by skeleton.
 * `shape === null` means the save removed the block, so no node may carry its identifier. */
export function matchesShape(description: unknown, localId: string, shape: string | null) {
  validateDescription(description);
  const doc = description ?? { type: 'doc', version: 1, content: [] };
  const found: { node: AdfNode; top: boolean }[] = [];
  function visit(node: AdfNode, top: boolean) {
    if (node.attrs?.localId === localId) found.push({ node, top });
    node.content?.forEach((child) => visit(child, false));
  }
  doc.content.forEach((node) => visit(node, true));
  if (shape === null) return found.length === 0;
  const hit = found[0];
  return (
    found.length === 1 &&
    !!hit &&
    hit.top &&
    hit.node.type === 'expand' &&
    blockShape(hit.node) === shape
  );
}

const textMarks = new Set([
  'strong',
  'em',
  'underline',
  'strike',
  'code',
  'subsup',
  'textColor',
  'backgroundColor',
  'link',
]);
const blockMarks = new Set(['alignment', 'indentation']);

/** Copy real instructions, never unresolved references or embedded external content. */
export function snapshotContent(description: unknown): AdfNode[] {
  validateDescription(description);
  if (!description)
    throw new DescriptionError('Write instructions in the prompt’s Description first.');
  // Existing feasibility prompts can be reused: their source block owns real ADF.
  const content = description.content.flatMap((node) =>
    node.type === 'bodiedSyncBlock' ? (node.content ?? []) : [node],
  );
  let textLength = 0;
  function copy(node: AdfNode): AdfNode {
    if (
      ![
        'paragraph',
        'heading',
        'text',
        'hardBreak',
        'rule',
        'codeBlock',
        'bulletList',
        'orderedList',
        'listItem',
        'blockquote',
      ].includes(node.type)
    )
      throw new DescriptionError(
        'Use text, headings, lists, quotes or code in the prompt Description. Embedded content and synced references cannot be copied.',
      );
    if (node.type === 'text') textLength += String(node.text).length;
    const result = structuredClone(node);
    // Copied editor identifiers must not alias the source or another copied prompt.
    if (result.attrs) delete result.attrs.localId;
    if (result.attrs && !Object.keys(result.attrs).length) delete result.attrs;
    if (Array.isArray(result.marks)) {
      // Inline comment anchors belong to the source issue; formatting outside the reviewed set
      // and links to non-web addresses are refused rather than silently changed.
      const kept = (result.marks as { type: string; attrs?: JsonObject }[]).filter((mark) => {
        if (mark.type === 'annotation') return false;
        if (!(node.type === 'text' ? textMarks : blockMarks).has(mark.type))
          throw new DescriptionError(
            'This prompt uses formatting that cannot be copied. Use text, headings, lists, quotes, code, links and basic text styles.',
          );
        if (mark.type === 'link' && !/^(?:https?:|mailto:)/i.test(String(mark.attrs?.href ?? '')))
          throw new DescriptionError('Prompt links must use http, https or mailto addresses.');
        return true;
      });
      if (kept.length) result.marks = kept;
      else delete result.marks;
    }
    if (node.content) result.content = node.content.map(copy);
    return result;
  }
  const result = content.map(copy);
  if (textLength < 1 || textLength > 4000)
    throw new DescriptionError('Prompt instructions must contain 1–4000 text characters.');
  return result;
}

/** Recover pre-fix receipts affected by Jira dropping empty copied attributes.
 * Only a unique, top-level, exactly identified snapshot may be considered.
 * Match the original cryptographic fingerprint; never adopt by title/content.
 * Bound old-record reconstruction to 256 variants and 32 KB per block.
 */
export function recoverEmptyAttributes(description: unknown, managed: ManagedBlock | null) {
  validateDescription(description);
  if (!description || !managed || 'mode' in managed) return undefined;
  const localId = managed.localId;
  const doc = structuredClone(description);
  const matches: AdfNode[] = [];
  function find(node: AdfNode) {
    if (node.attrs?.localId === localId) matches.push(node);
    node.content?.forEach(find);
  }
  doc.content.forEach(find);
  const block = matches[0];
  if (!block || matches.length !== 1 || !doc.content.includes(block) || block.type !== 'expand')
    return undefined;
  if (fingerprint(block) === managed.fingerprint) return doc;
  if (JSON.stringify(block).length > 32_000) return undefined;
  const candidates: AdfNode[] = [];
  function collect(node: AdfNode) {
    if (
      !node.attrs &&
      [
        'paragraph',
        'heading',
        'codeBlock',
        'bulletList',
        'orderedList',
        'listItem',
        'blockquote',
        'hardBreak',
        'rule',
        'text',
      ].includes(node.type)
    )
      candidates.push(node);
    node.content?.forEach(collect);
  }
  block.content?.forEach(collect);
  if (candidates.length > 8) return undefined;
  for (let mask = 1; mask < 2 ** candidates.length; mask++) {
    candidates.forEach((node, i) => {
      if (mask & (1 << i)) node.attrs = {};
      else delete node.attrs;
    });
    if (fingerprint(block) === managed.fingerprint) return doc;
  }
  return undefined;
}

export function observedManaged(
  description: unknown,
  managed: ManagedBlock | null,
): ManagedBlock | null {
  if (!managed || 'mode' in managed) return managed;
  validateDescription(description);
  const block = description?.content.find((node) => node.attrs?.localId === managed.localId);
  if (!block) throw new DescriptionError('The saved prompt container is missing.');
  return { localId: managed.localId, fingerprint: fingerprint(block) };
}

/** Change only tracked top-level references; preserve all other ADF verbatim. */
export function synchronizeDescription(
  description: unknown,
  prompts: readonly ResolvedPrompt[],
  managed: ManagedBlock | null,
  legacyId: string,
): {
  description: AdfDoc | null;
  managed: ManagedBlock | null;
  shape: string | null;
  forgotten?: true;
} {
  validateDescription(description);
  const doc: AdfDoc = description ?? { type: 'doc', version: 1, content: [] };
  const tracked = managed && 'mode' in managed ? managed.references : [];
  const owned = new Map<number, ManagedReference | null>();
  if (managed && !('mode' in managed) && managed.localId !== legacyId)
    throw new DescriptionError('Invalid legacy block record.');
  // A tracked block the user deleted in Jira: an empty selection forgets it (the caller then
  // clears only the field); anything that would add or refresh copies needs a fresh start.
  const trackedIds = managed
    ? 'mode' in managed
      ? tracked.map((r) => r.localId)
      : [managed.localId]
    : [];
  const occurrences = (localId: string) => {
    let count = 0;
    const visit = (node: AdfNode): void => {
      if (node.attrs?.localId === localId) count++;
      node.content?.forEach(visit);
    };
    doc.content.forEach(visit);
    return count;
  };
  if (trackedIds.length && trackedIds.every((id) => occurrences(id) === 0)) {
    if (prompts.length)
      throw new DescriptionError(
        'The Agent Prompts block was removed in Jira. Remove all prompts and save, then add them again.',
      );
    if (occurrences(legacyId))
      throw new DescriptionError(
        'An untracked prompt container exists. Review the description before saving.',
      );
    return { description, managed: null, shape: null, forgotten: true };
  }
  function locate(localId: string, expected: string, type: string): number {
    const found: { node: AdfNode; index: number | null }[] = [];
    function visit(n: AdfNode, index: number | null): void {
      if (n.attrs?.localId === localId) found.push({ node: n, index });
      for (const child of n.content ?? []) visit(child, null);
    }
    doc.content.forEach((n, i) => visit(n, i));
    const hit = found[0];
    if (
      found.length !== 1 ||
      !hit ||
      hit.index === null ||
      hit.node.type !== type ||
      fingerprint(hit.node) !== expected
    )
      throw new DescriptionError(
        'A linked description block was changed, moved or removed. Review the description before saving.',
      );
    return hit.index;
  }
  if (managed && !('mode' in managed))
    owned.set(locate(managed.localId, managed.fingerprint, 'expand'), null);
  for (const ref of tracked) {
    const index = locate(ref.localId, ref.fingerprint, 'syncBlock');
    if (owned.has(index)) throw new DescriptionError('Duplicate linked block records.');
    owned.set(index, ref);
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(legacyId))
    throw new DescriptionError('Invalid generated block identifier.');
  const seen = new Set<string>();
  for (const prompt of prompts) {
    if (
      !/^[1-9]\d{0,19}$/.test(prompt.id) ||
      seen.has(prompt.id) ||
      typeof prompt.name !== 'string' ||
      !prompt.name.trim()
    )
      throw new DescriptionError('Invalid or duplicate prompt.');
    seen.add(prompt.id);
  }
  // Do not adopt a lookalike expander solely because its title matches ours.
  function collisions(node: AdfNode, index: number | null): void {
    if (node.attrs?.localId === legacyId && (index === null || !owned.has(index)))
      throw new DescriptionError(
        'An untracked prompt container exists. Review the description before saving.',
      );
    for (const child of node.content ?? []) collisions(child, null);
  }
  doc.content.forEach((node, i) => collisions(node, i));
  if (!managed && !prompts.length) return { description, managed: null, shape: null };
  const block: AdfNode | null = prompts.length
    ? {
        type: 'expand',
        attrs: { localId: legacyId, title: 'Agent Prompts' },
        content: prompts.flatMap((prompt) => [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: prompt.name }] },
          ...prompt.content,
        ]),
      }
    : null;
  const content: AdfNode[] = [];
  let inserted = false;
  doc.content.forEach((node, index) => {
    if (!owned.has(index)) content.push(node);
    else if (block && !inserted) {
      content.push(block);
      inserted = true;
    }
  });
  if (block && !inserted) content.push(block);
  const result: AdfDoc = { ...doc, content };
  assertDoc(result);
  return {
    description: result,
    managed: block ? { localId: legacyId, fingerprint: fingerprint(block) } : null,
    shape: block ? blockShape(block) : null,
  };
}
