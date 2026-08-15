import type {
  PresentationContext,
  SurfaceComponentDefinition,
  SurfaceRendererManifest,
  SurfaceTarget,
} from "@tulipfarm/surface";
import type { HostedTurnRef } from "./authority";
import type { PrincipalCredentialReader } from "./credential-mode";
import type { SurfacePresentationPort } from "./ports";

/** Shared doubles for Tool host tests. Not exported from the package index. */

export const BUSINESS_ID = "tulipfarm-local";
export const CONVERSATION_ID = "conversation-1";
export const TURN_ID = "turn-1";
export const RUN_ID = "run-1";

export function turnRef(overrides: Partial<HostedTurnRef> = {}): HostedTurnRef {
  return { id: TURN_ID, conversationId: CONVERSATION_ID, attempt: 1, ...overrides };
}

const MANIFEST: SurfaceRendererManifest = {
  target: { channel: "web", surface: "chat" },
  renderer: "test",
  version: "1.0",
} as unknown as SurfaceRendererManifest;

/** Renders nothing, but answers every question a real renderer registry would. */
export class FakeSurfacePresentation implements SurfacePresentationPort {
  contextFor(target: SurfaceTarget, destination: string): PresentationContext {
    return { target, destination, rendererCapabilities: {} } as PresentationContext;
  }

  catalogFor(): readonly SurfaceComponentDefinition[] {
    return [];
  }

  catalogRevisionFor(): string {
    return "catalog-revision";
  }

  manifestFor(): SurfaceRendererManifest | undefined {
    return MANIFEST;
  }
}

/** Records only which principal holds a credential for which provider — all the resolver reads. */
export interface ConnectedCredential {
  readonly principalKind: string;
  readonly principalId: string;
  readonly provider: string;
  /** The rest of a real credential row. Nothing here is read; it keeps fixtures realistic. */
  readonly [field: string]: unknown;
}

export class InMemoryPrincipalCredentialReader implements PrincipalCredentialReader {
  private readonly rows = new Map<string, ConnectedCredential>();

  private key(principal: { readonly kind: string; readonly id: string }, provider: string): string {
    return `${principal.kind}\u0000${principal.id}\u0000${provider}`;
  }

  async upsert(doc: ConnectedCredential): Promise<void> {
    this.rows.set(this.key({ kind: doc.principalKind, id: doc.principalId }, doc.provider), doc);
  }

  /** A revoked credential resolves to `null` on the next call, matching the real repository. */
  async revoke(
    principal: { readonly kind: string; readonly id: string },
    provider: string
  ): Promise<boolean> {
    return this.rows.delete(this.key(principal, provider));
  }

  async find(
    principal: { readonly kind: string; readonly id: string },
    provider: string
  ): Promise<ConnectedCredential | null> {
    return this.rows.get(this.key(principal, provider)) ?? null;
  }
}
