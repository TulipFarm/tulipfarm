import { z } from 'zod';
import { IntegrationError, issueResultSchema, type IssueResult } from './contracts.ts';

const responseSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().max(1024),
  body: z.string().max(65536).nullable(),
  state: z.enum(['open', 'closed']),
  pull_request: z.unknown().optional(),
});

export async function fetchIssue(
  input: { owner: string; repo: string; issueNumber: number; token: string },
  providerFetch: typeof fetch,
): Promise<IssueResult> {
  try {
    const response = await providerFetch(
      `https://api.github.com/repos/${input.owner}/${input.repo}/issues/${input.issueNumber}`,
      {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${input.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'TulipFarm',
        },
      },
    );
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 262144) throw new Error();
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const issue = responseSchema.parse(payload);
    if (issue.pull_request !== undefined || issue.number !== input.issueNumber) throw new Error();
    const redact = (value: string) => value.replaceAll(input.token, '[redacted]');
    return issueResultSchema.parse({
      number: issue.number,
      title: redact(issue.title),
      body: redact(issue.body ?? ''),
      state: issue.state,
      url: `https://github.com/${input.owner}/${input.repo}/issues/${input.issueNumber}`,
    });
  } catch {
    throw new IntegrationError('provider-failed');
  }
}
