# Example: HR operations

Use this pattern when someone wants to run people operations the way Workday or BambooHR do: an employee directory, onboarding and offboarding, and time off.

## Employee directory

Start with one **Employees** table. Department and location are labels from a short list, so keep them as `single-select` fields. Split them into their own tables only when the person tracks details about each department, such as a head or a budget.

**Employees**

| Label           | Kind                        | Required | Notes                                           |
| --------------- | --------------------------- | -------- | ----------------------------------------------- |
| Full name       | `text` (200)                | yes      |                                                 |
| Work email      | `text` (254)                | yes      | Unique key.                                     |
| Job title       | `text` (200)                | no       |                                                 |
| Department      | `single-select`             | no       | Use the departments the person named.           |
| Employment type | `single-select`             | no       | Full-time, Part-time, Contractor, Intern        |
| Status          | `single-select`             | yes      | Onboarding, Active, On leave, Offboarding, Left |
| Location        | `single-select`             | no       | Office cities, or Remote.                       |
| Start date      | `date`                      | no       |                                                 |
| End date        | `date`                      | no       | Fill in when the person leaves.                 |
| Manager         | `relationship` to Employees | no       | Only when the person asks for reporting lines.  |

## Time off

When the person also wants to track leave, add **Time off requests** as a second table. Each request belongs to one employee, and one employee has many requests, so link to Employees instead of copying the name.

Create **Employees** first, then **Time off requests** with `dependsOn` set to the Employees table ID.

**Time off requests**

| Label      | Kind                             | Required | Notes                                     |
| ---------- | -------------------------------- | -------- | ----------------------------------------- |
| Employee   | `relationship` to Employees      | yes      | Many requests to one employee.            |
| Type       | `single-select`                  | yes      | Vacation, Sick, Parental, Unpaid, Other   |
| Start date | `date`                           | yes      |                                           |
| End date   | `date`                           | yes      |                                           |
| Days       | `numeric` (precision 4, scale 1) | no       | Working days requested. Allows half days. |
| Status     | `single-select`                  | yes      | Requested, Approved, Declined, Canceled   |
| Approver   | `text` (120)                     | no       |                                           |
| Note       | `text` (1000)                    | no       |                                           |

Days is entered, not computed. Working days depend on weekends and holidays, which the table cannot know.

## Onboarding checklist

When the person wants onboarding tasks, add an **Onboarding tasks** child table (Task, Employee relationship, Owner, Due date, Done `boolean`). Do not add numbered task fields to Employees.

## Sensitive data

Do not add fields for salary, bank details, government ID numbers, home address, or health information unless the person asks for them. Many people can see a table, and these values need tighter control. When the person asks, suggest a separate table that a smaller team owns.

## Defaults to name on the card

- The status list and the departments.
- Work email as the unique key.
- Whether Manager links to Employees or is plain text.
