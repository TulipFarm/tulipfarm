import { Segmented, SegmentedLink } from "~/components/ui/segmented";

// Tab nav shared by the Installed (/skills) and Marketplace (/skills/marketplace) panes. Mirrors the
// settings tab styling. `end` on Installed so it isn't marked active while on the marketplace route.
const tabs = [
  { to: "/skills", label: "Installed", end: true },
  { to: "/skills/marketplace", label: "Marketplace", end: false },
];

export function SkillsTabs() {
  return (
    <Segmented as="nav">
      {tabs.map((tab) => (
        <SegmentedLink key={tab.to} to={tab.to} end={tab.end}>
          {tab.label}
        </SegmentedLink>
      ))}
    </Segmented>
  );
}
