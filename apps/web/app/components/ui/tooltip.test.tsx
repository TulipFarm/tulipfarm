import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { Tooltip } from "./tooltip";

test("portals visible content outside an overflow boundary", async () => {
  const user = userEvent.setup();
  render(
    <div className="overflow-hidden">
      <Tooltip content="Mention Agent (@)">
        <button type="button">Mention</button>
      </Tooltip>
    </div>
  );

  await user.hover(screen.getByRole("button", { name: "Mention" }));
  expect(screen.getByRole("tooltip")).toHaveTextContent("Mention Agent (@)");
  expect(screen.getByRole("tooltip").parentElement).toBe(document.body);
});
