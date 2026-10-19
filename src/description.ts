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
interface AdfDoc extends AdfNode {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}
/** The one Agent Prompts block the app wrote into a description, by identifier and hash. */
export interface ManagedBlock {
  localId: string;
  fingerprint: string;
}
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
// normalize it: unfamiliar JSON attributes and nodes belong to the work item's owner.
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

/** SHA-256 of canonical JSON (sorted keys): the one hash used for fingerprints, receipts and
 * review fingerprints. */
export const hash = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const fingerprint = (node: AdfNode) => hash(node);

type Meaning = (attrs: JsonObject) => JsonValue;
const color: Meaning = (a) => (typeof a.color === 'string' ? a.color.toLowerCase() : null);
/** The attributes that carry instructions, by node and mark type, each with the value Jira may
 * fill in when it is left out. Every other attribute, such as an editor's localId, is ignored. */
const nodeMeaning: Record<string, Meaning> = {
  expand: (a) => a.title ?? '',
  heading: (a) => a.level ?? null,
  orderedList: (a) => a.order ?? 1,
  codeBlock: (a) => a.language || null,
};
const markMeaning: Record<string, Meaning> = {
  link: (a) => a.href ?? null,
  subsup: (a) => a.type ?? null,
  textColor: color,
  backgroundColor: color,
  alignment: (a) => a.align ?? null,
  indentation: (a) => a.level ?? null,
};

/** Identity of a block: node types, text, mark types and the attributes that carry meaning.
 * Jira may add or normalize other attributes on save; instructions must survive unchanged. */
function blockShape(node: AdfNode): string {
  function skeleton(n: AdfNode): JsonValue {
    const meaning = nodeMeaning[n.type];
    return {
      type: n.type,
      ...(typeof n.text === 'string' ? { text: n.text } : {}),
      ...(meaning ? { attrs: meaning(n.attrs ?? {}) } : {}),
      marks: ((n.marks as { type: string; attrs?: JsonObject }[] | undefined) ?? []).map((mark) => {
        const meaning = markMeaning[mark.type];
        return meaning ? [mark.type, meaning(mark.attrs ?? {})] : mark.type;
      }),
      content: (n.content ?? []).map(skeleton),
    };
  }
  return hash(skeleton(node));
}

/** Whether the observed description holds exactly the requested managed block, by skeleton.
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

/** Hash of every node carrying `localId`, anywhere in the document, in document order. An
 * empty list when none does. Lets recovery compare one block while other content changes. */
export function trackedBlock(description: unknown, localId: string): string {
  validateDescription(description);
  const found: AdfNode[] = [];
  function visit(node: AdfNode) {
    if (node.attrs?.localId === localId) found.push(node);
    node.content?.forEach(visit);
  }
  description?.content.forEach(visit);
  return hash(found);
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
    throw new DescriptionError('Write instructions in the prompt’s description first.');
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
        'Use text, headings, lists, quotes or code in the prompt description. Embedded content cannot be copied.',
      );
    // Characters as people count them: an emoji or supplementary character counts once.
    if (node.type === 'text') textLength += Array.from(String(node.text)).length;
    const result = structuredClone(node);
    // Copied editor identifiers must not alias the source or another copied prompt.
    if (result.attrs) delete result.attrs.localId;
    if (result.attrs && !Object.keys(result.attrs).length) delete result.attrs;
    if (Array.isArray(result.marks)) {
      // Inline comment anchors belong to the source work item; formatting outside the reviewed set
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
  const result = description.content.map(copy);
  if (textLength < 1 || textLength > 4000)
    throw new DescriptionError('Prompt instructions must contain 1–4000 text characters.');
  return result;
}

export function observedManaged(
  description: unknown,
  managed: ManagedBlock | null,
): ManagedBlock | null {
  if (!managed) return null;
  validateDescription(description);
  const block = description?.content.find((node) => node.attrs?.localId === managed.localId);
  if (!block) throw new DescriptionError('The Agent Prompts section is missing.');
  return { localId: managed.localId, fingerprint: fingerprint(block) };
}

/** Replace only the tracked top-level block; preserve all other ADF verbatim. */
export function synchronizeDescription(
  description: unknown,
  prompts: readonly ResolvedPrompt[],
  managed: ManagedBlock | null,
  blockId: string,
): {
  description: AdfDoc | null;
  managed: ManagedBlock | null;
  shape: string | null;
  forgotten?: true;
} {
  validateDescription(description);
  const doc: AdfDoc = description ?? { type: 'doc', version: 1, content: [] };
  const owned = new Set<number>();
  if (managed && managed.localId !== blockId)
    throw new DescriptionError('The saved Agent Prompts section belongs to another work item.');
  // A tracked block the user deleted in Jira: an empty selection forgets it (the caller then
  // clears only the field); anything that would add or refresh copies needs a fresh start.
  const occurrences = (localId: string) => {
    let count = 0;
    const visit = (node: AdfNode): void => {
      if (node.attrs?.localId === localId) count++;
      node.content?.forEach(visit);
    };
    doc.content.forEach(visit);
    return count;
  };
  if (managed && occurrences(managed.localId) === 0) {
    if (prompts.length)
      throw new DescriptionError(
        'The Agent Prompts section was removed in Jira. Remove all prompts and save, then add them again.',
      );
    if (occurrences(blockId))
      throw new DescriptionError(
        'The description has an Agent Prompts section the app did not save. Review the description before saving.',
      );
    return { description, managed: null, shape: null, forgotten: true };
  }
  function locate(localId: string, expected: string): number {
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
      hit.node.type !== 'expand' ||
      fingerprint(hit.node) !== expected
    )
      throw new DescriptionError(
        'The Agent Prompts section was changed, moved or duplicated. Review the description before saving.',
      );
    return hit.index;
  }
  if (managed) owned.add(locate(managed.localId, managed.fingerprint));
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(blockId))
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
    if (node.attrs?.localId === blockId && (index === null || !owned.has(index)))
      throw new DescriptionError(
        'The description has an Agent Prompts section the app did not save. Review the description before saving.',
      );
    for (const child of node.content ?? []) collisions(child, null);
  }
  doc.content.forEach((node, i) => collisions(node, i));
  if (!managed && !prompts.length) return { description, managed: null, shape: null };
  const block: AdfNode | null = prompts.length
    ? {
        type: 'expand',
        attrs: { localId: blockId, title: 'Agent Prompts' },
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
    managed: block ? { localId: blockId, fingerprint: fingerprint(block) } : null,
    shape: block ? blockShape(block) : null,
  };
}
