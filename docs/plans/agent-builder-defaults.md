# Agent builder defaults

Use the existing form and shared controls. Keep the Agents entry, chat start,
and workspace shell unchanged.

## Target flow

1. Open the manual builder from Agents.
2. Enter the name.
3. Enter instructions.
4. Select a table on Basics.
5. Continue to Review.
6. Create and activate.

Table selection suggests read actions. Instruction text never selects actions.
Manual removals stay removed. Activation needs a row-reading action when table
access is selected. Optional Skills and Triggers remain available without
requiring empty steps. Draft saves and uncertain-write recovery stay unchanged.

Use multi-table selection with names, and team names only to distinguish
duplicates. Add app action presets without removing individual choices.
Show data access in Summary. Hide the side panel on Review. Activation opens the
agent detail page and focuses Run agent now without starting a task.

## Copy

- Business tables
- Choose the tables this agent can read. You can change its actions and table access later in the Access step.
- Suggested actions: read tables
- Added so the agent can read the tables you chose: find tables, read their fields, and find, read, and total rows. These actions cannot change data. Remove them here, or change actions in the Access step.
- Suggested actions removed. To use the tables you chose, add an action that reads rows in the Access step.
- Remove these actions
- Remove suggested table actions
- Read only
- Read and change rows
- Changes data
- All actions
- Table access
- Data access
- This agent has table access but no action that reads rows. Add Find rows or Read a row in the Access step, or remove its table access.
- Go to Access
- Team name unavailable

Read only replaces that app's choices with its reads. The other preset selects
all actions in that app. Presets do not change another app's choices or exceed
twenty actions. Removing suggestions keeps actions selected manually. Only Find
rows and Read a row satisfy the row-reading check.

## Checks

Add focused draft and browser tests. Verify six interactions and no more than ten
seconds of waiting with local API fixtures. Capture desktop and phone screenshots.
Run formatting, lint, type checks, and related existing browser checks.
