export interface OimReleaseSelectionRequest {
  readonly integrationId: string;
  readonly version: string;
  readonly packageDigest: string;
}

export interface OimReleaseInspectionResult {
  readonly source: string;
  readonly ref: string;
  readonly candidates: readonly {
    readonly sourcePath: string;
    readonly integrationId: string;
    readonly version: string;
    readonly packageDigest: string;
    readonly issues: readonly string[];
    readonly review?: OimReleaseCandidateReview;
  }[];
}

export interface OimReleaseCandidateReview {
  readonly name: string;
  readonly description: string;
  readonly auth: {
    readonly credentialLabels: readonly string[];
    readonly configurationLabels: readonly string[];
    readonly steps: readonly { readonly title: string; readonly type: string }[];
  };
  readonly operations: readonly {
    readonly name: string;
    readonly description: string;
    readonly effect: string;
    readonly destination: string;
  }[];
  readonly ingress: {
    readonly events: boolean;
    readonly polling: boolean;
    readonly knowledge: boolean;
  };
}

export interface OimReleaseInstallRequest {
  readonly businessId: string;
  readonly source: string;
  readonly sourceRef: string;
  readonly slug: string;
  readonly selection: OimReleaseSelectionRequest;
  readonly trustClass: "community" | "official";
  readonly approvedCommunityDigest?: string;
  readonly autoPatchOptIn: boolean;
  readonly actorId: string;
}

export interface OimReleaseScopeRequest {
  readonly businessId: string;
  readonly integrationId: string;
  readonly majorVersion: number;
}

export interface OimReleaseGenerationRequest extends OimReleaseScopeRequest {
  readonly installationId: string;
}

export interface OimReleaseRecoveryRequest extends OimReleaseScopeRequest {
  readonly source: string;
  readonly sourceRef: string;
  readonly candidatePath: string;
  readonly slug: string;
}

export interface OimReleaseControlPlaneDeps {
  readonly inspect: (source: string, actorId: string) => Promise<OimReleaseInspectionResult>;
  readonly install: (input: OimReleaseInstallRequest) => Promise<unknown>;
  readonly uninstall: (
    input: OimReleaseGenerationRequest & { readonly actorId: string }
  ) => Promise<unknown>;
  readonly uninstallStatus: (input: OimReleaseGenerationRequest) => Promise<unknown>;
  readonly recover: (
    input: OimReleaseRecoveryRequest & { readonly actorId: string }
  ) => Promise<unknown>;
  readonly getAutoPatchPreference: (input: OimReleaseScopeRequest) => Promise<unknown>;
  readonly setAutoPatchPreference: (
    input: OimReleaseScopeRequest & { readonly enabled: boolean }
  ) => Promise<unknown>;
  readonly listTrustRoots: (includeDisabled?: boolean) => Promise<unknown>;
  readonly addTrustRoot: (input: {
    readonly purpose: "release" | "revocation";
    readonly keyId: string;
    readonly publicKeyPem: string;
    readonly actorId: string;
  }) => Promise<unknown>;
  readonly disableTrustRoot: (input: {
    readonly purpose: "release" | "revocation";
    readonly keyId: string;
    readonly actorId: string;
  }) => Promise<unknown>;
  readonly getRevocationFeed: () => Promise<unknown>;
  readonly setRevocationFeed: (input: {
    readonly url: string;
    readonly actorId: string;
  }) => Promise<unknown>;
  readonly disableRevocationFeed: (actorId: string) => Promise<unknown>;
  readonly acceptRevocationList: (
    input: unknown
  ) => Promise<{ readonly sequence: number; readonly expiresAt: string }>;
  readonly runMaintenance: (businessId: string) => Promise<unknown>;
}

export class OimReleaseControlPlane {
  constructor(private readonly deps: OimReleaseControlPlaneDeps) {}

  inspect(source: string, actorId: string): Promise<OimReleaseInspectionResult> {
    return this.deps.inspect(source, actorId);
  }

  install(input: OimReleaseInstallRequest): Promise<unknown> {
    return this.deps.install(input);
  }

  uninstall(input: OimReleaseGenerationRequest & { readonly actorId: string }): Promise<unknown> {
    return this.deps.uninstall(input);
  }

  uninstallStatus(input: OimReleaseGenerationRequest): Promise<unknown> {
    return this.deps.uninstallStatus(input);
  }

  recover(input: OimReleaseRecoveryRequest & { readonly actorId: string }): Promise<unknown> {
    return this.deps.recover(input);
  }

  getAutoPatchPreference(input: OimReleaseScopeRequest): Promise<unknown> {
    return this.deps.getAutoPatchPreference(input);
  }

  setAutoPatchPreference(
    input: OimReleaseScopeRequest & { readonly enabled: boolean }
  ): Promise<unknown> {
    return this.deps.setAutoPatchPreference(input);
  }

  listTrustRoots(includeDisabled = false): Promise<unknown> {
    return this.deps.listTrustRoots(includeDisabled);
  }

  addTrustRoot(input: {
    readonly purpose: "release" | "revocation";
    readonly keyId: string;
    readonly publicKeyPem: string;
    readonly actorId: string;
  }): Promise<unknown> {
    return this.deps.addTrustRoot(input);
  }

  disableTrustRoot(input: {
    readonly purpose: "release" | "revocation";
    readonly keyId: string;
    readonly actorId: string;
  }): Promise<unknown> {
    return this.deps.disableTrustRoot(input);
  }

  getRevocationFeed(): Promise<unknown> {
    return this.deps.getRevocationFeed();
  }

  setRevocationFeed(input: { readonly url: string; readonly actorId: string }): Promise<unknown> {
    return this.deps.setRevocationFeed(input);
  }

  disableRevocationFeed(actorId: string): Promise<unknown> {
    return this.deps.disableRevocationFeed(actorId);
  }

  acceptRevocationList(
    input: unknown
  ): Promise<{ readonly sequence: number; readonly expiresAt: string }> {
    return this.deps.acceptRevocationList(input);
  }

  runMaintenance(businessId: string): Promise<unknown> {
    return this.deps.runMaintenance(businessId);
  }
}
