import { type ScriptContext, ScriptedAdapter } from "./scripted";

export type ModelResponseFactory<Request, Response> = (
  context: ScriptContext<Request>
) => Response | Promise<Response>;

export class FakeModelAdapter<Request, Response> {
  private readonly script = new ScriptedAdapter<Request, Response>("model");

  get calls(): readonly Request[] {
    return this.script.calls;
  }

  respondWith(response: Response): void {
    this.script.respondWith(response);
  }

  respondUsing(factory: ModelResponseFactory<Request, Response>): void {
    this.script.respondUsing(factory);
  }

  failWith(error: Error): void {
    this.script.failWith(error);
  }

  invoke(request: Request): Promise<Response> {
    return this.script.invoke(request);
  }

  assertDrained(): void {
    this.script.assertDrained();
  }
}
