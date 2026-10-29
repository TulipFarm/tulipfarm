import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export function reviewDefinition(name, trigger = { kind: 'manual' }) {
  return {
    version: 1,
    name,
    trigger,
    steps: [
      { id: 'request', kind: 'transform', fields: { request: { kind: 'input', path: [] } } },
      { id: 'review', kind: 'human', prompt: 'Review this request and provide your decision.', timeoutSeconds: 86400 },
      { id: 'result', kind: 'transform', fields: { decision: { kind: 'step', step: 'review', path: [] } } },
    ],
  };
}

export async function saveWorkflow(service, workspace, definition, previous) {
  const id = previous?.id ?? randomUUID(),
    revision = randomUUID();
  const workflow = await service.save(workspace.id, workspace.userId, id, {
    revision,
    expectedRevision: previous?.revision ?? null,
    definition,
  });
  assert.equal(workflow.revision, revision);
  const detail = await service.definition(workspace.id, workspace.userId, id, { revision });
  assert.equal(detail.savedRevision, revision);
  assert.deepEqual(detail.definition, workflow.definition);
  return workflow;
}

export async function showWorkflowList(page) {
  const breadcrumb = page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'Workflows', exact: true });
  if (await breadcrumb.count()) await breadcrumb.click();
  await page.getByRole('region', { name: 'Workflow selection', exact: true }).waitFor();
}

export async function openWorkflow(page, workflow) {
  await showWorkflowList(page);
  await Promise.all([
    page.waitForResponse(
      response =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname.endsWith('/workflows') &&
        response.ok(),
    ),
    page.getByRole('button', { name: 'Refresh workflows', exact: true }).click(),
  ]);
  const [response] = await Promise.all([
    page.waitForResponse(
      response =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname.endsWith(`/workflows/${workflow.id}`) &&
        new URL(response.url()).searchParams.get('revision') === 'saved',
    ),
    page.getByRole('link', { name: workflow.definition.name, exact: true }).click(),
  ]);
  assert.equal(response.status(), 200);
  assert.equal((await response.json()).revision, workflow.revision);
  const viewer = page.getByRole('region', { name: `${workflow.definition.name} workflow`, exact: true });
  await viewer.getByRole('heading', { name: workflow.definition.name, exact: true }).waitFor();
  await viewer.getByRole('button', { name: 'Edit in chat', exact: true }).waitFor();
  assert.equal(await viewer.getByRole('button', { name: 'Diagram', exact: true }).getAttribute('aria-pressed'), 'true');
  const diagram = viewer.getByRole('figure', { name: 'Read-only workflow diagram', exact: true });
  await diagram
    .getByRole('button', { name: /^Inspect / })
    .first()
    .waitFor();
  assert.equal(await diagram.getByRole('button', { name: /^Inspect / }).count(), workflow.definition.steps.length + 1);
  assert.equal(await page.getByLabel('Name', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Workflow definition JSON', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Save revision', exact: true }).count(), 0);
  return viewer;
}

export async function assertConfiguration(viewer, ordinal, expected) {
  await viewer.getByRole('button', { name: 'Steps', exact: true }).click();
  await viewer.getByRole('list', { name: 'Workflow steps', exact: true }).getByRole('button').nth(ordinal).click();
  const inspector = viewer.getByRole('region', { name: 'Step details', exact: true });
  const details = inspector.getByRole('button', { name: 'Details', exact: true });
  if ((await details.getAttribute('aria-expanded')) !== 'true') await details.click();
  const configuration = inspector.locator('pre').last();
  await configuration.waitFor();
  assert.deepEqual(JSON.parse(await configuration.textContent()), expected);
  return inspector;
}
