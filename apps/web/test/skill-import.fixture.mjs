import { randomUUID } from 'node:crypto';
import { buildSkillPackage, skillDefinitionRevision } from '@tulipfarm/agents/skill-packages';
import { workspaceSkillReceiptSchema } from '@tulipfarm/agents/workspace-skill-contracts';
import { createWorkspaceFixture } from './workspace.fixture.mjs';
import { chatCatalog } from './chat-catalog.fixture.mjs';
import { membership, credits } from './chat-query.fixture.mjs';

export function skillImportFixture() {
  const { workspace, session } = createWorkspaceFixture();
  const files = [
    {
      path: 'SKILL.md',
      bytes: Buffer.from(
        '---\nname: monthly-close\ndescription: Prepare a monthly close with a clear list of checks.\nlicense: MIT\n---\nRead [the guide](references/guide.md), check the totals, and ask before any change.',
      ),
    },
    {
      path: 'references/guide.md',
      bytes: Buffer.from(
        'Use the current records. Report missing inputs before continuing.\n\n<img src="https://external.invalid/tracker">',
      ),
    },
  ];
  const built = buildSkillPackage(files),
    revision = skillDefinitionRevision(built.definition);
  const candidate = {
    id: randomUUID(),
    path: 'skills/monthly-close',
    definition: built.definition,
    source: {
      submittedUrl: 'https://github.com/example/business-skills',
      canonicalUrl: 'https://github.com/example/business-skills/tree/0123456789abcdef0123456789abcdef01234567',
      digest: 'a'.repeat(40),
      commit: 'a'.repeat(40),
    },
    report: null,
  };
  const report = {
    version: 1,
    packageDigest: built.definition.package.digest,
    runtimeProfile: 'skill-runtime-v1',
    deterministic: [],
    ai: {
      summary:
        'This procedure asks before changing records. Check the named external actions against your tool access.',
      findings: [
        {
          severity: 'high',
          path: 'SKILL.md',
          line: 7,
          message: 'Business changes still require the normal tool permissions and approval.',
        },
      ],
    },
    unreviewedFiles: [],
  };
  const imports = new Map();
  const installed = [];
  let loseDecision = false;
  const requests = [];
  function respond(method, inputUrl, body) {
    const url = new URL(inputUrl, 'http://localhost'),
      path = url.pathname,
      base = `/v1/workspaces/${workspace.id}`;
    requests.push({ method, path, body });
    const fixed = new Map([
      ['/v1/auth/get-session', session],
      ['/v1/user/visit', { firstSession: false }],
      ['/v1/workspaces', [workspace]],
      [`/v1/workspaces/${workspace.slug}`, workspace],
      [`${base}/governance/me`, membership],
      [`${base}/credits`, credits],
      [`${base}/model-catalog`, chatCatalog],
      [`${base}/projects`, []],
      [`${base}/governance/teams`, []],
      [`${base}/governance/members`, []],
    ]);
    const answer = (json, status = 200) => ({ status, json: structuredClone(json) });
    if (fixed.has(path)) return answer(fixed.get(path));
    if (path === `${base}/skills`)
      return answer({
        workspace: installed.map(item => ({
          id: item.id,
          revision,
          name: built.definition.name,
          description: built.definition.package.manifest.metadata.description,
          source: 'GitHub',
          status: 'enabled',
        })),
        nextCursor: null,
      });
    const match = new RegExp(`^${base}/skill-imports/([^/]+)(.*)$`).exec(path);
    if (match) {
      const [, id, rest] = match;
      if (method === 'PUT' && !rest && !imports.has(id))
        imports.set(id, {
          id,
          input: { kind: 'url', url: body.url },
          status: 'discovered',
          candidates: [candidate, { ...candidate, id: randomUUID(), path: 'skills/another/monthly-close' }],
          selected: [],
          links: [],
          digest: 'b'.repeat(64),
          error: null,
          expiresAt: '2099-01-01T00:00:00.000Z',
          receipts: [],
        });
      const view = imports.get(id);
      if (!view) return answer({ error: 'skill-import-not-found' }, 404);
      if (rest.startsWith('/packages/')) {
        const file = files.find(file => file.path === url.searchParams.get('path'));
        return file
          ? answer({
              path: file.path,
              kind: 'text',
              size: file.bytes.length,
              text: file.bytes.toString(),
              nextOffset: null,
            })
          : answer({ error: 'package-unavailable' }, 404);
      }
      if (rest === '/selection') {
        view.selected = body.selected;
        view.status = 'ready';
        view.candidates = view.candidates.map(item => ({ ...item, report }));
      }
      if (rest === '/cancel') view.status = 'cancelled';
      if (rest === '/decision') {
        if (!view.receipts.length) {
          for (const selected of view.selected) {
            const receipt = workspaceSkillReceiptSchema.parse({
              id: selected,
              version: 2,
              savedRevision: revision,
              activeRevision: revision,
              enabled: true,
            });
            installed.push(receipt);
            view.receipts.push(receipt);
          }
          view.status = 'installed';
        }
        if (loseDecision) {
          loseDecision = false;
          return answer({ error: 'skill-import-unavailable' }, 503);
        }
        return answer(view.receipts);
      }
      return answer(view);
    }
    const skill = installed.find(item => path.startsWith(`${base}/skills/${item.id}`));
    if (skill) {
      if (path.endsWith('/history'))
        return answer({
          items: [
            {
              revision,
              createdAt: '2026-10-09T12:00:00.000Z',
              provenance: {
                source: candidate.source,
                path: candidate.path,
                kind: 'url',
                parentRevision: null,
                localChanges: false,
              },
            },
          ],
          nextOffset: null,
        });
      if (path.endsWith('/runtime')) return answer({ available: false, profile: 'skill-runtime-v1' });
      if (path.endsWith('/provenance'))
        return answer({
          source: candidate.source,
          path: candidate.path,
          report,
          kind: 'url',
          parentRevision: null,
          localChanges: false,
        });
      if (path.includes('/revisions/')) {
        const file = files.find(file => file.path === url.searchParams.get('path'));
        return file
          ? answer({
              path: file.path,
              kind: 'text',
              size: file.bytes.length,
              text: file.bytes.toString(),
              nextOffset: null,
            })
          : answer({ error: 'package-unavailable' }, 404);
      }
      if (path.endsWith('/sharing')) return answer({ version: 1, grants: [], personGrants: [] });
      return answer({
        id: skill.id,
        revision,
        definition: built.definition,
        reviewedDefinition: built.definition,
        management: skill,
        canReview: true,
        lifecycle: 'active',
        canManageLifecycle: false,
      });
    }
    return answer({ error: 'not-found' }, 404);
  }
  return {
    workspace,
    session,
    imports,
    installed,
    respond,
    requests,
    loseNextDecision() {
      loseDecision = true;
    },
  };
}
