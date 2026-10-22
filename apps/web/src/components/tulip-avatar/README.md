# Tulip avatar

`TulipAvatar` is the approved procedural Three.js character set, now available as
a controlled React component. The default private chat uses the green Bud as
**Bud** beside the welcome greeting. It waves for three seconds after its first
frame loads, then idles. Once the chat has messages, Bud moves to the header
and follows AI state updates. Both placements use a transparent background; the
header shows only the avatar beside the chat title, with no name or state caption.
Other screens retain the existing `AgentAvatar`; saved agents,
project chats, and Slack do not use this integration.

```tsx
import { TulipAvatar } from '@/components/tulip-avatar';
import type { TulipAvatarState } from '@/components/tulip-avatar';

function AgentPortrait({ state }: { state: TulipAvatarState }) {
  return <TulipAvatar name="Research agent" character="Bud" color="Blue" state={state} size={64} shape="circle" />;
}
```

The caller changes `state` to change the animation. Each mounted avatar has its
own state and clock. Changing state starts the new animation at time zero; changing
character builds that character with the current state. Changing color, size,
shape, or view does not restart the animation.

| Prop        | Values                                                                                                                                 | Default                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `name`      | Accessible agent label, distinct from the character design                                                                             | Character name                   |
| `character` | Bud, Bloom, Swoop, Pip, Curl, Fan, Twin, Fringe, Dew, Clover, Ribbon, Floret, Wisp, Bramble, Lotus, Sprig                              | Bud                              |
| `color`     | Blue, Rose, Sage, Apricot, Lilac, Butter, Coral, Mint, Periwinkle, Peach, Plum, Cloud, or a six-digit `#RRGGBB` color                  | Blue                             |
| `state`     | Idle, Blinking, Thinking, Working, Waving, Solving, Listening, Breathing, Reading, Searching, Sleeping, Nodding, Confused, Celebrating | Idle                             |
| `size`      | 24, 32, 40, 64, 128, 256 pixels                                                                                                        | 40                               |
| `shape`     | circle, square (rounded corners)                                                                                                       | circle                           |
| `variant`   | default (muted background), plain (transparent background)                                                                             | default                          |
| `view`      | head, full                                                                                                                             | head                             |
| `paused`    | Freeze this avatar; state changes still show the new static pose                                                                       | false                            |
| `onReady`   | Optional callback after the first visible frame, and after recovery                                                                    | None                             |
| `onError`   | Optional `(error: Error) => void` notification                                                                                         | Console error and local retry UI |

The catalogs and prop types are exported from the same component module.
Consumers use these props, not `className`, `style`, or arbitrary DOM props.
Layout belongs on the surrounding element.

Hair remains at 90% of the original lab size; eyes remain at 120% with independent
blink transforms. Materials are matte. Head-only mode includes typing hands and
keyboard, reading book, waving hand, and gesture props. Thinking, solving,
listening, searching, sleeping, confused, and celebrating have their approved
indicators, including party emoji and confetti.

## Loading, motion, and recovery

The Three.js runtime loads only on mount. Initial loading reserves the requested
size and shows the name's initial. A successful first render replaces it with
the avatar. There is no data fetch or empty-record state.

All instances share one offscreen WebGL renderer, copied into individual 2D
canvases. Animations stop offscreen, in hidden tabs, when paused, and whenever the
operating system requests reduced motion. Paused avatars render again only when
their inputs or dimensions change. Unmount releases scene resources and observers;
the final unmount also releases the shared renderer, context, and listeners.
The component does not intercept scrolling or add orbit controls.

Rendering failures show the agent initial as a labeled **Retry avatar** button,
log the error, and call `onError` if supplied. Retry remounts the renderer subscription;
context restoration also redraws affected avatars. Invalid runtime colors,
characters, states, or views fail explicitly instead of selecting another design.

## Verification

Inspected 11 October 2026. The test-only Vite fixture imports the real component
without adding a route or usage to the app.

```sh
pnpm test:files apps/web/test/tulip-avatar.test.ts apps/web/test/tulip-avatar.browser.mjs
```

The browser suite covers independent prop updates, the approved geometry and props,
small sizes, reduced motion, pause, scrolling, unmount/remount, and error/retry.
`TULIP_AVATAR_SCREENSHOT` sets the capture path; `TULIP_AVATAR_CDP_PORT` enables
an agent-browser capture of the same test-only page.

## Bud in chat

The workspace-wide assistant now also uses this avatar in its launcher and
private floating popup. Dragging the launcher snaps it to one of four corners,
saved in local storage; its popup opens inward. Identity, onboarding, preference consent, and prompt timing
belong to `features/chat/bud-provider.tsx` and the conversations Bud service.
The avatar's animation state still grants no authority and writes no memory.

The private-chat worker enables the presentation-only `bud_state` native tool.
Each model request receives Bud's name, fixed appearance, supported states, and
latest expression. The model can set a state before its next action or answer.
The inference result includes `{ avatar: { name: "Bud", state } }` alongside
plain reply text. Avatar calls never dispatch business tools or grant authority.
They are limited to six updates per reply and use ordinary metered model requests.

Validated `avatar` events travel through the existing private conversation stream.
Generation, attempt, step, and sequence ordering reject old updates. Queued replies
start Thinking; failed/blocked replies show Confused; waiting shows Listening;
cancellation shows Idle. No-work starts Idle. A graphics error shows the initial
and an accessible retry action without blocking chat.

Expressions are live presentation state, not saved conversation data. A completed
reply keeps its last expression in the current browser session; reopening a chat
starts Idle. Reconnecting during a reply uses the API's bounded preview cache.
If the stream is unavailable, chat polling still works and Bud uses the known
turn status instead of claiming a live model expression.

For a local demo with real AI replies and in-memory sample chat data:

```sh
pnpm exec turbo run build --filter=@tulipfarm/agents --filter=@tulipfarm/recommendations
pnpm secrets run --env local --keys ANTHROPIC_API_KEY -- node apps/web/test/bud-demo.mjs
```

Open `http://127.0.0.1:4320/bud-demo`. Only typed demo messages reach the configured
Haiku model. Business tools and real workspace reads/writes are disabled. Demo
messages disappear when the server stops. This is not database/Temporal proof.
