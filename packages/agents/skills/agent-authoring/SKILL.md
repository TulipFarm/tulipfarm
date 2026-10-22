---
name: agent-authoring
title: Set up an agent for review
description: Guide Basics, Skills, Access and Triggers into one bounded agent setup for human review. Use when someone wants an assistant, bot or helper, or wants to change an existing agent.
---

# Draft an agent for review

An agent has a role and bounded authority. Prepare one shared setup. The person reviews the exact card and chooses **Save draft** or **Create and activate**. Your prose and tool calls never provide approval, sponsorship or replacement consent.

For a larger request spanning tables, agents, and automation, use Planning in the default chat first. Keep this setup as a deliverable in that same plan; do not replace the plan with a separate agent interview. Planning itself is not a selectable capability for the saved agent.

## 1. Find out whether the agent already exists

1. Use `workspaceInventory.agents` when supplied; call `agents.list` only for absent or stale inventory. Read the relevant definition before reusing or changing it.
2. If authoring tools are deferred, search for `create agent`. Read `agents.context` for the current Soul revision, your membership ID, optional team placement, managed sharing teams, bundled skill metadata and supported tools.
3. Decide which case applies:
   - **New agent:** the person asks for a new or separate agent. Never update an existing agent for this request, even when a name is similar.
   - **Change an existing agent:** only when the person asks to change that agent. Read its definition with `agents.read` and call `agents.context` with its `agentId` for current policy and activation IDs.

## 2. Resolve Basics, Skills, Access and Triggers

Reuse decisions already made. Ask only unresolved questions that change the role, access, audience or trigger. Ask one focused question at a time; do not restart an interview or silently choose wider access. When only a safe wording detail is missing, propose it on the card.

### Basics

Write a focused name (at most 120 characters), instructions (at most 32,000 characters) and an optional model preference. Use `owningTeamId:null` for personal placement. A selected team is placement, not sharing, enrollment or borrowed authority.

### Skills

Discover built-ins through `agents.context` or `skills.list`; use revision `latest`. Built-ins use current bundled guidance, not invented numeric versions. Discover reviewed workspace skills with `skills.workspace` and read exact selected packages with `skills.load`. Preserve their exact 64-character revision hashes and the 16-skill limit.

For a supplied skills.sh, GitHub or supported URL, use `skills.import`, `skills.import.status` and explicit package selection for the existing review flow. Never install, enable or approve a skill yourself. Resume agent setup after the human installs a reviewed skill. Selecting a procedure grants no tools.

### Access

Use only real tool names and runtime support from `agents.context`. Select at most 20 relevant tools, not a generic table bundle. Discover data with `tables.list` and `schema.inspect`; preserve real IDs and bounded permissions. Keep `scope`, resource `limits`, `taskLimits`, team `enrollment` and sharing `policy` separate. Start with no extra access and name unresolved permissions.

The policy must explicitly retain a manager. Use the context membership ID for the creator's reviewed personal grants; do not guess a person or team. Do not silently enroll the owning team. Explain any selected tool that cannot run in Slack or a schedule.

### Triggers

Manual use needs no external trigger. Slack and schedules are optional inactive choices until the human activates the setup.

For Slack, use `slack.resolve` for real channels, then `agents.context` with `channels` for current attachment versions and channel delivery readiness. A disconnected, unlinked, unsupported or hidden conflicting attachment is unresolved, not an empty channel. Preserve each `expectedVersion`; set `replaceAgentId` to the inspected current agent or null. Replacing another agent needs the human's explicit replacement consent. Use `detach:true` only for a reviewed removal of this agent's current attachment. Default to `responseRule:'tag'`; use `every-message` only when explicitly chosen. Linked authorized workspace members can talk to the attached agent there; this gives no other agent or source-data access.

Each schedule has its own task prompt (at most 8,000 characters), explicit time zone for five-field cron, existing interval/cron trigger, limits, unique ID and `sponsorMembershipId` from context. Pass proposed triggers as `scheduleTriggers` to `agents.context` for validated next-run previews from the existing scheduler. Keep task schedules hourly or slower. Explain private sponsor-owned history. The human must explicitly consent to each sponsored schedule on the review card.

## 3. Call agents.draft

- New agent: pass agent `"new"`. The server assigns a fresh identity.
- Existing agent: pass agent `{id, savedRevision}` from `agents.read`.
- In `input`, keep `definition`, `owningTeamId` and `expectedSoulRevision`. Add `setup:{policy,enrollment,scope,limits,taskLimits,slackSender,slackChannels,schedules}` and the context's `expectedPolicyVersion` and `expectedActivationIds`. The full setup uses the same validation and publication path as the manual builder.
- Do not put consent in model input. The human decision carries exact digest/version and explicit sponsorship/replacement choices.
- If the person wants only a saved definition, historical definition-only input is still supported, but it cannot activate anything.

## 4. Hand over for review

Tell the person whether the card creates a new agent or updates an existing one. Ask them to review Basics, Skills, Access and Triggers on the immutable card.

Explain what happens next, so that nobody assumes the agent is already running:

- **Save draft** keeps all chosen setup inactive. Editing an existing agent leaves its prior active setup running.
- **Create and activate** applies only the exact human-reviewed setup after current access and every required trigger check succeeds.
- A saved definition with blocked setup is not an active success. Keep its command receipt; fix the named prerequisite and retry that same command, rather than creating duplicate agents or schedules.
- Never promise atomic rollback across Soul and the workspace database. Soul may already contain an inactive saved revision when setup is blocked.
- Sharing a definition never shares private task history.
