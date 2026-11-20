import type { RecordedCall, ToolMode, ToolResultPin } from './contracts.ts';

/** A tool call as the agent made it: the tool name and its arguments. */
export type EvalToolCall = { tool: string } & Record<string, unknown>;

/** Tools that run code or reach external systems. Eval runs always simulate them, whatever their classification. */
export const alwaysSimulatedTools: ReadonlySet<string> = new Set([
  'mcp.call',
  'skills.execute',
  'execution.run',
  'coding.run',
  'api.request',
]);

export const simulatedNote = 'Simulated by an eval run. Nothing was changed and nothing was sent.';

/** Whether `actual` contains every value in `expected`: objects by key, arrays by element, everything else by equality. */
export function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return Array.isArray(actual) && expected.every(item => actual.some(value => contains(value, item)));
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) => contains((actual as Record<string, unknown>)[key], value));
  }
  return Object.is(actual, expected);
}

export const callArgs = (call: EvalToolCall): Record<string, unknown> => {
  const { tool: _tool, ...args } = call;
  return args;
};

const pinFor = (pins: readonly ToolResultPin[], call: EvalToolCall) =>
  pins.find(pin => pin.tool === call.tool && (!pin.match || contains(callArgs(call), pin.match)));

export interface EffectsOptions {
  /** Whether the call changes nothing. Unknown tools must answer false, so they are simulated. */
  isRead(call: EvalToolCall): boolean;
  /** Runs a read-only call with the runner's access, limited by the agent's permission limit. */
  live(call: EvalToolCall): Promise<unknown>;
  /** Whether the call asks a person to approve a change. It is recorded and treated as approved. */
  isApproval?(call: EvalToolCall): boolean;
  /** The success result a simulated call returns when the case has no override. */
  simulate?(call: EvalToolCall): unknown;
  pinnedReads?: readonly ToolResultPin[];
  effectOverrides?: readonly ToolResultPin[];
  /**
   * Tools that run live although they write. Only internal suites set this, against a disposable test workspace.
   * Workspace eval runs never do.
   */
  liveWrites?: ReadonlySet<string>;
}

export function genericSuccess(call: EvalToolCall, approval: boolean) {
  return approval
    ? { status: 'approved', simulated: true, note: simulatedNote }
    : { status: 'done', ok: true, simulated: true, tool: call.tool, note: simulatedNote };
}

/**
 * The tool layer of an eval run. Every tool call goes through `call`: read-only calls run live or return their pinned
 * result, and every other call becomes a simulated effect. Calls are recorded in order for the checks.
 */
export function createEffects(options: EffectsOptions) {
  const calls: RecordedCall[] = [];
  const record = (call: EvalToolCall, mode: ToolMode, extra: Partial<RecordedCall> = {}) => {
    calls.push({ tool: call.tool, args: callArgs(call), mode, ...extra });
  };
  async function call(call: EvalToolCall): Promise<unknown> {
    const external = alwaysSimulatedTools.has(call.tool) && !(call.tool === 'api.request' && isSafeMethod(call));
    const read = !external && safely(() => options.isRead(call));
    if (read) {
      const pin = pinFor(options.pinnedReads ?? [], call);
      if (pin) {
        record(call, 'pinned');
        return pin.result;
      }
      try {
        const result = await options.live(call);
        record(call, 'live');
        return result;
      } catch (error) {
        record(call, 'live', { error: message(error) });
        throw error;
      }
    }
    if (!external && options.liveWrites?.has(call.tool)) {
      const result = await options.live(call);
      // A live approval request counts only when it produced a pending request, not a validation error.
      const pending = (result as { status?: unknown } | null)?.status === 'pending';
      record(call, 'live', pending && safely(() => options.isApproval?.(call) ?? false) ? { approval: true } : {});
      return result;
    }
    const approval = safely(() => options.isApproval?.(call) ?? false);
    record(call, 'simulated', approval ? { approval: true } : {});
    const override = pinFor(options.effectOverrides ?? [], call);
    if (override) return override.result;
    return options.simulate?.(call) ?? genericSuccess(call, approval);
  }
  /**
   * Records the writes of an approval request that is not itself a tool call, such as a task proposal, treats them as
   * approved, and returns each write's simulated result.
   */
  function approve(proposed: readonly EvalToolCall[]) {
    return proposed.map(item => {
      record(item, 'simulated', { approval: true });
      const override = pinFor(options.effectOverrides ?? [], item);
      return override ? override.result : (options.simulate?.(item) ?? genericSuccess(item, true));
    });
  }
  return { calls, call, approve };
}
export type Effects = ReturnType<typeof createEffects>;

const isSafeMethod = (call: EvalToolCall) => call.method === 'GET' || call.method === 'HEAD';
function safely(test: () => boolean) {
  try {
    return test() === true;
  } catch {
    return false;
  }
}
export const message = (error: unknown) =>
  String(error instanceof Error ? error.message : error).slice(0, 500) || 'Unknown error';
