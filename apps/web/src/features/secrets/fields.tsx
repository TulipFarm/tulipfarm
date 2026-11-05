import { useId, useState, type ReactNode, type Ref } from 'react';
import { Eye } from 'reicon-react/icons/Eye';
import { EyeOff } from 'reicon-react/icons/EyeOff';
import { X } from 'reicon-react/icons/X';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@tulipfarm/sprout/input-group';
import { Label } from '@tulipfarm/sprout/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tulipfarm/sprout/select';
import {
  MAX_DESTINATIONS,
  placementKinds,
  placementOptions,
  type Placement,
  type PlacementKind,
  type SecretKind,
  type SecretValue,
  variableNameSchema,
} from './contracts';

export function emptyValue(kind: SecretKind): SecretValue {
  return kind === 'username-password' ? { username: '', password: '' } : { value: '' };
}

/** The IDs a control points at with `aria-describedby`, for its helper and error. */
export function describedBy(id: string, helper: unknown, error: unknown) {
  return [helper ? `${id}-helper` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
}

/**
 * A label, one control, and its helper and error, without a required or optional marker. The control
 * sets its own `id={id}` and `aria-describedby={describedBy(id, helper, error)}`.
 */
export function Labelled({
  id,
  label,
  hidden = false,
  helper,
  error,
  children,
}: {
  id: string;
  label: ReactNode;
  hidden?: boolean;
  helper?: ReactNode;
  error?: string | null | undefined;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      {hidden ? (
        <span className="sr-only">
          <Label htmlFor={id}>{label}</Label>
        </span>
      ) : (
        <Label htmlFor={id}>{label}</Label>
      )}
      {children}
      {helper && (
        <p id={`${id}-helper`} className="text-xs text-muted-foreground">
          {helper}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** A compact masked input with a show and hide button. Browsers never offer to save or fill it. */
export function SecretInput({
  id,
  label,
  placeholder,
  value,
  onChange,
  describedBy: description,
  invalid = false,
  disabled,
  masked = true,
  inputRef,
}: {
  id: string;
  label?: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  describedBy?: string | undefined;
  invalid?: boolean;
  disabled?: boolean | undefined;
  masked?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const [shown, setShown] = useState(false);
  return (
    <InputGroup>
      <InputGroupInput
        ref={inputRef}
        id={id}
        aria-label={label}
        aria-invalid={invalid}
        aria-describedby={description}
        placeholder={placeholder}
        type={masked && !shown ? 'password' : 'text'}
        autoComplete={masked ? 'new-password' : 'off'}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        value={value}
        disabled={disabled}
        onChange={event => onChange(event.target.value)}
      />
      {masked && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon"
            aria-label={shown ? 'Hide value' : 'Show value'}
            aria-pressed={shown}
            disabled={disabled}
            onClick={() => setShown(!shown)}
          >
            {shown ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

/** The value of a secret: one masked input, or a username and a masked password. */
export function SecretValueInput({
  kind,
  label,
  value,
  onChange,
  error,
  disabled,
}: {
  kind: SecretKind;
  label: string;
  value: SecretValue;
  onChange: (value: SecretValue) => void;
  error?: string | undefined;
  disabled?: boolean | undefined;
}) {
  const id = useId();
  if (kind === 'username-password' && 'username' in value)
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Labelled id={`${id}-username`} label="Username">
          <SecretInput
            id={`${id}-username`}
            masked={false}
            value={value.username}
            disabled={disabled}
            onChange={username => onChange({ ...value, username })}
          />
        </Labelled>
        <Labelled id={`${id}-password`} label="Password" error={error}>
          <SecretInput
            id={`${id}-password`}
            value={value.password}
            invalid={!!error}
            describedBy={describedBy(`${id}-password`, null, error)}
            disabled={disabled}
            onChange={password => onChange({ ...value, password })}
          />
        </Labelled>
      </div>
    );
  return (
    <Labelled id={id} label={label} error={error}>
      <SecretInput
        id={id}
        value={'value' in value ? value.value : ''}
        invalid={!!error}
        describedBy={describedBy(id, null, error)}
        disabled={disabled}
        onChange={text => onChange({ value: text })}
      />
    </Labelled>
  );
}

export function defaultPlacement(kind: PlacementKind, secret: SecretKind): Placement {
  switch (kind) {
    case 'bearer':
    case 'basic':
      return { kind };
    case 'header':
    case 'cookie':
    case 'query':
      return { kind, name: '' };
    case 'body':
      return { kind, format: 'json', fields: secret === 'username-password' ? ['', ''] : [''] };
  }
}

/** The ways a kind of secret can be sent. A username and password goes as a sign-in or in the body. */
export function placementChoices(kind: SecretKind) {
  return placementKinds.filter(option =>
    kind === 'username-password' ? option === 'basic' || option === 'body' : option !== 'basic',
  );
}

/** Where a secret goes in each request: a plain choice, then the name or fields it needs. */
export function PlacementEditor({
  kind,
  value,
  onChange,
  label = "How it's sent",
  error,
  disabled,
  compact = false,
}: {
  kind: SecretKind;
  value: Placement | null;
  onChange: (value: Placement) => void;
  label?: string;
  error?: string | null | undefined;
  disabled?: boolean | undefined;
  /** Hides the labels that the surrounding prompt already states, for the chat form. */
  compact?: boolean;
}) {
  const id = useId();
  const named = value && (value.kind === 'header' || value.kind === 'cookie' || value.kind === 'query') ? value : null;
  const nameLabel = named
    ? named.kind === 'header'
      ? 'Header name'
      : named.kind === 'cookie'
        ? 'Cookie name'
        : 'Parameter name'
    : '';
  const namePlaceholder = named?.kind === 'header' ? 'X-Api-Key' : named?.kind === 'query' ? 'key' : 'session';
  const kindError = !value && error ? error : null;
  const detailError = value && error ? error : null;
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <Labelled id={`${id}-kind`} label={label} hidden={compact} error={kindError}>
          <Select
            value={value?.kind ?? ''}
            disabled={disabled}
            onValueChange={next => {
              if (next) onChange(defaultPlacement(next as PlacementKind, kind));
            }}
          >
            <SelectTrigger
              id={`${id}-kind`}
              width="full"
              aria-invalid={!!kindError}
              aria-describedby={describedBy(`${id}-kind`, null, kindError)}
            >
              <SelectValue>{value ? placementOptions[value.kind].label : 'Choose how to send it'}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {placementChoices(kind).map(option => (
                <SelectItem key={option} value={option}>
                  <span className="flex flex-col">
                    <span>{placementOptions[option].label}</span>
                    <span className="text-xs text-muted-foreground">{placementOptions[option].hint}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Labelled>
        {named && (
          <Labelled id={`${id}-name`} label={nameLabel} hidden={compact} error={detailError}>
            <Input
              id={`${id}-name`}
              value={named.name}
              placeholder={namePlaceholder}
              aria-invalid={!!detailError}
              aria-describedby={describedBy(`${id}-name`, null, detailError)}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              onChange={event => onChange({ ...named, name: event.target.value })}
            />
          </Labelled>
        )}
        {value?.kind === 'body' && (
          <Labelled id={`${id}-format`} label="Body format" hidden={compact}>
            <Select
              value={value.format}
              disabled={disabled}
              onValueChange={format => {
                if (format === 'json' || format === 'form') onChange({ ...value, format });
              }}
            >
              <SelectTrigger id={`${id}-format`} width="full">
                <SelectValue>{value.format === 'json' ? 'JSON' : 'Form'}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="json">JSON</SelectItem>
                <SelectItem value="form">Form</SelectItem>
              </SelectContent>
            </Select>
          </Labelled>
        )}
      </div>
      {value?.kind === 'query' && (
        <p className="text-xs text-muted-foreground">
          Web addresses are often recorded by servers and proxies. Use a header if the service supports one.
        </p>
      )}
      {value?.kind === 'body' && (
        <div className="grid gap-2 sm:grid-cols-2">
          {value.fields.map((field, index) => {
            const fieldLabel =
              value.fields.length > 1 ? (index === 0 ? 'Username field' : 'Password field') : 'Field name';
            const fieldError = index === value.fields.length - 1 ? detailError : null;
            return (
              <Labelled key={index} id={`${id}-field-${index}`} label={fieldLabel} hidden={compact} error={fieldError}>
                <Input
                  id={`${id}-field-${index}`}
                  value={field}
                  placeholder={value.fields.length > 1 ? (index === 0 ? 'username' : 'password') : 'api_key'}
                  aria-invalid={!!fieldError}
                  aria-describedby={describedBy(`${id}-field-${index}`, null, fieldError)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={disabled}
                  onChange={event =>
                    onChange({
                      ...value,
                      fields: value.fields.map((current, position) =>
                        position === index ? event.target.value : current,
                      ),
                    })
                  }
                />
              </Labelled>
            );
          })}
        </div>
      )}
      {value && (value.kind === 'bearer' || value.kind === 'basic') && error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}

/** One input per website or API. A bare host name allows any address on that host. */
export function DestinationsEditor({
  value,
  onChange,
  label = 'Used with',
  helper = "The website or API it's for. It won't be sent anywhere else.",
  error,
  disabled,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  label?: string;
  helper?: string;
  error?: string | null | undefined;
  disabled?: boolean | undefined;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${id}-0`}>{label}</Label>
      <div className="space-y-2">
        {value.map((destination, index) => (
          <div key={index} className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <Input
                id={`${id}-${index}`}
                aria-label={index === 0 ? undefined : `${label}, ${index + 1}`}
                aria-invalid={!!error}
                aria-describedby={describedBy(id, helper, error)}
                value={destination}
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="api.stripe.com"
                disabled={disabled}
                onChange={event =>
                  onChange(value.map((current, position) => (position === index ? event.target.value : current)))
                }
              />
            </div>
            {value.length > 1 && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${destination.trim() || `website ${index + 1}`}`}
                disabled={disabled}
                onClick={() => onChange(value.filter((_, position) => position !== index))}
              >
                <X size={16} aria-hidden="true" />
              </Button>
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-x-2">
        <p id={`${id}-helper`} className="pt-1 text-xs text-muted-foreground">
          {helper}
        </p>
        {value.length < MAX_DESTINATIONS && (
          <Button
            variant="link"
            size="sm"

            disabled={disabled}
            onClick={() => onChange([...value, ''])}
          >
            + Add another
          </Button>
        )}
      </div>
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function localDateTime(iso: string) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

const durations = { '1h': 3_600_000, '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const;
const presetLabels = {
  none: 'Never',
  keep: 'Keep the current expiry',
  '1h': 'In 1 hour',
  '1d': 'In 1 day',
  '7d': 'In 7 days',
  '30d': 'In 30 days',
  custom: 'On a date and time',
} as const;
export type ExpiryChoice = { preset: keyof typeof presetLabels; custom: string };

/** The chosen expiry as an ISO timestamp, or null for none. `keep` returns the current expiry. */
export function expiryAt(choice: ExpiryChoice, current: string | null = null): string | null {
  if (choice.preset === 'none') return null;
  if (choice.preset === 'keep') return current;
  if (choice.preset === 'custom') {
    const date = new Date(choice.custom);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return new Date(Date.now() + durations[choice.preset]).toISOString();
}

export function expiryError(choice: ExpiryChoice) {
  if (choice.preset !== 'custom') return null;
  const at = expiryAt(choice);
  if (!at) return 'Enter a date and time.';
  return Date.parse(at) <= Date.now() ? 'Choose a time in the future.' : null;
}

const presetPhrases = { '1h': 'in 1 hour', '1d': 'in 1 day', '7d': 'in 7 days', '30d': 'in 30 days' } as const;

/** When a new secret is deleted, as a phrase such as "in 1 day", or null when it is kept. */
export function expiryPhrase(choice: ExpiryChoice) {
  if (choice.preset === 'none' || choice.preset === 'keep') return null;
  if (choice.preset === 'custom') {
    const at = expiryAt(choice);
    return at ? `on ${formatDate(at)}` : 'at the time you choose';
  }
  return presetPhrases[choice.preset];
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Expiry presets from the product: 1 hour, 1 day, 7 days, 30 days or a chosen time. */
export function ExpiryPicker({
  label = 'Delete it',
  labelVisibility = 'visible',
  value,
  onChange,
  allowNone,
  current,
  helper,
  error,
  disabled,
}: {
  label?: string;
  labelVisibility?: 'visible' | 'screen-reader';
  value: ExpiryChoice;
  onChange: (value: ExpiryChoice) => void;
  allowNone: boolean;
  current?: string | null | undefined;
  helper?: string | undefined;
  error?: string | null | undefined;
  disabled?: boolean | undefined;
}) {
  const id = useId();
  const presets = (Object.keys(presetLabels) as ExpiryChoice['preset'][]).filter(
    preset => (preset !== 'none' || allowNone) && (preset !== 'keep' || !!current),
  );
  const labelOf = (preset: ExpiryChoice['preset']) =>
    preset === 'keep' && current ? `Keep ${formatDate(current)}` : presetLabels[preset];
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Labelled id={id} label={label} hidden={labelVisibility === 'screen-reader'} helper={helper}>
        <Select
          value={value.preset}
          disabled={disabled}
          onValueChange={preset => {
            if (preset)
              onChange({
                preset,
                custom: value.custom || localDateTime(new Date(Date.now() + durations['1d']).toISOString()),
              });
          }}
        >
          <SelectTrigger id={id} width="full" aria-describedby={describedBy(id, helper, null)}>
            <SelectValue>{labelOf(value.preset)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {presets.map(preset => (
              <SelectItem key={preset} value={preset}>
                {labelOf(preset)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Labelled>
      {value.preset === 'custom' && (
        <Labelled id={`${id}-at`} label="Date and time" hidden={labelVisibility === 'screen-reader'} error={error}>
          <Input
            id={`${id}-at`}
            type="datetime-local"
            value={value.custom}
            min={localDateTime(new Date().toISOString())}
            aria-invalid={!!error}
            aria-describedby={describedBy(`${id}-at`, null, error)}
            disabled={disabled}
            onChange={event => onChange({ ...value, custom: event.target.value })}
          />
        </Labelled>
      )}
    </div>
  );
}

/** Shows the variable name, such as STRIPE_KEY, and offers a reset while it differs from the suggestion. */
export function VariableNameInput({
  value,
  suggestion,
  error,
  disabled,
  inputRef,
  onChange,
  onReset,
}: {
  value: string;
  suggestion?: string;
  error?: string | null | undefined;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onChange: (value: string) => void;
  onReset?: () => void;
}) {
  const id = useId();
  const helper = 'Used when code or tools need it as an environment variable.';
  return (
    <Labelled id={id} label="Variable name" helper={helper} error={error}>
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1 font-mono">
          <Input
            ref={inputRef}
            id={id}
            value={value}
            placeholder={suggestion || 'STRIPE_KEY'}
            spellCheck={false}
            autoCapitalize="characters"
            autoComplete="off"
            aria-invalid={!!error}
            aria-describedby={describedBy(id, helper, error)}
            disabled={disabled}
            onChange={event => onChange(event.target.value.toUpperCase().replace(/[\s-]/g, '_'))}
          />
        </div>
        {onReset && suggestion !== undefined && value !== suggestion && (
          <Button variant="link" size="sm" disabled={disabled} onClick={onReset}>
            Reset
          </Button>
        )}
      </div>
    </Labelled>
  );
}

export function variableNameError(value: string) {
  if (!value.trim()) return 'Give it a variable name.';
  return variableNameSchema.safeParse(value).success
    ? null
    : 'Use capital letters, numbers and underscores, starting with a letter.';
}
