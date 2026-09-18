import { ArrowRight, Box } from "~/components/icons";
import type { PackSummary } from "~/lib/packs";
import { cn } from "~/lib/utils";
import { PACK_CATEGORY_STYLE, PackCategoryIcon } from "./pack-category";
import { PackIntegrationIdeas } from "./pack-integration-ideas";

export function PackCard({
  pack,
  onPreview,
}: {
  pack: PackSummary;
  onPreview: (button: HTMLButtonElement) => void;
}) {
  const style = PACK_CATEGORY_STYLE[pack.category];
  return (
    <article className="group relative flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-background text-left transition-colors hover:border-border-strong has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-ring">
      <div
        className={cn(
          "relative flex h-28 w-full items-center justify-between overflow-hidden px-5",
          style.background
        )}
      >
        <div className={cn("rounded-xl bg-background/80 p-3", style.ink)}>
          <PackCategoryIcon category={pack.category} className="size-7" />
        </div>
        <PackIntegrationIdeas name={pack.name} sourceUrl={pack.url} compact />
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{pack.category}</span>
          <span className="font-mono">v{pack.version}</span>
        </div>
        <h3 className="line-clamp-2 break-words text-base font-semibold leading-snug">
          {pack.title}
        </h3>
        <p className="line-clamp-3 break-words text-sm leading-relaxed text-muted-foreground">
          {pack.description}
        </p>
        <div className="mt-auto flex items-center justify-between gap-2 pt-5 text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Box className="size-3.5" />
            Pack template
          </span>
          <button
            type="button"
            aria-label={`Preview installation of ${pack.title}`}
            onClick={(event) => onPreview(event.currentTarget)}
            className="flex cursor-pointer items-center gap-1.5 font-medium after:absolute after:inset-0 group-hover:text-brand focus-visible:outline-none"
          >
            Preview installation
            <ArrowRight className="size-3.5" />
          </button>
        </div>
      </div>
    </article>
  );
}
