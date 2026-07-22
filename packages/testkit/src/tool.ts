import { type ScriptContext, ScriptedAdapter } from "./scripted";

export type ToolResponseFactory<Request, Response> = (
  context: ScriptContext<Request>
) => Response | Promise<Response>;

export class FakeToolAdapter<Request, Response> {
  private readonly script = new ScriptedAdapter<Request, Response>("Tool");

  get calls(): readonly Request[] {
    return this.script.calls;
  }

  respondWith(response: Response): void {
    this.script.respondWith(response);
  }

  respondUsing(factory: ToolResponseFactory<Request, Response>): void {
    this.script.respondUsing(factory);
  }

  failWith(error: Error): void {
    this.script.failWith(error);
  }

  execute(request: Request): Promise<Response> {
    return this.script.invoke(request);
  }

  assertDrained(): void {
    this.script.assertDrained();
  }
}
