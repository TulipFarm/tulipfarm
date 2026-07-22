export interface ScriptContext<Request> {
  request: Request;
  callIndex: number;
}

type ResponseFactory<Request, Response> = (
  context: ScriptContext<Request>
) => Response | Promise<Response>;

type ScriptStep<Request, Response> =
  | { kind: "response"; response: Response }
  | { kind: "factory"; factory: ResponseFactory<Request, Response> }
  | { kind: "failure"; error: Error };

export class ScriptedAdapter<Request, Response> {
  private readonly recordedCalls: Request[] = [];
  private readonly steps: Array<ScriptStep<Request, Response>> = [];

  constructor(private readonly label: string) {}

  get calls(): readonly Request[] {
    return [...this.recordedCalls];
  }

  respondWith(response: Response): void {
    this.steps.push({ kind: "response", response });
  }

  respondUsing(factory: ResponseFactory<Request, Response>): void {
    this.steps.push({ kind: "factory", factory });
  }

  failWith(error: Error): void {
    this.steps.push({ kind: "failure", error });
  }

  async invoke(request: Request): Promise<Response> {
    const callIndex = this.recordedCalls.length;
    this.recordedCalls.push(request);
    const step = this.steps.shift();
    if (!step) throw new Error(`unexpected ${this.label} invocation at call ${callIndex}`);
    if (step.kind === "failure") throw step.error;
    if (step.kind === "factory") return step.factory({ request, callIndex });
    return step.response;
  }

  assertDrained(): void {
    if (this.steps.length > 0) {
      throw new Error(`${this.label} has ${this.steps.length} unconsumed script step(s)`);
    }
  }
}
