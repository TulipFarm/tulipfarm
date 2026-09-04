import type { MetaFunction } from "@remix-run/react";
import { SectionShell } from "~/components/section-shell";

export const meta: MetaFunction = () => [{ title: "Settings · tulipfarm" }];

export default function SettingsLayout() {
  return <SectionShell contentClassName="mx-auto max-w-3xl" />;
}
