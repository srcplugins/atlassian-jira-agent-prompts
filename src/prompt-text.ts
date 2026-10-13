import { DescriptionError, validateDescription, type AdfNode } from './description';

/** Preserve list identity and nesting when returning instructions to a read-only agent. */
export function sourceContent(description: unknown): string {
  validateDescription(description);
  let textLength = 0;
  let hasText = false;
  function renderChildren(node: AdfNode, separator: string): string {
    return (node.content ?? []).map(render).join(separator);
  }
  function render(node: AdfNode): string {
    switch (node.type) {
      case 'text': {
        const marks = (node.marks ?? []) as { type: string }[];
        if (marks.some((mark) => !['strong', 'em', 'code'].includes(mark.type)))
          throw new DescriptionError(
            'This prompt uses formatting that cannot be safely represented as plain text. Read it in Jira.',
          );
        const text = String(node.text);
        textLength += Array.from(text).length;
        hasText ||= !!text.trim();
        return text;
      }
      case 'hardBreak':
        return '\n';
      case 'paragraph':
      case 'heading':
        return renderChildren(node, '');
      case 'codeBlock': {
        const text = renderChildren(node, '');
        // A fence longer than any literal run cannot be closed by the source text.
        const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
        const fence = '`'.repeat(Math.max(3, longest + 1));
        return `${fence}\n${text}\n${fence}`;
      }
      case 'blockquote':
        return renderChildren(node, '\n\n')
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n');
      case 'rule':
        return '---';
      case 'bulletList':
      case 'orderedList': {
        const start =
          node.type === 'orderedList' && node.attrs && 'order' in node.attrs ? node.attrs.order : 1;
        if (
          typeof start !== 'number' ||
          !Number.isSafeInteger(start) ||
          start < 0 ||
          !Number.isSafeInteger(start + (node.content?.length ?? 0))
        )
          throw new DescriptionError('This prompt has invalid list numbering. Read it in Jira.');
        return (node.content ?? [])
          .map((item, index) => {
            if (item.type !== 'listItem')
              throw new DescriptionError('This prompt has an invalid list. Read it in Jira.');
            const marker = node.type === 'orderedList' ? `${start + index}. ` : '- ';
            return renderChildren(item, '\n\n')
              .split('\n')
              .map((line, lineIndex) =>
                lineIndex === 0 ? marker + line : line ? ' '.repeat(marker.length) + line : '',
              )
              .join('\n');
          })
          .join('\n');
      }
      default:
        throw new DescriptionError(
          'This prompt contains unsupported embedded content. Use text instructions.',
        );
    }
  }
  const content = description?.content.map(render).join('\n\n').trim() ?? '';
  if (!hasText || textLength > 4000)
    throw new DescriptionError('Prompt instructions must contain 1–4000 text characters.');
  if (content.length > 16000)
    throw new DescriptionError(
      'This prompt has too much structure to represent safely as text. Read it in Jira.',
    );
  return content;
}
