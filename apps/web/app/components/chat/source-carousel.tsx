import { ExternalLink, Globe, MoreHorizontal } from "lucide-react";

export type SourceCardItem = {
  id: string;
  title: string;
  snippet?: string;
  domain: string;
  domainIcon?: string;
  url?: string;
  imageUrl?: string;
};

export type SourceCarouselProps = {
  sources: SourceCardItem[];
};

/**
 * Source Carousel: Horizontal card carousel showcasing external research/search results
 * with domain branding, thumbnails, and preview text (matches Screenshot 2 design).
 */
export function SourceCarousel({ sources }: SourceCarouselProps) {
  if (!sources || sources.length === 0) return null;

  return (
    <div className="w-full my-3">
      <div className="flex w-full gap-3 overflow-x-auto pb-2 scrollbar-none snap-x snap-mandatory">
        {sources.map((source) => (
          <article
            key={source.id}
            className="group flex min-w-[240px] max-w-[280px] shrink-0 snap-start flex-col justify-between rounded-xl border border-border bg-card p-3.5 shadow-xs transition-all hover:border-border/80 hover:shadow-md dark:bg-card"
          >
            {/* Title and Image/Snippet */}
            <div className="flex gap-3">
              <div className="flex-1 space-y-1">
                <h4 className="line-clamp-2 text-xs font-semibold leading-snug text-foreground">
                  {source.url ? (
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:text-primary hover:underline"
                    >
                      {source.title}
                    </a>
                  ) : (
                    source.title
                  )}
                </h4>
                {source.snippet ? (
                  <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                    {source.snippet}
                  </p>
                ) : null}
              </div>

              {source.imageUrl ? (
                <div className="size-12 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
                  <img
                    src={source.imageUrl}
                    alt={source.title}
                    className="size-full object-cover transition-transform group-hover:scale-105"
                  />
                </div>
              ) : null}
            </div>

            {/* Footer domain line */}
            <div className="mt-3 flex items-center justify-between border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
              <div className="flex items-center gap-1.5 min-w-0 truncate">
                {source.domainIcon ? (
                  <img src={source.domainIcon} alt="" className="size-3.5 shrink-0 rounded-full" />
                ) : (
                  <Globe className="size-3.5 shrink-0 text-muted-foreground/70" />
                )}
                <span className="truncate font-medium text-foreground">{source.domain}</span>
              </div>

              <div className="flex items-center gap-1">
                {source.url ? (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${source.title}`}
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <ExternalLink className="size-3" />
                  </a>
                ) : (
                  <button
                    type="button"
                    aria-label="Options"
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <MoreHorizontal className="size-3" />
                  </button>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
