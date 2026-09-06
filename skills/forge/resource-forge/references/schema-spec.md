# Record Schema Spec

The exact shape `create_resource_type` and `resource_type_update` accept, and the closed `x-*`
vocabulary the validator enforces. Read this before Step 4 if you are writing anything beyond plain
fields — every `x-*` keyword below is rejected outright when its value is the wrong shape, and the
error arrives after the user has already approved.

## What you pass, and where it lands

You pass **only the record schema** — a JSON Schema object serialized as YAML. The platform wraps it
in the Soul envelope; you never write the envelope yourself, and you never set `apiVersion`, `kind`,
`metadata` or `spec`.

```text
soul/resources/<slug>/
├── resource.yaml   canonical envelope; written for a Resource type that has a domain
├── schema.yml      legacy bare schema; written for a domainless type — the common case
└── hooks.ts        companion, written by create_resource_hooks
```

`domain` is admin-only. `create_resource_type` and `resource_type_update` cannot set, change or
clear it, so a type you create from Chat lands in `schema.yml`. That is expected, not a fallback.

## The schema you write

Validated as **JSON Schema 2020-12** (Ajv 2020, non-strict), then against the closed `x-*`
vocabulary below.

```yaml
$schema: https://json-schema.org/draft/2020-12/schema
type: object            # must be exactly "object"
properties:
  title:
    type: string
    description: Short summary of the request
  status:
    type: string
    enum: [todo, in-progress, done]
  customerId:
    type: string
    x-links: { target: customer }
required: [title, status]
```

`type: object` and `properties` are mandatory. `required` is optional and its entries must be
unique. Unknown top-level keys are allowed — the schema is open — so a typo in an `x-*` keyword is
silently ignored rather than rejected. Spell them exactly as written below.

Never declare `id`, `createdAt`, `updatedAt` or `version`. The platform manages them on every
Record, and declaring them creates empty duplicate fields.

## The closed `x-*` vocabulary

These five are validated. Getting the shape wrong fails the write.

### `x-links` — property level

```yaml
customerId:
  type: string
  x-links: { target: customer }
```

`target` must be a non-empty string naming an existing Resource type. Not an object, not an array,
not blank. The value stored in the field is the target Record's `_id`.

Checked on write — the target must exist. **Not cascaded on delete**: deleting the target leaves the
link pointing at nothing, and nothing cleans it up.

Only a **string** value is checked. A field holding an array of ids passes validation untouched, so
an array of references is unvalidated in practice — use a join Resource type instead.

### `x-normalize` — property level

```yaml
email:
  type: string
  x-normalize: [trim, lowercase]
```

An array, applied in order, to string values only. The six allowed keys are the whole set:

| Key | Effect |
| --- | --- |
| `trim` | strips surrounding whitespace |
| `lowercase` | lowercases |
| `uppercase` | uppercases |
| `slugify` | kebab-case slug |
| `phone-e164` | strips non-digits, prefixes `+1` — US-shaped, so do not use it for other regions |
| `email-normalize` | trim plus lowercase |

Any other key is a validation error.

### `x-unique` — root level

**An array of arrays.** Each inner array is one uniqueness constraint over the named fields, and
every field it names must be declared in `properties`.

```yaml
x-unique: [[workEmail]]              # one single-field constraint
x-unique: [[projectId, key]]         # one composite constraint
x-unique: [[workEmail], [employeeNumber]]   # two separate constraints
```

```yaml
x-unique: [workEmail]                # WRONG — entries must be arrays
x-unique: workEmail                  # WRONG — not an array
```

Becomes a partial unique index over live rows, so soft-deleted Records do not block a re-create.
This is the only real duplicate guard, and it holds only within one Resource type.

### `x-computed` — root level

```yaml
x-computed:
  - field: fingerprint
    from: [title, customerId]
    fn: sha256
```

One object or an array of them. `fn` must be `sha256`, `uuid` or `sequence`; anything else is a
validation error. `from` names fields on **this same Record** — a computed field cannot read another
Resource type. Cross-type values need a `before` hook.

### `x-id-strategy` — root level

```yaml
x-id-strategy: { prefix: "TICK-", sequence: true, field: key }
```

Produces `TICK-1`, `TICK-2` into `field` (default `id`) on create. Only runs when
`sequence: true`. The counter is **per Resource type**, not per parent — several projects sharing
one `issue` type get one global sequence.

This is the human-facing identifier, entirely separate from the system `id` UUID.

## Property flags

Booleans on a property. Not part of the closed vocabulary, so a typo here fails silently — check the
spelling, including the capital letters.

| Flag | Effect |
| --- | --- |
| `x-readOnly: true` | stripped from user input; for fields only the platform or a hook sets |
| `x-immutable: true` | keeps its existing value on update once set; for fields that must not change after creation |

Pair `x-readOnly` with `x-id-strategy` and with any total a hook computes, so the stored value
cannot disagree with what produced it.

## Hooks

`x-hooks-enabled: false` at root turns hooks off without deleting `hooks.ts`. Omitted means enabled.
The hook source itself is written by `create_resource_hooks`, never inside the schema.

## Before you write

- Field names are camelCase; the Resource type name is singular kebab-case.
- Every `x-links` target must already exist — build linked types first.
- Call `validate_artifact` if it is available. It runs the same checks, so a failure there is a
  failure the user would otherwise have seen after approving.
