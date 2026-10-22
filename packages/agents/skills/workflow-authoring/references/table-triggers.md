# Table triggers

Get `tableId` and field IDs from `tables.definitions`.

## Record trigger: run relative to a row's date

`{"kind":"record","tableId","field":record field,"filter"?:record filter}`

A record trigger runs once for each row of the table, relative to that row's date or timestamp field.

A record field is one of:

- `{"kind":"date","fieldId","offset":{"direction":"before" or "after","amount":0 to 366,"unit":"days" or "weeks"},"time":"HH:MM","timezone":IANA zone}` for a date field.
- `{"kind":"timestamp","fieldId","offset":{"direction","amount","unit":"minutes", "hours" or "days"}}` for a timestamp field.

The offset is at most 366 days.

A record run's input is `{"tableId","recordId","token","scheduledFor","values"}`, with values keyed by field ID, each `{"kind","value"}`.

## Row trigger: run when a row changes

`{"kind":"row","tableId","event":"created", "updated" or "deleted","fieldIds"?:[fieldId],"filter"?:record filter}`

A row trigger runs within about a minute after a row of the table is created, updated or deleted. Only an `"updated"` trigger may name `fieldIds`; it then runs only when one of those fields changed. The filter is checked against the row's values after the change, or its last values for a deleted row.

A row run's input is `{"event","tableId","recordId","token","changedAt","values"}`, plus `"changedFieldIds"` and `"previousValues"` for updates; deleted rows carry no token.

- Read a field with `{"kind":"input","path":["values",fieldId,"value"]}`.
- Read its earlier value with `["previousValues",fieldId,"value"]`.

File fields are left out. When the values are too large, they keep only the changed, watched and filter fields and `"valuesTruncated"` is true.

Avoid loops. A step must not make the change that starts its own workflow: no create-row on the watched table for a `"created"` trigger, and no update-row on the watched table for an `"updated"` trigger unless `fieldIds` leaves out every field the step writes.

When many changes arrive at once, runs past 100 waiting changes are skipped and reported together.

## Record filter

The optional record filter limits runs to rows where one field matches. It is one of:

- `{"fieldId","match":"is" or "is-not","value"}` where value is `{"kind":"text","value"}`, `{"kind":"boolean","value"}`, `{"kind":"single-select","optionId"}`, `{"kind":"numeric","value":decimal string}`, `{"kind":"date","value":"YYYY-MM-DD"}` or `{"kind":"timestamp","value":ISO datetime}` and its kind matches the field kind.
- `{"fieldId","match":"lt", "lte", "gt" or "gte","value"}` with a numeric, date or timestamp value.
- `{"fieldId","match":"is-empty" or "is-not-empty"}` with no value.

`"is-not"` also matches rows with no value.
