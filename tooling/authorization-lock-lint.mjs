const policyRule =
  "only membership, team and grant changes pass 'write'; everything else passes 'read' (packages/workspace-storage/CONTRACT.md)";

const defaultedMessage = `This helper runs callbacks and defaults the workspace authorization lock to exclusive, so each new caller blocks the whole workspace without choosing to. Remove the default so every caller passes a mode: ${policyRule}.`;

const hardCodedMessage = `This helper takes the exclusive workspace authorization lock around every callback it runs, so reads routed through it block the whole workspace. Take a required 'read' | 'write' mode parameter and pass it here: ${policyRule}.`;

const functionTypes = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed) return callee.property.name;
  return '';
}

function parameterName(parameter) {
  const target = parameter.type === 'AssignmentPattern' ? parameter.left : parameter;
  return target.type === 'Identifier' ? target : undefined;
}

function isCallback(parameter) {
  return parameterName(parameter)?.typeAnnotation?.typeAnnotation?.type === 'TSFunctionType';
}

function defaultsToExclusive(parameter) {
  if (parameter.type !== 'AssignmentPattern') return false;
  const { left, right } = parameter;
  if (right.type !== 'Literal') return false;
  return right.value === 'write' || (right.value === true && /write|exclusive/i.test(left.name ?? ''));
}

export const authorizationLockMode = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    const frames = [];

    function enter(node) {
      const callbacks = new Set(node.params.filter(isCallback).map(parameter => parameterName(parameter).name));
      if (callbacks.size > 0)
        for (const parameter of node.params)
          if (defaultsToExclusive(parameter)) context.report({ node: parameter, message: defaultedMessage });
      frames.push({ callbacks, runsCallback: false, exclusiveLocks: [] });
    }

    function exit() {
      const frame = frames.pop();
      if (frame.runsCallback)
        for (const node of frame.exclusiveLocks) context.report({ node, message: hardCodedMessage });
    }

    function usesCallback(node) {
      return node?.type === 'Identifier' && frames.some(frame => frame.callbacks.has(node.name));
    }

    const visitors = {
      CallExpression(node) {
        const frame = frames.at(-1);
        if (!frame) return;
        if (usesCallback(node.callee) || node.arguments.some(usesCallback)) frame.runsCallback = true;
        if (/^lock[A-Z]/.test(calleeName(node.callee)))
          for (const argument of node.arguments)
            if (argument.type === 'Literal' && argument.value === 'write') frame.exclusiveLocks.push(argument);
      },
    };
    for (const type of functionTypes) {
      visitors[type] = enter;
      visitors[`${type}:exit`] = exit;
    }
    return visitors;
  },
};
