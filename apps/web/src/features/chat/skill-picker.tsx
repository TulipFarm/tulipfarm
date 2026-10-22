import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
  type SyntheticEvent,
} from 'react';
import { BookOpen } from 'reicon-react/icons/BookOpen';
import { Compress } from 'reicon-react/icons/Compress';
import { X } from 'reicon-react/icons/X';
import { Badge } from '@tulipfarm/sprout/badge';
import { Button } from '@tulipfarm/sprout/button';
import { Separator, SeparatorContent, SeparatorIcon } from '@tulipfarm/sprout/separator';
import { MentionList, MentionOption, MentionStatus } from '@tulipfarm/sprout/mention-list';
import { requestSignal } from '@/lib/http';
import { skillApi } from '@/features/skills/api';
import type { SkillReference } from './conversation-api';
import { skillAt } from './skill-trigger';
import type { RichTextEditorHandle } from '@tulipfarm/sprout/rich-text-editor';
import {
  EditorSuggestionPanel,
  suggestionExtension,
  type EditorSuggestionItem,
  type EditorSuggestionState,
} from './editor-extensions';
import { compactCommandName } from './compaction-copy';

type ReviewedSkill = Awaited<ReturnType<ReturnType<typeof skillApi>['reviewed']>>['workspace'][number];
type SkillOption = { skill: SkillReference; description: string };
type Search = { kind: 'loading' } | { kind: 'ready'; options: SkillOption[] } | { kind: 'error' };

const resultLimit = 8;
const version = (revision: string) => `Version ${revision.slice(0, 8)}`;
const label = (skill: SkillReference) => `${skill.name} · ${version(skill.revision)}`;

function group(skills: ReviewedSkill[], origin: string): SkillOption[] {
  return [...skills]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(item => ({
      skill: { skillId: item.id, revision: item.revision, name: item.name },
      description: `${origin} · ${version(item.revision)}`,
    }));
}

export function useSkillPicker(
  workspaceId: string,
  text: string,
  setText: (text: string) => void,
  input: RefObject<HTMLTextAreaElement | null>,
  enabled: boolean,
) {
  const api = useMemo(() => skillApi(workspaceId), [workspaceId]);
  const listId = useId();
  const [staged, setStaged] = useState<SkillReference | null>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [search, setSearch] = useState<Search>({ kind: 'loading' });
  const [active, setActive] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const trigger = enabled && caret !== null ? skillAt(text, caret) : null;
  const open = trigger !== null && trigger.start !== dismissed;
  const query = open ? trigger.query.trim() : null;

  useEffect(() => {
    if (query === null) return;
    const controller = new AbortController();
    setSearch(current => (current.kind === 'ready' ? current : { kind: 'loading' }));
    const timer = setTimeout(() => {
      api.reviewed(requestSignal(controller.signal), undefined, query, resultLimit).then(
        page => {
          setSearch({ kind: 'ready', options: group(page.workspace, 'Workspace skill') });
          setActive(0);
        },
        () => {
          if (!controller.signal.aborted) setSearch({ kind: 'error' });
        },
      );
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, query, attempt]);

  const options = search.kind === 'ready' ? search.options : [];
  const current = Math.min(active, Math.max(0, options.length - 1));
  const optionId = (index: number) => `${listId}-option-${index}`;

  function track(event: SyntheticEvent<HTMLTextAreaElement>) {
    const { selectionStart, selectionEnd, value } = event.currentTarget;
    const next = selectionStart === selectionEnd ? selectionStart : null;
    setCaret(next);
    if (next === null || !skillAt(value, next)) setDismissed(null);
  }

  function place(field: HTMLTextAreaElement, at: number) {
    requestAnimationFrame(() => {
      field.setSelectionRange(at, at);
      field.focus();
    });
  }
  function select(option: SkillOption) {
    if (!trigger || !input.current) return;
    setStaged(option.skill);
    setText(text.slice(0, trigger.start) + text.slice(trigger.end));
    setCaret(null);
    place(input.current, trigger.start);
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!open || !trigger || event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setDismissed(trigger.start);
      return;
    }
    if (search.kind === 'error' && event.key === 'Enter') {
      event.preventDefault();
      setAttempt(value => value + 1);
      return;
    }
    if (!options.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
    } else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      const option = options[current];
      if (!option) return;
      event.preventDefault();
      select(option);
    }
  }

  const status =
    search.kind === 'loading' ? (
      <MentionStatus tone="loading">Loading skills…</MentionStatus>
    ) : search.kind === 'error' ? (
      <MentionStatus tone="error" action={{ label: 'Retry skills', onAction: () => setAttempt(value => value + 1) }}>
        Couldn’t load skills. Check your connection, then retry.
      </MentionStatus>
    ) : options.length ? undefined : (
      <MentionStatus tone="empty">
        {query ? `No skills match “${query}”.` : 'No reviewed skills yet. An admin reviews skills in Skills.'}
      </MentionStatus>
    );
  return {
    staged: enabled ? staged : null,
    remove: () => {
      setStaged(null);
      input.current?.focus();
    },
    clear: () => setStaged(null),
    typeTrigger: () => {
      const field = input.current;
      if (!field) return;
      const before = text.slice(0, field.selectionEnd);
      const inserted = before === '' || /\s$/u.test(before) ? '/' : ' /';
      setText(before + inserted + text.slice(before.length));
      setCaret(before.length + inserted.length);
      setDismissed(null);
      place(field, before.length + inserted.length);
    },
    input: {
      'aria-autocomplete': 'list' as const,
      'aria-controls': open ? listId : undefined,
      'aria-activedescendant': open && options.length ? optionId(current) : undefined,
      onKeyDown,
      onSelect: track,
      onBlur: (event: FocusEvent<HTMLTextAreaElement>) => {
        if (!event.currentTarget.form?.contains(event.relatedTarget)) setCaret(null);
      },
    },
    panel: open ? (
      <MentionList
        id={listId}
        label="Skills you can use"
        status={status}
        announcement={
          options.length
            ? `${options.length} ${options.length === 1 ? 'skill' : 'skills'} you can use. Use Up and Down to choose, Enter to use, Escape to close.`
            : undefined
        }
      >
        {options.map((option, index) => (
          <MentionOption
            key={option.skill.skillId}
            id={optionId(index)}
            active={index === current}
            onSelect={() => select(option)}
            media={<BookOpen size={16} aria-hidden="true" />}
            title={option.skill.name}
            description={option.description}
          />
        ))}
      </MentionList>
    ) : null,
  };
}

export function useRichSkillPicker(
  workspaceId: string,
  input: RefObject<RichTextEditorHandle | null>,
  enabled: boolean,
) {
  const api = useMemo(() => skillApi(workspaceId), [workspaceId]);
  const [staged, setStaged] = useState<SkillReference | null>(null);
  const [suggestion, setSuggestion] = useState<EditorSuggestionState>(null);
  const [command, setCommand] = useState(false);
  // The editor keeps the extensions it was created with, so `items` reads the latest values through refs.
  const current = useRef({ api, enabled });
  current.current = { api, enabled };
  const extension = useMemo(
    () =>
      suggestionExtension({
        key: 'skill',
        char: '/',
        label: 'Skills you can use',
        allowSpaces: true,
        items: async (query, signal, editor) => {
          const { api, enabled } = current.current;
          if (!enabled) return [];
          // `/compact` is a whole-message command, so it is offered only at the start of the draft. Once typed with a space
          // the draft is the command itself: no suggestions remain, so Enter sends it.
          const name = query.trimStart().toLowerCase();
          const leading = editor.getText().trimStart().startsWith(`/${query}`);
          const typed = leading && (name === `${compactCommandName} ` || name.startsWith(`${compactCommandName} `));
          setCommand(typed);
          if (typed) return [];
          const offer: EditorSuggestionItem[] =
            leading && name.length > 0 && compactCommandName.startsWith(name)
              ? [
                  {
                    id: 'command:compact',
                    title: '/compact',
                    description: 'Summarize earlier messages to free context. Add instructions for a handoff.',
                    media: <Compress size={16} aria-hidden="true" />,
                    apply: (target, range) => {
                      target.chain().focus().deleteRange(range).insertContent(`/${compactCommandName} `).run();
                    },
                  },
                ]
              : [];
          const page = await api.reviewed(requestSignal(signal), undefined, query.trim(), resultLimit);
          return [
            ...offer,
            ...group(page.workspace, 'Workspace skill').map((option): EditorSuggestionItem => ({
              id: `${option.skill.skillId}:${option.skill.revision}`,
              title: option.skill.name,
              description: option.description,
              media: <BookOpen size={16} aria-hidden="true" />,
              apply: (editor, range) => {
                setStaged(option.skill);
                editor.chain().focus().deleteRange(range).run();
              },
            })),
          ];
        },
        onState: setSuggestion,
      }),
    [],
  );
  return {
    stage: (skill: SkillReference) => setStaged(skill),
    staged: enabled ? staged : null,
    extension,
    suggestion,
    panel:
      suggestion && !command ? <EditorSuggestionPanel state={suggestion} empty="No reviewed skills match." /> : null,
    remove: () => {
      setStaged(null);
      input.current?.focus();
    },
    clear: () => setStaged(null),
    typeTrigger: () => input.current?.editor()?.chain().focus().insertContent('/').run(),
  };
}

export function StagedSkill({
  skill,
  disabled,
  onRemove,
}: {
  skill: SkillReference;
  disabled: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex min-w-0 items-center gap-1">
        <Badge variant="secondary" size="chip" title={skill.name}>
          <BookOpen aria-hidden="true" />
          {label(skill)}
        </Badge>
        {!disabled && (
          <Button variant="ghost" size="icon-xs" aria-label={`Remove skill ${skill.name}`} onClick={onRemove}>
            <X size={14} aria-hidden="true" />
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">The assistant follows this skill for this message only.</p>
    </div>
  );
}

/** The `img` role lets its label replace the compact chip text for assistive technology. */
export function SentSkill({ skill }: { skill: SkillReference }) {
  return (
    <Badge
      variant="secondary"
      size="chip"
      role="img"
      aria-label={`Skill ${skill.name}, version ${skill.revision.slice(0, 8)}`}
    >
      <BookOpen aria-hidden="true" />
      {label(skill)}
    </Badge>
  );
}

export function SkillUse({ skill }: { skill: SkillReference }) {
  return (
    <Separator variant="marker">
      <SeparatorIcon>
        <BookOpen size={16} />
      </SeparatorIcon>
      <SeparatorContent>Used skill {label(skill)}</SeparatorContent>
    </Separator>
  );
}
