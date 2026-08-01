import {
  type ClientLoaderFunctionArgs,
  type MetaFunction,
  useLoaderData,
  useRouteError,
} from "@remix-run/react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/api";
import { confirmChannelBind, previewChannelBind } from "~/lib/channel-links";

export const meta: MetaFunction = () => [{ title: "Link channel · tulipfarm" }];

/*
 * Confirms a channel bind link. The link arrives in a channel the sender controls, so holding it
 * proves nothing on its own — this page sits under the `_app` shell, whose loader bounces an
 * unauthenticated visitor to /login. What binds the sender is the signed-in session plus the
 * explicit confirm below, never the link alone.
 */
export async function clientLoader({ request }: ClientLoaderFunctionArgs) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) throw new ApiError(400, "this link is missing its bind token");
  // Preview is a read: nothing is bound until the button is pressed.
  return { token, offer: await previewChannelBind(token) };
}

export default function LinkChannelRoute() {
  const { token, offer } = useLoaderData<typeof clientLoader>();
  const [bound, setBound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  if (bound) {
    return (
      <Card>
        <p>
          Bound. <span className="font-medium">{offer.senderId}</span> on {offer.slug} now acts as{" "}
          {offer.account.email}.
        </p>
        <p className="text-xs text-muted-foreground">
          Send your message again in {offer.slug} — it will be answered this time.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <p>Bind this channel sender to your account? Messages from it will then act as you.</p>
      {/* Names exactly what is being bound, and to whom — the page is the consent record. */}
      <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-xs">
        <dt className="text-muted-foreground">Integration</dt>
        <dd>{offer.slug}</dd>
        <dt className="text-muted-foreground">Sender</dt>
        <dd className="break-all font-medium">{offer.senderId}</dd>
        <dt className="text-muted-foreground">Account</dt>
        <dd className="break-all font-medium">{offer.account.email}</dd>
      </dl>
      <p className="text-xs text-muted-foreground">
        This link works once, and expires {new Date(offer.expiresAt).toLocaleString()}.
      </p>
      {failure ? <p className="text-destructive">{failure}</p> : null}
      <div>
        <Button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setFailure(undefined);
            try {
              await confirmChannelBind(token);
              setBound(true);
            } catch (error) {
              setFailure(
                error instanceof ApiError ? error.message : "the bind could not be recorded"
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Binding…" : "Bind to my account"}
        </Button>
      </div>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-auto flex h-full max-w-xl flex-col justify-center px-6 py-16">
      <div className="rounded-sm border border-border bg-card">
        <p className="border-b border-border px-4 py-2 text-[0.625rem] font-medium uppercase tracking-[0.2em] text-muted-foreground">
          link channel
        </p>
        <div className="flex flex-col gap-4 px-4 py-6 text-sm">{children}</div>
      </div>
    </section>
  );
}

/*
 * Every refusal — forged, expired, already redeemed — comes back as the same coarse 400, so the copy
 * says what to do rather than guessing which one it was.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  return (
    <Card>
      <p className="text-destructive">
        error: {status ? `${status} ` : ""}
        {error instanceof Error ? error.message : "request failed"}
      </p>
      <p className="text-muted-foreground">
        A bind link works once and expires 15 minutes after it is sent. Message the channel again to
        get a fresh one.
      </p>
    </Card>
  );
}
