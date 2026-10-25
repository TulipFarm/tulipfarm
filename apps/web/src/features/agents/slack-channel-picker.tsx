import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@tulipfarm/sprout/combobox';
import { SlackChannelName, slackChannelLabel, slackChannelMatches } from '@/components/slack-channel-name';
import type { SlackConversationChoice } from '@/features/integrations/slack-knowledge-api';

/** A searchable list of the public and private channels on the loaded page of Slack choices. */
export function SlackChannelPicker({
  id,
  items,
  value = null,
  placeholder,
  disabled,
  invalid,
  describedBy,
  isTaken,
  onPick,
}: {
  id: string;
  items: readonly SlackConversationChoice[];
  value?: string | null;
  placeholder: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string | undefined;
  isTaken?: (conversationId: string) => boolean;
  onPick: (item: SlackConversationChoice) => void;
}) {
  const channels = items.filter(item => item.kind === 'public' || item.kind === 'private');
  const byId = new Map(channels.map(item => [item.conversationId, item]));
  const title = (conversationId: string) => byId.get(conversationId)?.title ?? conversationId;
  return (
    <Combobox<string>
      items={channels.map(item => item.conversationId)}
      value={value}
      disabled={disabled}
      itemToStringLabel={conversationId => slackChannelLabel(title(conversationId))}
      filter={(conversationId, query) => slackChannelMatches(title(conversationId), query)}
      onValueChange={conversationId => {
        const item = conversationId ? byId.get(conversationId) : undefined;
        if (item) onPick(item);
      }}
    >
      <ComboboxInput
        id={id}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      />
      <ComboboxContent>
        <ComboboxEmpty>No channels on this page match.</ComboboxEmpty>
        <ComboboxList>
          {(conversationId: string) => {
            const item = byId.get(conversationId);
            return (
              item && (
                <ComboboxItem key={conversationId} value={conversationId} disabled={isTaken?.(conversationId)}>
                  <SlackChannelName title={item.title} private={item.kind === 'private'} />
                </ComboboxItem>
              )
            );
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
