import { z } from 'zod';
import { browserActionSchema, browserRefSchema } from '@tulipfarm/browser/contracts';

export const browserCallSchemas = [
  z.strictObject({
    tool: z.literal('browser.act'),
    action: browserActionSchema.describe(
      'One step: navigate to a URL, take a snapshot, click, type into, or select in an element by its ref from the latest snapshot, press a key such as Enter or Tab, scroll, go back, or wait.',
    ),
  }),
  z.strictObject({
    tool: z.literal('browser.handoff'),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe(
        'What the person needs to do in the browser, in one sentence, such as "Tick the terms box and solve the captcha".',
      ),
    signIn: z
      .string()
      .max(253)
      .optional()
      .describe(
        'Set when the person needs to sign in, to the site to sign in to, such as amazon.com. The panel then offers the saved logins they may use for it.',
      ),
  }),
  z.strictObject({
    tool: z.literal('browser.signIn'),
    secret: z
      .string()
      .min(1)
      .max(100)
      .describe('The reference of a username-and-password or password secret, from secrets.list or secrets.request.'),
    username: browserRefSchema
      .optional()
      .describe(
        "The ref of the page's username or email box, from the latest snapshot. Leave it out for a password secret.",
      ),
    password: browserRefSchema.describe("The ref of the page's password box, from the latest snapshot."),
    submit: browserRefSchema
      .optional()
      .describe('The ref of the sign-in button to click after typing, from the latest snapshot.'),
  }),
] as const;
export type BrowserCall = z.infer<(typeof browserCallSchemas)[number]>;
