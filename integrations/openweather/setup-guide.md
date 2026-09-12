# Connect OpenWeather

OpenWeather serves current conditions and forecasts from one API key that the whole organization
shares. There is no personal identity: everybody's request is the same request.

## Get a key

1. Create a free account at <https://home.openweathermap.org/users/sign_up>.
2. Open <https://home.openweathermap.org/api_keys> and copy the default key, or create a named one
   for TulipFarm so you can revoke it without disturbing anything else.
3. A new key takes a few minutes to become active. Until then the provider answers `401`, and the
   Connection shows as unhealthy rather than connected.

## Connect it

Open **Integrations → OpenWeather → Connect** and paste the key. It is stored as an organization
Secret and injected into each request by the runtime; no Agent, prompt, Tool argument or Tool result
ever contains it.

## What agents can do

| Tool | What it answers |
| --- | --- |
| `openweather_current` | Conditions now, for a place name or coordinates |
| `openweather_forecast` | Five days in three-hour steps |
| `openweather_geocode` | Coordinates for an ambiguous place name |

All three are read-only, so no approval is required to call them.

## Rotating the key

Create the new key at OpenWeather first, then update the Connection. The old lease is revoked the
moment the Secret changes, so an in-flight call using the previous key fails rather than continuing
on a credential you meant to retire.

## Free-plan limits

The free plan allows 60 calls a minute. The package declares that limit, so the runtime paces calls
instead of letting the provider reject them. A forecast for a place you name by string costs an
extra geocoding lookup at the provider; pass `lat`/`lon` when you already have them.
