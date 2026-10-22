# Workbook spec

`content` is a JSON string with this shape. Unknown properties are rejected.

```json
{
  "theme": "default",
  "accentColor": "#2563EB",
  "sheets": [
    {
      "name": "Budget",
      "columns": [
        { "header": "Item", "width": 30 },
        { "header": "Cost", "format": "$#,##0.00" }
      ],
      "rows": [],
      "freezeHeader": true,
      "filter": false,
      "bandedRows": false
    }
  ]
}
```

`theme` is one of `default`, `modern`, `classic`, `bold`, or `minimal`; it sets the fonts and the header and band colours. `accentColor` replaces the header colour.

## Sheets

- `name`: 1–31 characters, without `\ / ? * [ ] :`. Each name must be unique.
- `columns`: optional. When present, row 1 is a styled header row and your `rows` start at row 2. `width` is in characters. `format` is the default number format for the column.
- `rows`: an array of rows; each row is an array of cells, left to right from column A.
- `merges`: A1 ranges to merge, such as `["A1:D1"]`. The top-left cell keeps the value.
- `dropdowns`: `[{"range": "C2:C200", "options": ["Open", "Done"]}]` limits the cells to a list. Options cannot contain commas or quotes.
- `freezeHeader` (default `true`) keeps the header visible while scrolling. `filter` adds filter buttons to the header. `bandedRows` tints every second data row.

## Cells

A cell is a string, number, boolean, `null` (empty), or an object:

```json
{ "formula": "=SUM(B2:B10)", "format": "$#,##0.00", "bold": true, "color": "#B91C1C", "fill": "#FEF3C7" }
```

Use one of `value`, `formula`, or `date` in an object, plus any styling. `link` makes the cell a hyperlink (the cell shows `value`, or the URL). `note` adds a hover comment.

- `formula` starts with `=`. Use A1 references and English function names separated by commas: `=IF(C2>0,"Paid","Due")`, `=VLOOKUP(A2,Prices!A:B,2,FALSE)`, `=SUMIFS(D:D,B:B,"North")`. Reference another sheet as `'Sheet name'!A1`.
- `date` is `YYYY-MM-DD`; it is stored as a real date, so date formulas work. The default format is `yyyy-mm-dd`.
- `format` is an Excel number format: `0`, `0.00`, `#,##0`, `$#,##0.00`, `0%`, `0.0%`, `yyyy-mm-dd`, `d mmm yyyy`, `[h]:mm`.
- Store numbers as numbers, not strings, so sums and sorting work.

Remember the header: with `columns`, the first data row is row 2, so a total under five data rows is `=SUM(B2:B6)` in row 7.

## Example

```json
{
  "theme": "modern",
  "sheets": [
    {
      "name": "Expenses",
      "filter": true,
      "bandedRows": true,
      "columns": [
        { "header": "Date" },
        { "header": "Category", "width": 18 },
        { "header": "Amount", "format": "$#,##0.00" }
      ],
      "rows": [
        [{ "date": "2026-10-01" }, "Travel", 420],
        [{ "date": "2026-10-03" }, "Software", 99.5],
        [{ "date": "2026-10-07" }, "Travel", 180],
        [null, { "value": "Total", "bold": true }, { "formula": "=SUM(C2:C4)", "bold": true }]
      ]
    },
    {
      "name": "Summary",
      "columns": [
        { "header": "Category", "width": 18 },
        { "header": "Total", "format": "$#,##0.00" },
        { "header": "Share", "format": "0.0%" }
      ],
      "rows": [
        ["Travel", { "formula": "=SUMIFS(Expenses!C:C,Expenses!B:B,A2)" }, { "formula": "=B2/SUM(B$2:B$3)" }],
        ["Software", { "formula": "=SUMIFS(Expenses!C:C,Expenses!B:B,A3)" }, { "formula": "=B3/SUM(B$2:B$3)" }]
      ]
    }
  ]
}
```

## Pitfalls

- TulipFarm does not calculate formulas. The file asks Excel, Google Sheets, or LibreOffice to calculate them when it opens, so do not promise a computed number in chat; describe the formula.
- An off-by-one row reference is the most common error. Count the header row.
- Text that looks like a number (`"0042"`, phone numbers) must stay a string to keep leading zeros.
- Sheet names in formulas need quotes when they contain spaces: `'Q3 Sales'!B2`.
- A merged range keeps only the top-left value; put the value there.

Charts, pivot tables, conditional formatting, and sheet protection are not supported. Put chart data in a sheet; the person can insert a chart from it in one step.
