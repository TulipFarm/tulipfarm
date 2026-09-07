import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { ajv } from "@tulipfarm/schema";

const nonEmptyString = Type.String({ minLength: 1 });
const optionalNonEmptyString = Type.Optional(nonEmptyString);
const slackContextSchema = Type.Object({
  channel_id: Type.Optional(Type.Union([nonEmptyString, Type.Null()])),
  team_id: Type.Optional(Type.Union([nonEmptyString, Type.Null()])),
  enterprise_id: Type.Optional(Type.Union([nonEmptyString, Type.Null()])),
});
const slackFileSchema = Type.Object({ id: nonEmptyString });
const slackUserProfileSchema = Type.Object({
  display_name: Type.Optional(Type.String()),
  real_name: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  email: Type.Optional(Type.String()),
  image_72: Type.Optional(Type.String()),
});
const slackUserSchema = Type.Object({
  id: nonEmptyString,
  name: Type.Optional(Type.String()),
  real_name: Type.Optional(Type.String()),
  deleted: Type.Optional(Type.Boolean()),
  is_bot: Type.Optional(Type.Boolean()),
  profile: Type.Optional(slackUserProfileSchema),
});

export const SlackEventsApiEnvelopeSchema = Type.Object({
  type: Type.Literal("event_callback"),
  team_id: Type.Optional(Type.Union([nonEmptyString, Type.Null()])),
  enterprise_id: Type.Optional(Type.Union([nonEmptyString, Type.Null()])),
  api_app_id: nonEmptyString,
  event_id: nonEmptyString,
  event_time: Type.Number(),
  event: Type.Unknown(),
  authorizations: Type.Optional(
    Type.Array(
      Type.Object({
        user_id: Type.Optional(nonEmptyString),
        is_bot: Type.Optional(Type.Boolean()),
      })
    )
  ),
});

export type SlackEventsApiEnvelope = Static<typeof SlackEventsApiEnvelopeSchema>;

const messageEventSchema = (channelType: "channel" | "group" | "im" | "mpim") =>
  Type.Object({
    type: Type.Literal("message"),
    channel_type: Type.Literal(channelType),
    channel: nonEmptyString,
    user: nonEmptyString,
    ts: nonEmptyString,
    thread_ts: optionalNonEmptyString,
    text: Type.Optional(Type.String()),
    files: Type.Optional(Type.Array(slackFileSchema)),
  });

const anyMessageEventSchema = Type.Union([
  messageEventSchema("channel"),
  messageEventSchema("group"),
  messageEventSchema("im"),
  messageEventSchema("mpim"),
]);

const appMentionEventSchema = Type.Object({
  type: Type.Literal("app_mention"),
  channel: nonEmptyString,
  user: nonEmptyString,
  ts: nonEmptyString,
  thread_ts: optionalNonEmptyString,
  text: Type.Optional(Type.String()),
  app_id: optionalNonEmptyString,
  files: Type.Optional(Type.Array(slackFileSchema)),
});

const appHomeOpenedEventSchema = Type.Object({
  type: Type.Literal("app_home_opened"),
  user: nonEmptyString,
  tab: nonEmptyString,
  channel: optionalNonEmptyString,
});

const assistantThreadSchema = Type.Object({
  user_id: nonEmptyString,
  thread_ts: nonEmptyString,
  channel_id: nonEmptyString,
  context: Type.Optional(slackContextSchema),
});

const assistantThreadStartedEventSchema = Type.Object(
  {
    type: Type.Literal("assistant_thread_started"),
    assistant_thread: assistantThreadSchema,
    event_ts: Type.Optional(nonEmptyString),
  },
  { additionalProperties: false }
);

const assistantThreadContextChangedEventSchema = Type.Object(
  {
    type: Type.Literal("assistant_thread_context_changed"),
    assistant_thread: Type.Object({
      user_id: nonEmptyString,
      thread_ts: Type.Optional(nonEmptyString),
      channel_id: Type.Optional(nonEmptyString),
      context: slackContextSchema,
    }),
    event_ts: Type.Optional(nonEmptyString),
  },
  { additionalProperties: false }
);

const appContextChangedEventSchema = Type.Object(
  {
    type: Type.Literal("app_context_changed"),
    context: Type.Object(
      {
        entities: Type.Optional(
          Type.Array(
            Type.Object(
              {
                type: nonEmptyString,
                value: nonEmptyString,
                team_id: optionalNonEmptyString,
              },
              { additionalProperties: false }
            )
          )
        ),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

const reactionEventSchema = (type: "reaction_added" | "reaction_removed") =>
  Type.Object({
    type: Type.Literal(type),
    user: nonEmptyString,
    reaction: nonEmptyString,
    item: Type.Object({
      type: nonEmptyString,
      channel: optionalNonEmptyString,
      ts: optionalNonEmptyString,
      file: optionalNonEmptyString,
      file_comment: optionalNonEmptyString,
    }),
  });

const channelCreatedEventSchema = Type.Object({
  type: Type.Literal("channel_created"),
  channel: Type.Object({
    id: nonEmptyString,
    name: nonEmptyString,
    creator: optionalNonEmptyString,
  }),
});

const channelRenamedEventSchema = Type.Object({
  type: Type.Literal("channel_rename"),
  channel: Type.Object({ id: nonEmptyString, name: nonEmptyString }),
});

const channelLifecycleEventSchema = (type: "channel_archive" | "channel_unarchive") =>
  Type.Object({
    type: Type.Literal(type),
    channel: nonEmptyString,
    user: optionalNonEmptyString,
  });

const channelMembershipEventSchema = (type: "member_joined_channel" | "member_left_channel") =>
  Type.Object({
    type: Type.Literal(type),
    channel: nonEmptyString,
    user: nonEmptyString,
    inviter: optionalNonEmptyString,
  });

const fileEventSchema = (type: "file_shared" | "file_deleted") =>
  Type.Object({
    type: Type.Literal(type),
    file_id: nonEmptyString,
    user_id: optionalNonEmptyString,
    channel_id: optionalNonEmptyString,
  });

const userEventSchema = (type: "team_join" | "user_change" | "user_profile_changed") =>
  Type.Object({ type: Type.Literal(type), user: slackUserSchema });

const emojiChangedEventSchema = Type.Union([
  Type.Object({
    type: Type.Literal("emoji_changed"),
    subtype: Type.Literal("add"),
    name: nonEmptyString,
  }),
  Type.Object({
    type: Type.Literal("emoji_changed"),
    subtype: Type.Literal("remove"),
    names: Type.Array(nonEmptyString, { minItems: 1, maxItems: 1 }),
  }),
  Type.Object({
    type: Type.Literal("emoji_changed"),
    subtype: Type.Literal("rename"),
    old_name: nonEmptyString,
    new_name: nonEmptyString,
  }),
]);

export const SLACK_V1_EVENT_CATALOG = [
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
  "app_mention",
  "app_home_opened",
  "assistant_thread_started",
  "assistant_thread_context_changed",
  "app_context_changed",
  "reaction_added",
  "reaction_removed",
  "channel_created",
  "channel_rename",
  "channel_archive",
  "channel_unarchive",
  "member_joined_channel",
  "member_left_channel",
  "file_shared",
  "file_deleted",
  "team_join",
  "user_change",
  "user_profile_changed",
  "emoji_changed",
] as const;

export type SlackV1EventType = (typeof SLACK_V1_EVENT_CATALOG)[number];

export const SLACK_V1_EVENT_SCHEMAS = {
  "message.channels": messageEventSchema("channel"),
  "message.groups": messageEventSchema("group"),
  "message.im": messageEventSchema("im"),
  "message.mpim": messageEventSchema("mpim"),
  app_mention: appMentionEventSchema,
  app_home_opened: appHomeOpenedEventSchema,
  assistant_thread_started: assistantThreadStartedEventSchema,
  assistant_thread_context_changed: assistantThreadContextChangedEventSchema,
  app_context_changed: appContextChangedEventSchema,
  reaction_added: reactionEventSchema("reaction_added"),
  reaction_removed: reactionEventSchema("reaction_removed"),
  channel_created: channelCreatedEventSchema,
  channel_rename: channelRenamedEventSchema,
  channel_archive: channelLifecycleEventSchema("channel_archive"),
  channel_unarchive: channelLifecycleEventSchema("channel_unarchive"),
  member_joined_channel: channelMembershipEventSchema("member_joined_channel"),
  member_left_channel: channelMembershipEventSchema("member_left_channel"),
  file_shared: fileEventSchema("file_shared"),
  file_deleted: fileEventSchema("file_deleted"),
  team_join: userEventSchema("team_join"),
  user_change: userEventSchema("user_change"),
  user_profile_changed: userEventSchema("user_profile_changed"),
  emoji_changed: emojiChangedEventSchema,
} as const satisfies Record<string, TSchema>;

const rawEventSchemas = {
  message: anyMessageEventSchema,
  app_mention: appMentionEventSchema,
  app_home_opened: appHomeOpenedEventSchema,
  assistant_thread_started: assistantThreadStartedEventSchema,
  assistant_thread_context_changed: assistantThreadContextChangedEventSchema,
  app_context_changed: appContextChangedEventSchema,
  reaction_added: SLACK_V1_EVENT_SCHEMAS.reaction_added,
  reaction_removed: SLACK_V1_EVENT_SCHEMAS.reaction_removed,
  channel_created: channelCreatedEventSchema,
  channel_rename: channelRenamedEventSchema,
  channel_archive: SLACK_V1_EVENT_SCHEMAS.channel_archive,
  channel_unarchive: SLACK_V1_EVENT_SCHEMAS.channel_unarchive,
  member_joined_channel: SLACK_V1_EVENT_SCHEMAS.member_joined_channel,
  member_left_channel: SLACK_V1_EVENT_SCHEMAS.member_left_channel,
  file_shared: SLACK_V1_EVENT_SCHEMAS.file_shared,
  file_deleted: SLACK_V1_EVENT_SCHEMAS.file_deleted,
  team_join: SLACK_V1_EVENT_SCHEMAS.team_join,
  user_change: SLACK_V1_EVENT_SCHEMAS.user_change,
  user_profile_changed: SLACK_V1_EVENT_SCHEMAS.user_profile_changed,
  emoji_changed: emojiChangedEventSchema,
} as const satisfies Record<string, TSchema>;

type SupportedSlackEventType = keyof typeof rawEventSchemas;
type SlackContext = Static<typeof slackContextSchema>;
type SlackAppContext = Static<typeof appContextChangedEventSchema>["context"];
type SlackUser = Static<typeof slackUserSchema>;

export interface SlackEventNormalizationContext {
  integrationId: string;
  actorPrincipalId?: string;
}

export interface SlackEventValidationIssue {
  path: string;
  keyword: string;
  message: string;
}

export type SlackEventNormalizationResult =
  | { outcome: "normalized"; event: SlackNormalizedEvent }
  | { outcome: "unsupported"; eventType?: string }
  | {
      outcome: "validation_failed";
      eventType?: string;
      issues: readonly SlackEventValidationIssue[];
    };

interface NormalizedBase {
  name: string;
  version: 1;
  integrationId: string;
  externalTenantId: string;
  providerEventId: string;
  occurredAt: string;
  deduplicationKey: string;
  classification: readonly ["untrusted.external"];
  conversationId?: string;
  actorPrincipalId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eventTypeOf(event: unknown): string | undefined {
  return isRecord(event) && typeof event.type === "string" ? event.type : undefined;
}

function validationIssues(
  errors: typeof envelopeValidator.errors
): readonly SlackEventValidationIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? "validation failed",
  }));
}

const envelopeValidator = ajv.compile(SlackEventsApiEnvelopeSchema);
const eventValidators = Object.fromEntries(
  Object.entries(rawEventSchemas).map(([type, schema]) => [type, ajv.compile(schema)])
) as Record<SupportedSlackEventType, ReturnType<typeof ajv.compile>>;

function common(
  envelope: SlackEventsApiEnvelope,
  context: SlackEventNormalizationContext,
  name: string,
  actorExternalId?: string,
  conversationId?: string
): NormalizedBase {
  return {
    name,
    version: 1,
    integrationId: context.integrationId,
    externalTenantId: externalTenantIdOf(envelope),
    providerEventId: envelope.event_id,
    occurredAt: new Date(envelope.event_time * 1000).toISOString(),
    deduplicationKey: envelope.event_id,
    classification: ["untrusted.external"],
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(actorExternalId === undefined || context.actorPrincipalId === undefined
      ? {}
      : { actorPrincipalId: context.actorPrincipalId }),
  };
}

function externalTenantIdOf(envelope: SlackEventsApiEnvelope): string {
  const externalTenantId = envelope.team_id ?? envelope.enterprise_id;
  if (externalTenantId === undefined || externalTenantId === null) {
    throw new Error("slack_event_normalizer_unreachable");
  }
  return externalTenantId;
}

function compactContext(context: SlackContext): Record<string, string | null> {
  return {
    ...(context.channel_id === undefined ? {} : { channelId: context.channel_id }),
    ...(context.team_id === undefined ? {} : { teamId: context.team_id }),
    ...(context.enterprise_id === undefined ? {} : { enterpriseId: context.enterprise_id }),
  };
}

function compactAppContext(context: SlackAppContext) {
  return {
    ...(context.entities === undefined
      ? {}
      : {
          entities: context.entities.map((entity) => ({
            type: entity.type,
            value: entity.value,
            ...(entity.team_id === undefined ? {} : { teamId: entity.team_id }),
          })),
        }),
  };
}

function directoryFields(user: SlackUser) {
  return {
    subjectExternalId: user.id,
    ...(user.name === undefined ? {} : { name: user.name }),
    ...(user.real_name === undefined ? {} : { realName: user.real_name }),
    ...(user.profile?.display_name === undefined ? {} : { displayName: user.profile.display_name }),
    ...(user.profile?.real_name === undefined ? {} : { profileRealName: user.profile.real_name }),
    ...(user.profile?.title === undefined ? {} : { title: user.profile.title }),
    ...(user.profile?.email === undefined ? {} : { email: user.profile.email }),
    ...(user.profile?.image_72 === undefined ? {} : { avatarUrl: user.profile.image_72 }),
    ...(user.is_bot === undefined ? {} : { isBot: user.is_bot }),
    ...(user.deleted === undefined ? {} : { deleted: user.deleted }),
  };
}

function normalizeSupportedEvent(
  envelope: SlackEventsApiEnvelope,
  context: SlackEventNormalizationContext,
  event: Record<string, unknown>
) {
  switch (event.type) {
    case "message": {
      const value = event as Static<typeof anyMessageEventSchema>;
      const fileIds = value.files?.map((file) => file.id) ?? [];
      return {
        ...common(envelope, context, "slack.message.received.v1", value.user, value.channel),
        untrustedPayload: {
          messageId: value.ts,
          conversationId: value.channel,
          conversationKind: value.channel_type,
          ...(value.thread_ts === undefined ? {} : { threadId: value.thread_ts }),
          actorExternalId: value.user,
          text: value.text ?? "",
          fileIds,
        },
      } as const;
    }
    case "app_mention": {
      const value = event as Static<typeof appMentionEventSchema>;
      return {
        ...common(envelope, context, "slack.mention.received.v1", value.user, value.channel),
        untrustedPayload: {
          messageId: value.ts,
          conversationId: value.channel,
          conversationKind: "channel",
          ...(value.thread_ts === undefined ? {} : { threadId: value.thread_ts }),
          actorExternalId: value.user,
          text: value.text ?? "",
          fileIds: value.files?.map((file) => file.id) ?? [],
          mentionedAppId: value.app_id ?? envelope.api_app_id,
        },
      } as const;
    }
    case "app_home_opened": {
      const value = event as Static<typeof appHomeOpenedEventSchema>;
      return {
        ...common(envelope, context, "slack.home.opened.v1", value.user, value.channel),
        untrustedPayload: {
          actorExternalId: value.user,
          tab: value.tab,
          ...(value.channel === undefined ? {} : { conversationId: value.channel }),
        },
      } as const;
    }
    case "assistant_thread_started": {
      const value = event as Static<typeof assistantThreadStartedEventSchema>;
      return {
        ...common(
          envelope,
          context,
          "slack.agent.thread.started.v1",
          value.assistant_thread.user_id,
          value.assistant_thread.channel_id
        ),
        untrustedPayload: {
          actorExternalId: value.assistant_thread.user_id,
          threadId: value.assistant_thread.thread_ts,
          ...(value.assistant_thread.context === undefined
            ? {}
            : { context: compactContext(value.assistant_thread.context) }),
        },
      } as const;
    }
    case "assistant_thread_context_changed": {
      const value = event as Static<typeof assistantThreadContextChangedEventSchema>;
      return {
        ...common(
          envelope,
          context,
          "slack.agent.context.changed.v1",
          value.assistant_thread.user_id,
          value.assistant_thread.channel_id ??
            value.assistant_thread.context.channel_id ??
            undefined
        ),
        untrustedPayload: {
          actorExternalId: value.assistant_thread.user_id,
          ...(value.assistant_thread.thread_ts === undefined
            ? {}
            : { threadId: value.assistant_thread.thread_ts }),
          context: compactContext(value.assistant_thread.context),
        },
      } as const;
    }
    case "app_context_changed": {
      const value = event as Static<typeof appContextChangedEventSchema>;
      return {
        ...common(envelope, context, "slack.agent.context.changed.v1"),
        untrustedPayload: {
          context: compactAppContext(value.context),
        },
      } as const;
    }
    case "reaction_added":
    case "reaction_removed": {
      const value = event as Static<ReturnType<typeof reactionEventSchema>>;
      const conversationId = value.item.channel;
      return {
        ...common(
          envelope,
          context,
          value.type === "reaction_added" ? "slack.reaction.added.v1" : "slack.reaction.removed.v1",
          value.user,
          conversationId
        ),
        untrustedPayload: {
          actorExternalId: value.user,
          reaction: value.reaction,
          itemType: value.item.type,
          ...(conversationId === undefined ? {} : { conversationId }),
          ...(value.item.ts === undefined ? {} : { messageId: value.item.ts }),
          ...(value.item.file === undefined ? {} : { fileId: value.item.file }),
          ...(value.item.file_comment === undefined
            ? {}
            : { fileCommentId: value.item.file_comment }),
        },
      } as const;
    }
    case "channel_created": {
      const value = event as Static<typeof channelCreatedEventSchema>;
      return {
        ...common(
          envelope,
          context,
          "slack.channel.created.v1",
          value.channel.creator,
          value.channel.id
        ),
        untrustedPayload: {
          conversationId: value.channel.id,
          name: value.channel.name,
          ...(value.channel.creator === undefined
            ? {}
            : { creatorExternalId: value.channel.creator }),
        },
      } as const;
    }
    case "channel_rename": {
      const value = event as Static<typeof channelRenamedEventSchema>;
      return {
        ...common(envelope, context, "slack.channel.renamed.v1", undefined, value.channel.id),
        untrustedPayload: { conversationId: value.channel.id, name: value.channel.name },
      } as const;
    }
    case "channel_archive":
    case "channel_unarchive": {
      const value = event as Static<ReturnType<typeof channelLifecycleEventSchema>>;
      return {
        ...common(
          envelope,
          context,
          value.type === "channel_archive"
            ? "slack.channel.archived.v1"
            : "slack.channel.unarchived.v1",
          value.user,
          value.channel
        ),
        untrustedPayload: {
          conversationId: value.channel,
          ...(value.user === undefined ? {} : { actorExternalId: value.user }),
        },
      } as const;
    }
    case "member_joined_channel":
    case "member_left_channel": {
      const value = event as Static<ReturnType<typeof channelMembershipEventSchema>>;
      const actorExternalId = value.inviter;
      return {
        ...common(
          envelope,
          context,
          value.type === "member_joined_channel"
            ? "slack.channel.member_joined.v1"
            : "slack.channel.member_left.v1",
          actorExternalId,
          value.channel
        ),
        untrustedPayload: {
          conversationId: value.channel,
          memberExternalId: value.user,
          ...(actorExternalId === undefined ? {} : { actorExternalId }),
        },
      } as const;
    }
    case "file_shared":
    case "file_deleted": {
      const value = event as Static<ReturnType<typeof fileEventSchema>>;
      return {
        ...common(
          envelope,
          context,
          value.type === "file_shared" ? "slack.file.shared.v1" : "slack.file.deleted.v1",
          value.user_id,
          value.channel_id
        ),
        untrustedPayload: {
          fileId: value.file_id,
          ...(value.user_id === undefined ? {} : { actorExternalId: value.user_id }),
          ...(value.channel_id === undefined ? {} : { conversationId: value.channel_id }),
        },
      } as const;
    }
    case "team_join":
    case "user_change":
    case "user_profile_changed": {
      const value = event as Static<ReturnType<typeof userEventSchema>>;
      const name =
        value.type === "team_join"
          ? "slack.user.joined.v1"
          : value.type === "user_change"
            ? "slack.user.changed.v1"
            : "slack.user.profile_changed.v1";
      return {
        ...common(envelope, context, name),
        untrustedPayload: directoryFields(value.user),
      } as const;
    }
    case "emoji_changed": {
      const value = event as Static<typeof emojiChangedEventSchema>;
      const emojiName =
        value.subtype === "rename"
          ? value.old_name
          : value.subtype === "remove"
            ? value.names[0]
            : value.name;
      return {
        ...common(envelope, context, "slack.emoji.changed.v1"),
        untrustedPayload: {
          changeType: value.subtype,
          emojiName,
          ...(value.subtype === "rename" ? { newName: value.new_name } : {}),
        },
      } as const;
    }
    default:
      throw new Error("slack_event_normalizer_unreachable");
  }
}

export type SlackNormalizedEvent = ReturnType<typeof normalizeSupportedEvent>;
export type SlackNormalizedEventName = SlackNormalizedEvent["name"];

export function normalizeSlackEvent(
  input: unknown,
  context: SlackEventNormalizationContext
): SlackEventNormalizationResult {
  const inputEvent = isRecord(input) ? input.event : undefined;
  const eventType = eventTypeOf(inputEvent);
  if (!envelopeValidator(input)) {
    return {
      outcome: "validation_failed",
      ...(eventType === undefined ? {} : { eventType }),
      issues: validationIssues(envelopeValidator.errors),
    };
  }
  const envelope = input as SlackEventsApiEnvelope;
  if (envelope.team_id == null && envelope.enterprise_id == null) {
    return {
      outcome: "validation_failed",
      ...(eventType === undefined ? {} : { eventType }),
      issues: [
        {
          path: "",
          keyword: "required",
          message: "team_id or enterprise_id is required",
        },
      ],
    };
  }

  if (eventType === undefined || !(eventType in eventValidators)) {
    return {
      outcome: "unsupported",
      ...(eventType === undefined ? {} : { eventType }),
    };
  }
  if (
    eventType === "message" &&
    isRecord(envelope.event) &&
    typeof envelope.event.subtype === "string"
  ) {
    return { outcome: "unsupported", eventType: `message.${envelope.event.subtype}` };
  }

  const supportedType = eventType as SupportedSlackEventType;
  const validator = eventValidators[supportedType];
  if (!validator(envelope.event)) {
    return {
      outcome: "validation_failed",
      eventType,
      issues: validationIssues(validator.errors),
    };
  }

  return {
    outcome: "normalized",
    event: normalizeSupportedEvent(envelope, context, envelope.event as Record<string, unknown>),
  };
}
