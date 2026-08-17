# Author the L3 journeys

Type: grilling
Status: open
Blocked by: 07, 15

## Question

Which end-to-end journeys are worth 10-60 seconds and real money each?

L3 exists to measure the product promise that L2 cannot reach: a user describes what they want in
chat, and agents build and run it. The corpus here is small — call it 5-10 journeys — so each one
has to be a load-bearing claim about the product, not a variation on another.

The test for a journey: **would a user notice if this broke?** L2 already covers whether the
harness picks the right tool. L3 should cover whether the *outcome* is real and persisted.

Candidate journeys to grill through, keep or reject:

- **Build a Resource type from a plain-language request.** "Track our customers" -> a Resource
  type exists in the Soul with sane fields, committed to git. The flagship: it is the single
  clearest statement of the product promise.
- **Create a record against a type the agent just built**, proving the two halves connect.
- **Multi-turn refinement.** "Add a phone number field" as a *second* message, proving conversation
  state survives and the agent edits rather than recreates.
- **Build an Agent**, then have that Agent do something. Exercises delegation and the Soul write
  path together.
- **A routine with a trigger**, proving Run scheduling works end to end.
- **Knowledge ingestion then a cited answer**, proving retrieval and provenance.
- **Refusal.** The agent asked for something it cannot do, and says so instead of writing a broken
  artifact into the Soul. Cheap to author and catches a genuinely bad failure mode.

Settle in the same session:

- **Assertion strength.** Exact-match on the generated Resource schema is brittle — models will
  legitimately name a field `phone` or `phone_number`. Too loose and the journey passes on garbage.
  Decide the standard: structural assertions plus a judged rubric on the naming, or something else.
  This is the hardest part of authoring L3 and it decides whether the tier is trustworthy.
- **Failure attribution.** When a journey fails, the report must say whether the *agent* failed or
  the *harness* threw. Conflating them makes the tier noise.
- **Budget.** 5-10 journeys x 2 models within the ~$5 total alongside L2. Confirm against real
  numbers from [Cost accounting and the $5 ceiling](11-cost-accounting.md) rather than the
  20-50 cents charting guess.
- **Flakiness tolerance.** A journey is a long chain and each link can wobble. Decide upfront what
  happens to a journey that proves unstable — repaired, quarantined or deleted — before anyone is
  emotionally attached to it.
