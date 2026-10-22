import { createConversationRequests } from '../src/requests.ts';
import { createInternalConversations } from '../src/internal.ts';
import { internalFixture } from './internal-fixture.mjs';

export async function requestFixture(extend, prepareInitialAdmin) {
  const f = await internalFixture(extend, prepareInitialAdmin);
  try {
    const requests = createConversationRequests(f.runtime);
    async function start() {
      const { callId: _callId, ...run } = await f.run();
      return createInternalConversations(f.runtime).claim(run);
    }
    return { ...f, requests, start };
  } catch (error) {
    await f.close();
    throw error;
  }
}
