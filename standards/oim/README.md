# Open Integration Manifest

This directory is a portable, vendor-neutral distribution of Open Integration Manifest (OIM) 1.0.
It contains the specification, Apache-2.0 license, generated JSON Schemas, semantic validator,
positive and negative vectors, and a behavior-based conformance runner.

The package entry point is exactly `oim.yml`. `manifest.yml` is not an OIM entry point.

## Validate a package

```bash
oim validate ./my-integration
```

Validation checks YAML syntax, JSON Schema, cross-field semantics, declared companion files,
lowercase SHA-256 digests, prohibited content, fixed OpenAPI operations, and fixed GraphQL
documents.

## Test a runtime

```bash
oim conformance \
  --adapter ./oim-adapter.mjs \
  --runtime 'Example Runtime@2.0.0' \
  --profiles 'core=1.2,auth=1.0' \
  --output ./oim-conformance-report.json
```

The adapter exports `runCase(vector)`. It must invoke the public behavior of the runtime under
test and return the observed result. The runner compares that result with the portable vectors.
It issues a claim only after every required vector passes. Manifest validation alone never creates
a runtime conformance claim.

## Source parity

The schemas and portable semantic runtime are generated from the authoritative TypeScript source:

```bash
pnpm exec tsx scripts/oim-standard-generate.ts
pnpm exec tsx scripts/oim-standard-check.ts
```

The generated runtime has no import from a private TulipFarm package. Its ordinary npm
dependencies are declared in this directory's `package.json`.

This checkout is a distribution candidate. Publishing an npm package, creating a separate
repository, signing releases, and assigning official support status require explicit maintainer
authority.
