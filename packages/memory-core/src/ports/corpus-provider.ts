type CorpusOperation = { input: unknown[]; result: unknown };

export interface CorpusProvider<
  Operations extends {
    discover: CorpusOperation;
    fetch: CorpusOperation;
    permissions: CorpusOperation;
  },
> {
  discover(...input: Operations['discover']['input']): Promise<Operations['discover']['result']>;
  fetch(...input: Operations['fetch']['input']): Promise<Operations['fetch']['result']>;
  /** Provider evidence is not a grant of authority; the host still decides access. */
  permissions(...input: Operations['permissions']['input']): Promise<Operations['permissions']['result']>;
}
