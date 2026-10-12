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

// Jira permission responses are untrusted JSON; only the boolean true grants access (F-029).
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

// UI Kit components are not DOM, so jsx-a11y cannot check their labels (defect F-021).
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

export default {
  meta: { name: 'forge-local' },
  rules: { 'strict-permission-check': strictPermissionCheck, 'ui-kit-label': uiKitLabel },
};
