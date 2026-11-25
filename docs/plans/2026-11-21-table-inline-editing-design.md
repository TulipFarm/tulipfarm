# Table inline editing design

## Goal

Let a person edit simple row values directly in the Table layout while preserving the full row editor for long text and complex values. In a typical tickets table, Title, Status, Priority, Assignee, Type and similar fields should be editable from their cells. In the row editor, a one-to-one relationship such as Assignee needs one searchable select instead of separate search and choose controls. The full editor should open in a roomy centered modal instead of a narrow side sheet.

## Current behavior

The grid renders every value through `TableValueView`. Editing is available only through the row action, which opens `RecordEditor`. The row editor already uses the direct row mutation contract, including expected row token, idempotent request ID, error recovery and refresh.

After closing the editor, its row action sometimes stopped opening it again. Closing triggered a table refresh, and the grid disabled actions while that refresh failed or remained in progress, so a slow or failed table read left the rows behind disabled controls.

## Intended interaction

- A person with row update permission can activate a simple cell with a pointer or keyboard. A person without permission sees its value without an edit control.
- Short text uses a one-line input. Enter commits, Escape cancels, and blur commits only when valid and changed. Long text such as Description opens the full row editor.
- Single-select, multi-select, boolean and one-to-one relationship values use compact pickers in the cell. Assignee uses the existing relationship search and permission model. Dates and numbers may use a compact input when validation can be preserved.
- The full row editor's one-to-one relationship field uses a single combobox: typing filters choices, clicking opens the list, and the selected row is visible in the same control.
- The full Add/Edit row form uses a responsive centered dialog with enough width for long text and many fields. Its unsaved-change prompt and focus return remain intact.
- Closing an editor without saving leaves row actions usable. A failed background refresh must show its error and retry action without trapping the previously loaded rows behind disabled controls.
- The active cell remains readable while a write is pending. A rejected write keeps its attempted value and shows an actionable error; an uncertain write keeps the same request ID for receipt checking and retry.
- A successful save refreshes the row query and related references. A concurrent edit must report the stale row instead of overwriting it.
- Summary, List and Board retain their current behavior. System-protected fields continue to respect their existing write rules.

## Implementation sequence

1. Inspect the current grid, field input, mutation API and validation rules.
2. Replace the full row editor's two-part one-to-one relationship picker with one searchable combobox.
3. Move the full row editor from a side sheet to a responsive dialog, preserving its close guard and focus behavior.
4. Add an inline cell editor to the Table layout using the same direct mutation and error handling path as the row editor.
5. Reproduce the reopen problem and remove the stale refresh state that disables row actions.
6. Run typecheck and lint, then review the UI locally.
7. Update browser coverage, run the required checks and review the diff.

## Acceptance criteria

- Title and supported compact fields can be edited from their cells without opening the row editor.
- Description and other complex values still open the row editor.
- Assignee and other one-to-one relationships have one control that searches and chooses a row.
- Add/Edit row opens a wide, responsive modal that retains draft protection.
- Closing and reopening the same row editor works after a successful or failed refresh.
- No change is sent for an unchanged value or when update permission is absent.
- Validation, stale-token conflicts, uncertain outcomes and refresh preserve the direct-edit contract.
- Keyboard focus and screen-reader names make cell editing discoverable and operable.

## Implementation notes

- A one-to-one relationship cell keeps its link to the linked row, with a separate edit button beside it.
- Each cell's value stays its accessible name; the column header names the field.
- Members tables keep their own editor and are not edited from the grid.
