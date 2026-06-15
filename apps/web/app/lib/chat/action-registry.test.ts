import { afterEach, describe, expect, test, vi } from "vitest";
import { invokeClientAction, prefillForm, registerClientAction } from "~/lib/chat/action-registry";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("client action registry", () => {
  test("register → invoke calls the handler with the payload; unregister removes it", () => {
    const handler = vi.fn();
    const off = registerClientAction("refresh", handler);
    expect(invokeClientAction("refresh", { id: 1 })).toBe(true);
    expect(handler).toHaveBeenCalledWith({ id: 1 });
    off();
    expect(invokeClientAction("refresh", {})).toBe(false);
  });

  test("invoke for an unregistered action is a no-op returning false", () => {
    expect(invokeClientAction("nope", {})).toBe(false);
  });
});

describe("prefillForm", () => {
  test("sets fields matched by name or data-name and fires an input event", () => {
    document.body.innerHTML = `
      <input name="city" />
      <textarea data-name="bio"></textarea>
      <input type="checkbox" name="notify" />
    `;
    const city = document.querySelector('[name="city"]') as HTMLInputElement;
    const onInput = vi.fn();
    city.addEventListener("input", onInput);

    prefillForm({ city: "Pune", bio: "Engineer", notify: true });

    expect(city.value).toBe("Pune");
    expect((document.querySelector('[data-name="bio"]') as HTMLTextAreaElement).value).toBe(
      "Engineer"
    );
    expect((document.querySelector('[name="notify"]') as HTMLInputElement).checked).toBe(true);
    expect(onInput).toHaveBeenCalled();
  });

  test("ignores fields that aren't present", () => {
    document.body.innerHTML = `<input name="known" />`;
    expect(() => prefillForm({ known: "x", missing: "y" })).not.toThrow();
    expect((document.querySelector('[name="known"]') as HTMLInputElement).value).toBe("x");
  });
});
