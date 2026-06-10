import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { Composer } from "~/components/chat/composer";

test("Model Selector sets the per-message model override on send", async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  render(<Composer onSend={onSend} />);

  await user.selectOptions(screen.getByLabelText("Model"), "complex");
  await user.type(screen.getByLabelText("Message"), "do it");
  await user.click(screen.getByRole("button", { name: "send" }));

  expect(onSend).toHaveBeenCalledWith("do it", { model: "complex" });
});

test("the model defaults to the active agent's tier", async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  render(<Composer onSend={onSend} defaultModel="complex" />);

  await user.type(screen.getByLabelText("Message"), "go");
  await user.click(screen.getByRole("button", { name: "send" }));

  expect(onSend).toHaveBeenCalledWith("go", { model: "complex" });
});

test("the composer exposes no file-attachment affordance", () => {
  const { container } = render(<Composer onSend={vi.fn()} />);
  expect(container.querySelector('input[type="file"]')).toBeNull();
  expect(screen.queryByLabelText(/attach|upload|file/i)).toBeNull();
});
