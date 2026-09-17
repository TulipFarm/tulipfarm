import * as remix from "@remix-run/react";
import { createRemixStub } from "@remix-run/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ApiError, updateResourceType } from "~/lib/api";
import ResourceTypeEdit from "./_app.resources.$type.schema";

vi.mock("@remix-run/react", async () => {
  const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
  return {
    ...actual,
    useLoaderData: vi.fn(),
  };
});

vi.mock("~/lib/api", async () => {
  const actual = await vi.importActual<typeof import("~/lib/api")>("~/lib/api");
  return {
    ...actual,
    updateResourceType: vi.fn(),
  };
});

test("a schema conflict keeps the draft and uses the revision that was loaded", async () => {
  const loadedRevision = "a".repeat(40);
  const staleSchema = "type: object\nproperties:\n  title:\n    type: string\n";
  const draft = `${staleSchema}description: stale editor draft\n`;
  vi.mocked(remix.useLoaderData).mockReturnValue({
    type: "ticket",
    schema: staleSchema,
    revision: loadedRevision,
  });
  vi.mocked(updateResourceType).mockRejectedValue(
    new ApiError(409, "another change landed first; reload and try again")
  );
  const Stub = createRemixStub([{ path: "/", Component: ResourceTypeEdit }]);
  render(<Stub initialEntries={["/"]} />);

  fireEvent.change(screen.getByRole("textbox", { name: "schema" }), {
    target: { value: draft },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save schema" }));

  await waitFor(() =>
    expect(updateResourceType).toHaveBeenCalledWith("ticket", draft, loadedRevision)
  );
  expect(screen.getByRole("textbox", { name: "schema" })).toHaveValue(draft);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Your draft is still here. Reload to review the current schema"
  );
});
