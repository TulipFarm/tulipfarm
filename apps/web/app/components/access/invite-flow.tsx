import { useState } from "react";
import { Button } from "~/components/ui/button";
import { CopyField } from "~/components/ui/copy-field";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Panel } from "~/components/ui/panel";
import { type Invite, inviteUrl } from "~/lib/users";

/** Invite links are unrecoverable after first display because the API stores only a hash. */
export function IssuedLink({
  issued,
  onDismiss,
}: {
  issued: { email: string; invite: Invite };
  onDismiss: () => void;
}) {
  return (
    <Panel className="border-primary/40">
      <div className="space-y-2">
        <p className="text-sm text-foreground">
          Send this link to <strong>{issued.email}</strong> yourself. It is not shown again, and it
          stops working on {new Date(issued.invite.expiresAt).toLocaleDateString()}.
        </p>
        <div className="flex items-center gap-2">
          <CopyField
            value={inviteUrl(issued.invite)}
            label="invite link"
            className="min-w-0 flex-1"
          />
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    </Panel>
  );
}

export function InviteForm({
  busy,
  onInvite,
}: {
  busy: boolean;
  onInvite: (email: string) => Promise<boolean>;
}) {
  const [email, setEmail] = useState("");

  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (await onInvite(email.trim())) setEmail("");
      }}
    >
      <p className="text-sm text-muted-foreground">
        They get a link and choose their own password, so you never handle it. They start with
        everyday access. Give them more once they are in.
      </p>
      <Field label="Email" required>
        <Input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="name@example.com"
        />
      </Field>
      <Button type="submit" disabled={busy || email.trim().length === 0}>
        {busy ? "Inviting…" : "Create the invite link"}
      </Button>
    </form>
  );
}
