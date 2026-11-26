import { z } from 'zod';
import { createWorkspaceSchema } from './contracts.ts';
import { onboardingGoalIds, onboardingPersonas, starterAgentIds } from './onboarding-catalog.ts';

export const onboardingTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const workspaceUrlAvailabilitySchema = z.strictObject({ available: z.boolean() });
const answerText = z.string().trim().min(1).max(300);

/** What the creator told the onboarding chat before sign-up. Every answer is optional. */
export const onboardingProfileSchema = z
  .object({
    goal: z
      .object({ id: z.enum(onboardingGoalIds).nullable(), text: answerText.nullable() })
      .strict()
      .nullable()
      .default(null),
    about: answerText.nullable().default(null),
    /** The optional website from signup step 1, as an http(s) URL. */
    website: z
      .url({ protocol: /^https?$/ })
      .max(200)
      .nullable()
      .default(null),
    /** What TulipFarm understood from the website's homepage, in its own words. */
    site: z.string().trim().max(600).nullable().default(null),
    persona: z.enum(onboardingPersonas).nullable().default(null),
    answers: z
      .array(z.object({ question: answerText, answer: answerText }).strict())
      .max(4)
      .default([]),
    selectedAgents: z
      .array(z.enum(starterAgentIds))
      .max(starterAgentIds.length)
      .refine(ids => new Set(ids).size === ids.length, 'Each agent can be selected once.')
      .default([]),
    agentRequests: z.array(answerText).max(3).default([]),
  })
  .strict();
export type OnboardingProfile = z.infer<typeof onboardingProfileSchema>;

export const onboardingDetailsSchema = createWorkspaceSchema
  .pick({ name: true, slug: true })
  .extend({
    accountType: z.enum(['personal', 'business']),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(40)
      .default([]),
    profile: onboardingProfileSchema.optional(),
  })
  .strict();
export const saveOnboardingSchema = z
  .object({
    token: onboardingTokenSchema,
    details: onboardingDetailsSchema,
  })
  .strict();
export const resumeOnboardingSchema = z.object({ token: onboardingTokenSchema }).strict();
export const completeOnboardingSchema = resumeOnboardingSchema.extend({
  challengeToken: z.string().max(2048).optional(),
});
export const onboardingDraftSchema = z.object({
  id: z.uuid(),
  details: onboardingDetailsSchema,
  expiresAt: z.iso.datetime(),
});
export type OnboardingDetails = z.infer<typeof onboardingDetailsSchema>;

// The onboarding chat: one visitor message in, one TulipFarm turn out.
/** In order: what the business does, what they want agents for, at most two follow-ups, the agent checklist, sign-up. */
export const interviewStages = ['about', 'goal', 'follow-up', 'agents', 'signup'] as const;
export type InterviewStage = (typeof interviewStages)[number];
export const interviewRequestSchema = z
  .object({
    /** Empty only for the `open` turn. */
    message: z.string().trim().max(1200),
    /** Signed earlier turns from the previous response. */
    conversation: z.string().max(16_000).optional(),
    workspaceName: createWorkspaceSchema.shape.name,
    /** The visitor's name from signup step 1, to address them by. */
    visitorName: z.string().trim().max(80).nullable().default(null),
    stage: z.enum(interviewStages),
    profile: onboardingProfileSchema,
    /**
     * `open` asks for TulipFarm's first message, read from the step 1 details and website. `agents` means the message
     * reports the cards the visitor picked, already in `profile`. `skip` jumps to sign-up.
     */
    kind: z.enum(['open', 'message', 'agents', 'skip']).default('message'),
  })
  .strict()
  .refine(request => request.kind === 'open' || request.kind === 'skip' || request.message.length > 0, {
    path: ['message'],
    message: 'Type a message.',
  });
export type InterviewRequest = z.infer<typeof interviewRequestSchema>;
export const interviewTurnSchema = z
  .object({
    reply: z.string().min(1).max(1200),
    stage: z.enum(interviewStages),
    profile: onboardingProfileSchema,
    /** Quick replies the visitor can tap instead of typing. */
    suggestions: z.array(z.string().min(1).max(60)).max(5),
    /** Starter agents to offer when the stage is `agents`. */
    agents: z.array(z.enum(starterAgentIds)).max(starterAgentIds.length),
    conversation: z.string().max(16_000).optional(),
  })
  .strict();
export type InterviewTurn = z.infer<typeof interviewTurnSchema>;
