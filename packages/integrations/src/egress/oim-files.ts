interface OimFile {
  readonly id: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
}

export interface OimFilePort {
  content(input: {
    readonly businessId: string;
    readonly fileId: string;
    readonly principalId: string;
  }): Promise<{ readonly file: OimFile; readonly body: AsyncIterable<Uint8Array> }>;
  store(input: {
    readonly businessId: string;
    readonly ownerPrincipalId: string;
    readonly filename: string;
    readonly claimedMediaType: string;
    readonly declaredBytes: number;
    readonly body: AsyncIterable<Uint8Array>;
  }): Promise<OimFile>;
}
