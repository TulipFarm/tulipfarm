import type { OfficeGrammar } from './office.js';

const integer = /^\d{1,8}$/;
const boolean = /^(?:0|1|true|false)$/;
const cell = /^[A-Z]{1,3}[1-9]\d{0,6}$/;
const string = /^\S(?:[^\r\n]*\S)?$/;
const anyValue = /^[^\r\n]*$/;
/** Custom formats (164 and above), which the styles part defines. */
const customFormat = /^(?:16[4-9]|1[7-9]\d|[2-9]\d{2}|\d{4,5})$/;
/** Built-in formats AnyDoc renders faithfully, and custom formats. */
const numberFormat = /^(?:0|1|2|3|4|9|10|14|16[4-9]|1[7-9]\d|[2-9]\d{2}|\d{4,5})$/;
const unprefixed = /^[A-Za-z0-9]+$/;
const decimal = /^\d+(?:\.\d+)?$/;
/** Worksheet settings that AnyDoc does not render and that cannot carry cell text. */
const sheetSettings =
  's:sheetPr s:sheetCalcPr s:sheetProtection s:protectedRanges s:autoFilter s:sortState s:customSheetViews s:mergeCells s:phoneticPr s:hyperlinks s:printOptions s:pageSetup s:rowBreaks s:colBreaks s:ignoredErrors s:picture s:tableParts s:extLst mc:AlternateContent';

export const spreadsheetGrammar: OfficeGrammar = {
  's:workbook': {
    children: 's:workbookPr s:bookViews s:sheets s:definedNames s:calcPr',
    required: 's:sheets',
    ignored:
      's:fileVersion s:fileSharing s:fileRecoveryPr s:workbookProtection s:smartTagPr s:extLst mc:AlternateContent',
  },
  // AnyDoc converts date serials in the 1904 date system too.
  's:workbookPr': { children: '', ignoredAttributes: unprefixed },
  's:bookViews': { children: 's:workbookView', repeated: 's:workbookView' },
  's:workbookView': { children: '', ignored: 's:extLst', ignoredAttributes: unprefixed },
  's:calcPr': { children: '', ignoredAttributes: unprefixed },
  // Named ranges and constants are not cell values and are ignored; macro-bound names still reject.
  's:definedNames': { children: 's:definedName', repeated: 's:definedName' },
  's:definedName': {
    children: '',
    text: true,
    attributes: { name: string, localSheetId: integer, hidden: boolean },
    ignoredAttributes: /^(?:comment|description|customMenu|help|statusBar|publishToServer|workbookParameter)$/,
    requiredAttributes: 'name',
  },
  's:sheets': { children: 's:sheet', repeated: 's:sheet', required: 's:sheet' },
  's:sheet': {
    children: '',
    attributes: { name: string, sheetId: integer, 'r:id': string, state: /^(?:visible|hidden|veryHidden)$/ },
    requiredAttributes: 'name sheetId r:id',
  },
  's:worksheet': {
    children:
      's:dimension s:sheetViews s:sheetFormatPr s:cols s:sheetData s:conditionalFormatting s:dataValidations s:pageMargins s:headerFooter s:drawing',
    repeated: 's:conditionalFormatting',
    required: 's:sheetData',
    ignored: sheetSettings,
  },
  // Print headers and footers, highlight rules and input rules hold formulas and page furniture, not cell values.
  's:headerFooter': { children: '', opaque: true },
  's:conditionalFormatting': { children: '', opaque: true },
  's:dataValidations': { children: '', opaque: true },
  's:drawing': { children: '', attributes: { 'r:id': string }, requiredAttributes: 'r:id' },
  's:dimension': { children: '', attributes: { ref: /^[A-Z]{1,3}[1-9]\d{0,6}(?::[A-Z]{1,3}[1-9]\d{0,6})?$/ } },
  's:sheetViews': { children: 's:sheetView', repeated: 's:sheetView' },
  's:sheetView': {
    children: 's:selection',
    repeated: 's:selection',
    ignored: 's:pane s:pivotSelection s:extLst',
    ignoredAttributes: unprefixed,
  },
  's:selection': { children: '', ignoredAttributes: unprefixed },
  's:sheetFormatPr': { children: '', ignoredAttributes: unprefixed },
  's:cols': { children: 's:col', repeated: 's:col' },
  // AnyDoc skips hidden columns, rows and sheets; extraction records each sheet with hidden content as a gap.
  's:col': {
    children: '',
    attributes: { min: integer, max: integer, width: decimal, hidden: boolean },
    ignoredAttributes: /^(?:customWidth|bestFit|style|outlineLevel|collapsed|phonetic)$/,
  },
  's:sheetData': { children: 's:row', repeated: 's:row' },
  's:row': {
    children: 's:c',
    repeated: 's:c',
    attributes: { r: integer, spans: /^\d+:\d+$/, ht: decimal, customHeight: boolean, hidden: boolean },
    ignoredAttributes: /^(?:s|customFormat|outlineLevel|collapsed|thickTop|thickBot|ph)$/,
  },
  's:c': { children: 's:f s:v s:is', attributes: { r: cell, s: integer, t: /^(?:n|b|s|str|inlineStr)$/ } },
  // A formula, including a shared or array formula, reads as its cell's saved value.
  's:f': {
    children: '',
    text: true,
    attributes: {
      t: /^(?:normal|shared|array)$/,
      ref: /^[A-Z]{1,3}[1-9]\d{0,6}(?::[A-Z]{1,3}[1-9]\d{0,6})?$/,
      si: integer,
      ca: boolean,
      aca: boolean,
    },
  },
  's:v': { children: '', text: true },
  's:is': { children: 's:t s:r', repeated: 's:r' },
  's:sst': { children: 's:si', repeated: 's:si', attributes: { count: integer, uniqueCount: integer } },
  's:si': { children: 's:t s:r', repeated: 's:r' },
  's:r': { children: 's:rPr s:t', required: 's:t' },
  // Rich-text runs read as plain text; raised and lowered runs keep a `^` or `_` mark.
  's:rPr': {
    children:
      's:rFont s:charset s:family s:b s:i s:strike s:outline s:shadow s:condense s:extend s:color s:sz s:u s:vertAlign s:scheme',
  },
  's:rFont': { children: '', attributes: { val: string } },
  's:outline': { children: '', attributes: { val: boolean } },
  's:shadow': { children: '', attributes: { val: boolean } },
  's:condense': { children: '', attributes: { val: boolean } },
  's:extend': { children: '', attributes: { val: boolean } },
  's:t': { children: '', text: true, attributes: { 'xml:space': /^(?:preserve|default)$/ } },
  's:pageMargins': {
    children: '',
    attributes: Object.fromEntries(['left', 'right', 'top', 'bottom', 'header', 'footer'].map(name => [name, decimal])),
  },
  // Fonts are checked only where a cell uses them; differential, table and slicer styles are never applied to text.
  's:styleSheet': {
    children: 's:numFmts s:fonts s:fills s:borders s:cellStyleXfs s:cellXfs s:cellStyles',
    ignored: 's:dxfs s:tableStyles s:colors s:extLst mc:AlternateContent',
  },
  's:numFmts': { children: 's:numFmt', repeated: 's:numFmt', attributes: { count: integer } },
  // Extraction replaces custom formats AnyDoc cannot render faithfully with General, so the saved value shows.
  's:numFmt': {
    children: '',
    attributes: { numFmtId: customFormat, formatCode: anyValue },
    requiredAttributes: 'numFmtId formatCode',
  },
  's:fonts': { children: 's:font', repeated: 's:font', attributes: { count: integer } },
  's:font': { children: '', opaque: true },
  // AnyDoc prints cells as plain text, whatever the emphasis, strike, underline or raised text of their font.
  's:usedFont': {
    children: 's:sz s:name s:family s:charset s:scheme s:color s:b s:i s:strike s:u s:vertAlign',
    ignored: 's:condense s:extend s:outline s:shadow',
  },
  's:b': { children: '', attributes: { val: boolean } },
  's:strike': { children: '', attributes: { val: boolean } },
  's:u': { children: '', attributes: { val: /^(?:single|double|singleAccounting|doubleAccounting|none)$/ } },
  's:vertAlign': { children: '', attributes: { val: /^(?:baseline|superscript|subscript)$/ } },
  's:i': { children: '', attributes: { val: boolean } },
  's:sz': { children: '', attributes: { val: /^\d+(?:\.\d+)?$/ } },
  's:name': { children: '', attributes: { val: string } },
  's:family': { children: '', attributes: { val: /^[0-5]$/ } },
  's:charset': { children: '', attributes: { val: integer } },
  's:scheme': { children: '', attributes: { val: /^(?:major|minor|none)$/ } },
  's:color': {
    children: '',
    attributes: {
      rgb: /^[0-9a-fA-F]{8}$/,
      indexed: integer,
      theme: integer,
      auto: boolean,
      tint: /^-?[\d.]+(?:E-?\d+)?$/,
    },
  },
  's:fills': { children: 's:fill', repeated: 's:fill', attributes: { count: integer } },
  's:fill': { children: '', ignored: '*' },
  's:borders': { children: 's:border', repeated: 's:border', attributes: { count: integer } },
  's:border': { children: '', ignored: '*', ignoredAttributes: /^(?:diagonalUp|diagonalDown|outline)$/ },
  's:cellStyleXfs': { children: 's:xf', repeated: 's:xf', attributes: { count: integer } },
  's:cellXfs': { children: 's:xf', repeated: 's:xf', attributes: { count: integer } },
  's:xf': {
    children: '',
    attributes: {
      numFmtId: numberFormat,
      fontId: integer,
      fillId: integer,
      borderId: integer,
      xfId: integer,
      applyNumberFormat: /^1$/,
    },
    ignored: 's:alignment s:protection s:extLst',
    ignoredAttributes: /^(?:apply[A-Za-z]+|quotePrefix|pivotButton)$/,
  },
  's:cellStyles': { children: 's:cellStyle', repeated: 's:cellStyle', attributes: { count: integer } },
  's:cellStyle': {
    children: '',
    ignored: 's:extLst',
    attributes: { name: anyValue, xfId: integer, builtinId: integer },
    ignoredAttributes: /^(?:customBuiltin|iLevel|hidden)$/,
  },
};
