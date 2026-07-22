/** Provider-neutral external identity resolution request. */
export interface IdentityResolutionRequest {
  readonly businessId: string;
  readonly provider: string;
  readonly externalSubject: string;
  /** Opaque reference to verified authentication evidence; never a token or assertion body. */
  readonly evidenceRef?: string;
}

/** Resolved TulipFarm principal mapping returned by an identity adapter. */
export interface IdentityResolution {
  readonly principalId: string;
  readonly principalKind: "user" | "agent" | "service" | "guest";
  readonly provider: string;
  readonly externalSubject: string;
}

/** Identity adapters resolve verified external subjects without leaking provider-specific types. */
export interface IdentityPort {
  resolve(request: IdentityResolutionRequest): Promise<IdentityResolution | null>;
}
