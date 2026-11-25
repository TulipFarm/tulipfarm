import { useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode, type Ref } from 'react';
import type { Extensions } from '@tiptap/core';
import { editorDocument, type ChatDraft } from './editor-document';
import { packageReferenceExtension } from './package-reference';
import { keepFocusExtension } from './editor-extensions';
import { usePendingQuestion } from './pending-question';
import {
  AddIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  CloseIcon,
  MapIcon,
  PaperclipIcon,
  SlidersIcon,
  SparkleIcon,
  StopIcon,
  TerminalIcon,
} from '@tulipfarm/icons';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@tulipfarm/sprout/command';
import { Input } from '@tulipfarm/sprout/input';
import { InputGroup, InputGroupAddon, InputGroupButton } from '@tulipfarm/sprout/input-group';
import { RichTextEditor, type RichTextEditorHandle, type RichTextKeyword } from '@tulipfarm/sprout/rich-text-editor';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@tulipfarm/sprout/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@tulipfarm/sprout/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@tulipfarm/sprout/tooltip';
import { type Model, type Agent, type Mode, type Persona } from './composer-options';
import type { PlanProvider } from '@/features/models/chatgpt-plan-api';
import type { PlanAccountChoice } from './plan-account';
import { ModelPicker } from './model-picker';
import type { PlanUsage } from './plan-usage';

/**
 * `plan` marks a model billed to the member's own or a shared ChatGPT, Claude or Copilot plan; `planUsage` is what
 * that plan's replies last said about its usage limit.
 */
export type ComposerModel = Model & {
  disabled?: boolean;
  unavailableReason?: string;
  plan?: PlanProvider;
  planUsage?: PlanUsage | undefined;
};

type ComposerProps = {
  compact?: boolean;
  /** Lines the empty message shows before it grows; `1` once a conversation has started. */
  minRows?: number | undefined;
  content: ChatDraft;
  inputRef?: Ref<RichTextEditorHandle>;
  onContentChange: (content: ChatDraft) => void;
  onSend: () => void;
  onStop?: (() => void) | undefined;
  placeholder?: string | undefined;
  canSend: boolean;
  disabled?: boolean;
  sending?: boolean;
  validation?: string | null;
  attachments?: ReactNode;
  onFiles: (files: File[]) => void;
  accept?: string;
  model: ComposerModel | null;
  models: readonly ComposerModel[];
  onModelChange: (id: string) => void;
  /** The plan account a plan model answers with first. */
  planAccount?: PlanAccountChoice | undefined;
  persona?: {
    value: Persona | null;
    modes: readonly Mode[];
    agents: readonly Agent[];
    onChange: (persona: Persona | null) => void;
  };
  mode?: { value: ChatMode; onChange: (mode: ChatMode) => void } | undefined;
  codeHeader?: ReactNode;
  codeNotice?: ReactNode;
  codeAgentPicker?: ReactNode;
  sendDisabledReason?: string | undefined;
  scope?: ((disabled: boolean) => ReactNode) | undefined;
  /** Offers the three things a file can become here, so a person knows before choosing whether this chat reads it. */
  extensions?: Extensions;
  /** Integration names typed in the message show as chips; a disconnected one offers Connect. */
  integrations?:
    | {
        keywords: readonly RichTextKeyword[];
        onConnect: (keyword: RichTextKeyword) => void;
        /** Switches the account a keyword's app uses in this chat; offered when the keyword lists accounts. */
        onAccountChange?: ((keyword: RichTextKeyword, accountId: string) => Promise<unknown>) | undefined;
      }
    | undefined;
  /** Suggestions anchored above the message field. */
  picker?:
    | {
        id: string;
        activeId?: string;
        panel: ReactNode;
      }
    | undefined;
};

export function Composer({
  compact = false,
  minRows,
  content,
  inputRef,
  onContentChange,
  onSend,
  onStop,
  placeholder,
  canSend,
  disabled = false,
  sending = false,
  validation,
  attachments,
  onFiles,
  accept,
  model,
  models,
  onModelChange,
  planAccount,
  persona,
  mode,
  codeHeader,
  codeNotice,
  codeAgentPicker,
  sendDisabledReason,
  scope,
  extensions,
  integrations,
  picker,
}: ComposerProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const [panelBelow, setPanelBelow] = useState(false);
  const questionPending = usePendingQuestion();
  const [focused, setFocused] = useState(false);
  const condensed = !compact && questionPending && !focused && !attachments && !canSend;
  const panelOpen = !compact && !!picker?.panel;
  useLayoutEffect(() => {
    const bounds = form.current?.getBoundingClientRect();
    // A composer near the top of a short screen has no room above it, so suggestions open below.
    if (panelOpen && bounds) setPanelBelow(bounds.top < 320 && window.innerHeight - bounds.bottom > bounds.top);
  }, [panelOpen]);
  const errorId = useId();
  const editorValue = useMemo(() => editorDocument(content.doc), [content.doc]);
  const editorExtensions = useMemo(
    () => [
      packageReferenceExtension,
      keepFocusExtension,
      ...(compact ? (extensions?.filter(extension => extension.type !== 'extension') ?? []) : (extensions ?? [])),
    ],
    [compact, extensions],
  );
  const send = () => {
    if (canSend && !disabled && !sending) onSend();
  };
  const [dragging, setDragging] = useState(false);
  const dropsFiles = (event: DragEvent) => !compact && event.dataTransfer.types.includes('Files');
  // Capture runs before the editor, which would otherwise let the browser open a dropped file.
  const dragOver = (event: DragEvent) => {
    if (!dropsFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const blocked = disabled || sending;
    event.dataTransfer.dropEffect = blocked ? 'none' : 'copy';
    setDragging(!blocked);
  };

  return (
    <TooltipProvider>
      <form
        ref={form}
        className="relative"
        data-condensed={condensed || undefined}
        data-dragging={dragging || undefined}
        onDragEnterCapture={dragOver}
        onDragOverCapture={dragOver}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDropCapture={event => {
          if (!dropsFiles(event)) return;
          event.preventDefault();
          event.stopPropagation();
          setDragging(false);
          const files = Array.from(event.dataTransfer.files);
          if (!disabled && !sending && files.length > 0) onFiles(files);
        }}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
        onSubmit={event => {
          event.preventDefault();
          send();
        }}
        aria-label="Message composer"
      >
        {!compact && (
          <Input
            ref={fileInput}
            type="file"
            accept={accept}
            disabled={disabled || sending}
            multiple
            hidden
            tabIndex={-1}
            aria-hidden
            onChange={event => {
              onFiles(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
        )}
        <InputGroup
          variant={questionPending ? 'question-composer' : 'composer'}
          data-mode={mode?.value === 'plan' ? 'plan' : mode?.value === 'code' ? 'code' : undefined}
        >
          {codeHeader && mode?.value === 'code' && <div className="code-mode-header-slot w-full">{codeHeader}</div>}
          {codeNotice && mode?.value === 'code' && <div className="w-full">{codeNotice}</div>}
          {attachments && <InputGroupAddon align="block-start">{attachments}</InputGroupAddon>}
          <div
            className={
              mode?.value === 'code' ? 'code-mode-editor-row flex w-full items-start' : 'flex w-full items-start'
            }
          >
            {mode?.value === 'code' && (
              <span className="code-mode-prompt select-none" aria-hidden="true">
                ❯
              </span>
            )}
            <div className="min-w-0 flex-1">
              <RichTextEditor
                key={compact ? 'compact' : 'full'}
                size={compact ? 'sm' : 'md'}
                condensed={condensed}
                minRows={minRows}
                ref={inputRef}
                placeholder={
                  questionPending
                    ? 'Send a separate message…'
                    : mode?.value === 'code'
                      ? 'Describe what to build, fix, or refactor…'
                      : persona?.value?.kind === 'agent'
                        ? `Ask ${persona.value.agent.label} anything…`
                        : (placeholder ?? 'Ask anything…')
                }
                value={editorValue}
                disabled={disabled || sending}
                ariaInvalid={!!validation}
                ariaDescribedBy={validation ? errorId : undefined}
                ariaExpanded={panelOpen}
                ariaControls={compact ? undefined : picker?.id}
                ariaActiveDescendant={compact ? undefined : picker?.activeId}
                extensions={editorExtensions}
                keywords={integrations?.keywords}
                onKeywordConnect={integrations?.onConnect}
                onKeywordAccountChange={integrations?.onAccountChange}
                onChange={doc => onContentChange({ version: 1, doc })}
                onSend={send}
                toolbarAddon={
                  <div className="flex min-h-7 min-w-0 flex-1 items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-0.5">
                      {!compact && !condensed && (
                        <>
                          <AddMenu disabled={disabled || sending} upload={() => fileInput.current?.click()} />
                          {mode && (
                            <ModeMenu value={mode.value} onChange={mode.onChange} disabled={disabled || sending} />
                          )}
                          {persona && (
                            <PersonaPicker
                              value={persona.value}
                              onChange={persona.onChange}
                              modes={persona.modes}
                              agents={persona.agents}
                              disabled={disabled || sending}
                            />
                          )}
                          {scope && (
                            <>
                              <span aria-hidden="true" className="mx-1.5 h-5 w-px shrink-0 self-center bg-border" />
                              <div className="flex min-w-0 items-center *:min-w-0 *:shrink">
                                {scope(disabled || sending)}
                              </div>
                            </>
                          )}
                        </>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {!compact &&
                        !condensed &&
                        (mode?.value === 'code' && codeAgentPicker ? (
                          codeAgentPicker
                        ) : (
                          <ModelPicker
                            model={model}
                            models={models}
                            onModelChange={onModelChange}
                            account={planAccount}
                            disabled={disabled || sending}
                          />
                        ))}
                      {onStop ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <InputGroupButton
                                size="icon"
                                variant="default"
                                aria-label="Stop reply"
                                disabled={disabled}
                                onClick={onStop}
                              />
                            }
                          >
                            <StopIcon size="md" aria-hidden="true" />
                          </TooltipTrigger>
                          <TooltipContent>Stop reply</TooltipContent>
                        </Tooltip>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <InputGroupButton
                                type="submit"
                                size="icon"
                                variant={canSend ? 'default' : 'secondary'}
                                aria-label="Send message"
                                aria-busy={sending}
                                disabled={disabled || sending || !canSend}
                              />
                            }
                          >
                            <ArrowUpIcon size="md" aria-hidden="true" />
                          </TooltipTrigger>
                          <TooltipContent>
                            {!canSend && sendDisabledReason ? sendDisabledReason : 'Send · Enter'}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                }
              />
            </div>
          </div>
        </InputGroup>
        {!compact && picker?.panel && (
          <div
            className={
              panelBelow ? 'absolute inset-x-0 top-full z-50 mt-2' : 'absolute inset-x-0 bottom-full z-50 mb-2'
            }
          >
            {picker.panel}
          </div>
        )}
        {validation && (
          <p id={errorId} role="alert" className="mt-2 text-sm text-destructive">
            {validation}
          </p>
        )}
      </form>
    </TooltipProvider>
  );
}

const personaKey = (persona: Persona) =>
  persona.kind === 'mode' ? `mode:${persona.mode.id}` : `agent:${persona.agent.id}`;

function PersonaPicker({
  value,
  onChange,
  modes,
  agents,
  disabled,
}: {
  value: Persona | null;
  onChange: (persona: Persona | null) => void;
  modes: readonly Mode[];
  agents: readonly Agent[];
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = value ? personaKey(value) : null;
  const pick = (next: Persona) => {
    onChange(personaKey(next) === selected ? null : next);
    setOpen(false);
  };
  const Icon = value ? (value.kind === 'mode' ? value.mode.icon : value.agent.icon) : SparkleIcon;
  const tone = value?.kind === 'mode' ? value.mode.tone : '';
  const label = value ? (value.kind === 'mode' ? value.mode.label : value.agent.label) : 'Mode';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <InputGroupButton size="md" variant="ghost" disabled={disabled} aria-label={`Mode or agent: ${label}`} />
        }
      >
        <span className={`flex ${tone}`}>
          <Icon size={16} aria-hidden="true" />
        </span>
        {label}
        <ChevronDownIcon size="xs" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent size="menu" side="top" align="start" sideOffset={8}>
        <Command>
          <CommandInput aria-label="Search modes and agents" placeholder="Search modes and agents…" />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            <CommandGroup heading="Modes">
              {modes.map(mode => (
                <CommandItem
                  key={mode.id}
                  value={`${mode.label} ${mode.description}`}
                  data-checked={selected === `mode:${mode.id}`}
                  onSelect={() => pick({ kind: 'mode', mode })}
                >
                  <span className={`flex ${mode.tone}`}>
                    <mode.icon size={16} aria-hidden="true" />
                  </span>
                  <span className="whitespace-nowrap">{mode.label}</span>
                  <span className="truncate text-muted-foreground">{mode.description}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Agents">
              {agents.map(agent => (
                <CommandItem
                  key={agent.id}
                  value={`${agent.label} ${agent.description}`}
                  data-checked={selected === `agent:${agent.id}`}
                  onSelect={() => pick({ kind: 'agent', agent })}
                >
                  <agent.icon size={16} aria-hidden="true" />
                  <span className="whitespace-nowrap">{agent.label}</span>
                  <span className="truncate text-muted-foreground">{agent.description}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** The `+` menu. Upload is the only choice today; the menu leaves room for more. */
function AddMenu({ disabled, upload }: { disabled: boolean; upload: () => void }) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <InputGroupButton size="icon" variant="ghost" aria-label="Add files and more" disabled={disabled} />
              }
            />
          }
        >
          <AddIcon size="md" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>Add files and more</TooltipContent>
      </Tooltip>
      <DropdownMenuContent size="menu" side="top" align="start">
        <DropdownMenuItem onClick={upload}>
          <PaperclipIcon size="md" aria-hidden="true" />
          Upload from computer
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ChatMode = 'normal' | 'plan' | 'code';

/** Modes control how a turn executes; an active non-default mode shows as a removable chip. */
function ModeMenu({
  value,
  onChange,
  disabled,
}: {
  value: ChatMode;
  onChange: (mode: ChatMode) => void;
  disabled: boolean;
}) {
  const modeLabel = value === 'plan' ? 'Plan' : value === 'code' ? 'Code' : 'Default';
  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <InputGroupButton size="icon" variant="ghost" aria-label={`Mode: ${modeLabel}`} disabled={disabled} />
                }
              />
            }
          >
            <SlidersIcon size="md" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>Mode</TooltipContent>
        </Tooltip>
        <DropdownMenuContent size="menu" side="top" align="start">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Mode</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={value}
              onValueChange={next => onChange(next === 'plan' ? 'plan' : next === 'code' ? 'code' : 'normal')}
            >
              <DropdownMenuRadioItem value="normal" closeOnClick>
                <span className="flex items-start gap-2 py-0.5">
                  <span className="mt-0.5 flex shrink-0">
                    <SparkleIcon size="md" aria-hidden="true" />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span>Default</span>
                    <span className="text-xs text-muted-foreground">Acts on your request</span>
                  </span>
                </span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="plan" closeOnClick>
                <span className="flex items-start gap-2 py-0.5">
                  <span className="mt-0.5 flex shrink-0 text-info">
                    <MapIcon size="md" aria-hidden="true" />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span>Plan</span>
                    <span className="text-xs text-muted-foreground">Proposes steps before it acts</span>
                  </span>
                </span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="code" closeOnClick>
                <span className="flex items-start gap-2 py-0.5">
                  <span className="mt-0.5 flex shrink-0 text-primary">
                    <TerminalIcon size="md" aria-hidden="true" />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span>Code</span>
                    <span className="text-xs text-muted-foreground">Orchestrates a coding agent end to end</span>
                  </span>
                </span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {value === 'plan' && (
        <Tooltip>
          <TooltipTrigger
            render={
              <InputGroupButton
                size="md"
                variant="secondary"
                data-mode-chip=""
                aria-label="Turn off Plan"
                disabled={disabled}
                onClick={() => onChange('normal')}
              />
            }
          >
            <span className="flex text-info">
              <MapIcon size="md" aria-hidden="true" />
            </span>
            <span className="hidden sm:inline">Plan</span>
            <CloseIcon size="xs" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>Plan proposes steps before it acts. Select to turn off.</TooltipContent>
        </Tooltip>
      )}
      {value === 'code' && (
        <Tooltip>
          <TooltipTrigger
            render={
              <InputGroupButton
                size="md"
                variant="secondary"
                data-mode-chip=""
                aria-label="Turn off Code"
                disabled={disabled}
                onClick={() => onChange('normal')}
              />
            }
          >
            <span className="flex">
              <TerminalIcon size="md" aria-hidden="true" />
            </span>
            <span className="hidden sm:inline">Code</span>
            <CloseIcon size="xs" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>Code starts a coding agent session. Select to turn off.</TooltipContent>
        </Tooltip>
      )}
    </>
  );
}
