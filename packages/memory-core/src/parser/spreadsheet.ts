import type { OfficeGrammar } from './office.js';

const integer = /^\d{1,8}$/;
const boolean = /^(?:0|1|true|false)$/;
const cell = /^[A-Z]{1,3}[1-9]\d{0,6}$/;
const string = /^\S(?:[^\r\n]*\S)?$/;
const numberFormat = /^(?:0|1|2|3|4|9|10|14|164)$/;

export const spreadsheetGrammar: OfficeGrammar = {
  's:workbook': { children: 's:workbookPr s:bookViews s:sheets s:calcPr', required: 's:sheets' },
  's:workbookPr': { children: '', attributes: { date1904: /^(?:0|false)$/ } },
  's:bookViews': { children: 's:workbookView', repeated: 's:workbookView' },
  's:workbookView': {
    children: '',
    attributes: {
      activeTab: integer,
      firstSheet: integer,
      xWindow: integer,
      yWindow: integer,
      windowWidth: integer,
      windowHeight: integer,
    },
  },
  's:calcPr': { children: '', attributes: { calcId: integer, fullCalcOnLoad: boolean, forceFullCalc: boolean } },
  's:sheets': { children: 's:sheet', repeated: 's:sheet', required: 's:sheet' },
  's:sheet': {
    children: '',
    attributes: { name: string, sheetId: integer, 'r:id': string, state: /^visible$/ },
    requiredAttributes: 'name sheetId r:id',
  },
  's:worksheet': {
    children: 's:dimension s:sheetViews s:sheetFormatPr s:cols s:sheetData s:pageMargins',
    required: 's:sheetData',
  },
  's:dimension': { children: '', attributes: { ref: /^[A-Z]{1,3}[1-9]\d{0,6}(?::[A-Z]{1,3}[1-9]\d{0,6})?$/ } },
  's:sheetViews': { children: 's:sheetView', repeated: 's:sheetView' },
  's:sheetView': {
    children: 's:selection',
    repeated: 's:selection',
    attributes: { workbookViewId: integer, tabSelected: boolean, showGridLines: boolean, zoomScale: integer },
  },
  's:selection': { children: '', attributes: { activeCell: cell, sqref: string } },
  's:sheetFormatPr': { children: '', attributes: { defaultRowHeight: /^\d+(?:\.\d+)?$/, baseColWidth: integer } },
  's:cols': { children: 's:col', repeated: 's:col' },
  's:col': {
    children: '',
    attributes: { min: integer, max: integer, width: /^\d+(?:\.\d+)?$/, customWidth: boolean, bestFit: boolean },
  },
  's:sheetData': { children: 's:row', repeated: 's:row' },
  's:row': {
    children: 's:c',
    repeated: 's:c',
    attributes: { r: integer, spans: /^\d+:\d+$/, ht: /^\d+(?:\.\d+)?$/, customHeight: boolean },
  },
  's:c': { children: 's:f s:v s:is', attributes: { r: cell, s: integer, t: /^(?:n|b|s|str|inlineStr)$/ } },
  's:f': { children: '', text: true },
  's:v': { children: '', text: true },
  's:is': { children: 's:t s:r', repeated: 's:r' },
  's:sst': { children: 's:si', repeated: 's:si', attributes: { count: integer, uniqueCount: integer } },
  's:si': { children: 's:t s:r', repeated: 's:r' },
  's:r': { children: 's:rPr s:t', required: 's:t' },
  's:rPr': { children: '' },
  's:t': { children: '', text: true, attributes: { 'xml:space': /^(?:preserve|default)$/ } },
  's:pageMargins': {
    children: '',
    attributes: Object.fromEntries(
      ['left', 'right', 'top', 'bottom', 'header', 'footer'].map(name => [name, /^\d+(?:\.\d+)?$/]),
    ),
  },
  's:styleSheet': { children: 's:numFmts s:fonts s:fills s:borders s:cellStyleXfs s:cellXfs s:cellStyles' },
  's:numFmts': { children: 's:numFmt', repeated: 's:numFmt', attributes: { count: integer } },
  's:numFmt': {
    children: '',
    attributes: { numFmtId: /^164$/, formatCode: /^(?:0%|yyyy-mm-dd|#,##0;\(#,##0\))$/ },
    requiredAttributes: 'numFmtId formatCode',
  },
  's:fonts': { children: 's:font', repeated: 's:font', attributes: { count: integer } },
  's:font': { children: 's:sz s:name s:family s:charset s:scheme s:color' },
  's:sz': { children: '', attributes: { val: /^\d+(?:\.\d+)?$/ } },
  's:name': { children: '', attributes: { val: string } },
  's:family': { children: '', attributes: { val: /^[0-5]$/ } },
  's:charset': { children: '', attributes: { val: /^0$/ } },
  's:scheme': { children: '', attributes: { val: /^(?:major|minor|none)$/ } },
  's:color': { children: '', attributes: { rgb: /^[0-9a-fA-F]{8}$/, indexed: integer, theme: integer, auto: boolean } },
  's:fills': { children: 's:fill', repeated: 's:fill', attributes: { count: integer } },
  's:fill': { children: 's:patternFill' },
  's:patternFill': { children: '', attributes: { patternType: /^(?:none|gray125)$/ } },
  's:borders': { children: 's:border', repeated: 's:border', attributes: { count: integer } },
  's:border': { children: 's:left s:right s:top s:bottom s:diagonal' },
  's:left': { children: '' },
  's:right': { children: '' },
  's:top': { children: '' },
  's:bottom': { children: '' },
  's:diagonal': { children: '' },
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
  },
  's:cellStyles': { children: 's:cellStyle', repeated: 's:cellStyle', attributes: { count: integer } },
  's:cellStyle': { children: '', attributes: { name: /^Normal$/, xfId: /^0$/, builtinId: /^0$/ } },
};
