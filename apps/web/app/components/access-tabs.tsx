import { Segmented, SegmentedLink } from "~/components/ui/segmented";

/* `end` keeps People inactive on sibling routes. */
const tabs = [
  { to: "/business/access", label: "People", end: true },
  { to: "/business/access/teams", label: "Teams", end: false },
  { to: "/business/access/agents", label: "Agents", end: false },
  { to: "/business/access/check", label: "Check", end: false },
];

export function AccessTabs() {
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
