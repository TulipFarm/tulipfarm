# Presentation spec

`content` is a JSON string with this shape. Unknown properties are rejected.

```json
{
  "theme": "default",
  "accentColor": "#2563EB",
  "aspectRatio": "16:9",
  "slideNumbers": true,
  "footer": "Acme · Confidential",
  "slides": []
}
```

`slideNumbers` shows the slide number and `footer` shows a short line of text on every slide except title slides.

`theme` is one of `default`, `modern`, `classic`, `bold`, or `minimal`; it sets fonts, the accent colour, and the background. `aspectRatio` is `16:9` or `4:3`. A deck has 1–200 slides.

## Slides

| `layout`            | Properties               | Use                                              |
| ------------------- | ------------------------ | ------------------------------------------------ |
| `title`             | `title`, `subtitle`      | The first slide. Centred.                        |
| `section`           | `title`, `subtitle`      | A divider between parts. Full accent background. |
| `content` (default) | `title`, `content`       | One column of blocks.                            |
| `two-column`        | `title`, `left`, `right` | Comparisons, before and after, pros and cons.    |

Every slide can have `notes` (speaker notes as plain text) and `background` (`#RRGGBB`).

## Blocks

`content`, `left`, and `right` are arrays of blocks:

- `{"type": "paragraph", "text": ..., "align": "left" | "center" | "right" | "justify"}`
- `{"type": "list", "ordered": false, "items": [...]}`: each item is text, or `{"text": ..., "items": [...]}` for a nested level.
- `{"type": "table", "header": [...], "rows": [[...]]}`: the header row uses the accent colour.
- `{"type": "chart", "kind": "column", "title": "Revenue", "categories": ["Q1", "Q2"], "series": [{"name": "2026", "values": [120, 150]}]}`: `kind` is `column`, `bar` (horizontal), `line`, `pie`, or `doughnut`. Each series needs one number per category. Use one series for a pie.

Text is a string or an array of runs, such as `["Revenue ", {"text": "+12%", "bold": true, "color": "#15803D"}]`. A run can set `bold`, `italic`, `underline`, `strike`, `code`, `color`, and `link`.

Blocks on a slide share its height equally, so keep a slide to one or two blocks. Keep lists to about six short items and tables to about eight rows; split longer content across slides.

## Example

```json
{
  "theme": "bold",
  "slides": [
    { "layout": "title", "title": "Q4 launch plan", "subtitle": "Product team · October 2026" },
    {
      "title": "Goals",
      "content": [
        {
          "type": "list",
          "items": [
            "Ship the mobile app",
            { "text": "Grow paid accounts", "items": ["+20% in North America", "+35% in Europe"] },
            "Cut onboarding time in half"
          ]
        }
      ],
      "notes": "Start with why these three goals matter."
    },
    { "layout": "section", "title": "Timeline" },
    {
      "title": "Pipeline",
      "content": [
        {
          "type": "chart",
          "kind": "column",
          "title": "Signed deals",
          "categories": ["Jul", "Aug", "Sep"],
          "series": [{ "name": "2026", "values": [12, 18, 23] }]
        }
      ]
    },
    {
      "title": "Milestones",
      "content": [
        {
          "type": "table",
          "header": ["Date", "Milestone", "Owner"],
          "rows": [
            ["Oct 20", "Beta", "Priya"],
            ["Nov 15", "Launch", "Sam"]
          ]
        }
      ]
    },
    {
      "layout": "two-column",
      "title": "Risks",
      "left": [
        { "type": "paragraph", "text": [{ "text": "Risk", "bold": true }] },
        { "type": "list", "items": ["App review delay"] }
      ],
      "right": [
        { "type": "paragraph", "text": [{ "text": "Plan", "bold": true }] },
        { "type": "list", "items": ["Submit two weeks early"] }
      ]
    }
  ]
}
```

## Pitfalls

- Text does not shrink to fit. A long list or table overflows the slide; split it.
- Keep a dark `background` only with light text colours in runs; the theme text colour is dark.
- Charts become native, editable charts in PowerPoint and Google Slides.

Images, animations, transitions, and custom slide masters are not supported.
