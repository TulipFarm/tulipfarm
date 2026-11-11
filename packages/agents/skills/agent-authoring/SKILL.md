---
name: agent-authoring
title: Set up an agent for review
description: Guide Basics, Skills, Access and Triggers into one bounded agent setup for human review. Use when someone wants an assistant, bot or helper, or wants to change, archive, remove or restore an existing agent.
tools: agents.context agents.draft agents.list agents.read agents.status agents.archive agents.restore slack.resolve
---

# Draft an agent for review

An agent has a role and bounded authority. Prepare one shared setup. The person reviews the exact card and chooses **Save draft** or **Create and activate**. Your prose and tool calls never provide approval, sponsorship or replacement consent.

Prepare the draft yourself in the main chat. Helpers cannot draft agents. Delegation is disabled during this setup. If authoring is blocked, stop at the first failed prerequisite, say plainly why no draft was prepared, and link to **Configure manually** using the supplied builder URL. Do not claim a tool is unavailable or try repeated helpers.

For a larger request spanning tables, agents, and automation, use Planning in the default chat first. Keep this setup as a deliverable in that same plan; do not replace the plan with a separate agent interview. Planning itself is not a selectable capability for the saved agent.

## 1. Find out whether the agent already exists

1. Use `workspaceInventory.agents` when supplied; call `agents.list` only for absent or stale inventory. Read the relevant definition before reusing or changing it.
2. If authoring tools are deferred, search for `create agent`. Read `agents.context` for the current Soul revision, your membership ID, optional team placement, managed sharing teams, bundled skill metadata and supported tools.
3. Decide which case applies:
   - **New agent:** the person asks for a new or separate agent. Never update an existing agent for this request, even when a name is similar.
   - **Change an existing agent:** only when the person asks to change that agent. Read its definition with `agents.read` and call `agents.context` with its `agentId` for current policy and activation IDs.
   - **Archive or restore:** to remove agents, call `agents.archive` with up to 20 agent IDs on one card. Archiving hides each agent, turns it off, ends its activations and archives the Workflows created for its triggers, but keeps its team, sharing and history. To bring one back, call `agents.list` with `archived: true`, then `agents.restore`; restored agents and their trigger Workflows stay off until a manager turns them on and activates them. Only someone who may delete the agent can archive or restore it, and human review still applies.

## 2. Resolve Basics, Skills, Access and Triggers

Reuse decisions already made. Ask at most one necessary question before drafting; do not restart an interview or silently choose wider access. When only a safe wording detail is missing, propose it on the card.

### Basics

Write a focused name (at most 120 characters), instructions (at most 32,000 characters) and a model preference. Use `owningTeamId:null` for personal placement. A selected team is placement, not sharing, enrollment or borrowed authority.

Use the person's name and model when supplied. Otherwise derive a short name from the requested job and use the workspace's default chat model, marked `default` in `agents.context.models.choices`. If no default choice is available, leave the model preference unset. Do not ask for a name or model just to prepare the draft. State these defaults; both remain editable in the builder.

When changing an existing agent, ask about the name or model only when the person wants to change it.

### Skills

Discover built-ins through `agents.context` or `skills.list`; use revision `latest`. Built-ins use current bundled guidance, not invented numeric versions. Discover reviewed workspace skills with `skills.workspace` and read exact selected packages with `skills.load`. Preserve their exact 64-character revision hashes and the 16-skill limit.

For a supplied skills.sh, GitHub or supported URL, use `skills.import`, `skills.import.status` and explicit package selection for the existing review flow. Never install, enable or approve a skill yourself. Resume agent setup after the human installs a reviewed skill. Selecting a procedure grants no tools.

### Access

Use only real tool names and runtime support from `agents.context`. Select at most 20 tools, chosen from what the agent's job needs, not a generic bundle. For example, an agent that handles leave requests needs to read and update its leave-request rows and perhaps reply in Slack; it needs no GitHub tools and no tools that create or start other agents. Leave out tools the job does not use. The person sees the chosen tools and skills on the card and can add others from the builder. Discover data with `tables.list` and `schema.inspect`; preserve real IDs and bounded permissions. Keep `scope`, resource `limits`, `taskLimits`, team `enrollment` and sharing `policy` separate. Start with no extra access and name unresolved permissions.

The policy must explicitly retain a manager. Use the context membership ID for the creator's reviewed personal grants; do not guess a person or team. Do not silently enroll the owning team. Explain any selected tool that cannot run in Slack or from an unattended trigger.

### Triggers

Manual use needs no external trigger. Slack and triggers are optional inactive choices until the human activates the setup.

For Slack, use `slack.resolve` for real channels, then `agents.context` with `channels` for current attachment versions and channel delivery readiness. A disconnected, unlinked, unsupported or hidden conflicting attachment is unresolved, not an empty channel. Preserve each `expectedVersion`; set `replaceAgentId` to the inspected current agent or null. Replacing another agent needs the human's explicit replacement consent. Use `detach:true` only for a reviewed removal of this agent's current attachment. Default to `responseRule:'tag'`; use `every-message` only when explicitly chosen. Linked authorized workspace members can talk to the attached agent there; this gives no other agent or source-data access.

Agents have no schedules of their own. Each item in `setup.triggers` becomes its own Workflow with that trigger and one step that runs this agent. An item has a new UUID `id`, a Workflow `trigger` (cron with explicit time zone, interval, once, webhook, event, record, row, provider such as a Sheets row added, or github such as an issue opened), a task `prompt` (at most 8,000 characters) and optional `limits`. The trigger's data, such as the new row or issue, is passed to the agent with the prompt. Use `workflows.providers` for GitHub `repositoryId` and provider sources, and `tables.list`/`schema.inspect` for row and record triggers. Pass proposed triggers as `triggers` to `agents.context` to validate them and preview next runs. Keep cron and interval triggers hourly or slower. Explain private sponsor-owned history. The human must explicitly consent on the review card to sponsor each unattended trigger (every kind except manual and event).

## 3. Call agents.draft

- New agent: pass agent `"new"`. The server assigns a fresh identity.
- Existing agent: pass agent `{id, savedRevision}` from `agents.read`.
- In `input`, keep `definition`, `owningTeamId` and `expectedSoulRevision`. Add `setup:{policy,enrollment,scope,limits,taskLimits,slackSender,slackChannels,triggers}` and the context's `expectedPolicyVersion`, `expectedActivationIds`, `expectedWorkflowRevision` and `expectedWorkflowGeneration`. Copy all four exactly, including null workflow values for a new agent. Omit unused optional fields rather than sending null. The full setup uses the same validation and publication path as the manual builder.
- Do not put consent in model input. The human decision carries exact digest/version and explicit sponsorship/replacement choices.
- If the person wants only a saved definition, historical definition-only input is still supported, but it cannot activate anything.

## 4. Hand over for review

Tell the person whether the card creates a new agent or updates an existing one. Ask them to review Basics, Skills, Access and Triggers on the immutable card.

Explain what happens next, so that nobody assumes the agent is already running:

- **Save draft** keeps all chosen setup inactive. Editing an existing agent leaves its prior active setup running.
- **Create and activate** applies only the exact human-reviewed setup after current access and every required trigger check succeeds.
- A saved definition with blocked setup is not an active success. Keep its command receipt; fix the named prerequisite and retry that same command, rather than creating duplicate agents or Workflows.
- Never promise atomic rollback across Soul and the workspace database. Soul may already contain an inactive saved revision when setup is blocked.
- Sharing a definition never shares private task history.
