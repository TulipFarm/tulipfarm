import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { IntegrationChoice } from "./integration-choice";

test("selects a Team by keyboard and never submits an unmatched or empty choice", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  function ChoiceForm() {
    const [value, setValue] = useState("support-id");
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(value);
        }}
      >
        <IntegrationChoice
          label="Team"
          value={value}
          onChange={setValue}
          options={[
            { value: "support-id", label: "Support" },
            { value: "finance-id", label: "Finance" },
          ]}
        />
        <button type="submit">Save</button>
      </form>
    );
  }
  render(<ChoiceForm />);
  const combo = screen.getByRole("combobox", { name: "Team" });
  await user.click(combo);
  await user.keyboard("{ArrowDown}{Enter}");
  expect(combo).toHaveValue("Finance");
  await user.type(combo, "Not a Team");
  await user.keyboard("{Enter}");
  expect(onSubmit).not.toHaveBeenCalled();
  expect(combo).toHaveValue("Finance");
  await user.clear(combo);
  await user.tab();
  expect(combo).toHaveValue("Finance");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(onSubmit).toHaveBeenCalledWith("finance-id");
});
