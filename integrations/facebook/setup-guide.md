# Connect Facebook Pages

This package lists Pages managed by one Facebook user and reads or creates posts on one Page. It
uses Facebook Login for Business, a User access token for Page discovery, and a Page access token
for Page content.

This is a manual-token baseline, not a complete in-product Facebook Login flow. Use it only after
an approved app has issued both documented tokens.

## Provider setup and review

1. Create a Business app in the [Meta App Dashboard](https://developers.facebook.com/apps).
2. Add Facebook Login for Business and configure the redirect URI used by your login flow.
3. Request `pages_show_list`, `pages_read_engagement`, and `pages_manage_posts`.
4. Complete Meta App Review and request Advanced Access for all three permissions before serving
   people who do not have a role on the app or the Business Portfolio that claimed it.
5. The authorizing user must have a task on the target Page. Reading requires the relevant Page
   access; creating content requires `CREATE_CONTENT` or `MANAGE`.
6. Obtain a User access token through Facebook Login for Business.
7. Exchange it through `GET /me/accounts` and copy the Page access token for the target Page.
8. Paste both tokens into this Connection.

The `facebook_list_pages` Tool deliberately requests only `id`, `name`, `category`,
`category_list`, and `tasks`; it never returns Page access tokens to an Agent.

If an app user does not own or manage a Page, reading public posts requires the separately reviewed
**Page Public Content Access** feature. This package is designed for Pages the user manages and
does not claim access to every public Page.

## Current TulipFarm auth limitation

Meta issues a User token first and then returns a Page token from `/me/accounts`. The current OIM
auth profile cannot take one operation response field and promote it directly into a sealed
credential slot. This package therefore asks the operator to paste both documented tokens. It does
not expose either token to an Agent.

## Operations

| Tool | Access |
| --- | --- |
| `facebook_list_pages` | List Pages and Tasks available to the User token |
| `facebook_list_page_posts` | Read posts for a Page authorized by the Page token |
| `facebook_create_page_post` | Publish an immediate text or link post as that Page |

The package pins Graph API `v25.0`, matching the current Pages API examples fetched for this
package. It does not schedule posts, upload photos or videos, edit or delete posts, moderate
comments, or operate on Pages the token cannot manage.

## Official references

- [Pages API overview](https://developers.facebook.com/documentation/pages-api/overview)
- [Manage a Page](https://developers.facebook.com/documentation/pages-api/manage-pages)
- [Page posts](https://developers.facebook.com/documentation/pages-api/posts)
- [Meta access-token types and Page-token exchange](https://developers.facebook.com/documentation/facebook-login/guides/access-tokens)
- [Graph API versioning](https://developers.facebook.com/docs/graph-api/guides/versioning)
