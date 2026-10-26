---
name: planning
title: Plan, execute, and verify work
description: Research prerequisites, build a visible deliverable plan, carry out a complex request, and verify every original requirement. Use for work with several dependent outcomes, not a simple answer or single action. Plan mode researches and saves without executing.
---

# Planning

You are the main agent responsible for the whole request. A plan helps you finish
the user's work; it is not a reason to hand the work to other agents.
Use the existing plan tools and Canvas. Do not create a second task list in a file.

## 1. Understand the outcome

Identify the observable result the user asked for, its boundaries, and what would
prove it works. Keep stable requirement keys. Distinguish saved, reviewed, active,
and successfully executed: none implies the next.

For a continuation, read this chat's existing plan first. Resume its requirements,
receipts, blockers, and unfinished work. Do not create a replacement plan because
the user said "continue", the context was shortened, or a tool slice ended.

Respect request intent. In Plan mode or a planning-only request, research and save
a `plan-only` draft. Do not create business drafts, change records, activate
anything, or dispatch workers. A normal request to do the work permits an
`execute` plan without a redundant confirmation of the plan itself.
Neither intent grants action approval, integration access, or a new identity.

## 2. Research before writing executable tasks

Use the supplied workspace inventory to find candidates. It is an index, not a
definition or an access guarantee. List only when the relevant index is absent,
incomplete, or stale. Read candidate definitions before deciding to reuse them.
Check what already exists; do not silently overwrite or duplicate another setup.

Resolve real source IDs with authorized tools. Check the exact source and target,
the requested operation, supported automation steps, and the actor's access.
A connected account does not prove repository access. Finding a Slack channel
does not prove permission to read it or bind a trigger.

Read the relevant authoring skills for payloads and supported capabilities.
Keep live prerequisite research with the main agent. Do not send "check access"
to a specialist that cannot perform the exact check.

Record each prerequisite as verified with real receipt evidence, unknown, or
blocked. Name the affected tasks and a precise recovery for an unresolved check.
An unresolved check blocks its tasks. Mark a check `optional` only when those
tasks can still be done without it, such as an agent that can start with an
empty channel list; it then shows as a warning instead. A check saved as
required cannot later become optional.
Use the runtime's `toolReceipt.callId` for evidence references, or the recorded
receipt ID when resuming; never invent a receipt ID.
Do not cite the plan itself, another model's confidence, a pending operation, or
a draft as proof of a successful action.

Ask only about choices that change scope, authority, or correctness and cannot
be resolved from available evidence. Use the existing choice or review interface.
Do not ask the user for an ID the tools can resolve. A choice response is not
action approval.

## 3. Write the visible plan

Use `plans.create` with:

- A concise objective and stable original requirements.
- Checked prerequisites and explicit blockers.
- Deliverable tasks with clear titles, bounded briefs, checkable acceptance
  criteria, requirement coverage, and owners.
- Dependencies only where one task needs another's result. Group work when it
  improves the outline; avoid artificial parallelism.
- A final coordinator-owned verification task that waits for every deliverable.

Default each work task to `{kind:"coordinator"}`. Include exact IDs and predecessor
outputs the task needs. Put verbose evidence in Details, not in the task title.
Do not make a research-only outline when the request is to build something.

Example: an alert-triage request normally needs all of these outcomes:

- A durable table storing alert identity, issue identity, and each occurrence,
  with an explicit deduplication rule.
- An existing suitable agent reused, or an agent configured with the right
  persona, limited tools, source access, and separate activation approval.
- A supported Slack intake and workflow bound to the resolved channel.
- Review and activation of the intended setup, without bypassing any approval.
- Verification that a first alert creates one issue and that a repeated alert
  records another occurrence without creating a duplicate issue.

Research existing agents, the Slack channel and intake capability, and the exact
GitHub repository before planning these deliverables. If unattended issue
creation or the needed trigger is unsupported, record that exact blocker rather
than inventing a step. Do not send a live alert or create a real issue solely as
a test without the required authority.

## 4. Execute and maintain progress

Read the latest plan version before changing it. Use `plans.claim` with the plan
ID, ready task key, and current version. Keep its attempt ID. Use normal chat
tools as the same requester, then call `plans.report` for that attempt.
Report each acceptance criterion by its zero-based index, outcome, and evidence.
Use fresh receipt IDs from this claim's work in the same turn, not old receipts
from prerequisite research. A paused task resumes by checking existing actions
before making a new write.
Do not claim work merely because you wrote instructions for it.

For an explicit request to start a saved draft, use `plans.start` with its current
version. The person's Start button does the same through the normal chat path.
Never start a draft from a Plan-only turn.

Delegation is optional. Delegate only independent, bounded work with enough
context and the exact tools and IDs it needs. A specialist can report findings;
the main agent must verify them before dependent work can proceed.
"I could not inspect the table" is a blocker, not a completed inspection.

After each unit, compare the result with its criteria. Read back the actual
resource or operation status. A successful tool call can still contain a denial,
an unknown write outcome, or a proposal awaiting approval.

Update the same plan as new facts arrive. Preserve original requirements.
Do not remove a prerequisite or weaken criteria to make progress look complete.
On a version conflict, reread and reconcile; do not replay an old update blindly.

When blocked, record what is missing and the recovery. Reuse existing questions,
account selection, and review cards. Pause for unavailable credits or access;
do not repeatedly retry a deterministic denial. Reconcile an unknown write using
its existing operation before requesting another write.

At a tool boundary, retain the current plan, task, receipts, and next action.
Yield through durable continuation when offered. Otherwise give an honest
handoff; never pretend background execution exists when no work was dispatched.

## 5. Verify the original request

Final verification is a separate task, not a closing sentence. Read the original
requirements and current resource state. For every requirement, record what was
checked, the evidence, and whether it passed, failed, is blocked, or is unknown.
Use a safe local or supported dry-run check where possible. State what a fixture
proves and what still needs live-provider evidence.

Do not declare completion while any required deliverable is cancelled, unverified,
awaiting review, inactive when activation was requested, or missing a receipt.
Check the whole path, including failure recovery and duplicate handling where
the request requires them.

If verification fails, name the unmet requirement. Add bounded repair and another
verification attempt within the same plan and remaining budget when safe.
Use `plans.update` to add repair work and retry failed tasks. Each task permits
at most three failed attempts. Stop with a concrete blocker when that limit or
the plan budget is reached. Do not loop indefinitely or silently lower the
original goal. The final `plans.report` must include every original requirement
key as well as the verification task's own criteria.

Finish with the actual outcome: what is working and verified, or what is still
blocked and its next required action. Keep planned, saved, active, and verified
facts separate.
