# Connect LinkedIn

This package uses LinkedIn's approved Community Management API and 3-legged OAuth. It identifies
the authorized member, reads an organization post by URN, and creates a public text post as that
member or an organization they are allowed to manage.

## Provider setup and approval

1. Create or select an app in the [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps).
2. Add the exact TulipFarm callback URL:
   `https://YOUR-TULIPFARM-HOST/api/v1/integrations/oim/auth/callback`.
3. On **Products**, apply for **Community Management API** access.
4. Development tier is the initial approved tier. It is limited to 500 app calls and 100 calls per
   member in 24 hours, disables batch-get and social-action webhooks, and must be used to complete
   integration testing within 12 months.
5. Apply separately for **Standard tier** before production use. LinkedIn approves partners at its
   discretion and does not guarantee an upgrade.
6. Copy the app's Client ID and Client Secret into the Connection, then authorize a member.

The package requests `r_basicprofile`, `r_organization_social`, `w_organization_social`, and
`w_member_social`. LinkedIn grants these only to apps approved for Community Management.
Organization reads and writes also require the member to have an `ADMINISTRATOR`,
`DIRECT_SPONSORED_CONTENT_POSTER`, or `CONTENT_ADMIN` role on that Page.

`r_member_social` is separately restricted to approved users and is not part of the normal
Community Management grant. This package therefore does not claim member-post reading. The read
Tool is for organization posts the authorized member may read.

## Operations and limits

| Tool | Access |
| --- | --- |
| `linkedin_current_member` | Read the authorized member's approved basic profile fields |
| `linkedin_read_post` | Read one organization post by `urn:li:share:*` or `urn:li:ugcPost:*` |
| `linkedin_create_post` | Create a public text post as a member or eligible organization |

Requests pin `Linkedin-Version: 202608` and `X-Restli-Protocol-Version: 2.0.0`. LinkedIn returns a
new post's URN only in the `x-restli-id` response header. The current OIM JSON result contract does
not expose response headers, so the create Tool returns an empty object even when creation succeeds.

This package does not upload images, videos, or documents and does not create sponsored posts.

## Official references

- [Community Management access and tiers](https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access?view=li-lms-2026-08)
- [LinkedIn 3-legged OAuth](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow)
- [Profile API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/profile-api)
- [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-08)
- [Marketing API versioning](https://learn.microsoft.com/en-us/linkedin/marketing/versioning?view=li-lms-2026-08)
