// Shared srcplugins file, synchronized across repositories.
// Forge-specific lint rules that standard ESLint selectors cannot express readably.

const transparent = new Set(['ChainExpression', 'TSNonNullExpression']);

function isPermissionKey(node, computed) {
  return computed
    ? node.type === 'Literal' && node.value === 'havePermission'
    : node.type === 'Identifier' && node.name === 'havePermission';
}

function comparedWithTrue(node) {
  let current = node;
  while (current.parent && transparent.has(current.parent.type)) current = current.parent;
  const { parent } = current;
  if (parent?.type !== 'BinaryExpression' || !['===', '!=='].includes(parent.operator))
    return false;
  const other = parent.left === current ? parent.right : parent.left;
  return other.type === 'Literal' && other.value === true;
}

// Jira permission responses are untrusted JSON; only the boolean true grants access.
const strictPermissionCheck = {
  meta: {
    type: 'problem',
    docs: { description: 'Require havePermission to be compared strictly with true.' },
    schema: [],
    messages: {
      strict: 'Compare havePermission with `=== true` or `!== true`; malformed values must deny.',
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (!isPermissionKey(node.property, node.computed)) return;
        if (node.parent?.type === 'AssignmentExpression' && node.parent.left === node) return;
        if (!comparedWithTrue(node)) context.report({ node, messageId: 'strict' });
      },
      'ObjectPattern > Property'(node) {
        if (isPermissionKey(node.key, node.computed)) context.report({ node, messageId: 'strict' });
      },
    };
  },
};

// UI Kit components are not DOM, so jsx-a11y cannot check their labels.
const labelledControls = new Set([
  'Textfield',
  'TextArea',
  'Select',
  'Checkbox',
  'RadioGroup',
  'Toggle',
  'DatePicker',
]);
const accessibleName = new Set(['label', 'aria-label', 'aria-labelledby']);

function attributes(node) {
  const values = new Map();
  for (const attribute of node.attributes) {
    if (attribute.type !== 'JSXAttribute' || attribute.name.type !== 'JSXIdentifier') continue;
    const { value } = attribute;
    const literal =
      value?.type === 'Literal'
        ? value.value
        : value?.type === 'JSXExpressionContainer' && value.expression.type === 'Literal'
          ? value.expression.value
          : undefined;
    values.set(attribute.name.name, typeof literal === 'string' ? literal : null);
  }
  return values;
}

const uiKitLabel = {
  meta: {
    type: 'problem',
    docs: { description: 'Require UI Kit form controls to have an associated label.' },
    schema: [],
    messages: {
      unmatched: 'Label labelFor="{{id}}" has no control with a matching id or inputId.',
      unlabelled:
        '{{name}} needs label, aria-label, aria-labelledby, or an id/inputId referenced by a Label.',
      selectId: 'Label a UI Kit Select through inputId; id names the container, not the input.',
    },
  },
  create(context) {
    let uiKit = false;
    const labels = [];
    const ids = new Set();
    const controls = [];
    return {
      ImportDeclaration(node) {
        if (node.source.value === '@forge/react') uiKit = true;
      },
      JSXOpeningElement(node) {
        if (node.name.type !== 'JSXIdentifier') return;
        const name = node.name.name;
        const values = attributes(node);
        for (const key of ['id', 'inputId']) if (values.get(key)) ids.add(values.get(key));
        if (name === 'Label' && values.get('labelFor'))
          labels.push({ node, id: values.get('labelFor') });
        if (labelledControls.has(name)) controls.push({ node, name, values });
      },
      'Program:exit'() {
        if (!uiKit) return;
        const referenced = new Set(labels.map((label) => label.id));
        for (const label of labels)
          if (!ids.has(label.id))
            context.report({ node: label.node, messageId: 'unmatched', data: label });
        for (const { node, name, values } of controls) {
          if ([...accessibleName].some((key) => values.has(key))) continue;
          const inputId = values.get('inputId');
          const id = values.get('id');
          if (name === 'Select' && id && referenced.has(id) && !values.has('inputId')) {
            context.report({ node, messageId: 'selectId' });
            continue;
          }
          // Computed ids cannot be resolved statically; hosted checks cover them.
          if (values.get('id') === null || values.get('inputId') === null) continue;
          if (
            (inputId && referenced.has(inputId)) ||
            (name !== 'Select' && id && referenced.has(id))
          )
            continue;
          context.report({ node, messageId: 'unlabelled', data: { name } });
        }
      },
    };
  },
};

// String positions that name code, not text: module sources and object or member keys.
function isCodeName(node) {
  const { parent } = node;
  if (parent?.source === node || parent?.type === 'TSExternalModuleReference') return true;
  return parent?.key === node && parent.type !== 'JSXAttribute';
}

function* strings(node) {
  if (node.type === 'Literal' && typeof node.value === 'string' && !isCodeName(node))
    yield { node, text: node.value };
  if (node.type === 'TemplateLiteral')
    for (const quasi of node.quasis) yield { node: quasi, text: quasi.value.cooked ?? '' };
}

// Prose reads as a sentence or label: it starts with a capital and has more than one word.
function isProse(node) {
  const text =
    node.type === 'TemplateLiteral'
      ? node.quasis.map((quasi) => quasi.value.cooked ?? '').join('x')
      : node.value;
  const trimmed = text.trim();
  return /^\p{Lu}/u.test(trimmed) && trimmed.includes(' ');
}

const oldTerms = /\b(issue\s+types?|issues?|projects?|tickets?)\b/giu;
const currentTerms = {
  issue: 'work item',
  'issue type': 'work type',
  project: 'space',
  ticket: 'work item',
};

// Jira Cloud renamed issues, issue types and projects; user-visible text must use the new terms.
const hostTerms = {
  meta: {
    type: 'problem',
    docs: { description: 'Require current Jira terms in user-visible text.' },
    schema: [],
    messages: {
      old: 'Jira now says "{{replacement}}", not "{{term}}", in user-visible text. A quoted Jira label that still uses the old word is exempted with an eslint-disable comment stating the reason.',
    },
  },
  create(context) {
    const check = (node, text) => {
      for (const [term] of text.matchAll(oldTerms)) {
        const words = term.toLowerCase().replace(/\s+/g, ' ');
        const plural = words.endsWith('s');
        const replacement = currentTerms[plural ? words.slice(0, -1) : words];
        context.report({
          node,
          messageId: 'old',
          data: { term, replacement: plural ? `${replacement}s` : replacement },
        });
      }
    };
    return {
      JSXText: (node) => check(node, node.value),
      'Literal, TemplateLiteral': (node) => {
        if (node.type === 'Literal' && typeof node.value !== 'string') return;
        if (isProse(node)) for (const { node: part, text } of strings(node)) check(part, text);
      },
    };
  },
};

const harnessWords = new Set(['fixture', 'sentinel', 'e2e', 'hosted']);
const harnessText = /\b(fixtures?|sentinels?|e2e)\b/iu;

function namesHarness(name) {
  if (name.includes('__test')) return true;
  const words = name
    .split(/[_$-]+|(?<=[a-z])(?=[A-Z])/u)
    .map((word) => word.toLowerCase().replace(/s$/u, ''));
  return words.some(
    (word, index) =>
      harnessWords.has(word) ||
      (word === 'for' && /^test(ing)?$/u.test(words[index + 1])) ||
      (word === 'test' && words[index + 1] === 'only'),
  );
}

// Deployed source must not carry test hooks.
export const testOnlyMessage =
  "Test-only code doesn't belong in deployed source; put it in the SDK double or the hosted harness.";

const testHarnessNames = {
  meta: {
    type: 'problem',
    docs: { description: 'Reject test harness names in deployed source.' },
    schema: [],
    messages: { testOnly: testOnlyMessage },
  },
  create(context) {
    const name = (node) => {
      if (namesHarness(node.name)) context.report({ node, messageId: 'testOnly' });
    };
    return {
      Identifier: name,
      JSXIdentifier: name,
      'Literal, TemplateLiteral': (node) => {
        for (const { node: part, text } of strings(node))
          if (harnessText.test(text)) context.report({ node: part, messageId: 'testOnly' });
      },
    };
  },
};

export default {
  meta: { name: 'forge-local' },
  rules: {
    'host-terms': hostTerms,
    'strict-permission-check': strictPermissionCheck,
    'test-harness-names': testHarnessNames,
    'ui-kit-label': uiKitLabel,
  },
};
