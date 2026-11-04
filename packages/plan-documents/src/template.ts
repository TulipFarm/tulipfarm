import { planGraphOutline } from './graph.ts';
import { escapeHtml, renderMarkdown } from './markdown.ts';
import type { PlanChangeOrigin, PlanDocumentModel, PlanDocumentTask, PlanPrerequisiteStatus } from './model.ts';
import type { PlanStamp, PlanStampTone } from './stamp.ts';
import { formatDate } from './stamp.ts';
import { sproutFont, sproutLight, sproutMonoFont, sproutRadius } from './theme.ts';

export type PlanDocumentRenderOptions = {
  /**
   * Drawn diagrams by key, with `plan` for the plan graph. Each string is an SVG the caller has already sanitized; null
   * or a missing key means the diagram couldn't be drawn.
   */
  diagramSvgs: Readonly<Record<string, string | null | undefined>>;
  stamp: PlanStamp;
  /** IANA zone for the generated date. Defaults to UTC. */
  timeZone?: string | undefined;
};

export const planDocumentContentSecurityPolicy = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

const c = sproutLight;
const css = `
:root {
  --canvas: ${c.canvas}; --surface: ${c.surface}; --hover: ${c.hover}; --text: ${c.text}; --muted: ${c.muted};
  --line: ${c.line}; --border: ${c.border}; --secondary: ${c.secondary};
  --info: ${c.info}; --info-subtle: ${c.infoSubtle}; --success: ${c.success}; --success-subtle: ${c.successSubtle};
  --warning: ${c.warning}; --warning-subtle: ${c.warningSubtle}; --danger: ${c.danger}; --danger-subtle: ${c.dangerSubtle};
  --radius-control: ${sproutRadius.control}; --radius-panel: ${sproutRadius.panel};
  --font: ${sproutFont}; --mono: ${sproutMonoFont};
}
@page { size: A4; margin: 18mm 16mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0; color: var(--text); background: var(--surface); font-family: var(--font);
  font-size: 10.5pt; line-height: 1.6; font-kerning: normal; text-rendering: optimizeLegibility;
  counter-reset: section;
}
@media print {
  body { background: none; }
}
@media screen {
  body { background: var(--canvas); padding: 32px 16px; }
  .page { max-width: 210mm; margin: 0 auto; background: var(--surface); padding: 18mm 16mm;
    border: 1px solid var(--line); border-radius: var(--radius-panel); box-shadow: 0 2px 6px -4px rgb(0 0 0 / 0.1); }
}
p { margin: 0 0 0.7em; }
.lead-in { margin-top: 1em; }
p:last-child { margin-bottom: 0; }
ul, ol { margin: 0 0 0.7em; padding-left: 1.25em; }
li + li { margin-top: 0.25em; }
a { color: var(--info); text-decoration: underline; text-underline-offset: 2px; }
code { font-family: var(--mono); font-size: 0.9em; background: var(--secondary); border-radius: 4px; padding: 0.05em 0.35em; }
.num { font-variant-numeric: tabular-nums; }
.muted { color: var(--muted); }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

header.masthead { padding-bottom: 20px; margin-bottom: 8px; border-bottom: 1px solid var(--line); }
.masthead-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
.eyebrow { font-size: 8pt; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0 0 8px; }
h1 { font-size: 22pt; line-height: 1.2; font-weight: 650; letter-spacing: -0.015em; margin: 0; text-wrap: balance; }
.lede { margin-top: 12px; font-size: 11.5pt; color: var(--muted); max-width: 150mm; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 28px; margin: 18px 0 0; font-size: 9pt; }
.meta div { display: flex; flex-direction: column; }
.meta dt { color: var(--muted); font-size: 7.5pt; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; }
.meta dd { margin: 2px 0 0; font-weight: 500; }

.stamp { flex: none; display: inline-flex; align-items: center; gap: 8px; max-width: 70mm; padding: 6px 12px;
  border-radius: 999px; border: 1px solid currentColor; font-size: 8.5pt; font-weight: 600; line-height: 1.35; }
.stamp::before { content: ''; flex: none; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.tone-draft { color: var(--warning); background: var(--warning-subtle); }
.tone-approved { color: var(--success); background: var(--success-subtle); }
.tone-changed { color: var(--info); background: var(--info-subtle); }
.tone-danger { color: var(--danger); background: var(--danger-subtle); }
.tone-neutral { color: var(--muted); background: var(--secondary); }

section.part { padding-top: 26px; counter-increment: section; }
section.part > h2 { display: flex; align-items: baseline; gap: 10px; font-size: 13pt; font-weight: 650;
  letter-spacing: -0.005em; margin: 0 0 14px; break-after: avoid; page-break-after: avoid; }
section.part > h2::before { content: counter(section, decimal-leading-zero); font-size: 8.5pt; font-weight: 600;
  color: var(--muted); font-variant-numeric: tabular-nums; letter-spacing: 0.04em; }
h3 { font-size: 11pt; font-weight: 650; margin: 0 0 6px; break-after: avoid; page-break-after: avoid; }
h4 { font-size: 7.5pt; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); margin: 10px 0 4px; }

.prose { max-width: 165mm; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-panel); padding: 14px 16px; }

ol.requirements { list-style: none; padding: 0; margin: 0; counter-reset: requirement; }
ol.requirements li { counter-increment: requirement; display: flex; gap: 12px; padding: 9px 0; border-top: 1px solid var(--line);
  break-inside: avoid; page-break-inside: avoid; }
ol.requirements li:first-child { border-top: 0; padding-top: 0; }
ol.requirements li::before { content: counter(requirement); flex: none; width: 20px; height: 20px; border-radius: 50%;
  background: var(--secondary); color: var(--muted); font-size: 8pt; font-weight: 600; display: inline-flex;
  align-items: center; justify-content: center; font-variant-numeric: tabular-nums; margin-top: 1px; }

figure { margin: 0; break-inside: avoid; page-break-inside: avoid; }
figure.diagram { padding: 18px; }
figure.diagram + figure.diagram { margin-top: 14px; }
.drawing { display: flex; justify-content: center; }
.drawing svg { max-width: 100%; height: auto; max-height: 220mm; }
figcaption { margin-top: 12px; font-size: 9pt; color: var(--muted); }
.not-drawn { margin: 8px 0; font-size: 9pt; }
pre { font-family: var(--mono); font-size: 8pt; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
  background: var(--canvas); border: 1px solid var(--line); border-radius: var(--radius-control); padding: 10px 12px; margin: 0; }

.group + .group { margin-top: 22px; }
.group-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; break-after: avoid; page-break-after: avoid; }
.group-head .order { font-size: 8pt; color: var(--muted); white-space: nowrap; }
.group-brief { color: var(--muted); font-size: 9.5pt; margin: 0 0 10px; }
.tasks { display: flex; flex-direction: column; gap: 10px; }
article.task { break-inside: avoid; page-break-inside: avoid; }
.task-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.task-head h3 { margin: 0; font-size: 10.5pt; }
.owner { flex: none; font-size: 8pt; font-weight: 500; color: var(--muted); background: var(--secondary);
  border-radius: 999px; padding: 2px 9px; white-space: nowrap; }
.task-brief { margin-top: 6px; color: var(--text); font-size: 9.5pt; }
.task ul.criteria { list-style: none; padding: 0; margin: 0; font-size: 9.5pt; }
.task ul.criteria li { position: relative; padding-left: 16px; }
.task ul.criteria li::before { content: ''; position: absolute; left: 2px; top: 0.45em; width: 7px; height: 7px;
  border: 1.5px solid var(--border); border-radius: 2px; }
.waits { font-size: 9pt; color: var(--muted); }
.outline { list-style: none; padding: 0; font-size: 9.5pt; }
.outline .depth-1 { padding-left: 1.25em; } .outline .depth-2 { padding-left: 2.5em; }
.outline .depth-3 { padding-left: 3.75em; } .outline .depth-4 { padding-left: 5em; }

table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 9.5pt; border: 1px solid var(--line);
  border-radius: var(--radius-panel); overflow: hidden; }
thead { display: table-header-group; }
th { text-align: left; font-size: 7.5pt; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600;
  color: var(--muted); background: var(--canvas); padding: 8px 12px; border-bottom: 1px solid var(--line); }
td { padding: 10px 12px; vertical-align: top; border-top: 1px solid var(--line); }
tbody tr:first-child td { border-top: 0; }
tr { break-inside: avoid; page-break-inside: avoid; }
table.risks th, table.risks td { width: 50%; }
table.risks td:first-child { font-weight: 500; }
.pill { display: inline-block; font-size: 8pt; font-weight: 600; padding: 2px 9px; border-radius: 999px; white-space: nowrap; }
.note + .note { margin-top: 4px; }
.note b { font-weight: 600; }

.budget { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.stat { break-inside: avoid; page-break-inside: avoid; }
.stat .value { font-size: 17pt; font-weight: 650; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; line-height: 1.2; }
.stat .label { font-size: 8.5pt; color: var(--muted); margin-top: 2px; }

ul.changes { list-style: none; padding: 0; margin: 0; }
ul.changes li { display: flex; gap: 12px; align-items: baseline; padding: 7px 0; border-top: 1px solid var(--line);
  break-inside: avoid; page-break-inside: avoid; }
ul.changes li:first-child { border-top: 0; padding-top: 0; }
ul.changes .pill { flex: none; min-width: 26mm; text-align: center; }

footer.colophon { margin-top: 32px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 8pt; color: var(--muted);
  display: flex; justify-content: space-between; gap: 16px; }
`;

const stampTone: Record<PlanStampTone, string> = {
  draft: 'tone-draft',
  approved: 'tone-approved',
  changed: 'tone-changed',
};
const prerequisiteTone: Record<PlanPrerequisiteStatus, [string, string]> = {
  verified: ['tone-approved', 'Verified'],
  blocked: ['tone-danger', 'Blocked'],
  unknown: ['tone-draft', 'Not checked yet'],
};

function section(id: string, title: string, body: string): string {
  return `<section class="part" id="${id}" aria-labelledby="${id}-title">
<h2 id="${id}-title">${escapeHtml(title)}</h2>
${body}
</section>`;
}

function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

const number = (value: number) => new Intl.NumberFormat('en-GB').format(value);

function drawing(svg: string | null | undefined, title: string, source: string | null): string {
  if (svg) return `<div class="drawing">${svg}</div>`;
  return `<p class="not-drawn muted" role="note">This diagram couldn't be drawn.</p>${
    source === null ? '' : `<pre aria-label="${escapeHtml(`Diagram source for ${title}`)}">${escapeHtml(source)}</pre>`
  }`;
}

function groupPath(task: PlanDocumentTask, byKey: Map<string, PlanDocumentTask>): string {
  const names = [task.title];
  const seen = new Set([task.key]);
  for (let parent = task.parent; parent && !seen.has(parent); parent = byKey.get(parent)?.parent ?? null) {
    seen.add(parent);
    const group = byKey.get(parent);
    if (group) names.unshift(group.title);
  }
  return names.join(' / ');
}

function tasksByGroup(model: PlanDocumentModel): string {
  const byKey = new Map(model.tasks.map(task => [task.key, task]));
  const card = (task: PlanDocumentTask) => {
    const waits = task.dependsOn.map(key => byKey.get(key)?.title ?? key);
    return `<article class="task card">
<div class="task-head"><h3>${escapeHtml(task.title)}</h3><span class="owner">${escapeHtml(task.owner ?? 'Unassigned')}</span></div>
${task.brief ? `<div class="task-brief">${renderMarkdown(task.brief)}</div>` : ''}
${task.criteria.length ? `<h4>Done when</h4><ul class="criteria">${task.criteria.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
${waits.length ? `<h4>Waits for</h4><p class="waits">${waits.map(escapeHtml).join(', ')}</p>` : ''}
</article>`;
  };
  const children = (parent: string | null) => model.tasks.filter(task => task.parent === parent);
  const blocks: string[] = [];
  const groupBlock = (group: PlanDocumentTask) => {
    const items = children(group.key).filter(task => task.kind === 'work');
    if (items.length)
      blocks.push(`<div class="group">
<div class="group-head"><h3>${escapeHtml(groupPath(group, byKey))}</h3><span class="order">${group.order === 'serial' ? 'One after another' : 'In parallel'}</span></div>
${group.brief ? `<div class="group-brief">${renderMarkdown(group.brief)}</div>` : ''}
${group.dependsOn.length ? `<p class="waits">Waits for ${group.dependsOn.map(key => escapeHtml(byKey.get(key)?.title ?? key)).join(', ')}</p>` : ''}
<div class="tasks">${items.map(card).join('\n')}</div>
</div>`);
    for (const nested of children(group.key)) if (nested.kind === 'group') groupBlock(nested);
  };
  // Top-level tasks and groups keep the plan's order, so the list reads in the order the work runs.
  let loose: PlanDocumentTask[] = [];
  const flush = () => {
    if (loose.length) blocks.push(`<div class="group"><div class="tasks">${loose.map(card).join('\n')}</div></div>`);
    loose = [];
  };
  for (const task of children(null)) {
    if (task.kind === 'work') loose.push(task);
    else {
      flush();
      groupBlock(task);
    }
  }
  flush();
  return blocks.join('\n');
}

function changeOrigin(origin: PlanChangeOrigin, starter: string): string {
  return origin === 'starter'
    ? `<span class="pill tone-neutral">By ${escapeHtml(starter || 'the starter')}</span>`
    : '<span class="pill tone-changed">During the run</span>';
}

/**
 * The plan document as one self-contained HTML page for A4 print: inline CSS, no scripts and no external resources,
 * enforced by its Content-Security-Policy. Empty sections are left out.
 */
export function renderPlanDocumentHtml(model: PlanDocumentModel, options: PlanDocumentRenderOptions): string {
  const timeZone = options.timeZone ?? 'UTC';
  const generated = formatDate(model.generatedAt, timeZone);
  const { sections } = model;
  const parts: string[] = [];

  parts.push(section('summary', 'Summary', `<div class="prose">${renderMarkdown(sections.summary)}</div>`));

  if (model.requirements.length)
    parts.push(
      section(
        'requirements',
        'Requirements',
        `<ol class="requirements">${model.requirements.map(item => `<li><span>${escapeHtml(item.description)}</span></li>`).join('')}</ol>`,
      ),
    );

  if (sections.approach)
    parts.push(section('approach', 'Approach', `<div class="prose">${renderMarkdown(sections.approach)}</div>`));

  if (model.tasks.some(task => task.kind === 'work')) {
    const outline = planGraphOutline(model.tasks);
    parts.push(
      section(
        'plan-diagram',
        'Plan diagram',
        `<figure class="diagram card" aria-describedby="plan-diagram-text">
${drawing(options.diagramSvgs.plan, 'the plan', null)}
<figcaption>Each arrow points from a task to the work that waits for it.</figcaption>
</figure>
<div id="plan-diagram-text" class="${options.diagramSvgs.plan ? 'visually-hidden' : ''}">
<h3 class="${options.diagramSvgs.plan ? '' : 'visually-hidden'}">The plan as text</h3>
<ul class="outline">${outline.map(line => `<li class="depth-${Math.min(line.depth, 4)}">${escapeHtml(line.text)}</li>`).join('')}</ul>
</div>`,
      ),
    );
    parts.push(section('tasks', 'Tasks', tasksByGroup(model)));
  }

  if (model.prerequisites.length)
    parts.push(
      section(
        'prerequisites',
        'Prerequisites',
        `<table class="prerequisites"><thead><tr><th scope="col">Prerequisite</th><th scope="col">Status</th><th scope="col">Notes</th></tr></thead><tbody>
${model.prerequisites
  .map(item => {
    const [tone, label] = prerequisiteTone[item.status];
    const notes = [
      item.reason ? `<div class="note"><b>Reason:</b> ${escapeHtml(item.reason)}</div>` : '',
      item.resolution ? `<div class="note"><b>Resolution:</b> ${escapeHtml(item.resolution)}</div>` : '',
    ].join('');
    return `<tr><td>${escapeHtml(item.title)}</td><td><span class="pill ${tone}">${label}</span></td><td>${notes || '<span class="muted">None</span>'}</td></tr>`;
  })
  .join('\n')}
</tbody></table>`,
      ),
    );

  if (sections.risks.length)
    parts.push(
      section(
        'risks',
        'Risks',
        `<table class="risks"><thead><tr><th scope="col">Risk</th><th scope="col">Mitigation</th></tr></thead><tbody>
${sections.risks.map(item => `<tr><td>${escapeHtml(item.risk)}</td><td>${escapeHtml(item.mitigation)}</td></tr>`).join('\n')}
</tbody></table>`,
      ),
    );

  if (sections.diagrams.length)
    parts.push(
      section(
        'diagrams',
        'Diagrams',
        sections.diagrams
          .map(
            diagram => `<figure class="diagram card" aria-labelledby="diagram-${diagram.key}-title">
<h3 id="diagram-${diagram.key}-title">${escapeHtml(diagram.title)}</h3>
${drawing(options.diagramSvgs[diagram.key], diagram.title, diagram.mermaid)}
${diagram.caption ? `<figcaption>${escapeHtml(diagram.caption)}</figcaption>` : ''}
</figure>`,
          )
          .join('\n'),
      ),
    );

  const stats = [
    [number(model.budget.toolCalls), 'Tool calls'],
    [duration(model.budget.activeMinutes), 'Active time'],
    ...(model.budget.credits === null ? [] : [[number(model.budget.credits), 'Credits']]),
  ];
  parts.push(
    section(
      'budget',
      'Budget',
      `<div class="budget">${stats.map(([value, label]) => `<div class="stat card"><div class="value">${escapeHtml(value ?? '')}</div><div class="label">${escapeHtml(label ?? '')}</div></div>`).join('')}</div>`,
    ),
  );

  if (model.changes.length)
    parts.push(
      section(
        'changes',
        'Changes since approval',
        `<ul class="changes">${model.changes.map(change => `<li>${changeOrigin(change.origin, model.starterName)}<span>${escapeHtml(change.text)}</span></li>`).join('')}</ul>`,
      ),
    );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${planDocumentContentSecurityPolicy}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(model.title)}</title>
<style>${css}</style>
</head>
<body>
<main class="page">
<header class="masthead">
<div class="masthead-top">
<div>
<p class="eyebrow">Plan</p>
<h1>${escapeHtml(model.title)}</h1>
</div>
<span class="stamp ${stampTone[options.stamp.tone]}">${escapeHtml(options.stamp.text)}</span>
</div>
${model.brief ? `<div class="lede">${renderMarkdown(model.brief)}</div>` : ''}
<dl class="meta">
<div><dt>Started by</dt><dd>${escapeHtml(model.starterName)}</dd></div>
<div><dt>Revision</dt><dd class="num">${model.contentRevision}</dd></div>
<div><dt>Generated</dt><dd class="num">${escapeHtml(generated)}</dd></div>
</dl>
</header>
${parts.join('\n')}
<footer class="colophon"><span>${escapeHtml(model.title)}</span><span class="num">Revision ${model.contentRevision} · ${escapeHtml(generated)}</span></footer>
</main>
</body>
</html>
`;
}
