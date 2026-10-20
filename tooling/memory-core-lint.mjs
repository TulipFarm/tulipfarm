import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

function text(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    const left = text(node.left);
    const right = text(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
}

function property(node) {
  const key = node.property ?? node.key;
  return node.computed ? text(key) : (key?.name ?? text(key));
}

function unwrap(node) {
  while (
    ['ChainExpression', 'TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'AwaitExpression'].includes(
      node?.type,
    )
  ) {
    node = node.expression ?? node.argument;
  }
  return node;
}

export const memoryCoreBoundary = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    const filename = context.filename;
    const marker = `${sep}packages${sep}memory-core${sep}`;
    const root = filename.slice(0, filename.lastIndexOf(marker)) + marker.slice(0, -1);
    const processes = new Set(['process']);
    const loaders = new Set(['require']);
    const factories = new Set();
    const declarations = [];
    const members = [];
    const calls = [];
    const report = node =>
      context.report({
        node,
        message:
          'Keep memory-core independent of host packages, Postgres, Temporal, and environment variables. Use a port instead.',
      });
    const processModule = source => ['process', 'node:process'].includes(source);

    function checkSource(node, source) {
      const name = text(source);
      if (
        name === undefined ||
        /^(@tulipfarm(?:\/|$)|pg(?:[-/]|$)|@temporalio(?:\/|$)|temporalio(?:\/|$)|file:)/.test(name) ||
        isAbsolute(name)
      ) {
        report(node);
      } else if (name.startsWith('.')) {
        const destination = relative(root, resolve(dirname(filename), name));
        if (destination === '..' || destination.startsWith(`..${sep}`) || isAbsolute(destination)) report(node);
      }
    }

    function loader(node) {
      node = unwrap(node);
      return (
        (node?.type === 'Identifier' && loaders.has(node.name)) ||
        (node?.type === 'MemberExpression' &&
          ((node.object.type === 'Identifier' && node.object.name === 'module' && property(node) === 'require') ||
            (node.object.type === 'Identifier' && loaders.has(node.object.name) && property(node) === 'resolve'))) ||
        (node?.type === 'CallExpression' && node.callee.type === 'Identifier' && factories.has(node.callee.name))
      );
    }

    function processObject(node) {
      node = unwrap(node);
      return (
        (node?.type === 'Identifier' && processes.has(node.name)) ||
        (node?.type === 'MemberExpression' &&
          ['globalThis', 'global'].includes(node.object.name) &&
          property(node) === 'process') ||
        (node?.type === 'CallExpression' && loader(node.callee) && processModule(text(node.arguments[0]))) ||
        (node?.type === 'ImportExpression' && processModule(text(node.source)))
      );
    }

    return {
      ImportDeclaration(node) {
        checkSource(node, node.source);
        for (const specifier of node.specifiers) {
          if (processModule(text(node.source))) {
            if (specifier.type !== 'ImportSpecifier') processes.add(specifier.local.name);
            else if ((specifier.imported.name ?? specifier.imported.value) === 'env') report(specifier);
            else if ((specifier.imported.name ?? specifier.imported.value) === 'default')
              processes.add(specifier.local.name);
          }
          if (['module', 'node:module'].includes(text(node.source)) && specifier.imported?.name === 'createRequire')
            factories.add(specifier.local.name);
        }
      },
      ExportNamedDeclaration(node) {
        if (!node.source) return;
        checkSource(node, node.source);
        if (processModule(text(node.source))) {
          for (const specifier of node.specifiers) {
            if ((specifier.local.name ?? specifier.local.value) === 'env') report(specifier);
          }
        }
      },
      ExportAllDeclaration(node) {
        checkSource(node, node.source);
        if (processModule(text(node.source))) report(node);
      },
      ImportExpression(node) {
        checkSource(node, node.source);
      },
      TSImportType(node) {
        checkSource(node, node.source);
      },
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference.type !== 'TSExternalModuleReference') return;
        checkSource(node, node.moduleReference.expression);
        if (processModule(text(node.moduleReference.expression))) processes.add(node.id.name);
      },
      VariableDeclarator(node) {
        declarations.push(node);
      },
      MemberExpression(node) {
        members.push(node);
      },
      CallExpression(node) {
        calls.push(node);
      },
      'Program:exit'() {
        for (const node of declarations) {
          if (node.id.type !== 'Identifier') continue;
          const init = unwrap(node.init);
          if (loader(init)) loaders.add(node.id.name);
          if (processObject(init)) processes.add(node.id.name);
        }
        for (const node of calls) {
          if (loader(node.callee)) checkSource(node, node.arguments[0]);
        }
        for (const node of members) {
          if (processObject(node.object) && (property(node) === 'env' || property(node) === undefined)) report(node);
          if (node.object.type === 'MetaProperty' && property(node) === 'env') report(node);
        }
        for (const node of declarations) {
          if (node.id.type !== 'ObjectPattern' || !processObject(node.init)) continue;
          for (const entry of node.id.properties) {
            if (entry.type === 'Property' && (property(entry) === 'env' || property(entry) === undefined))
              report(entry);
          }
        }
      },
    };
  },
};
