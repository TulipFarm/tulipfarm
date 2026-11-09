import { useRef, useState, type ReactNode } from 'react';
import type { Team } from '@tulipfarm/workspaces/governance-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { Label } from '@tulipfarm/sprout/label';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@tulipfarm/sprout/dialog';
import type { GovernanceChange } from '@/pages/governance';

export type Details = Pick<Team, 'name' | 'description'>;
export const sameDetails = (first: Details, second: Details) =>
  first.name === second.name && first.description === second.description;
export type FieldError = 'duplicate-team-name' | 'invalid-team-name' | 'invalid-team-description' | null;
export const fieldError = (result: Awaited<ReturnType<GovernanceChange>>): FieldError =>
  result === 'duplicate-team-name' || result === 'invalid-team-name' || result === 'invalid-team-description'
    ? result
    : null;

export function TeamFields({
  id,
  details,
  setDetails,
  disabled,
  error,
  preserveFocus = false,
}: {
  id: string;
  details: Details;
  setDetails: (details: Details) => void;
  disabled: boolean;
  error: FieldError;
  preserveFocus?: boolean;
}) {
  const nameError =
    error === 'duplicate-team-name'
      ? 'A team already uses this name. Choose a different name.'
      : error === 'invalid-team-name'
        ? 'Enter a name of 1 to 80 characters.'
        : null;
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-name`}>{id === 'new-team' ? 'New team name' : 'Team name'}</Label>
        <Input
          id={`${id}-name`}
          required
          maxLength={80}
          value={details.name}
          disabled={disabled && !preserveFocus}
          readOnly={disabled && preserveFocus}
          aria-invalid={Boolean(nameError)}
          aria-describedby={nameError ? `${id}-name-error` : undefined}
          onChange={event => setDetails({ ...details, name: event.target.value })}
        />
        {nameError && (
          <p id={`${id}-name-error`} role="alert">
            {nameError}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-description`}>Description (optional)</Label>
        <Textarea
          id={`${id}-description`}
          maxLength={1000}
          value={details.description}
          disabled={disabled && !preserveFocus}
          readOnly={disabled && preserveFocus}
          aria-invalid={error === 'invalid-team-description'}
          aria-describedby={`${id}-description-help`}
          onChange={event => setDetails({ ...details, description: event.target.value })}
        />
        <p
          id={`${id}-description-help`}
          role={error === 'invalid-team-description' ? 'alert' : undefined}
          className="text-sm text-muted-foreground"
        >
          {error === 'invalid-team-description'
            ? 'Enter a description of up to 1,000 characters.'
            : 'Up to 1,000 characters.'}
        </p>
      </div>
    </>
  );
}

export function TeamConfirmation({
  label,
  title,
  description,
  busy,
  run,
  recovery,
}: {
  label: string;
  title: string;
  description: string;
  busy: boolean;
  run: () => ReturnType<GovernanceChange>;
  recovery?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const lock = useRef(false);
  return (
    <Dialog
      open={open}
      onOpenChange={value => {
        if (!lock.current) {
          setOpen(value);
          setFailure(null);
        }
      }}
    >
      <DialogTrigger ref={trigger} render={<Button variant="outline" disabled={busy} />}>
        {label}
      </DialogTrigger>
      <DialogContent
        finalFocus={() =>
          trigger.current?.isConnected ? trigger.current : document.getElementById('governance-heading')
        }
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        {recovery && <div>{recovery}</div>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy || pending}
            aria-busy={pending}
            onClick={async () => {
              if (lock.current) return;
              lock.current = true;
              setPending(true);
              setFailure(null);
              try {
                const result = await run();
                if (result === 'saved') setOpen(false);
                else
                  setFailure(
                    result === 'team-owns-tables'
                      ? 'This team owns tables and can’t be deleted.'
                      : result === 'team-owns-archived-tables'
                        ? 'This team owns archived tables and can’t be deleted. Unarchive them from Archived tables, then change their owning team in Table access.'
                        : result === 'team-owns-agents'
                          ? 'This team owns active agents and can’t be deleted.'
                          : result === 'team-owns-integrations'
                            ? 'This team owns active integrations and can’t be deleted.'
                            : 'We couldn’t confirm the change. Close this and reload access to check before trying again.',
                  );
              } finally {
                lock.current = false;
                setPending(false);
              }
            }}
          >
            {pending ? 'Saving…' : label}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
