# Connect Reddit

This Integration calls Reddit's OAuth Data API. It is not a certification or approval from Reddit.

## Approval comes first

Reddit allows Data API access only for approved uses. Apply through Reddit's Data API request form
and obtain any contract or commercial-use permission your use needs. Do not connect this package
until Reddit has approved the app and its intended use.

Register an OAuth app for the approved account and request only these scopes:

- `identity` for `reddit_get_identity`.
- `read` for subreddit listings and submission comments.
- `submit` for comments and posts.

Every request must carry a unique, truthful User-Agent in Reddit's documented form:
`<platform>:<app-id>:<version> (by /u/<reddit-username>)`.

## Connect it

Create a Reddit **web app** and register the exact callback URL shown by TulipFarm. In
**Integrations → Reddit → Connect**, enter the app's client ID, client secret and truthful
User-Agent, then authorize the Reddit account. TulipFarm sends the client credentials with HTTP
Basic authentication during the authorization-code exchange and refreshes the access token using
the returned refresh token. The authorization request uses `duration=permanent`.

TulipFarm saves the User-Agent on the Connection and adds it to every API request. Agents cannot
change it per call.

## What agents can do

| Tool | Effect | Scope |
| --- | --- | --- |
| `reddit_get_identity` | sensitive read | `identity` |
| `reddit_list_subreddit_posts` | read | `read` |
| `reddit_get_submission` | read | `read` |
| `reddit_add_comment` | send | `submit` |
| `reddit_create_post` | send | `submit` |

For subreddit listings, use the returned `next_page_token` to continue. For comments and posts,
Reddit may return HTTP 200 with errors inside `json.errors`; treat any non-empty array as failure.
The package declares a missing success envelope or a non-empty error array invalid. Treat a write
as successful only when TulipFarm returns a confirmed effect.

Reddit's documented free limit is 100 queries per minute per OAuth client id, averaged over its
window. OIM can scope limits only per Connection or operation, so this package does not misstate
that client-wide limit as a per-Connection allowance.

Reddit requires deleted content and identifying data to be removed. Do not use these Tools to train
models, retain deleted content, or exceed the approved purpose.

## Sources

- https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data
- https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki
- https://www.reddit.com/dev/api/oauth
- https://www.redditinc.com/policies/developer-terms
- https://www.redditinc.com/policies/data-api-terms
