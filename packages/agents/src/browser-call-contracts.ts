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
      .describe(
        "The Files folder for files this step downloads. In a chat, omit it to save them to the person's files. In a run, set it or folderName to a folder the run's owner can add to whenever the step may download a file; without either, downloads are not saved.",
      ),
    folderName: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .optional()
      .describe(
        "In a run, the name of the Files folder for files this step downloads, as the task names it, when you do not have its id. It must name exactly one folder the run's owner can add to. Ignored when folderId is set.",
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
/** In a run, only the files attached to the run or saved by it may be uploaded. */
export const browserUploadCallSchema = z.strictObject({
  tool: z.literal('browser.upload'),
  file: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'The file to upload. In a chat: an attachment-id or file-id from a file block of this chat, the source of an api.request response file, or a file ID from files.list. In a run: the file ID of a file attached to the run, or of a file this run saved, such as a browser download or a generated image.',
    ),
  ref: browserRefSchema.describe(
    "The ref of the page's file input or upload button, from the latest snapshot. A file input shows as a button.",
  ),
});
export type BrowserCall = z.infer<(typeof browserCallSchemas)[number] | typeof browserUploadCallSchema>;
