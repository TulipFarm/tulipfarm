import { marketplacePackage } from '@tulipfarm/config/package-links';
import { systemPackageSchema } from './system-package-contracts.ts';
import { fetchPublicFile } from './web-fetch.ts';

export async function inspectMarketplacePackage(input: string, signal: AbortSignal) {
  const link = marketplacePackage(input);
  if (!link) return { error: 'marketplace-package-url-required', installed: false };
  const fetched = await fetchPublicFile(link.url, signal, { redirect: 'error' });
  if (fetched.kind !== 'file')
    return { error: fetched.kind === 'failed' ? fetched.reason : 'package-json-required', installed: false };
  if (fetched.url !== link.url) return { error: 'package-redirect-refused', installed: false };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fetched.bytes));
  } catch {
    return { error: 'package-json-invalid', installed: false };
  }
  const parsed = systemPackageSchema.safeParse(value);
  if (!parsed.success) return { error: 'package-schema-invalid', installed: false };
  const document = parsed.data;
  if (document.package.name !== link.name || document.package.version !== link.version)
    return { error: 'package-identity-mismatch', installed: false };
  return {
    url: link.url,
    digest: fetched.sha256,
    untrusted: true,
    installed: false,
    workspaceValidated: false,
    package: document.package,
    inputs: document.inputs,
    requires: document.requires,
    resources: document.resources,
    outputs: document.outputs,
    instruction:
      'This inspection made no workspace changes. For installation, the human uses the A2UI package form to choose inputs, check compatibility and approve the exact package once. The installer then runs without per-resource approval prompts. An inspection is neither installation nor approval.',
  };
}
