import { useState } from 'react';
import { Button } from '@tulipfarm/sprout/button';
import type { ConversationApi } from './conversation-api';
import { AuthoringDraftCard } from './authoring-draft-card';
import { rowDraftElementId } from './row-draft-card';

/**
 * Shown when chat refused a row write because an earlier row card for the same table is still undecided, so the
 * person learns why nothing changed and can reach that card. It is shown here instead when it isn't loaded above.
 */
export function WaitingRowDraft({
  api,
  chatId,
  draft,
}: {
  api: ConversationApi;
  chatId: string;
  draft: { id: string; table?: string | undefined };
}) {
  const [inline, setInline] = useState(false);
  return (
    <section aria-label="Row change waiting for approval" className="space-y-2">
      <p className="text-sm">
        Nothing new was added. A row change{draft.table ? ` to ${draft.table}` : ''} is waiting for your approval on an
        earlier card in this chat. Approve or dismiss it first.
      </p>
      {inline ? (
        <AuthoringDraftCard api={api} chatId={chatId} id={draft.id} />
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const card = document.getElementById(rowDraftElementId(draft.id));
            if (!card) return setInline(true);
            card.scrollIntoView({ behavior: 'smooth', block: 'start' });
            card.focus({ preventScroll: true });
          }}
        >
          Go to waiting card
        </Button>
      )}
    </section>
  );
}
