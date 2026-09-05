import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";

/**
 * Closed style vocabulary a Soul-composed component may apply to any node it renders. Every value
 * is a fixed literal union, never a string, so a business component can vary its look without ever
 * carrying a CSS value — the schema itself cannot express one.
 */
export const SurfaceToneSchema = Type.Union([
  Type.Literal("neutral"),
  Type.Literal("positive"),
  Type.Literal("warning"),
  Type.Literal("negative"),
  Type.Literal("info"),
]);

export const SurfaceRadiusSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("sm"),
  Type.Literal("md"),
  Type.Literal("lg"),
  Type.Literal("full"),
]);

export const SurfaceSizeSchema = Type.Union([
  Type.Literal("xs"),
  Type.Literal("sm"),
  Type.Literal("md"),
  Type.Literal("lg"),
  Type.Literal("xl"),
]);

export const SurfaceStyleSchema = Type.Object(
  {
    tone: Type.Optional(SurfaceToneSchema),
    radius: Type.Optional(SurfaceRadiusSchema),
    size: Type.Optional(SurfaceSizeSchema),
  },
  { additionalProperties: false }
);

export type SurfaceTone = Static<typeof SurfaceToneSchema>;
export type SurfaceRadius = Static<typeof SurfaceRadiusSchema>;
export type SurfaceSize = Static<typeof SurfaceSizeSchema>;
export type SurfaceStyle = Static<typeof SurfaceStyleSchema>;
