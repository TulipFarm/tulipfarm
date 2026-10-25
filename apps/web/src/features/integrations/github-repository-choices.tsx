import { useId } from 'react';
import { Checkbox } from '@tulipfarm/sprout/checkbox';
import { Label } from '@tulipfarm/sprout/label';
import { PrivateMark } from '@/components/private-mark';

type Choice = {
  repositoryId: string;
  fullName: string;
  visibility: 'public' | 'private' | 'internal';
  detail?: string | undefined;
  disabled?: boolean | undefined;
};

/** Repository checkboxes that show a lock beside private and internal repositories. */
export function GitHubRepositoryChoices({
  legend,
  options,
  value,
  error,
  onValueChange,
}: {
  legend: string;
  options: readonly Choice[];
  value: readonly string[];
  error?: string | undefined;
  onValueChange: (ids: string[]) => void;
}) {
  const id = useId();
  return (
    <fieldset aria-describedby={error ? `${id}-error` : undefined} className="space-y-2">
      <legend className="sr-only">{legend}</legend>
      <ul className="space-y-2.5">
        {options.map(option => (
          <li key={option.repositoryId} className="flex items-start gap-3">
            <Checkbox
              id={`${id}-${option.repositoryId}`}
              checked={value.includes(option.repositoryId)}
              disabled={option.disabled}
              aria-invalid={error ? true : undefined}
              onCheckedChange={checked =>
                onValueChange(
                  checked ? [...value, option.repositoryId] : value.filter(item => item !== option.repositoryId),
                )
              }
            />
            <Label htmlFor={`${id}-${option.repositoryId}`}>
              <span className="break-all">{option.fullName}</span>
              {option.visibility !== 'public' && (
                <PrivateMark label={option.visibility === 'private' ? 'Private' : 'Internal'} />
              )}
              {option.detail && <span className="text-muted-foreground">· {option.detail}</span>}
            </Label>
          </li>
        ))}
      </ul>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}
