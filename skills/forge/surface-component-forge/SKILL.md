---
name: surface-component-forge
description: "Forge a declarative Tulip Surface Protocol business component."
category: forge
tools:
  [
    surface_component_list,
    surface_component_create,
    surface_component_update,
    surface_component_get,
  ]
---
# Surface Component Forge

Build one business presentation component at a time. Use canonical `business.<slug>` names and
exact semantic component versions.

{{FORGE_EXECUTION_CONTRACT}}

## Workflow

1. Call `surface_component_list` and check for overlap.
2. Establish a kebab-case slug, version, purpose, target channels, semantic props, and events.
3. Design a TypeBox-compatible JSON `propsSchema`; every example must validate against it.
4. Compose `default` and channel-specific views from trusted TSP components. Values may be literals
   or `{ $prop: "/json/pointer" }` bindings.
5. Do not author HTML, CSS, JavaScript, imports, executable templates, network calls, or provider
   payloads.
6. Ensure every declared target has a valid view, every binding resolves through declared props,
   and component versions are exact.
7. Call `surface_component_create` or `surface_component_update`.
8. Verify with `surface_component_get` and report the published name and supported targets.
