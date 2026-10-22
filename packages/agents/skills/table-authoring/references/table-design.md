# Designing a business table

A good table matches how the person actually tracks the work. Your goal is a first version that is useful today and easy to extend later, not every field they might ever need.

## Ask first, but only what matters

Ask at most two short questions, and only when the answer changes the shape:

- **Stages:** "Which statuses does a ticket move through?" These become the options of a single-select field.
- **Ownership:** "Who handles each row? A name is enough, or should it link to a People table?"
- **Uniqueness:** "Is anything unique, such as an order number or an email address?"

If the person already said these things, or says "just make it", propose a sensible default and say which choices they can change on the review card.

## Choose a small set of fields

Start with 4 to 8 fields:

1. A short **title or name** (`text`, required). This is how people recognize a row.
2. The **lifecycle**, when the work moves through stages (`single-select`, such as Open, In progress, Done).
3. **Who** is responsible or affected.
4. **When** it matters: a due date or the time an event happened.
5. Details that the person mentioned explicitly.

Do not add fields for data that nobody will fill in.

## Split into linked tables or keep one table

A normalized design stores each kind of thing once, in its own table, and links rows with `relationship` fields. A denormalized design keeps the values in one table, even when the same value repeats across rows. Choose per field, not for the whole design.

Use a separate table and a relationship when:

- The thing has its own details that people look up or update, such as a customer with an email, phone, and address.
- Many rows refer to the same thing, and a change must show everywhere, such as renaming a customer once.
- One row owns a list of items that each have their own fields, such as the line items of an order. Put the items in a child table that links to the parent; do not add numbered fields such as Item 1 and Item 2.
- A matching table already exists. Check `tables.definitions` and link to it instead of copying its data.

Keep the value in the same table when:

- It is a plain label from a short fixed list, such as status or priority. Use `single-select` or `multi-select`.
- Nobody tracks anything else about it, such as a requester email on a ticket.
- The value must stay as it was at that moment, such as the price on an order or the shipping address on an invoice. Copy the value onto the row, even if a Products or Customers table also holds it, because the linked value can change later.
- The person asked for something simple and has no other tables yet. One table is easier to start with, and you can split it later.

Linked tables have costs. A relationship target must already exist or be created by an earlier plan in `dependsOn`. With `onDelete: "restrict"`, a linked row cannot be deleted while others point to it. Each extra table is one more thing to fill in. For a first version, propose at most two or three tables, and explain why each split helps.

Do not add a field for a value that is computed from other fields, such as quantity × price or an order total from its line items. Tables have no formula fields, so a stored total goes stale as soon as one of its inputs changes. Add it only when the person asks to record a final amount as a snapshot.

## Pick the field kind

| Need                        | Kind            | Notes                                                                                                |
| --------------------------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| Name, description, notes    | `text`          | Set `maxLength`: about 200 for a title, up to 10000 for long notes.                                  |
| Amount, quantity, price     | `numeric`       | Set `precision` and `scale`. Use scale 2 for money. `precision - scale` must be at most 20.          |
| Yes or no                   | `boolean`       |                                                                                                      |
| Calendar day without a time | `date`          | Due dates and birthdays.                                                                             |
| Exact moment                | `timestamp`     | `timezone` is always `"UTC"`.                                                                        |
| One value from a fixed list | `single-select` | Status, priority, category. Each option is `{id, label, retired:false}` with a new UUID.             |
| Several values from a list  | `multi-select`  | Tags and labels.                                                                                     |
| A row in another table      | `relationship`  | Customer, project, assignee in a People table. The target table must exist or be in an earlier plan. |
| Attachments                 | `file`          | Screenshots, contracts.                                                                              |

There is no user or person field kind. For an assignee, use `text` for a simple name, or a `relationship` to a People table when the person tracks people as rows.

Mark a field `required` only when a row is useless without it. Required fields make every new row harder to add.

Add a unique key only for a real business identifier, such as an invoice number. Do not add one on the title.

## Examples

Read the closest example with `skills.read` and `resource` before you propose. Adapt it to what the person said; do not copy fields they do not need.

- `references/example-ticket-management.md`: tasks and tickets, as in Jira, Linear, or Asana.
- `references/example-hr-operations.md`: employees, time off, and onboarding, as in Workday.
- `references/example-engineering-work.md`: issues and releases, as in GitHub Issues.
- `references/example-customer-support.md`: customers and feedback, as in Zendesk or Canny.

After the card is ready, tell the person which defaults you chose, such as the status list. They can ask for changes before they approve it.
