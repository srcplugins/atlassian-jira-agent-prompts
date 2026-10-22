import { createHash } from 'node:crypto';
import { sectionIdPrefix } from './names';

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

/** An Agent Prompts block: an expand titled Agent Prompts (any case or spacing), wherever it is and
 * whatever it holds, or any node carrying an app section's identifier (a retitled section, or one
 * copied from another work item). */
function promptsBlock(node: AdfNode): boolean {
  const id = node.attrs?.localId;
  if (typeof id === 'string' && id.startsWith(sectionIdPrefix)) return true;
  const title = node.attrs?.title;
  return (
    (node.type === 'expand' || node.type === 'nestedExpand') &&
    typeof title === 'string' &&
    title.trim().replace(/\s+/g, ' ').toLowerCase() === 'agent prompts'
  );
}

/** Rewrites the description's Agent Prompts section from the linked prompts. Every Agent Prompts
 * block is removed, however many there are and whatever anyone wrote in them; one fresh section
 * takes the top-level place of the first (before the node that held it, when it was nested), or
 * goes last. Everything else stays exactly as it is. Nothing inside an old block is read. */
export function synchronizeDescription(
  description: unknown,
  prompts: readonly ResolvedPrompt[],
  blockId: string,
): AdfDoc | null {
  validateDescription(description);
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
  if (!description && !prompts.length) return null;
  const doc: AdfDoc = description ?? { type: 'doc', version: 1, content: [] };
  // Returns the node itself when nothing inside it is a block, so untouched content is never
  // copied. A container left empty gets an empty paragraph, which every container of an expand
  // (table cells, layout columns, an expand of the user's own) accepts.
  function strip(node: AdfNode): AdfNode {
    if (!node.content) return node;
    const kept: AdfNode[] = [];
    let changed = false;
    for (const child of node.content) {
      if (promptsBlock(child)) {
        changed = true;
        continue;
      }
      const next = strip(child);
      if (next !== child) changed = true;
      kept.push(next);
    }
    if (!changed) return node;
    return { ...node, content: kept.length ? kept : [{ type: 'paragraph' }] };
  }
  const content: AdfNode[] = [];
  let at: number | undefined;
  for (const node of doc.content) {
    if (promptsBlock(node)) {
      at ??= content.length;
      continue;
    }
    const next = strip(node);
    if (next !== node) at ??= content.length;
    content.push(next);
  }
  if (prompts.length)
    content.splice(at ?? content.length, 0, {
      type: 'expand',
      attrs: { localId: blockId, title: 'Agent Prompts' },
      content: prompts.flatMap((prompt) => [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: prompt.name }] },
        ...prompt.content,
      ]),
    });
  const result: AdfDoc = { ...doc, content };
  assertDoc(result);
  return result;
}
