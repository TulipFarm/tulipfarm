# Everyone team and owner picker

## Goal

- Add an internal team `_everyone`. Every active member belongs to it. Nobody can leave it.
- Show `_admin` as **Admin** and `_everyone` as **Everyone** everywhere a person or the agent sees a team name.
- When the agent asks which team owns a new table, the first option is Everyone and the picker is a searchable select, not radio buttons.

## Decisions

- Everyone may own a table. Every member can use it. Only workspace admins change its structure or delete it.
- Any member may add an agent to Everyone.
- On the Access page a grant to Everyone shows as a team policy named Everyone.
- Everyone is hidden from team management, like `_admin` (leading underscore).

## Steps

1. Migration `packages/workspace-storage/common/0083_internal_everyone_team.sql`
   - Insert `_everyone` if missing.
   - Backfill every active membership into it.
   - Trigger on `tf_memberships` insert that enrols the new member, so no code path can miss it.
   - Default grants: `table.create` and the four row permissions for `_everyone` on tables it owns. Never `table.schema.manage`.
   - Redefine `tf_table_creation_access`: for owner `_everyone`, grant only row permissions to the team, and `table.schema.manage` only if the creator is an admin.
   - Bump `tf_authorization_lock`.
   - Do not edit `0001_baseline.sql` (migration checksums).
2. Labels: one `teamLabel` helper in `packages/workspace-storage/src/names.ts`. Replace the one-off maps in `packages/agents/src/members.ts` and `workspace-inventory.ts`, and the web `team-labels.ts`.
3. Treat `_everyone` like `_admin` where needed: `grantTeamExists`, `canAssignTeam`, the MCP team picker filter, member chips filter, access snapshot.
4. Agent: `authoringContext` returns Everyone first with its label. The `present_choice` prompt rule asks for a searchable select when there are many options.
5. Web: searchable select in `apps/web/src/features/chat/interaction-card.tsx`. Layout chosen from three prototypes.
6. After the founder checks it locally: update tests, then raise the PR.

## Risks

- `tf_table_creation_access` grants all five permissions to the owner team. Without step 1 this lets every member delete an Everyone table.
- About ten tests hard-code team names or counts. They change after founder approval.
