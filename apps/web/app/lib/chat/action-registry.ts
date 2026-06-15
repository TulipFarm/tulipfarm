/**
 * Client-side action registry + form prefill for agent→client actions (A2UI P3, `invoke_action` /
 * `prefill_form`). A page registers named handlers (in an effect); the chat hook dispatches a
 * `client-action` to them. Prefill is generic — it sets fields by `name` / `data-name` on whatever
 * form the user has open, no registration required.
 */

type ClientActionHandler = (payload: unknown) => void;

const registry = new Map<string, ClientActionHandler>();

/** Register a named client action; returns an unregister fn (call it on unmount). */
export function registerClientAction(name: string, handler: ClientActionHandler): () => void {
  registry.set(name, handler);
  return () => {
    if (registry.get(name) === handler) registry.delete(name);
  };
}

/** Invoke a registered action by name. Returns false (no-op) if nothing is registered for it. */
export function invokeClientAction(name: string, payload: unknown): boolean {
  const handler = registry.get(name);
  if (!handler) return false;
  handler(payload);
  return true;
}

function cssEscape(value: string): string {
  const esc = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
  return esc ? esc(value) : value.replace(/["\\]/g, "\\$&");
}

// Set a value on a (possibly React-controlled) input via the native setter + an input/change event,
// so controlled components pick up the change.
function setFieldValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: unknown
) {
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    el.checked = value === true || value === el.value;
  } else {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value == null ? "" : String(value));
    else el.value = value == null ? "" : String(value);
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Set form fields (matched by `name` / `data-name`) to proposed values on the current page. */
export function prefillForm(values: Record<string, unknown>): void {
  if (typeof document === "undefined") return;
  for (const [name, value] of Object.entries(values)) {
    const sel = cssEscape(name);
    const el = document.querySelector(`[name="${sel}"], [data-name="${sel}"]`);
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      setFieldValue(el, value);
    }
  }
}
