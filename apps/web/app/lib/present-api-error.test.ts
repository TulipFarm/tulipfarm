import { expect, test } from "vitest";
import { ApiError } from "./api";
import { presentApiError } from "./present-api-error";

test("maps a forbidden wire code to human copy naming the surface", () => {
  const error = new ApiError(403, "forbidden", undefined, "forbidden");
  expect(presentApiError(error, "The Team directory")).toBe(
    "The Team directory isn't available to your account. Ask an administrator if you need access."
  );
});

test("maps a denied wire code to human copy naming the surface", () => {
  const error = new ApiError(403, "denied", undefined, "denied");
  expect(presentApiError(error, "The Team directory")).toBe(
    "The Team directory isn't available to your account. Ask an administrator if you need access."
  );
});

test("maps an unauthorized wire code to human copy about signing in again", () => {
  const error = new ApiError(401, "unauthorized", undefined, "unauthorized");
  expect(presentApiError(error, "The Team directory")).toBe(
    "The Team directory isn't available — sign in again to continue. Ask an administrator if you need access."
  );
});

test("falls back to generic copy for an unrecognized code", () => {
  const error = new ApiError(500, "internal server error", undefined, "internal server error");
  expect(presentApiError(error, "The Team directory")).toBe(
    "The Team directory could not be loaded. Ask an administrator if this continues."
  );
});

test("falls back to generic copy for a non-ApiError", () => {
  expect(presentApiError(new Error("network down"), "The Team directory")).toBe(
    "The Team directory could not be loaded. Ask an administrator if this continues."
  );
});
