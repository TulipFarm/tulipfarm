import { z } from 'zod';
import { browserActionSchema, browserRefSchema } from '@tulipfarm/browser/contracts';

export const browserCallSchemas = [
  z.strictObject({
    tool: z.literal('browser.act'),
    action: browserActionSchema.describe(
      'One step: navigate to a URL, take a snapshot, click, type into, or select in an element by its ref from the latest snapshot, press a key such as Enter or Tab, scroll, go back, or wait.',
    ),
    folderId: z
      .uuid()
      .optional()
      .describe("In a chat, the Files folder for files this step downloads. Omit to save them to the person's files."),
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
/** Chat only: a run has no Files to upload from. */
export const browserUploadCallSchema = z.strictObject({
  tool: z.literal('browser.upload'),
  file: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'The file to upload: an attachment-id or file-id from a file block of this chat, the source of an api.request response file, or a file ID from files.list.',
    ),
  ref: browserRefSchema.describe(
    "The ref of the page's file input or upload button, from the latest snapshot. A file input shows as a button.",
  ),
});
export type BrowserCall = z.infer<(typeof browserCallSchemas)[number] | typeof browserUploadCallSchema>;
