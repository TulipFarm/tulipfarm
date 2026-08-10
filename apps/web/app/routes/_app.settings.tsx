import type { MetaFunction } from "@remix-run/react";
import { SectionShell } from "~/components/section-shell";

export const meta: MetaFunction = () => [{ title: "Settings · tulipfarm" }];

/**
 * Settings is strictly personal — one participant's own account. Anything that configures the
 * workspace lives under `/business/*` in Operate, where the person changing it is acting as an
 * operator rather than a user.
 */
export default function SettingsLayout() {
  return <SectionShell />;
}
