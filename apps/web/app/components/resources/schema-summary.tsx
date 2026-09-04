import { ChevronRight, KeyRound, Link2, Lock } from "~/components/icons";
import type { FieldDescriptor } from "~/lib/schema";
import { cn } from "~/lib/utils";

/** Enum values shown inline before the rest collapse into a "+N" with the full list on hover. */
const ENUM_PREVIEW = 4;

function KindLabel({ field }: { readonly field: FieldDescriptor }) {
  if (field.kind === "link") {
    return (
      <span className="inline-flex items-center gap-1 text-status-info">
        <Link2 aria-hidden className="size-3" />
        {field.linkTarget ?? "link"}
      </span>
    );
  }
  if (field.kind === "enum" && field.enumValues) {
    const shown = field.enumValues.slice(0, ENUM_PREVIEW);
    const rest = field.enumValues.length - shown.length;
    return (
      <span title={field.enumValues.join(", ")}>
        {shown.join(" | ")}
        {rest > 0 ? ` +${rest}` : ""}
      </span>
    );
  }
  return <span>{field.format ? `${field.kind} (${field.format})` : field.kind}</span>;
}

/**
 * The type's shape, field by field. The grid shows at most a handful of columns, so without this
 * an object field, a read-only field or an enum's allowed values would be invisible in the UI.
 */
export function SchemaSummary({
  fields,
  idField,
  defaultOpen = false,
}: {
  readonly fields: readonly FieldDescriptor[];
  readonly idField: string;
  readonly defaultOpen?: boolean;
}) {
  const systemCount = fields.filter((f) => f.isSystem).length;
  const ownCount = fields.length - systemCount;
  return (
    <details open={defaultOpen} className="group rounded-lg border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent">
        <ChevronRight
          aria-hidden
          className="size-4 text-muted-foreground transition-transform duration-100 group-open:rotate-90"
        />
        Schema
        {/* Names both numbers, because the stat strip above counts only the type's own fields and
            an unqualified larger total here reads as a contradiction. */}
        <span className="font-normal text-muted-foreground">
          {ownCount} {ownCount === 1 ? "field" : "fields"}
          {systemCount > 0 ? ` · ${systemCount} runtime-managed` : ""}
        </span>
      </summary>

      <div className="overflow-x-auto border-t border-border">
        <table className="w-full min-w-[36rem] border-collapse text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="px-3 py-2 text-start font-medium">
                Field
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                Type
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                Rules
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border border-t border-border">
            {fields.map((field) => (
              <tr key={field.name}>
                <td className="px-3 py-2 align-top font-medium text-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    {field.name === idField ? (
                      <KeyRound aria-hidden className="size-3 text-primary" />
                    ) : null}
                    {field.name}
                  </span>
                </td>
                <td
                  className={cn(
                    "px-3 py-2 align-top",
                    field.kind === "unknown" ? "text-muted-foreground" : "text-foreground"
                  )}
                >
                  <KindLabel field={field} />
                </td>
                <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {field.required ? <span className="text-foreground">Required</span> : null}
                    {field.isSystem ? <span>Managed by the runtime</span> : null}
                    {field.readOnly ? (
                      <span className="inline-flex items-center gap-1">
                        <Lock aria-hidden className="size-3" />
                        Read only
                      </span>
                    ) : null}
                    {field.immutable ? <span>Set once</span> : null}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
