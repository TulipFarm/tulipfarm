import type { ReactNode } from "react";
import { Panel } from "~/components/ui/panel";
import { SKILL_REACH_HINT, type SkillFacts } from "~/lib/skill-facts";

const CHIP_BASE =
  "inline-flex min-h-6 items-center rounded-sm border px-1.5 py-0.5 font-mono text-[11px]";
const CHIP_TONE = {
  neutral: "border-border bg-muted text-foreground",
  network: "border-status-warning/30 bg-status-warning/10 text-status-warning",
  secret: "border-status-danger/30 bg-status-danger/10 text-status-danger",
} as const;

function Chip({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: keyof typeof CHIP_TONE;
}) {
  return <span className={`${CHIP_BASE} ${CHIP_TONE[tone]}`}>{children}</span>;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[11rem_1fr] sm:gap-4">
      <dt className="text-sm text-foreground">
        {label}
        {hint ? <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span> : null}
      </dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1.5">{children}</dd>
    </div>
  );
}

function Nothing({ children }: { children: ReactNode }) {
  return <span className="text-sm text-muted-foreground">{children}</span>;
}

/**
 * What this Skill reaches, in the order people ask: how far does it go, what will it call, where
 * can it connect, what can it run, whose secrets does it want.
 *
 * A Skill grants no authority, so every row here is a *ceiling* on the Agent that loads it rather
 * than a grant to it — which is why the empty answers say "none declared" and never "everything".
 * Getting that inverted would read as a Skill widening an Agent, which it can never do.
 */
export function SkillCapabilityPanel({ facts }: { facts: SkillFacts }) {
  return (
    <Panel
      flush
      title="What it reaches"
      description={
        facts.declaresNothing
          ? "This skill declares nothing beyond its instructions. It cannot run code, open a connection, or read a secret."
          : "Declared in the skill's own SKILL.md and enforced by the sandbox when one of its commands runs."
      }
    >
      <dl className="flex flex-col">
        <Row label="Reach" hint="How far past plain text it goes">
          {/*
            No badge here: the page header already carries it, and the same chip twice on one page
            reads as two facts. This row's job is the sentence that says what the word means.
          */}
          <span className="text-sm text-muted-foreground">{SKILL_REACH_HINT[facts.reach]}</span>
        </Row>

        <Row label="Tools" hint="What the agent is shown while this is loaded">
          {facts.tools.length === 0 ? (
            <Nothing>No tool list declared, so the agent keeps every tool it already had.</Nothing>
          ) : (
            facts.tools.map((tool) => <Chip key={tool}>{tool}</Chip>)
          )}
        </Row>

        <Row label="Network" hint="Hosts its commands may open">
          {facts.domains.length === 0 ? (
            <Nothing>None declared. Its commands run with the network switched off.</Nothing>
          ) : (
            facts.domains.map((domain) => (
              <Chip key={domain} tone="network">
                {domain}
              </Chip>
            ))
          )}
        </Row>

        <Row label="Commands" hint="Shell it is allowed to run">
          {facts.commands.length === 0 ? (
            <Nothing>None declared. It can only run commands its own package ships.</Nothing>
          ) : (
            facts.commands.map((command) => <Chip key={command}>{command}</Chip>)
          )}
        </Row>

        <Row label="Secrets" hint="Credentials leased to it while it runs">
          {facts.secrets.length === 0 ? (
            <Nothing>None. It never sees a stored credential.</Nothing>
          ) : (
            facts.secrets.map((secret) => (
              <Chip key={secret} tone="secret">
                {secret}
              </Chip>
            ))
          )}
        </Row>
      </dl>
    </Panel>
  );
}
