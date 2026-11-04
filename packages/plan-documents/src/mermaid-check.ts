export type MermaidCheck = { ok: true } | { ok: false; reason: string };

export const mermaidSourceLimit = 4000;

const declaration = /^(?:(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)|sequenceDiagram|stateDiagram-v2|timeline)(?:\s|;|$)/;

const denied: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /%%\{/, reason: 'Init directives (%%{ … }%%) are not allowed.' },
  { pattern: /(?:^|;)\s*click\b/im, reason: 'Click handlers are not allowed.' },
  { pattern: /\bhref\b/i, reason: 'Links (href) are not allowed.' },
  { pattern: /\bcall\s+[\w$.]+\s*\(/i, reason: 'Function calls are not allowed.' },
  { pattern: /javascript\s*:/i, reason: 'javascript: URLs are not allowed.' },
  { pattern: /<\s*[a-zA-Z/!?]/, reason: 'HTML tags are not allowed in labels.' },
  { pattern: /^\s*(?:style|classDef|linkStyle)\b[^\n]*url\s*\(/im, reason: 'Styles must not load URLs.' },
];

/**
 * Server-side denylist for diagram sources a model writes. It does not parse Mermaid: a source that passes can still
 * fail to draw, and the render step reports that per diagram so the document shows the source instead.
 */
export function checkMermaid(source: string): MermaidCheck {
  if (typeof source !== 'string' || !source.trim()) return { ok: false, reason: 'The diagram is empty.' };
  if (source.length > mermaidSourceLimit)
    return { ok: false, reason: `The diagram must be at most ${mermaidSourceLimit} characters.` };
  for (const { pattern, reason } of denied) if (pattern.test(source)) return { ok: false, reason };
  const first = source
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line && !line.startsWith('%%'));
  if (!first || !declaration.test(first))
    return {
      ok: false,
      reason:
        'Start with a flowchart or graph and its direction (TD, TB, BT, LR, RL), sequenceDiagram, stateDiagram-v2 or timeline.',
    };
  return { ok: true };
}
