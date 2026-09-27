/**
 * Local ESLint rule: no visible Latin text in the copilot UI.
 *
 * CommonJS on purpose: the root eslint.config.mjs can import it and the Jest
 * suite (CommonJS under ts-jest) can require it, with no runtime flags.
 *
 * Applied to apps/copilot/src/**\/*.tsx only (wired in the root eslint
 * config). Every string a user can see must come from src/i18n/ar.ts.
 *
 * What it flags:
 *  - JSXText containing a Latin letter (e.g. `<p>Hello</p>`).
 *  - A string Literal, or a no-substitution TemplateLiteral, containing a
 *    Latin letter, when it is:
 *      - the value of a watched JSX attribute (placeholder, title, alt,
 *        aria-label, aria-description, label), written either directly
 *        (`placeholder="Email"`) or via an expression container
 *        (`placeholder={'Email'}`);
 *      - a direct JSX child expression (`{'Save'}`).
 *
 * What it does NOT look at: className, href, id, type, role, name, data-*,
 * or any other attribute; and any string nested inside a call/object rather
 * than sitting directly in one of the positions above (e.g. `t('login.title')`
 * is untouched — the key itself is not visible UI text).
 */

const MESSAGE =
  'Visible UI text must come from src/i18n/ar.ts (no Latin text in the copilot UI).';
const LATIN_RE = /[A-Za-z]/;
const WATCHED_ATTRS = new Set([
  'placeholder',
  'title',
  'alt',
  'aria-label',
  'aria-description',
  'label',
]);

function attrName(nameNode) {
  if (!nameNode) return undefined;
  // Plain attribute: JSXIdentifier (name="x"). Namespaced (aria-label parses
  // as a single JSXIdentifier with a hyphen — JSX allows hyphens in names).
  if (nameNode.type === 'JSXIdentifier') return nameNode.name;
  return undefined;
}

function checkPlacement(context, node) {
  const parent = node.parent;
  if (!parent) return;

  // `placeholder="Email"` — Literal assigned straight to a JSX attribute.
  if (parent.type === 'JSXAttribute' && parent.value === node) {
    const name = attrName(parent.name);
    if (name && WATCHED_ATTRS.has(name)) {
      context.report({ node, message: MESSAGE });
    }
    return;
  }

  if (parent.type === 'JSXExpressionContainer' && parent.expression === node) {
    const grandParent = parent.parent;
    if (!grandParent) return;

    // `placeholder={'Email'}` — same attribute, wrapped in an expression.
    if (grandParent.type === 'JSXAttribute') {
      const name = attrName(grandParent.name);
      if (name && WATCHED_ATTRS.has(name)) {
        context.report({ node, message: MESSAGE });
      }
      return;
    }

    // `{'Save'}` sitting directly as a child of a JSX element/fragment.
    if (grandParent.type === 'JSXElement' || grandParent.type === 'JSXFragment') {
      context.report({ node, message: MESSAGE });
    }
  }
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow visible Latin UI text in the copilot app; use src/i18n/ar.ts.',
    },
    schema: [],
    messages: {
      latinText: MESSAGE,
    },
  },
  create(context) {
    return {
      JSXText(node) {
        if (LATIN_RE.test(node.value)) {
          context.report({ node, message: MESSAGE });
        }
      },
      Literal(node) {
        if (typeof node.value !== 'string' || !LATIN_RE.test(node.value)) return;
        checkPlacement(context, node);
      },
      TemplateLiteral(node) {
        if (node.expressions.length > 0) return; // only no-substitution literals
        const raw = node.quasis.map((q) => q.value.cooked ?? q.value.raw ?? '').join('');
        if (!LATIN_RE.test(raw)) return;
        checkPlacement(context, node);
      },
    };
  },
};

module.exports = rule;
