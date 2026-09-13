import type { ModelPort } from "@tulipfarm/agent-runtime";
import type { EvalCase } from "./case.ts";
import type { ModelBinding } from "./runner.ts";

export class ScriptExhaustedError extends Error {
  constructor(caseId: string, call: number) {
    super(
      `Case "${caseId}" called the model ${call} time(s) but its script has fewer entries. ` +
        `Lengthen "script" or tighten the Case so the loop terminates.`
    );
    this.name = "ScriptExhaustedError";
  }
}

/**
 * A model binding that replays each Case's `script`.
 *
 * Free, deterministic and credential-free, so the whole Corpus runs in ordinary CI and a
 * contributor without vendor keys can still develop the framework. A real binding ignores
 * `script` entirely.
 */
export function scriptedBinding(): ModelBinding {
  return {
    id: "scripted",
    create(evalCase: EvalCase): ModelPort {
      const script = [...(evalCase.script ?? [])];
      let call = 0;
      const next = () => {
        call += 1;
        const output = script.shift();
        if (output === undefined) throw new ScriptExhaustedError(evalCase.id, call);
        return output;
      };
      const result = (requestId: string, output: NonNullable<EvalCase["script"]>[number]) => ({
        requestId,
        output,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costBasis: "priced" as const },
      });
      const invoke: ModelPort["invoke"] = async (request) => {
        return result(request.requestId, next());
      };
      return {
        invoke,
        async *stream(request) {
          const output = next();
          const completed = result(request.requestId, output);
          const text =
            output.kind === "text"
              ? output.text
              : output.kind === "tool_calls"
                ? output.text
                : undefined;
          if (text !== undefined) {
            for (let offset = 0; offset < text.length; offset += 8) {
              yield { kind: "text_delta", text: text.slice(offset, offset + 8) };
            }
          }
          yield { kind: "completed", result: completed };
        },
      };
    },
  };
}
