import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useRouteError,
} from "@remix-run/react";
import { useCallback, useState } from "react";
import { CropLegend, SeasonStrip } from "~/components/farm/farm-summary";
import { type FieldFocus, TulipField } from "~/components/farm/tulip-field";
import { ErrorState } from "~/components/states";
import { Link } from "~/components/ui/link";
import { ApiError } from "~/lib/api";
import { CROPS, cropFor, farmSeason, loadFarm } from "~/lib/farm";
import { mockCountFromUrl, mockFarm } from "~/lib/farm.mock";
import { getBusinessProfile } from "~/lib/settings";

export const meta: MetaFunction = () => [{ title: "Farm · tulipfarm" }];

export async function clientLoader({ request }: ClientLoaderFunctionArgs) {
  const mock = mockCountFromUrl(request.url);
  // The name on the barn is real even in preview, and its absence must not cost anyone the field.
  const named = getBusinessProfile().then(
    (profile) => profile.name,
    () => ""
  );
  if (mock !== null) return { farm: mockFarm(mock), farmName: await named, mock: true };
  const [farm, farmName] = await Promise.all([loadFarm(), named]);
  return { farm, farmName, mock: false };
}

export default function Farm() {
  const { farm, farmName, mock } = useLoaderData<typeof clientLoader>();
  const [focus, setFocus] = useState<FieldFocus | null>(null);
  const season = farmSeason(farm.counts);

  const onFocusChange = useCallback((next: FieldFocus | null) => setFocus(next), []);

  const failedLabels = farm.failed.map((kind) => cropFor(kind).label);

  return (
    <div className="flex h-full min-h-full flex-col">
      <SeasonStrip season={season} total={farm.total} />

      {mock ? (
        <p className="border-b border-border bg-muted px-6 py-2 font-mono text-xs text-muted-foreground md:px-8">
          Preview only, {farm.total === 1 ? "this tulip is" : `these ${farm.total} tulips are`} made
          up. Change the count with <code>?mock=N</code>, or drop the parameter for the real farm.
        </p>
      ) : null}

      {failedLabels.length > 0 ? (
        <p className="border-b border-border bg-muted px-6 py-2 text-xs text-muted-foreground md:px-8">
          {failedLabels.join(" and ")} could not be read, so{" "}
          {failedLabels.length === 1 ? "that crop is" : "those crops are"} missing from the field.
        </p>
      ) : null}

      <div className="relative min-h-[55svh] flex-1 overflow-hidden">
        <TulipField plantings={farm.plantings} farmName={farmName} onFocusChange={onFocusChange} />

        {farm.total === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6">
            <div className="pointer-events-auto max-w-sm rounded-sm border border-border bg-card px-4 py-3 text-center">
              <p className="text-sm font-medium text-foreground">Nothing planted yet</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Every resource, agent, skill, routine, integration and space your business grows
                shows up here as a tulip.
              </p>
              <Link
                to="/"
                className="mt-3 inline-block text-xs font-medium text-primary transition-colors duration-150 hover:underline"
              >
                Ask in chat to plant the first one
              </Link>
            </div>
          </div>
        ) : null}

        {focus ? (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full pb-3"
            style={{ left: `${focus.x}px`, top: `${focus.y}px` }}
          >
            <div className="max-w-56 rounded-sm border border-border bg-popover px-2 py-1.5 text-left">
              <p className="truncate text-xs font-medium text-foreground">{focus.planting.name}</p>
              <p className="mt-0.5 truncate font-mono text-[0.6875rem] text-muted-foreground">
                {cropFor(focus.planting.kind).singular}
                {focus.planting.detail ? ` · ${focus.planting.detail}` : ""}
                {focus.planting.bloomed ? "" : " · dormant"}
              </p>
            </div>
          </div>
        ) : null}
      </div>

      {/*
        The canvas is aria-hidden, so the field's contents are published here instead. A reader
        gets the tally and the same links a pointer gets by clicking a tulip.
      */}
      <p className="sr-only">
        {farm.total === 0
          ? "Nothing is planted yet."
          : `${farm.total} plantings are growing: ${CROPS.filter(
              (crop) => farm.counts[crop.kind] > 0
            )
              .map((crop) => `${farm.counts[crop.kind]} ${crop.label.toLowerCase()}`)
              .join(", ")}. Open a crop below to see each one.`}
      </p>

      <CropLegend counts={farm.counts} failed={farm.failed} />
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="farm" status={status} message={message} />;
}
