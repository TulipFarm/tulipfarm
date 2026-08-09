import { expect, test } from "vitest";
import { errorAction } from "~/lib/error-actions";

test("maps LLM-not-configured to the LLM settings CTA", () => {
  expect(errorAction("LLM not configured")).toEqual({
    label: "Configure LLM",
    to: "/settings/llm",
  });
});

test("maps an unknown-model error to the LLM settings CTA", () => {
  expect(errorAction("model not configured in any tier: gpt-4o")).toEqual({
    label: "Configure LLM",
    to: "/settings/llm",
  });
});

test("maps unavailable ModelProfiles to the LLM settings CTA", () => {
  expect(errorAction("The configured model is unavailable. Choose another ModelProfile.")).toEqual({
    label: "Configure LLM",
    to: "/settings/llm",
  });
});

test("maps a credential error to the secrets CTA", () => {
  const msg =
    'LLM credential "azure-openai-api-key" could not be decrypted — Re-enter it (PUT /secrets/azure-openai-api-key).';
  expect(errorAction(msg)).toEqual({ label: "Manage secrets", to: "/settings/secrets" });
});

test("maps inactive provider billing to Provider Credentials", () => {
  expect(errorAction("API billing is inactive. Use another Provider Credential.")).toEqual({
    label: "Manage secrets",
    to: "/settings/secrets",
  });
});

test("returns null for a generic error and for empty input", () => {
  expect(errorAction("the stream failed")).toBeNull();
  expect(errorAction(null)).toBeNull();
  expect(errorAction(undefined)).toBeNull();
  expect(errorAction("")).toBeNull();
});
