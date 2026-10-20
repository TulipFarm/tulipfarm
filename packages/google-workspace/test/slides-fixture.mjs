const themeColors = [
  'DARK1',
  'LIGHT1',
  'DARK2',
  'LIGHT2',
  'ACCENT1',
  'ACCENT2',
  'ACCENT3',
  'ACCENT4',
  'ACCENT5',
  'ACCENT6',
  'HYPERLINK',
  'FOLLOWED_HYPERLINK',
];
const layoutNames = [
  'TITLE',
  'SECTION_HEADER',
  'TITLE_AND_BODY',
  'TITLE_AND_TWO_COLUMNS',
  'TITLE_ONLY',
  'ONE_COLUMN_TEXT',
  'MAIN_POINT',
  'SECTION_TITLE_AND_DESCRIPTION',
  'CAPTION_ONLY',
  'BIG_NUMBER',
  'BLANK',
];
const placeholderTypes = ['TITLE', 'BODY', 'SUBTITLE', 'SLIDE_NUMBER', 'CENTERED_TITLE'];

const magnitude = value => ({ magnitude: value, unit: 'PT' });
const textStyle = level => ({
  backgroundColor: {},
  foregroundColor: { opaqueColor: { themeColor: 'DARK2' } },
  bold: false,
  italic: false,
  fontFamily: 'Arial',
  fontSize: magnitude(18 - level),
  link: null,
  baselineOffset: 'NONE',
  smallCaps: false,
  strikethrough: false,
  underline: false,
  weightedFontFamily: { fontFamily: 'Arial', weight: 400 },
});
const paragraphStyle = level => ({
  lineSpacing: 115,
  alignment: 'START',
  indentStart: magnitude(36 * level),
  indentEnd: magnitude(0),
  spaceAbove: magnitude(0),
  spaceBelow: magnitude(0),
  indentFirstLine: magnitude(-18),
  direction: 'LEFT_TO_RIGHT',
  spacingMode: 'COLLAPSE_LISTS',
});
const lists = id => ({
  [`list-${id}`]: {
    listId: `list-${id}`,
    nestingLevel: Object.fromEntries(
      Array.from({ length: 9 }, (_, level) => [level, { bulletStyle: textStyle(level) }]),
    ),
  },
});
const styledText = (id, content = '') => ({
  textElements: [
    {
      endIndex: content.length + 1,
      paragraphMarker: {
        style: paragraphStyle(0),
        bullet: { listId: `list-${id}`, glyph: '●', bulletStyle: textStyle(0) },
      },
    },
    ...(content ? [{ endIndex: content.length, textRun: { content, style: textStyle(0) } }] : []),
    { startIndex: content.length, endIndex: content.length + 1, textRun: { content: '\n', style: textStyle(0) } },
  ],
  lists: lists(id),
});
const shapeProperties = {
  shapeBackgroundFill: { propertyState: 'INHERIT', solidFill: { color: { themeColor: 'LIGHT1' }, alpha: 1 } },
  outline: {
    outlineFill: { solidFill: { color: { themeColor: 'DARK2' }, alpha: 1 } },
    weight: magnitude(0.75),
    dashStyle: 'SOLID',
    propertyState: 'INHERIT',
  },
  shadow: {
    type: 'OUTER',
    transform: { scaleX: 1, scaleY: 1, unit: 'EMU' },
    alignment: 'BOTTOM_LEFT',
    blurRadius: magnitude(0),
    color: { themeColor: 'DARK1' },
    alpha: 1,
    rotateWithShape: false,
    propertyState: 'INHERIT',
  },
  contentAlignment: 'BOTTOM',
  autofit: { autofitType: 'NONE', fontScale: 1, lineSpacingReduction: 0 },
};
const element = (objectId, type, index, content) => ({
  objectId,
  size: { width: { magnitude: 8_520_600, unit: 'EMU' }, height: { magnitude: 2_052_600, unit: 'EMU' } },
  transform: { scaleX: 1, scaleY: 1, translateX: 311_700, translateY: 744_575 + index * 2_000_000, unit: 'EMU' },
  shape: {
    shapeType: 'TEXT_BOX',
    text: styledText(objectId, content),
    shapeProperties,
    placeholder: { type, parentObjectId: `parent-${type}` },
  },
});
const placeholders = (page, count) =>
  Array.from({ length: count }, (_, index) =>
    element(`${page}_${index}`, placeholderTypes[index % placeholderTypes.length], index),
  );

/** A new presentation as Google returns it without a field mask: one title slide, its master, the eleven predefined layouts, and the notes master. */
export function freshPresentation({
  presentationId = 'qa-deck',
  title = 'qa-20261003-cloud-agent-created-slides',
  revisionId = 'rev-fresh-1',
} = {}) {
  return {
    presentationId,
    title,
    locale: 'en',
    revisionId,
    pageSize: { width: { magnitude: 9_144_000, unit: 'EMU' }, height: { magnitude: 5_143_500, unit: 'EMU' } },
    slides: [
      {
        objectId: 'p',
        pageType: 'SLIDE',
        revisionId,
        pageElements: [element('i0', 'CENTERED_TITLE', 0), element('i1', 'SUBTITLE', 1)],
        slideProperties: {
          layoutObjectId: 'p2',
          masterObjectId: 'simple-light-2',
          notesPage: {
            objectId: 'p:notes',
            pageType: 'NOTES',
            pageElements: placeholders('p:notes', 2),
            notesProperties: { speakerNotesObjectId: 'p:notes_1' },
          },
        },
        pageProperties: { pageBackgroundFill: { propertyState: 'INHERIT' } },
      },
    ],
    masters: [
      {
        objectId: 'simple-light-2',
        pageType: 'MASTER',
        pageElements: placeholders('master', 5),
        pageProperties: {
          pageBackgroundFill: { solidFill: { color: { themeColor: 'LIGHT1' }, alpha: 1 } },
          colorScheme: { colors: themeColors.map(type => ({ type, color: { red: 0.2, green: 0.2, blue: 0.2 } })) },
        },
        masterProperties: { displayName: 'Simple Light' },
      },
    ],
    layouts: layoutNames.map((name, index) => ({
      objectId: `p${index + 2}`,
      pageType: 'LAYOUT',
      pageElements: placeholders(`layout${index}`, 4),
      layoutProperties: { masterObjectId: 'simple-light-2', name, displayName: name },
    })),
    notesMaster: { objectId: 'notes-master', pageType: 'NOTES_MASTER', pageElements: placeholders('notes-master', 2) },
  };
}

function parseMask(mask) {
  let position = 0;
  const list = () => {
    const tree = {};
    for (;;) {
      let node = tree,
        name = '';
      for (;;) {
        const match = /^[A-Za-z0-9_]+/.exec(mask.slice(position));
        if (!match) throw new Error(`invalid field mask at ${position}: ${mask}`);
        name = match[0];
        position += name.length;
        if (mask[position] !== '/') break;
        position++;
        node = node[name] ??= {};
      }
      if (mask[position] === '(') {
        position++;
        node[name] = Object.assign(node[name] ?? {}, list());
        if (mask[position++] !== ')') throw new Error(`unclosed field mask: ${mask}`);
      } else node[name] ??= true;
      if (mask[position] !== ',') return tree;
      position++;
    }
  };
  const tree = list();
  if (position !== mask.length) throw new Error(`trailing field mask: ${mask}`);
  return tree;
}

function project(value, tree) {
  if (tree === true || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => project(item, tree));
  return Object.fromEntries(
    Object.entries(tree)
      .filter(([key]) => key in value)
      .map(([key, child]) => [key, project(value[key], child)]),
  );
}

/** A Slides fake that honours Google's `fields` partial-response mask for presentation and page reads. */
export function slidesFake(presentation) {
  const requests = [];
  const fetcher = async url => {
    requests.push(url);
    const match = /^\/v1\/presentations\/([^/:]+)(?:\/pages\/([^/]+))?$/.exec(url.pathname);
    if (
      url.origin !== 'https://slides.googleapis.com' ||
      !match ||
      decodeURIComponent(match[1]) !== presentation.presentationId
    )
      return new Response('{}', { status: 404 });
    const page =
      match[2] &&
      [...presentation.slides, ...presentation.layouts, ...presentation.masters].find(
        candidate => candidate.objectId === decodeURIComponent(match[2]),
      );
    if (match[2] && !page) return new Response('{}', { status: 404 });
    const body = page ? { ...page, revisionId: presentation.revisionId } : presentation;
    const fields = url.searchParams.get('fields');
    return Response.json(fields ? project(body, parseMask(fields)) : body);
  };
  return { fetcher, requests };
}
