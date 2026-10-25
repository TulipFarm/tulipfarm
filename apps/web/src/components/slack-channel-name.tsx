import { HashIcon, LockIcon } from 'lucide-react';

/** Slack titles arrive as `#name`; the leading icon carries the `#`, so the text drops it. */
export function slackChannelLabel(title: string) {
  return title.replace(/^#/, '');
}

/** Read-only Slack lists get a search field once they hold more than this many items; pickers always have one. */
export const slackListSearchFrom = 8;

/** Case-insensitive match on a channel title that ignores a typed or stored leading `#`. */
export function slackChannelMatches(title: string, query: string) {
  const needle = slackChannelLabel(query.trim()).toLowerCase();
  return !needle || slackChannelLabel(title).toLowerCase().includes(needle);
}

/** A Slack channel name led by `#` for public channels and a lock for private ones. */
export function SlackChannelName({ title, private: isPrivate }: { title: string; private: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="inline-flex shrink-0 text-muted-foreground">
        {isPrivate ? (
          <LockIcon aria-hidden="true" className="size-4" />
        ) : (
          <HashIcon aria-hidden="true" className="size-4" />
        )}
      </span>
      <span className="min-w-0 break-words">{slackChannelLabel(title)}</span>
      {isPrivate && <span className="sr-only">(private channel)</span>}
    </span>
  );
}
