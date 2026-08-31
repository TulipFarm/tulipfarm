import { expect, test, vi } from "vitest";
import { uploadFile } from "./files";

/**
 * A minimal fake `XMLHttpRequest` that lets a test drive `uploadFile` to a chosen status without
 * a real network. Only the surface `uploadFile` touches is implemented.
 */
class FakeXhr {
  status = 0;
  responseText = "";
  upload = { addEventListener: vi.fn() };
  private listeners = new Map<string, () => void>();

  open = vi.fn();
  setRequestHeader = vi.fn();
  abort = vi.fn();

  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }

  send() {
    // Real `send()` starts an async request; the test drives the response by calling `respond`
    // after `uploadFile` has returned, so firing `load` here would race ahead of the status.
  }

  respond(status: number, body: string) {
    this.status = status;
    this.responseText = body;
    this.listeners.get("load")?.();
  }
}

function stubXhr(): FakeXhr {
  const xhr = new FakeXhr();
  vi.stubGlobal(
    "XMLHttpRequest",
    vi.fn(function XMLHttpRequestStub() {
      return xhr;
    })
  );
  return xhr;
}

test("a 403 upload failure shows a friendly permission message, never the raw server body", async () => {
  const xhr = stubXhr();

  const handle = uploadFile(new File(["x"], "shot.png", { type: "image/png" }));
  xhr.respond(403, JSON.stringify({ error: "ROLE_GRANT_MISSING_UPLOAD_SCOPE" }));

  await expect(handle.done).rejects.toMatchObject({
    status: 403,
    message: "You don't have permission to upload files.",
  });

  vi.unstubAllGlobals();
});

test("a 401 upload failure prompts signing in again", async () => {
  const xhr = stubXhr();

  const handle = uploadFile(new File(["x"], "shot.png", { type: "image/png" }));
  xhr.respond(401, JSON.stringify({ error: "SESSION_EXPIRED" }));

  await expect(handle.done).rejects.toMatchObject({
    status: 401,
    message: "Your session expired — sign in again.",
  });

  vi.unstubAllGlobals();
});

test("an unrecognized status still gets a generic friendly message, not the raw body", async () => {
  const xhr = stubXhr();

  const handle = uploadFile(new File(["x"], "shot.png", { type: "image/png" }));
  xhr.respond(500, JSON.stringify({ error: "INTERNAL_STORAGE_UNAVAILABLE" }));

  await expect(handle.done).rejects.toMatchObject({
    status: 500,
    message: "The upload failed. Try again.",
  });

  vi.unstubAllGlobals();
});
