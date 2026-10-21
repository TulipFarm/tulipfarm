export interface TenantRuntime<Context> {
  transaction<Value>(
    tenantId: string,
    options: { deadlineAt?: number },
    operation: (context: Context) => Promise<Value>,
  ): Promise<Value>;
}

export type StorageErrorPolicy = {
  timeout(): Error;
  deadline(error: unknown): boolean;
  transient(error: unknown): boolean;
};
