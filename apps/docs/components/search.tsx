"use client";
import { useDocsSearch } from "fumadocs-core/search/client";
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from "fumadocs-ui/components/dialog/search";
import { useI18n } from "fumadocs-ui/contexts/i18n";

export default function DefaultSearchDialog(props: SharedProps) {
  const { locale } = useI18n(); // (optional) for i18n
  const { search, setSearch, query } = useDocsSearch({
    type: "static",
    locale,
  });

  return (
    <SearchDialog search={search} onSearchChange={setSearch} isLoading={query.isLoading} {...props}>
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList
          items={query.data !== "empty" ? query.data : null}
          Empty={() => (
            <div className="py-10 text-center">
              {search.trim() === "" ? (
                <p className="text-sm text-fd-muted-foreground">
                  Search the docs by title or content.
                </p>
              ) : (
                <>
                  <p className="text-sm font-medium">No results for “{search}”</p>
                  <p className="mt-1 text-xs text-fd-muted-foreground">
                    Try a shorter phrase, or browse the sidebar.
                  </p>
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="mt-4 min-h-11 cursor-pointer text-sm font-medium text-fd-primary transition-colors duration-150 hover:text-fd-primary/80"
                  >
                    Clear search
                  </button>
                </>
              )}
            </div>
          )}
        />
      </SearchDialogContent>
    </SearchDialog>
  );
}
