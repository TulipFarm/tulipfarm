import { ajv, type ToolContractDefinition } from "@tulipfarm/schema";
import {
  AdapterDispatchError,
  type ToolAdapter,
  type ToolAdapterCredentials,
  type ToolAdapterRequest,
} from "@tulipfarm/tool-broker";
import type { CompiledOimCompositeStep } from "./oim-composite-compile";

const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export interface OimCompositeToolAdapterDeps {
  readonly steps: readonly (CompiledOimCompositeStep & {
    readonly adapter: ToolAdapter;
    readonly contract: ToolContractDefinition;
  })[];
}

function segments(pointer: string): string[] {
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function readPointer(value: unknown, pointer: string): unknown {
  let current = value;
  for (const segment of segments(pointer)) {
    if (
      UNSAFE_SEGMENTS.has(segment) ||
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, segment)
    ) {
      throw new AdapterDispatchError("before_dispatch", "composite_binding_invalid", false);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return structuredClone(current);
}

function writePointer(value: Record<string, unknown>, pointer: string, input: unknown): void {
  const path = segments(pointer);
  let current = value;
  for (const segment of path.slice(0, -1)) {
    if (UNSAFE_SEGMENTS.has(segment)) {
      throw new AdapterDispatchError("before_dispatch", "composite_binding_invalid", false);
    }
    const child = current[segment];
    if (child === undefined) {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
      continue;
    }
    if (child === null || typeof child !== "object" || Array.isArray(child)) {
      throw new AdapterDispatchError("before_dispatch", "composite_binding_invalid", false);
    }
    current = child as Record<string, unknown>;
  }
  const leaf = path.at(-1);
  if (leaf === undefined || UNSAFE_SEGMENTS.has(leaf) || Object.hasOwn(current, leaf)) {
    throw new AdapterDispatchError("before_dispatch", "composite_binding_invalid", false);
  }
  current[leaf] = input;
}

/** Runs a manifest-bounded sequence without exposing an intermediate operation result. */
export class OimCompositeToolAdapter implements ToolAdapter {
  readonly kind = "native" as const;

  constructor(private readonly deps: OimCompositeToolAdapterDeps) {}

  async dispatch(
    request: ToolAdapterRequest,
    credential?: string,
    credentials?: ToolAdapterCredentials
  ): Promise<unknown> {
    if (
      request.intent.arguments === null ||
      typeof request.intent.arguments !== "object" ||
      Array.isArray(request.intent.arguments)
    ) {
      throw new AdapterDispatchError("before_dispatch", "invalid_arguments", false);
    }
    const input = structuredClone(request.intent.arguments);
    const results = new Map<string, unknown>();
    let output: unknown;

    for (const step of this.deps.steps) {
      const arguments_: Record<string, unknown> = {};
      for (const binding of step.bindings) {
        const source = binding.source.type === "input" ? input : results.get(binding.source.stepId);
        if (source === undefined) {
          throw new AdapterDispatchError("before_dispatch", "composite_binding_invalid", false);
        }
        writePointer(arguments_, binding.target, readPointer(source, binding.source.pointer));
      }
      const validateInput = ajv.compile(step.contract.spec.inputSchema);
      if (!validateInput(arguments_)) {
        throw new AdapterDispatchError("before_dispatch", "composite_binding_invalid", false);
      }
      const result = await step.adapter.dispatch(
        {
          ...request,
          intent: {
            ...request.intent,
            toolId: step.contract.spec.toolId,
            toolVersion: step.contract.spec.toolVersion,
            action: step.contract.spec.action,
            arguments: arguments_,
          },
        },
        credential,
        credentials
      );
      const validateOutput = ajv.compile(step.contract.spec.outputSchema);
      if (!validateOutput(result)) {
        throw new AdapterDispatchError("after_dispatch", "invalid_output", false);
      }
      results.set(step.id, result);
      output = result;
    }
    return output;
  }
}
