import { memoryCoreBoundary } from './memory-core-lint.mjs';

const nativeControls = new Map([
  ['button', 'Button'],
  ['input', 'Input or Checkbox'],
  ['textarea', 'Textarea'],
  ['select', 'Select'],
  ['option', 'SelectItem'],
  ['optgroup', 'SelectGroup'],
  ['label', 'Label or FieldLabel'],
  ['table', 'Table'],
  ['thead', 'TableHeader'],
  ['tbody', 'TableBody'],
  ['tr', 'TableRow'],
  ['th', 'TableHead'],
  ['td', 'TableCell'],
  ['dialog', 'Dialog'],
  ['details', 'Accordion or Collapsible'],
  ['summary', 'AccordionTrigger'],
  ['progress', 'Progress'],
  ['meter', 'Progress'],
]);

export default {
  meta: { name: 'tulipfarm' },
  rules: {
    'memory-core-boundary': memoryCoreBoundary,
    'product-copy': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        function check(node, text) {
          if (typeof text === 'string' && /\bpreviews?\b/i.test(text)) {
            context.report({
              node,
              message:
                'Do not use "preview" in application copy. Name the action or content directly, or remove the label.',
            });
          }
        }
        return {
          JSXText(node) {
            check(node, node.value);
          },
          Literal(node) {
            if (node.parent?.source === node) return;
            check(node, node.value);
          },
          TemplateElement(node) {
            check(node, node.value.cooked);
          },
        };
      },
    },
    'shared-controls': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        return {
          ImportDeclaration(node) {
            if (
              /^(@base-ui\/react|@radix-ui\/|@shadcn\/react|cmdk$|input-otp$|react-day-picker$|react-resizable-panels$|embla-carousel-react$)/.test(
                node.source.value,
              )
            ) {
              context.report({
                node,
                message:
                  'Import the shared component from @tulipfarm/sprout. Primitive libraries belong inside sprout or an app-local component.',
              });
            }
          },
          JSXOpeningElement(node) {
            if (node.name.type !== 'JSXIdentifier') return;
            const name = node.name.name;
            const replacement = nativeControls.get(name);
            if (replacement)
              context.report({ node, message: `Use ${replacement} from @tulipfarm/sprout instead of <${name}>.` });
            if (!/^[a-z]/.test(name) || name === 'a') return;
            const interactive = node.attributes.some(
              attribute =>
                attribute.type === 'JSXAttribute' &&
                (attribute.name.name === 'onClick' ||
                  (attribute.name.name === 'role' &&
                    ['button', 'checkbox', 'switch', 'radio', 'combobox', 'slider', 'tab'].includes(
                      attribute.value?.value,
                    ))),
            );
            if (interactive && !replacement)
              context.report({
                node,
                message: 'Use a shared interactive component instead of adding control behavior to a native element.',
              });
          },
        };
      },
    },
    'custom-select': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        return {
          ImportDeclaration(node) {
            if (node.source.value === '@/components/ui/native-select') {
              context.report({
                node,
                message:
                  'Use Select from @tulipfarm/sprout/select. NativeSelect opens the operating-system menu, which does not match the design system.',
              });
            }
          },
        };
      },
    },
    'no-component-overrides': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        const icons = new Set();
        return {
          ImportDeclaration(node) {
            if (node.source.value === 'lucide-react') {
              for (const specifier of node.specifiers) icons.add(specifier.local.name);
            }
          },
          JSXOpeningElement(node) {
            const name = node.name.type === 'JSXIdentifier' ? node.name.name : null;
            if (name && (/^[a-z]/.test(name) || icons.has(name))) return;
            for (const attribute of node.attributes) {
              if (
                attribute.type === 'JSXSpreadAttribute' ||
                /^(?:.*classNames?|.*styles?)$/i.test(attribute.name?.name ?? '')
              ) {
                context.report({
                  node: attribute,
                  message:
                    'Component appearance belongs in the component. Use explicit variant/size props, not className, style, or opaque prop spreads. Put layout classes on a surrounding element.',
                });
              }
            }
          },
        };
      },
    },
  },
};
