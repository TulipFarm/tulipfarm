# Decide whether ModelPort gets sampling controls

Type: grilling
Status: open
Blocked by: 12

## Question

`ModelPort` exposes no temperature, top-p or seed. Should it?

Surfaced by [Pin an exact model for a whole eval run](03-pin-an-exact-model.md): the eval **cannot
run at temperature 0 today**. `ModelInvocationRequest` carries only `requestId`, `modelProfileId`,
messages, tools, `outputSchema`, `maxOutputTokens`, `policy`, `principal`, `agentId`
(`packages/agent-runtime/src/ports/model.ts:8-34`), and `createModel()` takes only a
`ProviderEntry` plus secrets/timeout/principal/credentials/log
(`packages/llm/src/provider.ts:85-105`). Nothing in between plumbs sampling parameters.

Deliberately blocked on [Measure the noise floor](12-noise-floor.md): do not add a knob before
knowing whether the variance actually warrants it. If the corpus is stable enough without it, this
ticket closes as "no" and the harness stays smaller.

If the noise floor says the variance is unacceptable, decide:

- **Where the knob goes.** On `ModelInvocationRequest` (every caller can set it, so it becomes
  product surface and a Run-replay concern), or only on the eval's own `ModelPort` implementation
  (contained, but then the eval is measuring a configuration the product never runs — which is its
  own kind of lie).
- **Replay.** `agent-runtime`'s rules require Run replay to route identically. A sampling parameter
  that is not persisted breaks that. If the knob is on the product path, it must be recorded.
- **Vendor support.** Confirm both pinned subject models honour temperature and seed through the
  Vercel AI SDK path, and what they do when asked for a seed they do not support — silently ignore
  it, or error. Silent ignoring is the dangerous case: you would believe you had determinism.
- **What it actually buys.** Temperature 0 is widely assumed to make tool calls deterministic and
  frequently does not — distributed inference and float non-determinism remain. Measure the
  improvement rather than assuming it, and be willing to conclude the knob is not worth the product
  surface it costs.
