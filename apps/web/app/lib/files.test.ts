import { afterEach, describe, expect, test, vi } from "vitest";
import {
  archiveFile,
  deleteFile,
  deleteFileFolder,
  fetchArchivedFiles,
  fetchFileVersions,
  replaceFile,
  uploadFile,
} from "./files";

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

afterEach(() => vi.unstubAllGlobals());

test("a 403 upload failure shows a friendly permission message, never the raw server body", async () => {
  const xhr = stubXhr();

  const handle = uploadFile(new File(["x"], "shot.png", { type: "image/png" }));
  xhr.respond(403, JSON.stringify({ error: "ROLE_GRANT_MISSING_UPLOAD_SCOPE" }));

  await expect(handle.done).rejects.toMatchObject({
    status: 403,
    message: "You don't have permission to upload files.",
  });
});

test("a 401 upload failure prompts signing in again", async () => {
  const xhr = stubXhr();

  const handle = uploadFile(new File(["x"], "shot.png", { type: "image/png" }));
  xhr.respond(401, JSON.stringify({ error: "SESSION_EXPIRED" }));

  await expect(handle.done).rejects.toMatchObject({
    status: 401,
    message: "Your session expired — sign in again.",
  });
});

test("an unrecognized status still gets a generic friendly message, not the raw body", async () => {
  const xhr = stubXhr();

  const handle = uploadFile(new File(["x"], "shot.png", { type: "image/png" }));
  xhr.respond(500, JSON.stringify({ error: "INTERNAL_STORAGE_UNAVAILABLE" }));

  await expect(handle.done).rejects.toMatchObject({
    status: 500,
    message: "The upload failed. Try again.",
  });
});

test("an upload can use a renamed filename without changing the selected bytes", () => {
  const xhr = stubXhr();
  const file = new File(["x"], "shot.png", { type: "image/png" });

  uploadFile(file, undefined, "team-photo.png");

  expect(xhr.open).toHaveBeenCalledWith(
    "POST",
    expect.stringContaining("filename=team-photo.png"),
    true
  );
});

describe("Files lifecycle client", () => {
  test("deletes a folder without declaring a JSON body it does not send", async () => {
    // Fastify rejects an empty body typed as JSON before the route runs, and that 400 is
    // indistinguishable from the folder-is-not-empty 400 the caller reports to the person.
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await deleteFileFolder("folder_1");

    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain("Content-Type");
  });

  test("loads the caller-owned Archived page", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ files: [], nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetch);

    await fetchArchivedFiles({ limit: 25, after: "cursor" });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/files/archived?limit=25&after=cursor"),
      expect.objectContaining({ credentials: "include" })
    );
  });

  test("sends the expected revision with archive and permanent delete", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "file_1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await archiveFile("file_1", 4);
    await deleteFile("file_1", 5);

    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ expectedRevision: 4 }),
    });
    expect(fetch.mock.calls[1]?.[0]).toContain("/api/v1/files/file_1?expectedRevision=5");
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });

  test("replaces raw content and reads immutable versions", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "file_1", revision: 3 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ versions: [{ id: "version_1", versionNumber: 1 }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetch);

    await replaceFile("file_1", 2, new File(["next"], "report.pdf", { type: "application/pdf" }));
    const versions = await fetchFileVersions("file_1");

    expect(fetch.mock.calls[0]?.[0]).toContain("/api/v1/files/file_1/content?expectedRevision=2");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "PUT" });
    expect(versions).toEqual([expect.objectContaining({ id: "version_1", versionNumber: 1 })]);
  });
});
