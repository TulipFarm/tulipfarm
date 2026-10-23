import type { OfficeGrammar } from './office.js';
import type { XmlElement } from './xml.js';

const integer = /^\d{1,10}$/;
const string = /^\S(?:[^\r\n]*\S)?$/;
const shapes = 'p:sp p:pic p:graphicFrame p:grpSp p:cxnSp p:contentPart mc:AlternateContent';
const language = /^[a-zA-Z]{2,3}(?:-[A-Za-z0-9]+)*$/;
const anyValue = /^[^\r\n]*$/;
/** Fill, outline, effect, font and link formatting that AnyDoc does not render and that cannot carry text. */
const runFormatting =
  'a:ln a:noFill a:solidFill a:gradFill a:blipFill a:pattFill a:grpFill a:effectLst a:effectDag a:highlight a:uLnTx a:uLn a:uFillTx a:uFill a:latin a:ea a:cs a:sym a:hlinkClick a:hlinkMouseOver a:rtl a:extLst';
/** AnyDoc renders bold, italic and struck runs as Markdown emphasis; underline reads as plain text. */
const runEmphasis = {
  b: /^(?:0|1|true|false)$/,
  i: /^(?:0|1|true|false)$/,
  u: /^[A-Za-z]+$/,
  strike: /^(?:noStrike|sngStrike|dblStrike)$/,
  baseline: /^-?\d{1,7}$/,
};
const runLayout = /^(?:lang|altLang|sz|kern|spc|noProof|smtClean|smtId|err|bmk|cap|dirty|kumimoji|normalizeH)$/;
/** Slide-number and date placeholders hold generated fields; the converter removes them before AnyDoc runs. */
const isAutomaticField = (node: XmlElement) =>
  node.children.some(child =>
    child.children.some(grand =>
      grand.children.some(
        value => value.name.endsWith('|ph') && /^(?:sldNum|dt)$/.test(value.attributes.get('|type') ?? ''),
      ),
    ),
  );

export const presentationGrammar: OfficeGrammar = {
  'p:presentation': {
    children: 'p:sldIdLst p:sldSz p:notesSz',
    required: 'p:sldIdLst',
    ignored:
      'p:sldMasterIdLst p:notesMasterIdLst p:handoutMasterIdLst p:defaultTextStyle p:extLst p:embeddedFontLst p:custDataLst p:kinsoku p:photoAlbum p:modifyVerifier p:custShowLst p:smartTags',
    ignoredAttributes: /^[A-Za-z]+$/,
  },
  'p:sldIdLst': { children: 'p:sldId', repeated: 'p:sldId', required: 'p:sldId' },
  'p:sldId': { children: '', attributes: { id: integer, 'r:id': string }, requiredAttributes: 'id r:id' },
  'p:sldSz': { children: '', attributes: { cx: integer, cy: integer, type: /^[A-Za-z0-9]+$/ } },
  'p:notesSz': { children: '', attributes: { cx: integer, cy: integer } },
  'p:sld': {
    children: 'p:cSld',
    required: 'p:cSld',
    ignored: 'p:clrMapOvr p:transition p:timing p:extLst mc:AlternateContent',
    ignoredAttributes: /^(?:show|showMasterSp|showMasterPhAnim)$/,
  },
  'p:cSld': {
    children: 'p:spTree',
    required: 'p:spTree',
    ignored: 'p:bg p:extLst p:custDataLst',
    attributes: { name: anyValue },
  },
  'p:notes': {
    children: 'p:cSld',
    required: 'p:cSld',
    ignored: 'p:clrMapOvr p:extLst',
    ignoredAttributes: /^(?:showMasterSp|showMasterPhAnim)$/,
  },
  'p:spTree': { children: `p:nvGrpSpPr p:grpSpPr ${shapes}`, repeated: shapes },
  'p:grpSp': { children: `p:nvGrpSpPr p:grpSpPr ${shapes}`, repeated: shapes },
  'p:pic': { children: '', opaque: true },
  'p:graphicFrame': { children: '', opaque: true },
  'p:cxnSp': { children: '', opaque: true },
  'p:contentPart': { children: '', opaque: true },
  'mc:AlternateContent': { children: '', opaque: true },
  'p:nvGrpSpPr': { children: 'p:cNvPr p:cNvGrpSpPr p:nvPr' },
  'p:cNvGrpSpPr': { children: '', ignored: '*' },
  'p:grpSpPr': { children: '', ignored: '*', ignoredAttributes: /^bwMode$/ },
  'p:sp': {
    children: 'p:nvSpPr p:spPr p:txBody',
    ignored: 'p:style p:extLst',
    ignoredAttributes: /^useBgFill$/,
    opaque: isAutomaticField,
  },
  'p:nvSpPr': { children: 'p:cNvPr p:cNvSpPr p:nvPr' },
  'p:cNvPr': {
    children: '',
    ignored: 'a:hlinkClick a:hlinkHover a:extLst',
    attributes: { id: integer, name: anyValue, descr: anyValue, title: anyValue, hidden: /^(?:0|1|true|false)$/ },
  },
  'p:cNvSpPr': { children: '', ignored: 'a:spLocks a:extLst', attributes: { txBox: /^(?:0|1)$/ } },
  'p:nvPr': { children: 'p:ph', ignored: 'p:extLst p:custDataLst', ignoredAttributes: /^(?:isPhoto|userDrawn)$/ },
  'p:ph': {
    children: '',
    ignored: 'p:extLst',
    attributes: {
      type: /^(?:title|ctrTitle|subTitle|body|obj|sldImg|ftr|hdr|chart|tbl|clipArt|dgm|media|pic)$/,
      idx: integer,
      sz: /^(?:full|half|quarter)$/,
      orient: /^(?:horz|vert)$/,
      hasCustomPrompt: /^(?:0|1|true|false)$/,
    },
  },
  'p:spPr': { children: '', ignored: '*', ignoredAttributes: /^bwMode$/ },
  'p:txBody': { children: 'a:bodyPr a:lstStyle a:p', repeated: 'a:p', required: 'a:p' },
  'a:bodyPr': { children: '', ignored: '*', ignoredAttributes: /^[A-Za-z]+$/ },
  'a:lstStyle': { children: '', ignored: '*' },
  'a:p': { children: 'a:pPr a:r a:br a:fld a:endParaRPr', repeated: 'a:r a:br a:fld' },
  'a:pPr': {
    children: 'a:defRPr',
    ignored:
      'a:lnSpc a:spcBef a:spcAft a:buClrTx a:buClr a:buSzTx a:buSzPct a:buSzPts a:buFontTx a:buFont a:buNone a:buAutoNum a:buChar a:buBlip a:tabLst a:extLst',
    attributes: { algn: /^(?:l|ctr|r|just|dist|justLow|thaiDist)$/ },
    ignoredAttributes: /^(?:marL|marR|lvl|indent|defTabSz|rtl|eaLnBrk|fontAlgn|latinLnBrk|hangingPunct)$/,
  },
  'a:r': { children: 'a:rPr a:t', required: 'a:t' },
  // A field, such as a slide number or date, reads as the text PowerPoint last saved for it.
  'a:fld': {
    children: 'a:rPr a:pPr a:t',
    attributes: { id: string, type: string },
    requiredAttributes: 'id',
  },
  // Raised and lowered runs keep a `^` or `_` mark, as in Word.
  'a:rPr': {
    children: '',
    ignored: runFormatting,
    attributes: { ...runEmphasis, lang: language },
    ignoredAttributes: runLayout,
  },
  // Paragraph defaults are not applied to the runs AnyDoc reads.
  'a:defRPr': {
    children: '',
    ignored: runFormatting,
    attributes: { ...runEmphasis, lang: language },
    ignoredAttributes: runLayout,
  },
  'a:endParaRPr': {
    children: '',
    ignored: runFormatting,
    attributes: { b: /^(?:0|1|true|false)$/, i: /^(?:0|1|true|false)$/, lang: language },
    ignoredAttributes:
      /^(?:altLang|sz|kern|spc|noProof|smtClean|smtId|err|bmk|cap|dirty|kumimoji|normalizeH|u|strike|baseline)$/,
  },
  'a:br': { children: '' },
  'a:t': { children: '', text: true, attributes: { 'xml:space': /^(?:preserve|default)$/ } },
};
