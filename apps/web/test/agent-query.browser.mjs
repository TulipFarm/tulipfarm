import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

test(
  'task accounting invalidates credits once, reads share cache, and skill writes survive unmount without replay',
  { timeout: 60000 },
  async () => {
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { port: 0 },
      plugins: [
        {
          name: 'agent-query-proof',
          configureServer(server) {
            server.middlewares.use('/agent-query-proof', async (_request, response) => {
              response.setHeader('Content-Type', 'text/html');
              response.end(await server.transformIndexHtml('/agent-query-proof', '<html><body></body></html>'));
            });
          },
        },
      ],
    });
    await server.listen();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.goto(`${server.resolvedUrls.local[0]}agent-query-proof`);
      const result = await page.evaluate(async () => {
        const {
          React,
          createRoot,
          SessionQueryProvider,
          WorkspaceQueryProvider,
          useFeatureRead,
          useTaskDetail,
          useSkillApi,
          useSkills,
          useReviewedSkills,
          useAgentAccessChanges,
        } = await import('/test/agent-query-fixture.tsx');
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const wait = async predicate => {
          for (let i = 0; i < 300 && !predicate(); i++) await sleep(10);
          if (!predicate()) throw new Error(`Timed out: ${document.body.textContent}`);
        };
        const root = createRoot(document.body.appendChild(document.createElement('div')));
        const scope = {
          kind: 'workspace',
          userId: 'reader',
          workspaceId: '10000000-0000-4000-8000-000000000001',
          membershipId: 'member',
        };
        const admitted = () => true,
          subscribe = () => () => {};
        const calls = { task: 0, credits: 0, models: 0, skills: 0, reviewed: 0, writes: 0 };
        let task = {
          id: 'task',
          generation: 0,
          status: 'pending',
          cost: { chargedCreditUnits: '0', heldCreditUnits: '100' },
        };
        let taskError = 0,
          refreshTask,
          save,
          releaseWrite,
          writer = true,
          hidden = false,
          changeAccess,
          holdAccess = false,
          releaseAccess;
        const api = {
          read: async () => {
            calls.task++;
            if (taskError) throw Object.assign(new Error('failed'), { status: taskError });
            return structuredClone(task);
          },
        };
        const originalFetch = window.fetch;
        window.fetch = async (input, init) => {
          const url = String(input);
          if (!url.includes('/skills')) return originalFetch(input, init);
          if (init?.method === 'PUT') {
            calls.writes++;
            await new Promise(resolve => {
              releaseWrite = resolve;
            });
            return Response.json({
              id: '20000000-0000-4000-8000-000000000001',
              version: 1,
              savedRevision: 'a'.repeat(64),
              activeRevision: null,
              enabled: false,
            });
          }
          if (url.includes('view=reviewed')) calls.reviewed++;
          else calls.skills++;
          return Response.json({ workspace: [], nextCursor: null });
        };
        function Task() {
          const read = useTaskDetail(api, 'task');
          refreshTask = read.refresh;
          return React.createElement('output', { id: 'task' }, JSON.stringify(read.state));
        }
        function Credits() {
          const read = useFeatureRead({ key: ['credits', 'balance'], load: async () => ++calls.credits });
          return React.createElement('output', null, read.state.kind);
        }
        function Models() {
          useFeatureRead({ key: ['models', 'catalog'], load: async () => ++calls.models });
          return null;
        }
        function Skills() {
          const api = useSkillApi(scope.workspaceId);
          useSkills(api);
          useReviewedSkills(api);
          return null;
        }
        function Writer() {
          const api = useSkillApi(scope.workspaceId);
          save = () =>
            api.send('20000000-0000-4000-8000-000000000001', {
              kind: 'save',
              requestId: '30000000-0000-4000-8000-000000000001',
              expectedVersion: 0,
              definition: {
                name: 'Procedure',
                description: 'Follow the procedure steps.',
                instructions: 'Follow steps.',
              },
            });
          return null;
        }
        function Protected() {
          changeAccess = useAgentAccessChanges();
          const read = useFeatureRead({
            key: ['agents', 'detail', 'protected'],
            load: async () => {
              if (holdAccess)
                await new Promise(resolve => {
                  releaseAccess = resolve;
                });
              return 'private definition';
            },
          });
          return React.createElement('output', { id: 'protected' }, JSON.stringify(read.state));
        }
        const render = () =>
          root.render(
            React.createElement(
              SessionQueryProvider,
              { identity: { userId: scope.userId, sessionId: 'session' } },
              React.createElement(
                WorkspaceQueryProvider,
                { scope, admitted, subscribe },
                React.createElement(Task),
                React.createElement(Task),
                React.createElement(Credits),
                React.createElement(Credits),
                React.createElement(Models),
                React.createElement(Skills),
                React.createElement(Protected),
                writer ? React.createElement(Writer) : null,
              ),
            ),
          );
        render();
        await wait(
          () =>
            calls.task === 1 &&
            calls.credits >= 1 &&
            calls.skills >= 1 &&
            document.querySelector('#task').textContent.includes('ready'),
        );
        await sleep(100);
        const initial = { ...calls };
        window.dispatchEvent(new Event('focus'));
        await sleep(100);
        const focus = { ...calls };
        await refreshTask();
        await sleep(100);
        const unchangedCredits = calls.credits === initial.credits;
        task = { ...task, status: 'completed', cost: { chargedCreditUnits: '75', heldCreditUnits: '0' } };
        await refreshTask();
        await wait(() => calls.credits === initial.credits + 1);
        await refreshTask();
        await sleep(100);
        const completed = { credits: calls.credits - initial.credits, models: calls.models - initial.models };
        taskError = 422;
        await refreshTask();
        await wait(() => document.querySelector('#task').textContent.includes('Check your connection'));
        const retained = document.querySelector('#task').textContent.includes('completed');
        taskError = 403;
        await refreshTask();
        await wait(() => document.querySelector('#task').textContent.includes('unavailable'));
        const concealed = !document.querySelector('#task').textContent.includes('completed');
        taskError = 0;
        task = { ...task, status: 'pending' };
        await refreshTask();
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => (hidden ? 'hidden' : 'visible'),
        });
        hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        const beforeHidden = calls.task;
        await sleep(2200);
        const hiddenReads = calls.task - beforeHidden;
        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        await sleep(150);
        const immediateResumeReads = calls.task - beforeHidden;
        await wait(() => calls.task > beforeHidden);
        task = { ...task, status: 'completed' };
        await refreshTask();
        await sleep(100);
        const beforeWrite = { ...calls };
        const pendingWrite = save();
        await wait(() => calls.writes === 1);
        writer = false;
        render();
        await sleep(50);
        releaseWrite();
        await pendingWrite;
        await wait(() => calls.skills > beforeWrite.skills && calls.reviewed > beforeWrite.reviewed);
        window.dispatchEvent(new Event('online'));
        window.dispatchEvent(new Event('focus'));
        await sleep(150);
        const afterWrite = {
          writes: calls.writes,
          skills: calls.skills - beforeWrite.skills,
          reviewed: calls.reviewed - beforeWrite.reviewed,
        };
        holdAccess = true;
        const accessChange = changeAccess([['agents', 'detail', 'protected']]);
        await wait(
          () => !!releaseAccess && !document.querySelector('#protected').textContent.includes('private definition'),
        );
        const grantConcealed = !document.querySelector('#protected').textContent.includes('private definition');
        releaseAccess();
        await accessChange;
        await wait(() => document.querySelector('#protected').textContent.includes('private definition'));
        root.unmount();
        window.fetch = originalFetch;
        return {
          initialTaskReads: initial.task,
          focusUnchanged: JSON.stringify(initial) === JSON.stringify(focus),
          unchangedCredits,
          completed,
          retained,
          concealed,
          hiddenReads,
          immediateResumeReads,
          afterWrite,
          grantConcealed,
        };
      });
      assert.deepEqual(result, {
        initialTaskReads: 1,
        focusUnchanged: true,
        unchangedCredits: true,
        completed: { credits: 1, models: 0 },
        retained: true,
        concealed: true,
        hiddenReads: 0,
        immediateResumeReads: 0,
        afterWrite: { writes: 1, skills: 1, reviewed: 1 },
        grantConcealed: true,
      });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
