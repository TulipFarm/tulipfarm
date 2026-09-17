import { useEffect, useState } from "react";
import { Combobox } from "~/components/ui/combobox";

export function IntegrationChoice({
  id,
  label,
  value,
  options,
  onChange,
  disabled = false,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: {
  id?: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const selected = options.find((option) => option.value === value)?.label ?? "";
  const [query, setQuery] = useState(selected);
  useEffect(() => setQuery(selected), [selected]);
  return (
    <fieldset
      disabled={disabled}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setQuery(selected);
      }}
      onKeyDownCapture={(event) => {
        if (
          event.key === "Enter" &&
          !options.some((option) => option.label.toLowerCase().includes(query.trim().toLowerCase()))
        ) {
          event.preventDefault();
          setQuery(selected);
        }
      }}
    >
      <Combobox
        id={id}
        aria-label={label}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        value={query}
        options={options.map((option) => option.label)}
        emptyLabel="Choose an available option."
        onValueChange={setQuery}
        onCommit={(next) => {
          const option = options.find((option) => option.label === next);
          if (option) onChange(option.value);
          setQuery(option?.label ?? selected);
        }}
      />
    </fieldset>
  );
}
