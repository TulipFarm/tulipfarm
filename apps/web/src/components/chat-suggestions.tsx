import { ArrowUpRight } from 'reicon-react/icons/ArrowUpRight';

export function ChatSuggestions({
  suggestions,
  onSelect,
  disabled = false,
}: {
  suggestions: readonly string[];
  onSelect: (suggestion: string) => void;
  disabled?: boolean;
}) {
  return (
    <div data-slot="chat-suggestions" className="flex flex-wrap gap-2" role="group" aria-label="Suggested prompts">
      {suggestions.map(suggestion => (
        <button
          key={suggestion}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(suggestion)}
          className="flex min-h-9 max-w-full items-center gap-1.5 rounded-xl border bg-card px-3 py-2 text-left text-xs font-medium shadow-xs transition hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
        >
          {suggestion}
          <ArrowUpRight size={12} aria-hidden="true" className="shrink-0 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}
