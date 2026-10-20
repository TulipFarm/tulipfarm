import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWorkspaceSkills } from '../../../packages/agents/dist/workspace-skills.js';

export async function latestActivationJourney({
  page,
  origin,
  apiOrigin,
  w,
  db,
  table,
  runtime,
  saved,
  tasks,
  authoring,
  owner,
  other,
  agentId,
  definition,
  scope,
  completed,
  activationProofSkills,
  screenshotPrefix,
}) {
  const agentUrl = `${origin}/journey/agents/${agentId}`,
    startUrl = `${apiOrigin}/v1/workspaces/${w.id}/agent-tasks`;
  const skills = createWorkspaceSkills(runtime),
    skillId = randomUUID();
  const draft = await skills.save(w.id, other.user.id, skillId, {
    requestId: randomUUID(),
    expectedVersion: 0,
    definition: {
      name: 'Latest cleanup',
      description: 'Use the newly reviewed cleanup procedure.',
      instructions: 'Use the newly reviewed cleanup procedure.',
    },
  });
  await skills.review(w.id, other.user.id, skillId, {
    requestId: randomUUID(),
    expectedVersion: 1,
    revision: draft.savedRevision,
  });
  const latestSharing = await skills.sharing(w.id, other.user.id, skillId);
  await skills.share(w.id, other.user.id, skillId, {
    ...latestSharing,
    personGrants: [...latestSharing.personGrants, { membershipId: w.membershipId, permissions: ['read', 'use'] }],
  });
  const newerSkills = [definition.skills[0], { id: skillId, revision: draft.savedRevision }];
  const oldActivation = completed.activationId;
  const policy = await saved.policy(w.id, owner.user.id, agentId),
    otherMembership = (
      await db.platform.query(`SELECT id FROM ${table('tf_memberships')} WHERE user_id=$1`, [other.user.id])
    ).rows[0].id;
  await saved.updatePolicy(w.id, owner.user.id, agentId, {
    version: policy.version,
    owningTeamId: policy.owningTeamId,
    grants: policy.grants,
    personGrants: [...policy.personGrants, { membershipId: otherMembership, permissions: ['read', 'edit', 'manage'] }],
  });
  for (const { id } of definition.skills.filter(skill => /^[0-9a-f-]{36}$/.test(skill.id))) {
    const sharing = await skills.sharing(w.id, owner.user.id, id);
    await skills.share(w.id, owner.user.id, id, {
      ...sharing,
      personGrants: [...sharing.personGrants, { membershipId: otherMembership, permissions: ['read', 'use'] }],
    });
  }
  await page.goto(agentUrl);
  await page.getByRole('combobox', { name: 'Activated instructions', exact: true }).waitFor();
  assert.match(
    await page.getByRole('combobox', { name: 'Activated instructions', exact: true }).innerText(),
    /Latest eligible activation/,
  );
  await page.getByText('Uses the newest active version when the task starts.', { exact: true }).waitFor();
  const revision = await authoring.revise(other.user.id, {
    ...definition,
    instructions: 'Use the newer cleanup instructions.',
    skills: newerSkills,
  });
  const newer = await saved.activate(w.id, other.user.id, agentId, {
    requestId: 'ffffffff-ffff-4fff-bfff-fffffffffff1',
    revision,
    scope,
  });
  assert.equal((await saved.detail(w.id, owner.user.id, agentId)).activations[0].id, oldActivation);
  activationProofSkills.set('Activation proof concurrent latest', newerSkills);
  await page.getByLabel('What should this agent do?').fill('Activation proof concurrent latest');
  let lost, receipt;
  await page.route(
    startUrl,
    async route => {
      lost = route.request().postDataJSON();
      assert.equal(Object.hasOwn(lost, 'activationId'), false);
      assert.deepEqual(lost.scope, scope);
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      receipt = await response.json();
      await route.abort('failed');
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await page.getByRole('button', { name: 'Retry same operation', exact: true }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: 'Activated instructions', exact: true }).isEnabled(), false);
  assert.equal(await page.getByLabel('What should this agent do?').inputValue(), 'Activation proof concurrent latest');
  const nextRevision = await authoring.revise(other.user.id, {
    ...definition,
    instructions: 'A third revision activated after the lost response.',
  });
  const newest = await saved.activate(w.id, other.user.id, agentId, {
    requestId: '00000000-0000-4000-8000-000000000001',
    revision: nextRevision,
    scope,
  });
  await page.route(
    startUrl,
    async route => {
      assert.deepEqual(route.request().postDataJSON(), lost);
      const response = await route.fetch();
      assert.deepEqual(await response.json(), receipt);
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Retry same operation', exact: true }).click();
  await page.waitForURL(`**/agent-tasks/${receipt.id}`);
  await page
    .getByRole('region', { name: 'Latest task update', exact: true })
    .getByText('Completed Activation proof concurrent latest', { exact: true })
    .waitFor();
  const accepted = await tasks.read(w.id, owner.user.id, receipt.id);
  assert.equal(accepted.activationId, newer.activationId);
  assert.equal(accepted.definitionRevision, revision);
  assert.deepEqual(accepted.skills, newerSkills);
  assert.equal(
    (
      await db.platform.query(
        `SELECT count(*)::integer AS n FROM ${table('tf_agent_task_commands')} WHERE request_id=$1`,
        [lost.requestId],
      )
    ).rows[0].n,
    1,
  );

  const beforeFollowup = await tasks.read(w.id, owner.user.id, completed.id);
  await page.goto(`${origin}/journey/agent-tasks/${completed.id}`);
  await page.getByLabel('Follow up on this task').fill('Summarize the same task.');
  const reopenResponse = page.waitForResponse(
    response => response.url() === `${startUrl}/${completed.id}/reopen` && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Send follow-up', exact: true }).click();
  assert.equal((await reopenResponse).status(), 200);
  await page.getByLabel('Follow up on this task').waitFor();
  const followed = await tasks.read(w.id, owner.user.id, completed.id);
  assert.equal(followed.generation, beforeFollowup.generation + 1);
  assert.equal(followed.activationId, oldActivation);
  assert.equal(followed.definitionRevision, completed.definitionRevision);
  assert.deepEqual(followed.skills, completed.skills);
  assert.equal(followed.flowId, completed.flowId);

  async function start(text, expectedActivation, expectedSkills, pin) {
    activationProofSkills.set(text, expectedSkills);
    await page.goto(agentUrl);
    if (pin) {
      await page.getByRole('combobox', { name: 'Activated instructions', exact: true }).click();
      await page.getByRole('option', { name: new RegExp(pin.slice(0, 8)) }).click();
      await page
        .getByText('This task keeps the selected version even if a newer one is activated.', { exact: true })
        .waitFor();
    }
    await page.getByLabel('What should this agent do?').fill(text);
    const response = page.waitForResponse(
      response => response.url() === startUrl && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Start task', exact: true }).click();
    const result = await response;
    assert.equal(result.status(), 200);
    const body = result.request().postDataJSON();
    assert.equal(body.activationId, pin);
    const receipt = await result.json();
    await page
      .getByRole('region', { name: 'Latest task update', exact: true })
      .getByText(`Completed ${text}`, { exact: true })
      .waitFor();
    const task = await tasks.read(w.id, owner.user.id, receipt.id);
    assert.equal(task.activationId, expectedActivation);
    assert.deepEqual(task.skills, expectedSkills);
    return task;
  }
  const latest = await start('Activation proof next task', newest.activationId, definition.skills);
  assert.equal(latest.definitionRevision, nextRevision);
  await start('Activation proof explicit historical', newer.activationId, newerSkills, newer.activationId);
  await saved.activate(w.id, other.user.id, agentId, { revision, scope });
  await skills.setEnabled(w.id, other.user.id, skillId, {
    requestId: randomUUID(),
    expectedVersion: 3,
    enabled: false,
  });
  await start('Activation proof skips disabled skill', newest.activationId, definition.skills);
  await saved.activate(w.id, other.user.id, agentId, { revision: nextRevision, scope: [] });
  await page.goto(agentUrl);
  await page.getByLabel('What should this agent do?').fill('Activation proof chosen scope');
  assert.equal(await page.getByRole('button', { name: 'Start task', exact: true }).isEnabled(), false);
  await page.getByRole('combobox', { name: 'Task data scope', exact: true }).click();
  await page.getByRole('option', { name: 'No table access', exact: true }).click();
  activationProofSkills.set('Activation proof chosen scope', definition.skills);
  const scopeResponse = page.waitForResponse(
    response => response.url() === startUrl && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  const scoped = await scopeResponse;
  assert.deepEqual(scoped.request().postDataJSON().scope, []);
  assert.equal(Object.hasOwn(scoped.request().postDataJSON(), 'activationId'), false);
  await page
    .getByRole('region', { name: 'Latest task update', exact: true })
    .getByText('Completed Activation proof chosen scope', { exact: true })
    .waitFor();
  assert.deepEqual((await tasks.read(w.id, owner.user.id, (await scoped.json()).id)).scope, []);

  await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET activated_at=NULL WHERE agent_id=$1`, [agentId]);
  await page.goto(agentUrl);
  await page.getByLabel('What should this agent do?').fill('Activation proof ambiguous history');
  await page.getByRole('combobox', { name: 'Task data scope', exact: true }).click();
  await page.getByRole('option', { name: 'No table access', exact: true }).click();
  const rejected = page.waitForResponse(
    response => response.url() === startUrl && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  assert.equal((await rejected).status(), 409);
  await page
    .getByText(
      'The server cannot determine which activation is latest. Pin a specific activation in Activated instructions, then start the task again. Your message is retained.',
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.getByLabel('What should this agent do?').inputValue(), 'Activation proof ambiguous history');
  activationProofSkills.set('Activation proof ambiguous history', definition.skills);
  await page.getByRole('combobox', { name: 'Activated instructions', exact: true }).click();
  await page.getByRole('option', { name: new RegExp(oldActivation.slice(0, 8)) }).click();
  const recovered = page.waitForResponse(
    response => response.url() === startUrl && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  const recovery = await recovered;
  assert.equal(recovery.status(), 200);
  assert.equal(recovery.request().postDataJSON().activationId, oldActivation);
  assert.deepEqual(recovery.request().postDataJSON().scope, scope);
  await page
    .getByRole('region', { name: 'Latest task update', exact: true })
    .getByText('Completed Activation proof ambiguous history', { exact: true })
    .waitFor();
  await db.platform.query(`UPDATE ${table('tf_agent_activations')} SET revoked_at=now() WHERE agent_id=$1 AND id<>$2`, [
    agentId,
    oldActivation,
  ]);
  await page.goto(agentUrl);
  await page.getByRole('combobox', { name: 'Activated instructions', exact: true }).waitFor();
  await page.screenshot({ path: `${screenshotPrefix}-latest-mobile.png`, fullPage: true });
  assert.equal(
    await page
      .locator('[data-slot="page-content"]')
      .locator('..')
      .evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth)),
    true,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: `${screenshotPrefix}-latest-desktop.png`, fullPage: true });
  console.log(
    'PASS latest activation browser: concurrent activation after form load, exact omitted-ID lost-response replay after newer activation, retained follow-up pins, new-task pins, explicit historical override, distinct scope choice, unordered historical ambiguity and recovery.',
  );
}
