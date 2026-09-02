import type { ReactNode } from "react";
import { Link } from "~/components/ui/link";
import { Panel } from "~/components/ui/panel";
import type { CapabilityFacts } from "~/lib/agent-capabilities";
import { ReachBadge } from "./reach-badge";

const CHIP_BASE =
  "inline-flex min-h-6 items-center rounded-sm border px-1.5 py-0.5 font-mono text-[11px]";
const CHIP_TONE = {
  allow: "border-border bg-muted text-foreground",
  deny: "border-status-danger/30 bg-status-danger/10 text-status-danger",
} as const;

/**
 * A single declared capability. When `to` is given the link *is* the chip rather than sitting
 * inside it, so the padding belongs to the hit area and the target clears 24px.
 *
 * A denied chip carries a visible `✕` as well as the danger tone: refusal is a state, and a state
 * that only hue distinguishes is invisible to a reader who cannot separate these two hues.
 */
function Chip({
  children,
  tone = "allow",
  to,
}: {
  children: ReactNode;
  tone?: "allow" | "deny";
  to?: string;
}) {
  const className = `${CHIP_BASE} ${CHIP_TONE[tone]}`;
  const body =
    tone === "deny" ? (
      <>
        <span aria-hidden="true" className="mr-1 font-sans">
          ✕
        </span>
        <span className="sr-only">blocked: </span>
        {children}
      </>
    ) : (
      children
    );
  if (to) {
    return (
      <Link to={to} className={`${className} underline-offset-2 hover:underline`}>
        {body}
      </Link>
    );
  }
  return <span className={className}>{body}</span>;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[10rem_1fr] sm:gap-4">
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
 * What the runtime will let this agent do, in the order people ask: can it change anything, what
 * can it reach, what was it explicitly refused.
 *
 * A denial is shown as its own chip in the danger tone rather than as struck-through text, because
 * a refusal is a fact about the agent worth reading, not a correction to the list beside it.
 */
export function CapabilityPanel({ facts }: { facts: CapabilityFacts }) {
  return (
    <Panel
      flush
      title="What it is allowed to do"
      description={
        facts.restricted
          ? "Authored in this agent's own definition and enforced on every tool call."
          : "This agent declares no limits of its own, so it can use every capability its team allows."
      }
    >
      <dl className="flex flex-col">
        <Row label="Reach" hint="Whether it can change anything">
          <ReachBadge reach={facts.reach} />
          <span className="text-sm text-muted-foreground">{facts.headline}</span>
        </Row>

        <Row label="Tools" hint="The callables it may invoke">
          {facts.toolsAllowed.length === 0 && facts.toolsDenied.length === 0 ? (
            <Nothing>
              {facts.reach === "read-only"
                ? "Every non-mutating tool."
                : "No tool list declared — every tool its team allows."}
            </Nothing>
          ) : (
            <>
              {facts.toolsAllowed.map((tool) => (
                <Chip key={tool}>{tool}</Chip>
              ))}
              {facts.toolsDenied.map((tool) => (
                <Chip key={tool} tone="deny">
                  {tool}
                </Chip>
              ))}
            </>
          )}
        </Row>

        {facts.skillsAllowed.length > 0 || facts.skillsDenied.length > 0 ? (
          <Row label="Skills" hint="Procedures it may load">
            {facts.skillsAllowed.map((skill) => (
              <Chip key={skill} to="/skills">
                {skill}
              </Chip>
            ))}
            {facts.skillsDenied.map((skill) => (
              <Chip key={skill} tone="deny">
                {skill}
              </Chip>
            ))}
          </Row>
        ) : null}

        <Row label="Record types" hint="The data it can reach">
          {facts.resourceTypes.length === 0 ? (
            <Nothing>Not pinned to any record type.</Nothing>
          ) : (
            facts.resourceTypes.map((type) => (
              <Chip key={type} to={`/resources/${encodeURIComponent(type)}`}>
                {type}
              </Chip>
            ))
          )}
        </Row>

        <Row label="Record actions" hint="What it may do to those records">
          {facts.recordActionsAllowed.length === 0 && facts.recordActionsDenied.length === 0 ? (
            <Nothing>No action list declared.</Nothing>
          ) : (
            <>
              {facts.recordActionsAllowed.map((action) => (
                <Chip key={action}>{action}</Chip>
              ))}
              {facts.recordActionsDenied.map((action) => (
                <Chip key={action} tone="deny">
                  {action}
                </Chip>
              ))}
            </>
          )}
        </Row>

        {facts.resourceTypeActionsAllowed.length > 0 ||
        facts.resourceTypeActionsDenied.length > 0 ||
        facts.resourceTypeNames.length > 0 ? (
          <Row label="Schema changes" hint="What it may do to resource type definitions">
            {facts.resourceTypeActionsAllowed.map((action) => (
              <Chip key={`allow-${action}`}>{action}</Chip>
            ))}
            {facts.resourceTypeActionsDenied.map((action) => (
              <Chip key={`deny-${action}`} tone="deny">
                {action}
              </Chip>
            ))}
            {facts.resourceTypeNames.length > 0 ? (
              <>
                <span className="text-sm text-muted-foreground">on</span>
                {facts.resourceTypeNames.map((name) => (
                  <Chip key={`name-${name}`} to={`/resources/${encodeURIComponent(name)}`}>
                    {name}
                  </Chip>
                ))}
              </>
            ) : null}
          </Row>
        ) : null}
      </dl>
    </Panel>
  );
}
