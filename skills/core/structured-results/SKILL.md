---
name: structured-results
description: Present lists, metrics, comparisons, and forms with clear structured surfaces.
category: core
---
# Structured Results

Use this Skill when the response contains structured data that is easier to act on visually than in
prose.

## Choose the Surface

- Use a data table for multiple records with repeated fields.
- Use metric cards for a small set of headline values.
- Use a chart only when shape, trend, or comparison matters more than exact row-level values.
- Use a Schema-backed form when the user must supply structured input.
- Use choices for a genuine branch or confirmation.

## Workflow

1. Select only the fields needed for the decision. Avoid dumping every available property.
2. Give columns and metrics plain-language labels while preserving exact values.
3. Render the surface with the relevant UI Tool.
4. Add a one-sentence text summary so the result remains understandable outside the visual.
5. If a surface cannot render, fall back to concise Markdown without claiming it succeeded.

## Safety

Never place secrets, credentials, hidden system fields, or unrelated personal data into a surface.
Do not turn a simple one-line answer into a form, table, or chart.
