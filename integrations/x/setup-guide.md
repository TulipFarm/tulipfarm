# Connect X

This package uses X API v2 with OAuth 2.0 Authorization Code with PKCE in **user context**. It
identifies the authorized user, reads one post by id, and creates a plain-text post as that user.

## Provider setup and access

1. Apply for and obtain an approved X developer account.
2. Create a Project and App in the [X Developer Console](https://developer.x.com/en/portal/dashboard).
3. Enable OAuth 2.0 Authorization Code with PKCE for a confidential client that has a client
   secret.
4. Set the app permissions to read and write.
5. Register the exact TulipFarm callback URL shown while creating the Connection.
6. Allow `tweet.read`, `users.read`, `tweet.write`, and `offline.access`.
7. Add billing credits or an Enterprise agreement appropriate for expected use. X documents these
   endpoints under pay-per-usage access; quote-post creation is Enterprise-only and is not exposed
   by this package.

X does not document a separate content-review grant for these three endpoints. Developer-account
approval, app configuration, requested scopes, and the account's current API plan still gate use.

## Connect in TulipFarm

1. Create a personal X Connection.
2. Enter the app's client ID and client secret.
3. Select **Connect an X user** and approve the requested permissions on X.
4. Confirm that TulipFarm identifies the expected X user.

TulipFarm sends the confidential client credentials with HTTP Basic for both the authorization-code
exchange and refresh. It stores the returned access and refresh tokens as Credentials. The
`offline.access` scope is required for refresh-token issuance; without it, X documents that the
access token expires after two hours.

Each Connection belongs to the person who completed consent. Do not share one person's Connection
as an organization credential.

## Operations

| Tool | Access |
| --- | --- |
| `x_current_user` | Read the user who authorized the token |
| `x_read_post` | Read one post by numeric id |
| `x_create_post` | Create one plain-text post |

The package does not upload media, quote posts, read timelines, or automate engagement.

## Official references

- [OAuth 2.0 Authorization Code with PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)
- [OAuth 2.0 scopes](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code#scopes)
- [Get Users Me](https://docs.x.com/x-api/users/get-my-user)
- [Get Posts by ID](https://docs.x.com/x-api/posts/get-post-by-id)
- [Create Posts](https://docs.x.com/x-api/posts/create-post)
- [X API rate limits](https://docs.x.com/x-api/fundamentals/rate-limits)
- [X API pricing](https://docs.x.com/x-api/getting-started/pricing)
