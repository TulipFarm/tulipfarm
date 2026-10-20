import JSZip from 'jszip';
import {
  googleAppScopes,
  googleIdentityScopes,
  googleProposalSchema,
} from '@tulipfarm/google-workspace/public-contracts';
import { planViewSchema } from '@tulipfarm/agents/plan-contracts';
import sourceDeck from '../../../test/fixtures/documents/follow-ups.pptx?url';

export const googleResultsMockId = '23232323-2323-4323-8323-232323232323';
const proposalId = '24242424-2424-4424-8424-242424242424';
const planId = '25252525-2525-4525-8525-252525252525';
const turnId = '26262626-2626-4626-8626-262626262626';
const fileId = '29292929-2929-4929-8929-292929292929';
const workspaceId = '99999999-9999-4999-8999-999999999999';
const deckName = 'TulipFarm — investor pitch draft';
const pptx = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const slides = 'application/vnd.google-apps.presentation';
const notes = '# Pitch notes\n\nA local draft saved in Files. Saving to Google is a separate action.';

async function pitchBytes() {
  const response = await fetch(sourceDeck);
  if (!response.ok) throw new Error('The local presentation fixture could not be loaded.');
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  const replacements = [
    [
      'Customer follow-ups',
      'TulipFarm',
      'Local files. Full-page viewing.',
      'Your business operations, in one conversation.',
    ],
    [
      'Next steps',
      'From a request to reviewed work',
      'Review the proposal with Northstar.',
      'Describe the work. Review the draft. Approve the action.',
    ],
  ];
  for (const [index, words] of replacements.entries()) {
    const path = `ppt/slides/slide${index + 1}.xml`;
    const source = zip.file(path);
    if (!source) throw new Error(`The local presentation fixture is missing slide ${index + 1}.`);
    zip.file(path, (await source.async('string')).replace(words[0]!, words[1]!).replace(words[2]!, words[3]!));
  }
  return zip.generateAsync({ type: 'base64' });
}

export function createGoogleResultsMock(scenario: string) {
  const createdAt = new Date().toISOString();
  const chat = {
    id: googleResultsMockId,
    title: 'Prepare our investor pitch',
    titleRevision: 1,
    titleManual: true,
    archived: false,
    activityAt: createdAt,
    createdAt,
    projectId: null,
  };
  const result = {
    untrusted: true as const,
    data: {
      id: 'local-demo-pitch',
      name: deckName,
      mimeType: slides,
      webViewLink: 'https://docs.google.com/presentation/d/local-demo-pitch/edit',
    },
  };
  const receiptStatus =
    scenario === 'slides-saved'
      ? 'succeeded'
      : scenario === 'slides-unknown'
        ? 'outcome-unknown'
        : scenario === 'slides-failed'
          ? 'failed'
          : scenario === 'slides-saving'
            ? 'executing'
            : null;
  const proposal = pitchBytes().then(contentBase64 =>
    googleProposalSchema.parse({
      id: proposalId,
      operation: {
        kind: 'drive.files.upload',
        mimeType: pptx,
        contentBase64,
        file: { name: deckName, mimeType: slides },
      },
      digest: 'f'.repeat(64),
      expiresAt: new Date(Date.now() + (scenario === 'slides-expired' ? -60000 : 3600000)).toISOString(),
      integration: {
        integrationId: workspaceId,
        accountId: 'local-demo-google',
        generation: 1,
        scopes: [],
        requiredScopes: [],
      },
      decision: receiptStatus || scenario === 'slides-approved' ? 'approve' : null,
      receipt: receiptStatus
        ? {
            status: receiptStatus,
            result: receiptStatus === 'succeeded' ? result : null,
            error:
              receiptStatus === 'outcome-unknown'
                ? 'provider-outcome-unknown'
                : receiptStatus === 'failed'
                  ? 'provider-request-failed'
                  : null,
          }
        : null,
    }),
  );
  const tasks = ['Understand the pitch', 'Prepare the presentation draft'].map((title, index) => ({
    id: `27272727-2727-4727-8727-${String(index + 1).padStart(12, '0')}`,
    key: `step-${index}`,
    parent: null,
    position: index,
    kind: 'work',
    order: 'serial',
    title,
    brief: '',
    criteria: [],
    dependsOn: [],
    state: 'completed',
    reason: null,
    assignee: null,
    summary: null,
    waitingTaskId: null,
  }));
  const plan = planViewSchema.parse({
    id: planId,
    chatId: googleResultsMockId,
    title: 'Understand the pitch and prepare a draft',
    brief: 'Prepare a draft for review. Saving it to Google is a separate action.',
    lifecycle: 'completed',
    outcome: 'completed',
    version: 1,
    canControl: true,
    createdAt,
    updatedAt: createdAt,
    pause: null,
    counts: {
      total: 2,
      pending: 0,
      ready: 0,
      running: 0,
      'waiting-input': 0,
      'waiting-approval': 0,
      blocked: 0,
      completed: 2,
      failed: 0,
      cancelled: 0,
    },
    budget: { toolCalls: 100, activeMilliseconds: 600000, credits: 100 },
    specialists: [],
    tasks,
  });
  let reads = 0;
  return async (url: URL, method: string, input: RequestInfo | URL, init?: RequestInit): Promise<Response | null> => {
    const path = url.pathname;
    if (method === 'GET' && path.endsWith('/google-workspace/availability')) return Response.json({ configured: true });
    if (method === 'GET' && path.endsWith('/google-workspace'))
      return Response.json({
        status: 'connected',
        integrationId: workspaceId,
        accountId: 'local-demo-google',
        generation: 1,
        email: 'demo@tulipfarm.test',
        scopes: [...googleIdentityScopes, ...googleAppScopes.drive, ...googleAppScopes.slides],
      });
    if (method === 'GET' && path.endsWith('/github/accounts'))
      return Response.json({ configured: false, accounts: [] });
    if (method === 'GET' && path.endsWith('/operations/proposals'))
      return Response.json({ proposals: [], nextCursor: null });
    if (scenario === 'slides-files' && method === 'GET' && path.endsWith(`/files/${fileId}`))
      return Response.json({
        id: fileId,
        kind: 'file',
        name: 'Pitch notes.md',
        mediaType: 'text/markdown',
        size: notes.length,
        parentId: null,
        creatorMembershipId: workspaceId,
        role: 'manager',
        trashed: false,
      });
    if (scenario === 'slides-files' && method === 'GET' && path.endsWith(`/files/${fileId}/content`))
      return new Response(notes, { headers: { 'Content-Type': 'text/markdown' } });
    if (scenario === 'slides-files' && method === 'POST' && path.includes('/operations/files/')) {
      const body: unknown =
        typeof init?.body === 'string' ? JSON.parse(init.body) : input instanceof Request ? await input.json() : null;
      if (!body || typeof body !== 'object' || !('fileId' in body) || body.fileId !== 'local-demo-source')
        return Response.json({ error: 'source-not-found' }, { status: 409 });
      if (path.endsWith('/metadata'))
        return Response.json({
          id: 'local-demo-source',
          name: 'Pitch source.pptx',
          mimeType: pptx,
          webViewLink: 'https://drive.google.com/file/d/local-demo-source/view',
        });
      if (path.endsWith('/content')) {
        const current = await proposal;
        if (current.operation.kind !== 'drive.files.upload')
          throw new Error('The local fixture must be a file upload.');
        return new Response(
          Uint8Array.from(atob(current.operation.contentBase64), character => character.charCodeAt(0)),
          { headers: { 'Content-Type': pptx } },
        );
      }
      return Response.json({ error: 'unsupported-demo-read' }, { status: 405 });
    }
    if (path.includes(`/operations/proposals/${proposalId}`)) {
      if (scenario === 'slides-denied') return Response.json({ error: 'not-found' }, { status: 404 });
      if (method === 'GET') {
        reads++;
        if (scenario === 'slides-slow') await new Promise(resolve => setTimeout(resolve, 2000));
        if (scenario === 'slides-error' && reads <= 3)
          return Response.json({ error: 'demo-status-unavailable' }, { status: 503 });
        return Response.json(await proposal);
      }
      const current = await proposal;
      if (method === 'POST' && path.endsWith('/decision')) {
        const body: unknown =
          typeof init?.body === 'string' ? JSON.parse(init.body) : input instanceof Request ? await input.json() : null;
        if (
          !body ||
          typeof body !== 'object' ||
          !('digest' in body) ||
          body.digest !== current.digest ||
          !('decision' in body) ||
          !['approve', 'reject'].includes(String(body.decision))
        )
          return Response.json({ error: 'invalid-request' }, { status: 400 });
        if (current.receipt || current.decision || Date.parse(current.expiresAt) <= Date.now())
          return Response.json({ error: 'operation-expired' }, { status: 409 });
        current.decision = body.decision === 'approve' ? 'approve' : 'reject';
        return Response.json(current);
      }
      if (method === 'POST' && path.endsWith('/execute')) {
        if (current.decision !== 'approve') return Response.json({ error: 'approval-required' }, { status: 409 });
        if (current.receipt) return Response.json(current.receipt);
        if (scenario === 'slides-send-error') return Response.json({ error: 'demo-response-lost' }, { status: 503 });
        current.receipt = { status: 'executing', result: null, error: null };
        await new Promise(resolve => setTimeout(resolve, 1200));
        current.receipt = { status: 'succeeded', result, error: null };
        return Response.json(current.receipt);
      }
      return Response.json({ error: 'unsupported-demo-command' }, { status: 405 });
    }
    if (method === 'GET' && path.endsWith(`/agent-plans/${planId}`)) return Response.json(plan);
    if (method === 'GET' && path.endsWith('/conversations')) return Response.json({ chats: [chat], nextCursor: null });
    if (!path.includes(`/conversations/${googleResultsMockId}`)) return null;
    if (method !== 'GET') return Response.json({ error: 'demo-has-no-live-model-or-provider-writes' }, { status: 409 });
    if (path.endsWith('/plans')) return Response.json({ plans: scenario === 'slides-empty' ? [] : [plan] });
    if (path.endsWith('/messages'))
      return Response.json({
        messages:
          scenario === 'slides-empty'
            ? []
            : [
                {
                  id: turnId,
                  sequence: 1,
                  author: 'human',
                  createdAt,
                  parts: [{ kind: 'text', text: 'Understand our pitch and prepare a Google Slides presentation.' }],
                  turn: { id: turnId, status: 'completed', generation: 0 },
                  tools: [
                    { id: proposalId, tool: 'google.propose', status: 'completed', googleProposalId: proposalId },
                    ...(scenario === 'slides-files'
                      ? [{ id: fileId, tool: 'files.create', status: 'completed', fileId }]
                      : []),
                  ],
                },
                {
                  id: '28282828-2828-4828-8828-282828282828',
                  sequence: 2,
                  author: 'assistant',
                  createdAt,
                  parts: [
                    {
                      kind: 'text',
                      text: 'The pitch draft is ready to review. Open the presentation to see the slides and its current save status.\n\n*Local demo: two seeded slides. Approval and saving are simulated; no Google account is changed.*',
                    },
                    ...(scenario === 'slides-files'
                      ? [
                          {
                            kind: 'google-file',
                            fileId: 'local-demo-source',
                            name: 'Pitch source.pptx',
                            mimeType: pptx,
                          },
                        ]
                      : []),
                  ],
                  turn: null,
                  tools: [],
                },
              ],
        nextBefore: null,
        hasGitHubProposals: false,
      });
    if (path.endsWith(`/conversations/${googleResultsMockId}`)) return Response.json(chat);
    return null;
  };
}
