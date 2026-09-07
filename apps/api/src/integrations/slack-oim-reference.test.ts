import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runOimFixtures } from "@tulipfarm/integrations";
import { oimPackageIssues, parseOimManifest } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..", "..", "integrations", "slack-oim");

async function loadSlackOim() {
  const manifest = parseOimManifest(await readFile(join(ROOT, "oim.yml"), "utf8"));
  const companions = new Map<string, string>();
  for (const file of manifest.files ?? []) {
    companions.set(file.path, await readFile(join(ROOT, file.path), "utf8"));
  }
  return { manifest, companions };
}

describe("Slack OIM reference", () => {
  it("ships a valid package with hermetic passing fixtures", async () => {
    const { manifest, companions } = await loadSlackOim();

    expect(oimPackageIssues(manifest, companions)).toEqual([]);
    expect(await runOimFixtures(manifest, companions)).toEqual([
      { name: "identifies-bot-workspace", fixture: "fixtures.yml", passed: true },
      { name: "lists-bot-conversations", fixture: "fixtures.yml", passed: true },
      { name: "reads-bot-history", fixture: "fixtures.yml", passed: true },
      { name: "lists-channel-members", fixture: "fixtures.yml", passed: true },
      { name: "reads-one-bot-message", fixture: "fixtures.yml", passed: true },
      { name: "sends-bot-message", fixture: "fixtures.yml", passed: true },
    ]);
  });

  it("keeps every operation on the shared bot identity", async () => {
    const { manifest } = await loadSlackOim();
    const operations = new Map(manifest.operations.map((operation) => [operation.id, operation]));

    for (const id of [
      "bot-auth-test",
      "bot-list-conversations",
      "bot-conversation-history",
      "bot-list-members",
      "bot-user-info",
      "bot-read-message",
      "bot-send-message",
    ]) {
      expect(operations.get(id)).toMatchObject({
        identityMode: "shared_only",
        credentialSlot: "bot_access_token",
      });
    }
    const names = manifest.operations.map((operation) => operation.name);
    expect(names.every((name) => name.startsWith("slack_oim_"))).toBe(true);
    expect(manifest.operations.every((operation) => operation.identityMode === "shared_only")).toBe(
      true
    );
    expect(manifest.auth?.credentialSlots.map((slot) => slot.id)).not.toContain(
      "personal_access_token"
    );
    expect(names).not.toContain("send_slack_message");
    expect(names).not.toContain("slack_channel_list");
    expect(names).not.toContain("slack_acknowledge");
  });

  it("uses one portable shared-bot OAuth flow", async () => {
    const { manifest } = await loadSlackOim();
    const install = manifest.auth?.steps.find((step) => step.id === "install");
    if (install?.type !== "oauth2") throw new Error("expected Slack OAuth install");

    expect(install.authorizationUrl).toBe("https://slack.com/oauth/v2/authorize");
    expect(install.tokenUrl).toBe("https://slack.com/api/oauth.v2.access");
    expect(install.pkce).toBe(false);
    expect(new Set(install.scopes)).toEqual(
      new Set([
        "chat:write",
        "app_mentions:read",
        "channels:read",
        "channels:history",
        "groups:read",
        "groups:history",
        "im:read",
        "im:history",
        "mpim:read",
        "mpim:history",
        "users:read",
        "users:read.email",
        "assistant:write",
        "reactions:write",
        "emoji:read",
      ])
    );
    expect(install.bindings).toEqual(
      expect.arrayContaining([
        {
          sourcePath: "/access_token",
          target: { type: "credential", slot: "bot_access_token" },
        },
        {
          sourcePath: "/app_id",
          target: { type: "configuration", field: "app_id" },
        },
        {
          sourcePath: "/team/id",
          target: { type: "configuration", field: "team_id" },
        },
      ])
    );
  });

  it("declares Slack's raw-body timestamped HMAC and typed events", async () => {
    const { manifest } = await loadSlackOim();

    expect(manifest.events?.verification).toEqual({
      scheme: "hmac_sha256",
      secretSlot: "signing_secret",
      signatureHeader: "X-Slack-Signature",
      signatureEncoding: "hex",
      signaturePrefix: "v0=",
      signingInput: "v0:{timestamp}:{body}",
      timestampHeader: "X-Slack-Request-Timestamp",
      toleranceSeconds: 300,
    });
    expect(manifest.events?.handshake).toEqual({
      kind: "echo_body_pointer",
      bodyPointer: "/challenge",
      responseField: "challenge",
    });
    expect(manifest.events?.deduplication).toEqual({
      kind: "body_pointer",
      bodyPointer: "/event_id",
    });
    expect(manifest.events?.eventTypes.map((event) => event.type)).toEqual([
      "slack.message",
      "slack.app_mention",
    ]);
  });

  it("maps Slack messages and membership through the portable Knowledge profile", async () => {
    const { manifest, companions } = await loadSlackOim();
    const guide = companions.get("setup-guide.md");

    expect(manifest.profiles.knowledge).toBe("1.1");
    expect(manifest.knowledge).toMatchObject({
      list: {
        operationId: "bot-conversation-history",
        scopeParameter: "channel",
        mapping: {
          itemFields: {
            channel: { source: "scope" },
            timestamp: { source: "item", pointer: "/ts" },
          },
          itemIdentity: ["channel", "timestamp"],
        },
      },
      content: {
        operationId: "bot-read-message",
        parameters: {
          channel: "channel",
          latest: "timestamp",
          oldest: "timestamp",
        },
        mapping: {
          content: {
            itemsPointer: "/messages",
            itemPointer: "/text",
            separator: "\n",
          },
        },
      },
      acl: {
        mode: "scope",
        operationId: "bot-list-members",
        entriesPointer: "/members",
        entry: { defaultKind: "user", providerUserId: "" },
      },
      liveAuthorization: {
        operationId: "bot-list-members",
        parameters: { channel: "channel" },
        principalSet: { entriesPointer: "/members", principalIdPointer: "" },
      },
    });
    expect(manifest.extensions?.["x-tulipfarm-legacy-slack-bridge"]).toBeUndefined();
    expect(guide).toContain("not attached to that legacy channel path");
    expect(guide).toContain("Channel migration is incomplete");
  });
});
