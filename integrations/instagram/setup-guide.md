# Connect Instagram

This package uses **Instagram API with Instagram Login** only. It does not mix in the separate
Facebook Login product. It supports professional Business and Creator accounts, account and media
reads, image-container creation, and image publishing.

This is a manual-token baseline, not a complete in-product OAuth connection. Use it only after an
approved app has issued the documented long-lived token.

## Provider setup and review

1. Create a **Business** type Meta app in the [Meta App Dashboard](https://developers.facebook.com/apps).
2. Add the **Instagram** product and choose **API setup with Instagram business login**.
3. Configure Business Login for Instagram and the redirect URI used by your own login flow.
4. Request `instagram_business_basic` and `instagram_business_content_publish`.
5. For accounts owned or managed by app-role users, Standard Access is sufficient.
6. To serve professional accounts you do not own or manage, complete Business Verification and
   Meta App Review for Advanced Access to both permissions.
7. Generate a long-lived Instagram User access token in the App Dashboard, or complete Business
   Login and exchange the short-lived token server-side. Paste the long-lived token into TulipFarm.

Personal Instagram accounts are not supported. Media publishing can also be blocked until Page
Publishing Authorization is complete when the professional account is connected to a Page that
requires it.

## Current TulipFarm auth limitation

Instagram Login first returns a one-hour token, then requires a separate
`GET /access_token?grant_type=ig_exchange_token` exchange and later
`GET /refresh_access_token?grant_type=ig_refresh_token`. The current OIM OAuth runtime supports one
authorization-code exchange and a standard POST refresh-token grant; it cannot represent this
provider-specific chain. This package therefore accepts a long-lived token generated through
Meta's documented UI or server-side flow. Long-lived tokens are documented as valid for 60 days
and must be replaced or refreshed outside this package.

## Operations

| Tool | Access |
| --- | --- |
| `instagram_current_account` | Read the authorized professional account and its `user_id` |
| `instagram_list_media` | List media for that professional account |
| `instagram_read_media` | Read one owned media object |
| `instagram_create_image_container` | Create an unpublished image container from a public JPEG URL |
| `instagram_read_container_status` | Check that a container is ready to publish |
| `instagram_publish_media` | Publish a ready image container |

The image URL must be publicly reachable when Meta fetches it. Containers expire after 24 hours.
Meta's official pages conflict between 50 and 100 API-published posts per rolling 24 hours, so the
package does not encode either value as a local rate limit. Check the account's live
`content_publishing_limit` when quota-sensitive.

The package pins Graph API `v25.0`, matching the current Instagram Login examples and reference
pages fetched for this package. It does not upload local files, videos, Reels, Stories, carousels,
shopping tags, or filters.

Media reads omit `caption` and `media_product_type` because Meta's current IG Media reference marks
those fields as available only through the separate Facebook Login product.

## Official references

- [Instagram Platform overview](https://developers.facebook.com/documentation/instagram-platform/overview)
- [Instagram API with Instagram Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login)
- [Business Login for Instagram](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login)
- [Instagram Login get started](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started)
- [Content publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing)
- [Instagram User media edge](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media)
- [Publish media container](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media_publish)
