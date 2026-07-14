import { describe, expect, it } from "vitest";
import { dotPath, matchesBody, renderBodyTemplate, renderVarTemplate } from "./template";

describe("dotPath", () => {
  it("resolves nested paths and returns undefined for missing hops", () => {
    const obj = { event: { channel: "C1", n: 0, flag: false } };
    expect(dotPath(obj, "event.channel")).toBe("C1");
    expect(dotPath(obj, "event.n")).toBe(0);
    expect(dotPath(obj, "event.flag")).toBe(false);
    expect(dotPath(obj, "event.missing")).toBeUndefined();
    expect(dotPath(obj, "missing.deep.path")).toBeUndefined();
    expect(dotPath(null, "a")).toBeUndefined();
  });

  it("indexes into arrays with numeric segments", () => {
    expect(dotPath({ auth: [{ user_id: "U9" }] }, "auth.0.user_id")).toBe("U9");
  });
});

describe("renderBodyTemplate", () => {
  const body = { team_id: "T1", event: { channel: "C1", ts: "2.2" } };

  it("substitutes dot-paths and keeps literal text", () => {
    expect(renderBodyTemplate("{team_id}/{event.channel}", body)).toBe("T1/C1");
  });

  it("uses | fallbacks in order and empty-strings a fully missing var", () => {
    expect(renderBodyTemplate("{event.thread_ts|event.ts}", body)).toBe("2.2");
    expect(renderBodyTemplate("x{event.nope|also.nope}y", body)).toBe("xy");
  });
});

describe("matchesBody", () => {
  it("passes with no match config, compares stringified values, fails on missing path", () => {
    expect(matchesBody({ a: 1 }, undefined)).toBe(true);
    expect(matchesBody({ kind: "ping" }, { path: "kind", equals: "ping" })).toBe(true);
    expect(matchesBody({ n: 5 }, { path: "n", equals: "5" })).toBe(true);
    expect(matchesBody({ kind: "pong" }, { path: "kind", equals: "ping" })).toBe(false);
    expect(matchesBody({}, { path: "kind", equals: "ping" })).toBe(false);
  });
});

describe("renderVarTemplate", () => {
  it("substitutes from the var map and empty-strings unknown vars", () => {
    expect(renderVarTemplate("{channel}: {text}", { channel: "C1", text: "hi" })).toBe("C1: hi");
    expect(renderVarTemplate("{unknown}", {})).toBe("");
  });
});
