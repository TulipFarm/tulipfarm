import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import type { Extensions } from '@tiptap/core';
import { editorDocument, type ChatDraft } from './editor-document';
import { usePendingQuestion } from './choice-dock';
import { ArrowUp } from 'reicon-react/icons/ArrowUp';
import { Stop3 } from 'reicon-react/icons/Stop3';
import { ChevronDown } from 'reicon-react/icons/ChevronDown';
import { Map as MapIcon } from 'reicon-react/icons/Map';
import { Paperclip } from 'reicon-react/icons/Paperclip';
import { Plus } from 'reicon-react/icons/Plus';
import { Sliders } from 'reicon-react/icons/Sliders';
import { Sparkle } from 'reicon-react/icons/Sparkle';
import { X } from 'reicon-react/icons/X';
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
import { ModelSelector, type ModelSelectorModel } from '@tulipfarm/sprout/model-selector';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@tulipfarm/sprout/tooltip';
import { type Model, type Agent, type Mode, type Persona } from './composer-options';

export type ComposerModel = Model & { disabled?: boolean; unavailableReason?: string };

type ComposerProps = {
  compact?: boolean;
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
  persona?: {
    value: Persona | null;
    modes: readonly Mode[];
    agents: readonly Agent[];
    onChange: (persona: Persona | null) => void;
  };
  mode?: { value: 'normal' | 'plan'; onChange: (mode: 'normal' | 'plan') => void } | undefined;
  scope?: ((disabled: boolean) => ReactNode) | undefined;
  /** Offers the three things a file can become here, so a person knows before choosing whether this chat reads it. */
  extensions?: Extensions;
  /** Integration names typed in the message show as chips; a disconnected one offers Connect. */
  integrations?: { keywords: readonly RichTextKeyword[]; onConnect: (keyword: RichTextKeyword) => void } | undefined;
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
  persona,
  mode,
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
    () => (compact ? extensions?.filter(extension => extension.type !== 'extension') : extensions),
    [compact, extensions],
  );
  const send = () => {
    if (canSend && !disabled && !sending) onSend();
  };

  return (
    <TooltipProvider>
      <form
        ref={form}
        className="relative"
        data-condensed={condensed || undefined}
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
        <InputGroup variant={questionPending ? 'question-composer' : 'composer'}>
          {attachments && <InputGroupAddon align="block-start">{attachments}</InputGroupAddon>}
          <RichTextEditor
            key={compact ? 'compact' : 'full'}
            size={compact ? 'sm' : 'md'}
            condensed={condensed}
            ref={inputRef}
            placeholder={
              questionPending
                ? 'Send a separate message…'
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
            onChange={doc => onContentChange({ version: 1, doc })}
            onSend={send}
            toolbarAddon={
              <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-0.5">
                  {!compact && !condensed && (
                    <>
                      <AddMenu disabled={disabled || sending} upload={() => fileInput.current?.click()} />
                      {mode && <ModeMenu value={mode.value} onChange={mode.onChange} disabled={disabled || sending} />}
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
                  {!compact && !condensed && (
                    <ModelPicker
                      model={model}
                      models={models}
                      onModelChange={onModelChange}
                      disabled={disabled || sending}
                    />
                  )}
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
                        <Stop3 size={16} aria-hidden="true" />
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
                        <ArrowUp size={16} aria-hidden="true" />
                      </TooltipTrigger>
                      <TooltipContent>Send · Enter</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>
            }
          />
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
  const Icon = value ? (value.kind === 'mode' ? value.mode.icon : value.agent.icon) : Sparkle;
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
        <ChevronDown size={12} aria-hidden="true" />
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

function ModelPicker({
  model,
  models,
  disabled,
  onModelChange,
}: {
  model: ComposerModel | null;
  models: readonly ComposerModel[];
  disabled: boolean;
  onModelChange: (id: string) => void;
}) {
  // A chosen model stays named on the trigger while the list is briefly empty, such as while a default saves.
  const listed = model && !models.some(candidate => candidate.id === model.id) ? [model, ...models] : models;
  const off = disabled || models.length === 0;
  return (
    <Tooltip>
      <ModelSelector
        models={listed.map(selectorModel)}
        value={model?.id}
        onValueChange={onModelChange}
        emptyMessage="No models found."
        disabled={off}
        side="top"
        align="end"
        // The tooltip trigger drops the native `disabled` the selector sets, so the button takes it directly.
        render={<TooltipTrigger render={<InputGroupButton size="md" variant="ghost" disabled={off} />} />}
      />
      <TooltipContent>AI model that writes replies</TooltipContent>
    </Tooltip>
  );
}

function selectorModel(model: ComposerModel): ModelSelectorModel {
  return {
    id: model.id,
    label: model.label,
    brand: model.brand ?? undefined,
    icon: model.brand ? undefined : <model.logo size={16} aria-hidden="true" />,
    description: model.disabled ? `Unavailable: ${model.unavailableReason ?? 'not offered here'}` : undefined,
    disabled: model.disabled,
    speed: model.speed,
    quality: model.quality,
    cost: model.cost,
  };
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
          <Plus size={16} aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>Add files and more</TooltipContent>
      </Tooltip>
      <DropdownMenuContent size="menu" side="top" align="start">
        <DropdownMenuItem onClick={upload}>
          <Paperclip size={16} aria-hidden="true" />
          Upload from computer
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ChatMode = 'normal' | 'plan';

/** Plan is the one mode today; the menu leaves room for more, and an active mode shows as a removable chip. */
function ModeMenu({
  value,
  onChange,
  disabled,
}: {
  value: ChatMode;
  onChange: (mode: ChatMode) => void;
  disabled: boolean;
}) {
  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <InputGroupButton
                    size="icon"
                    variant="ghost"
                    aria-label={`Mode: ${value === 'plan' ? 'Plan' : 'Default'}`}
                    disabled={disabled}
                  />
                }
              />
            }
          >
            <Sliders size={16} aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>Mode</TooltipContent>
        </Tooltip>
        <DropdownMenuContent size="menu" side="top" align="start">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Mode</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={value} onValueChange={next => onChange(next === 'plan' ? 'plan' : 'normal')}>
              <DropdownMenuRadioItem value="normal" closeOnClick>
                <span className="flex items-start gap-2 py-0.5">
                  <span className="mt-0.5 flex shrink-0">
                    <Sparkle size={16} aria-hidden="true" />
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
                    <MapIcon size={16} aria-hidden="true" />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span>Plan</span>
                    <span className="text-xs text-muted-foreground">Proposes steps before it acts</span>
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
                aria-label="Turn off Plan"
                disabled={disabled}
                onClick={() => onChange('normal')}
              />
            }
          >
            <span className="flex text-info">
              <MapIcon size={16} aria-hidden="true" />
            </span>
            <span className="hidden sm:inline">Plan</span>
            <X size={12} aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>Plan proposes steps before it acts. Select to turn off.</TooltipContent>
        </Tooltip>
      )}
    </>
  );
}
