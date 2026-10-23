import type { OfficeGrammar } from './office.js';
import type { XmlElement } from './xml.js';

const textBoxUri = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
function* descendants(node: XmlElement): Generator<XmlElement> {
  for (const child of node.children) {
    yield child;
    yield* descendants(child);
  }
}
/** Text boxes keep the strict grammar; pictures, charts, diagrams and other drawings become media or gaps. */
const isMediaDrawing = (node: XmlElement) =>
  ![...descendants(node)].some(
    child =>
      child.name === 'http://schemas.openxmlformats.org/drawingml/2006/main|graphicData' &&
      child.attributes.get('|uri') === textBoxUri,
  );

const integer = /^\d{1,8}$/;
const boolean = /^(?:true|false|0|1|on|off)$/;
const string = /^\S(?:[^\r\n]*\S)?$/;
const noteId = /^[1-9]\d{0,8}$/;
/** Word's separator and continuation-separator notes use ids -1 and 0; normal notes are positive. */
const separatorId = /^(?:-1|0|[1-9]\d{0,8})$/;
const noteType = /^(?:normal|separator|continuationSeparator|continuationNotice)$/;
const level = /^[0-8]$/;
const anyValue = /^[^\r\n]*$/;
/** Layout and typography that AnyDoc does not render and that cannot carry text. */
const paragraphLayout =
  'w:rPr w:widowControl w:contextualSpacing w:shd w:pBdr w:tabs w:suppressAutoHyphens w:snapToGrid w:adjustRightInd w:autoSpaceDE w:autoSpaceDN w:textAlignment w:outlineLvl w:suppressLineNumbers w:mirrorIndents w:wordWrap w:overflowPunct w:topLinePunct w:kinsoku w:cnfStyle w:divId w:bidi w:textDirection w:framePr w:suppressOverlap w:sectPr w:spacing w:ind w:jc w:keepNext w:keepLines w:pageBreakBefore';
/** Position markers for bookmarks, comments, moves, proofing and permissions; none holds text. */
const markers =
  'w:bookmarkStart w:bookmarkEnd w:proofErr w:permStart w:permEnd w:commentRangeStart w:commentRangeEnd w:moveFromRangeStart w:moveFromRangeEnd w:moveToRangeStart w:moveToRangeEnd w:customXmlInsRangeStart w:customXmlInsRangeEnd w:customXmlDelRangeStart w:customXmlDelRangeEnd';
/** Run containers: inserted and moved text, content controls and simple fields are unwrapped; deletions are dropped. */
const runContent =
  'w:r w:hyperlink w:sdt w:ins w:del w:moveFrom w:moveTo w:fldSimple w:smartTag w:customXml w:dir w:bdo';
/** An imported chunk (`w:altChunk`) holds another document AnyDoc cannot read; extraction records it as a gap. */
const blockContent = 'w:p w:tbl w:sdt w:altChunk';
const revision = { 'w:id': integer, 'w:author': anyValue, 'w:date': anyValue };
const runTypography =
  'w:rFonts w:szCs w:bCs w:iCs w:lang w:kern w:w w:spacing w:noProof w:shd w:rStyle w:sz w:color w:highlight w:effect w:emboss w:imprint w:outline w:shadow w:eastAsianLayout w:fitText w:snapToGrid w:caps w:smallCaps w:bdr w:em w:specVanish';

export const wordGrammar: OfficeGrammar = {
  'w:document': { children: 'w:body', required: 'w:body', ignored: 'w:background' },
  'w:body': { children: `${blockContent} w:sectPr`, repeated: blockContent, ignored: markers },
  'w:hdr': { children: blockContent, repeated: blockContent, ignored: markers },
  'w:ftr': { children: blockContent, repeated: blockContent, ignored: markers },
  'w:comments': { children: 'w:comment', repeated: 'w:comment' },
  'w:comment': {
    children: blockContent,
    repeated: blockContent,
    ignored: markers,
    attributes: { ...revision, 'w:initials': anyValue },
    requiredAttributes: 'w:id',
  },
  // Content controls, such as a table of contents, a date picker or a checkbox, show their content as typed.
  'w:sdt': { children: 'w:sdtPr w:sdtEndPr w:sdtContent', required: 'w:sdtContent', wrapper: true },
  'w:sdtPr': { children: '', opaque: true },
  'w:sdtEndPr': { children: '', opaque: true },
  'w:sdtContent': { children: '', transparent: true },
  // Tracked changes read as the current text: insertions and moved-in text stay, deletions and moved-out text go.
  'w:ins': { children: '', transparent: true, attributes: revision },
  'w:moveTo': { children: '', transparent: true, attributes: { ...revision, 'w:name': anyValue } },
  'w:del': { children: '', opaque: true },
  'w:moveFrom': { children: '', opaque: true },
  // Right-to-left embedding and override wrappers read as their text, in stored order.
  'w:dir': { children: '', transparent: true, attributes: { 'w:val': /^(?:rtl|ltr)$/ }, requiredAttributes: 'w:val' },
  'w:bdo': { children: '', transparent: true, attributes: { 'w:val': /^(?:rtl|ltr)$/ }, requiredAttributes: 'w:val' },
  'w:altChunk': { children: '', ignored: 'w:altChunkPr', attributes: { 'r:id': string }, requiredAttributes: 'r:id' },
  'w:smartTag': { children: '', transparent: true, ignored: 'w:smartTagPr', ignoredAttributes: /^w:(?:uri|element)$/ },
  'w:customXml': {
    children: '',
    transparent: true,
    ignored: 'w:customXmlPr',
    ignoredAttributes: /^w:(?:uri|element)$/,
  },
  // A field reads as its cached result; its instruction is never text.
  'w:fldSimple': {
    children: '',
    transparent: true,
    attributes: { 'w:instr': anyValue, 'w:fldLock': boolean, 'w:dirty': boolean },
  },
  'w:fldChar': {
    children: 'w:ffData w:fldData',
    ignored: 'w:numberingChange',
    attributes: { 'w:fldCharType': /^(?:begin|separate|end)$/, 'w:fldLock': boolean, 'w:dirty': boolean },
    requiredAttributes: 'w:fldCharType',
  },
  'w:ffData': { children: '', opaque: true },
  'w:fldData': { children: '', opaque: true },
  'w:instrText': { children: '', text: true, attributes: { 'xml:space': /^(?:preserve|default)$/ } },
  'w:commentReference': { children: '', attributes: { 'w:id': integer }, requiredAttributes: 'w:id' },
  'w:annotationRef': { children: '' },
  'w:ptab': { children: '', ignoredAttributes: /^w:(?:relativeTo|alignment|leader)$/ },
  'w:sectPr': { children: '', ignored: '*', ignoredAttributes: /^w:rsid/ },
  'w:p': { children: `w:pPr ${runContent}`, repeated: runContent, ignored: markers },
  'w:pPr': { children: 'w:pStyle w:numPr', ignored: `${paragraphLayout} w:pPrChange` },
  'w:pStyle': { children: '', attributes: { 'w:val': /^\S{1,253}$/ }, requiredAttributes: 'w:val' },
  'w:r': {
    ignored: 'w:lastRenderedPageBreak',
    children:
      'w:rPr w:t w:br w:tab w:ptab w:sym w:noBreakHyphen w:softHyphen w:footnoteReference w:endnoteReference w:footnoteRef w:endnoteRef w:separator w:continuationSeparator w:drawing w:pict w:object mc:AlternateContent w:fldChar w:instrText w:commentReference w:annotationRef',
    repeated:
      'w:t w:br w:tab w:ptab w:sym w:noBreakHyphen w:softHyphen w:footnoteReference w:endnoteReference w:drawing w:pict w:object mc:AlternateContent w:instrText',
  },
  'w:pict': { children: '', opaque: true },
  'w:object': { children: '', opaque: true },
  'mc:AlternateContent': { children: '', opaque: true },
  // Underline, right-to-left and raised or lowered text read as plain text; hidden text is skipped and recorded as a gap.
  'w:rPr': {
    children: 'w:b w:i w:strike w:dstrike w:rtl w:cs w:u w:vertAlign w:position w:vanish',
    ignored: `${runTypography} w:webHidden w:rPrChange w:ins w:del`,
  },
  'w:vanish': { children: '', attributes: { 'w:val': boolean } },
  'w:rtl': { children: '', attributes: { 'w:val': boolean } },
  'w:cs': { children: '', attributes: { 'w:val': boolean } },
  'w:u': { children: '', attributes: { 'w:val': /^[A-Za-z]+$/ }, ignoredAttributes: /^w:(?:color|theme[A-Za-z]+)$/ },
  'w:vertAlign': {
    children: '',
    attributes: { 'w:val': /^(?:baseline|superscript|subscript)$/ },
    requiredAttributes: 'w:val',
  },
  'w:position': { children: '', attributes: { 'w:val': /^-?\d{1,8}$/ }, requiredAttributes: 'w:val' },
  'w:t': { children: '', text: true, attributes: { 'xml:space': /^(?:preserve|default)$/ } },
  // A symbol reads as its character; a non-breaking hyphen as `-`; an optional hyphen as nothing.
  'w:sym': {
    children: '',
    attributes: { 'w:font': string, 'w:char': /^[0-9A-Fa-f]{1,4}$/ },
    requiredAttributes: 'w:char',
  },
  'w:noBreakHyphen': { children: '' },
  'w:softHyphen': { children: '' },
  'w:br': { children: '', attributes: { 'w:type': /^(?:textWrapping|page|column)$/ } },
  'w:tab': { children: '' },
  // A link to a bookmark in the document reads as its text.
  'w:hyperlink': {
    children: runContent,
    repeated: runContent,
    required: 'w:r',
    ignored: markers,
    attributes: { 'r:id': string, 'w:anchor': anyValue },
    ignoredAttributes: /^w:(?:history|tooltip|tgtFrame|docLocation)$/,
  },
  'w:footnotes': { children: 'w:footnote', repeated: 'w:footnote' },
  'w:endnotes': { children: 'w:endnote', repeated: 'w:endnote' },
  'w:footnote': {
    children: blockContent,
    repeated: blockContent,
    ignored: markers,
    attributes: { 'w:id': separatorId, 'w:type': noteType },
    requiredAttributes: 'w:id',
  },
  'w:endnote': {
    children: blockContent,
    repeated: blockContent,
    ignored: markers,
    attributes: { 'w:id': separatorId, 'w:type': noteType },
    requiredAttributes: 'w:id',
  },
  'w:footnoteReference': { children: '', attributes: { 'w:id': noteId }, requiredAttributes: 'w:id' },
  'w:endnoteReference': { children: '', attributes: { 'w:id': noteId }, requiredAttributes: 'w:id' },
  'w:footnoteRef': { children: '' },
  'w:endnoteRef': { children: '' },
  'w:separator': { children: '' },
  'w:continuationSeparator': { children: '' },
  'w:tbl': { children: 'w:tblPr w:tblGrid w:tr w:sdt', repeated: 'w:tr w:sdt', required: 'w:tr', ignored: markers },
  'w:tblPr': {
    children: '',
    ignored:
      'w:tblW w:jc w:tblStyle w:tblLook w:tblLayout w:tblBorders w:tblCellMar w:tblInd w:tblCellSpacing w:shd w:tblStyleRowBandSize w:tblStyleColBandSize w:tblCaption w:tblDescription w:bidiVisual w:tblOverlap w:tblpPr w:tblPrChange',
  },
  'w:tblGrid': { children: 'w:gridCol', repeated: 'w:gridCol', ignored: 'w:tblGridChange' },
  'w:gridCol': { children: '', attributes: { 'w:w': integer } },
  'w:tr': {
    children: 'w:tblPrEx w:trPr w:tc w:sdt',
    repeated: 'w:tc w:sdt',
    required: 'w:tc',
    ignored: markers,
  },
  'w:tblPrEx': { children: '', ignored: '*' },
  // A deleted row is removed before conversion; an inserted row is current text.
  'w:trPr': {
    children: 'w:tblHeader w:del',
    ignored:
      'w:trHeight w:cantSplit w:jc w:cnfStyle w:tblCellSpacing w:ins w:trPrChange w:gridBefore w:gridAfter w:wBefore w:wAfter w:hidden',
  },
  'w:tblHeader': { children: '' },
  'w:tc': { children: 'w:tcPr w:p w:sdt', repeated: 'w:p w:sdt', required: 'w:p', ignored: markers },
  // AnyDoc keeps a merged cell's content in its first cell and leaves the cells it covers empty.
  'w:tcPr': {
    children: '',
    ignored:
      'w:tcW w:tcBorders w:shd w:vAlign w:noWrap w:tcMar w:hideMark w:cnfStyle w:textDirection w:tcFitText w:gridSpan w:vMerge w:hMerge w:tcPrChange w:cellIns w:cellDel',
  },
  // AnyDoc renders false toggles as plain text and true bold, italic and single or double strike as Markdown emphasis.
  'w:b': { children: '', attributes: { 'w:val': boolean } },
  'w:i': { children: '', attributes: { 'w:val': boolean } },
  'w:strike': { children: '', attributes: { 'w:val': boolean } },
  'w:dstrike': { children: '', attributes: { 'w:val': boolean } },
  'w:numPr': { children: 'w:ilvl w:numId', required: 'w:ilvl w:numId', ignored: 'w:ins w:numberingChange' },
  'w:ilvl': { children: '', attributes: { 'w:val': level }, requiredAttributes: 'w:val' },
  'w:numId': { children: '', attributes: { 'w:val': noteId }, requiredAttributes: 'w:val' },
  'w:numbering': {
    children: 'w:abstractNum w:num',
    repeated: 'w:abstractNum w:num',
    ignored: 'w:numPicBullet w:numIdMacAtCleanup',
  },
  'w:abstractNum': {
    children: 'w:multiLevelType w:lvl',
    repeated: 'w:lvl',
    required: 'w:lvl',
    ignored: 'w:nsid w:tmpl w:name',
    attributes: { 'w:abstractNumId': integer },
    requiredAttributes: 'w:abstractNumId',
  },
  'w:multiLevelType': {
    children: '',
    attributes: { 'w:val': /^(?:singleLevel|multilevel|hybridMultilevel)$/ },
    requiredAttributes: 'w:val',
  },
  'w:lvl': {
    children: 'w:start w:numFmt w:lvlText w:lvlJc',
    required: 'w:numFmt w:lvlText',
    ignored: 'w:pPr w:rPr w:suff w:lvlRestart',
    attributes: { 'w:ilvl': level, 'w:tentative': boolean, 'w:tplc': /^[0-9A-Fa-f]{8}$/ },
    requiredAttributes: 'w:ilvl',
  },
  'w:start': { children: '', attributes: { 'w:val': integer }, requiredAttributes: 'w:val' },
  'w:numFmt': {
    children: '',
    attributes: { 'w:val': /^(?:decimal|bullet|lowerLetter|upperLetter|lowerRoman|upperRoman|decimalZero)$/ },
    requiredAttributes: 'w:val',
  },
  'w:lvlText': { children: '', attributes: { 'w:val': anyValue }, requiredAttributes: 'w:val' },
  'w:lvlJc': { children: '', attributes: { 'w:val': /^(?:left|right|center|start|end)$/ } },
  'w:num': {
    children: 'w:abstractNumId w:lvlOverride',
    repeated: 'w:lvlOverride',
    required: 'w:abstractNumId',
    attributes: { 'w:numId': noteId },
    requiredAttributes: 'w:numId',
  },
  'w:lvlOverride': {
    children: 'w:startOverride',
    attributes: { 'w:ilvl': level },
    requiredAttributes: 'w:ilvl',
  },
  'w:startOverride': { children: '', attributes: { 'w:val': integer }, requiredAttributes: 'w:val' },
  'w:abstractNumId': { children: '', attributes: { 'w:val': integer }, requiredAttributes: 'w:val' },
  'w:drawing': { children: 'wp:inline', required: 'wp:inline', opaque: isMediaDrawing },
  'wp:inline': { children: 'wp:extent wp:docPr a:graphic', required: 'wp:extent wp:docPr a:graphic' },
  'wp:extent': { children: '', attributes: { cx: integer, cy: integer }, requiredAttributes: 'cx cy' },
  'wp:docPr': { children: '', attributes: { id: integer, name: string }, requiredAttributes: 'id name' },
  'a:graphic': { children: 'a:graphicData', required: 'a:graphicData' },
  'a:graphicData': {
    children: 'wps:wsp',
    required: 'wps:wsp',
    attributes: { uri: /^http:\/\/schemas.microsoft.com\/office\/word\/2010\/wordprocessingShape$/ },
    requiredAttributes: 'uri',
  },
  'wps:wsp': { children: 'wps:cNvSpPr wps:spPr wps:txbx wps:bodyPr', required: 'wps:txbx' },
  'wps:cNvSpPr': { children: '', attributes: { txBox: /^1$/ } },
  'wps:spPr': { children: 'a:xfrm a:prstGeom' },
  'a:xfrm': { children: 'a:off a:ext' },
  'a:off': { children: '', attributes: { x: integer, y: integer } },
  'a:ext': { children: '', attributes: { cx: integer, cy: integer } },
  'a:prstGeom': { children: 'a:avLst', attributes: { prst: /^rect$/ } },
  'a:avLst': { children: '' },
  'wps:txbx': { children: 'w:txbxContent', required: 'w:txbxContent' },
  'w:txbxContent': { children: blockContent, repeated: blockContent, ignored: markers },
  'wps:bodyPr': { children: '' },
};
