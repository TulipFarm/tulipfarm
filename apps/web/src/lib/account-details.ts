import { accountSignInMethodsSchema } from '@tulipfarm/workspaces/contracts';
import { apiOrigin } from './auth';
import { jsonResponse, readJson } from './http';

class AccountDetailsError extends Error {
  constructor(readonly status: number) {
    super('Your sign-in methods could not be loaded. Try again.');
  }
}

export async function accountSignInMethods(signal: AbortSignal) {
  const response = await jsonResponse(`${apiOrigin}/v1/account/sign-in-methods`, { signal, cache: 'no-store' });
  if (!response.ok) throw new AccountDetailsError(response.status);
  return accountSignInMethodsSchema.parse(await readJson(response));
}
