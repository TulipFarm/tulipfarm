# Example: customer support and feedback

Use this pattern when someone wants to collect customer feedback, feature requests, or support conversations, the way Zendesk, Intercom, or Canny do.

## Feedback only, one table

When the person only wants a feedback log, keep the customer on the row:

**Feedback**

| Label          | Kind            | Required | Notes                                             |
| -------------- | --------------- | -------- | ------------------------------------------------- |
| Summary        | `text` (200)    | yes      |                                                   |
| Details        | `text` (10000)  | no       | The customer's words.                             |
| Customer email | `text` (254)    | no       |                                                   |
| Channel        | `single-select` | no       | Email, Chat, Call, Survey, Social, Sales          |
| Type           | `single-select` | yes      | Bug, Feature request, Question, Praise, Complaint |
| Product area   | `multi-select`  | no       | Use the areas the person named.                   |
| Sentiment      | `single-select` | no       | Positive, Neutral, Negative                       |
| Status         | `single-select` | yes      | New, Reviewed, Planned, Done, Won't do            |
| Received at    | `timestamp`     | no       | UTC.                                              |

## Customers and feedback, two tables

When the person also tracks details about each customer, such as company and plan, or wants to see all feedback from one customer, split customers into their own table.

Create **Customers** first, then **Feedback** with `dependsOn` set to the Customers table ID. Replace Customer email on Feedback with a Customer relationship.

**Customers**

| Label   | Kind            | Required | Notes                  |
| ------- | --------------- | -------- | ---------------------- |
| Name    | `text` (200)    | yes      |                        |
| Email   | `text` (254)    | yes      | Unique key.            |
| Company | `text` (200)    | no       |                        |
| Plan    | `single-select` | no       | Free, Pro, Enterprise  |
| Status  | `single-select` | no       | Trial, Active, Churned |

**Feedback** gets one changed field:

| Label    | Kind                        | Required | Notes                                                                             |
| -------- | --------------------------- | -------- | --------------------------------------------------------------------------------- |
| Customer | `relationship` to Customers | no       | Many feedback rows to one customer. Optional, because some feedback is anonymous. |

## Variations

- **Support tickets:** use the ticket pattern in `references/example-ticket-management.md` and add Channel and Customer.
- **Survey scores:** add Rating as `numeric` (precision 2, scale 0) and say the scale, such as 0 to 10 for NPS.
- **Many requests for one feature:** add a **Feature requests** table (Title, Status, Product area) and a Feature request relationship on Feedback. Do not store a vote count; it goes stale.

## Defaults to name on the card

- The type, channel, and status lists.
- Whether customers get their own table.
