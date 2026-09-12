# Connect Confluence Data Center

This package reads spaces and pages from Confluence Data Center over the REST v1 API.
It is separate from the Confluence Cloud package because Cloud uses REST v2 paths, Atlassian
account ids and a different token format.

## Supported server

The API compatibility floor is Confluence Data Center 7.9 with personal access tokens enabled.
Atlassian documents personal access tokens from 7.9 onward and requires them in the
`Authorization: Bearer` header. Run a Data Center release that Atlassian currently supports;
TulipFarm does not claim support for the vendor-EOL Confluence Server product.

The package supports an HTTPS site at the origin root, such as `https://confluence.example.com`.
It does not support an installation below a context path such as
`https://example.com/confluence`, or a custom HTTPS port.

## Connect it

1. In Confluence, open your profile settings.
2. Select **Personal access tokens** and create a token for TulipFarm.
3. In TulipFarm, enter the bare site host and the token.
4. Confirm the exact HTTPS origin shown by TulipFarm.

The confirmation is stored as trusted runtime state, not as a form checkbox or caller-provided
flag. It applies only to this Connection. Changing the configured host removes the confirmation
and invalidates outstanding credential leases.

The host must resolve only to public addresses. Private, loopback, link-local and unresolved DNS
answers are refused at dispatch even after confirmation.

## Limits

This package exposes current-user, space listing, page listing and page reading. Pagination uses
the Data Center `start` and `limit` parameters, which callers must advance explicitly.

Knowledge indexing is not declared. Data Center page restrictions use usernames, user keys and
group names rather than Cloud account ids, so reusing the Cloud Knowledge mapping would lose the
source permission model.
