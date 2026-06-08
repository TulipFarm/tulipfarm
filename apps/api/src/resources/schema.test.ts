import { describe, expect, it } from "vitest";
import {
  assertValidType,
  createHistoryTableSql,
  createResourceTableSql,
  historyTableName,
  rowToResourceDoc,
  tableName,
} from "./schema";

describe("resources/schema", () => {
  describe("assertValidType", () => {
    it("accepts lowercase, digits, and hyphens", () => {
      expect(() => assertValidType("ticket")).not.toThrow();
      expect(() => assertValidType("support-ticket")).not.toThrow();
      expect(() => assertValidType("a1")).not.toThrow();
    });

    it("rejects empty, uppercase, leading digit, and injection chars", () => {
      for (const bad of ["", "Ticket", "1ticket", "tick et", 'tick"et', "tick;drop", "tick_et"]) {
        expect(() => assertValidType(bad)).toThrow();
      }
    });
  });

  describe("tableName / historyTableName", () => {
    it("quotes inside the resources schema", () => {
      expect(tableName("ticket")).toBe('resources."ticket"');
      expect(historyTableName("ticket")).toBe('resources."ticket_history"');
      expect(tableName("support-ticket")).toBe('resources."support-ticket"');
    });

    it("guards against invalid identifiers before building SQL", () => {
      expect(() => tableName('x"; DROP TABLE users; --')).toThrow();
      expect(() => historyTableName("BAD")).toThrow();
    });
  });

  describe("create*Sql", () => {
    it("emits idempotent CREATE TABLE with the quoted name and core columns", () => {
      const sql = createResourceTableSql("ticket");
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS resources."ticket"');
      expect(sql).toContain("jsonb NOT NULL");
      expect(sql).toMatch(/version\s+integer/);
      expect(sql).toContain("deleted_at");

      const hist = createHistoryTableSql("ticket");
      expect(hist).toContain('CREATE TABLE IF NOT EXISTS resources."ticket_history"');
      expect(hist).toContain("snapshot");
      expect(hist).toContain("resource_id");
    });
  });

  describe("rowToResourceDoc", () => {
    const created = new Date("2026-06-01T00:00:00Z");
    const updated = new Date("2026-06-02T00:00:00Z");

    it("maps system columns and spreads data, omitting deletedAt when null", () => {
      const doc = rowToResourceDoc({
        id: "11111111-1111-1111-1111-111111111111",
        version: 3,
        created_at: created,
        updated_at: updated,
        deleted_at: null,
        data: { title: "Bug", priority: "high" },
      });
      expect(doc).toEqual({
        _id: "11111111-1111-1111-1111-111111111111",
        version: 3,
        createdAt: created,
        updatedAt: updated,
        title: "Bug",
        priority: "high",
      });
      expect("deletedAt" in doc).toBe(false);
    });

    it("includes deletedAt when set and never lets data override system fields", () => {
      const del = new Date("2026-06-03T00:00:00Z");
      const doc = rowToResourceDoc({
        id: "abc",
        version: 5,
        created_at: created,
        updated_at: updated,
        deleted_at: del,
        data: { _id: "HACK", version: 999, title: "x" },
      });
      expect(doc._id).toBe("abc");
      expect(doc.version).toBe(5);
      expect(doc.deletedAt).toBe(del);
      expect(doc.title).toBe("x");
    });
  });
});
