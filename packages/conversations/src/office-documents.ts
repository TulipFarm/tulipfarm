import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  type FileChild,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  PageOrientation,
  Paragraph,
  type ILevelsOptions,
  ShadingType,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import pptxgen from 'pptxgenjs';
import { z } from 'zod';

// pptxgenjs ships CommonJS-style types, so NodeNext sees the default export one level down.
const Presentation = pptxgen as unknown as typeof pptxgen.default;
type TextProps = pptxgen.default.TextProps;
type TextOptions = pptxgen.default.TextPropsOptions;
type Slide = pptxgen.default.Slide;

export const officeFormats = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;
export type OfficeFormat = keyof typeof officeFormats;
/** The native Google type each Office format converts to on a Drive upload. */
export const googleConversions = {
  docx: 'application/vnd.google-apps.document',
  xlsx: 'application/vnd.google-apps.spreadsheet',
  pptx: 'application/vnd.google-apps.presentation',
} as const satisfies Record<OfficeFormat, string>;

type Theme = {
  headingFont: string;
  bodyFont: string;
  accent: string;
  text: string;
  muted: string;
  headerText: string;
  band: string;
  background: string;
};
// Fonts are limited to ones that both Office and Google Drive conversion render without substitution.
export const themes = {
  default: {
    headingFont: 'Calibri',
    bodyFont: 'Calibri',
    accent: '2563EB',
    text: '1F2937',
    muted: '6B7280',
    headerText: 'FFFFFF',
    band: 'EFF4FF',
    background: 'FFFFFF',
  },
  modern: {
    headingFont: 'Arial',
    bodyFont: 'Arial',
    accent: '0D9488',
    text: '111827',
    muted: '6B7280',
    headerText: 'FFFFFF',
    band: 'ECFDF9',
    background: 'FFFFFF',
  },
  classic: {
    headingFont: 'Georgia',
    bodyFont: 'Times New Roman',
    accent: '7C2D12',
    text: '1C1917',
    muted: '57534E',
    headerText: 'FFFFFF',
    band: 'FAF5F0',
    background: 'FFFDF8',
  },
  bold: {
    headingFont: 'Trebuchet MS',
    bodyFont: 'Verdana',
    accent: 'DB2777',
    text: '0F172A',
    muted: '475569',
    headerText: 'FFFFFF',
    band: 'FDF2F8',
    background: 'FFFFFF',
  },
  minimal: {
    headingFont: 'Arial',
    bodyFont: 'Arial',
    accent: '111827',
    text: '111827',
    muted: '9CA3AF',
    headerText: 'FFFFFF',
    band: 'F3F4F6',
    background: 'FFFFFF',
  },
} satisfies Record<string, Theme>;

const color = z
  .string()
  .regex(/^#?[0-9a-fA-F]{6}$/)
  .transform(value => value.replace('#', '').toUpperCase());
const run = z.strictObject({
  text: z.string().max(20000),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strike: z.boolean().optional(),
  code: z.boolean().optional(),
  color: color.optional(),
  link: z.url().optional(),
});
const text = z.union([z.string().max(20000), z.array(z.union([z.string().max(20000), run])).max(200)]);
type Text = z.infer<typeof text>;
type ListItem = Text | { text: Text; items?: ListItem[] | undefined };
const listItem: z.ZodType<ListItem> = z.lazy(() =>
  z.union([text, z.strictObject({ text, items: z.array(listItem).max(200).optional() })]),
);
const list = z.strictObject({
  type: z.literal('list'),
  ordered: z.boolean().optional(),
  items: z.array(listItem).min(1).max(500),
});
const paragraph = z.strictObject({
  type: z.literal('paragraph'),
  text,
  align: z.enum(['left', 'center', 'right', 'justify']).optional(),
});
const table = z
  .strictObject({
    type: z.literal('table'),
    header: z.array(text).max(30).optional(),
    rows: z.array(z.array(text).max(30)).max(2000),
  })
  .refine(value => value.header?.length || value.rows.length, 'A table needs a header or at least one row');
const style = {
  theme: z.enum(Object.keys(themes) as [keyof typeof themes]).default('default'),
  accentColor: color.optional(),
};

export const documentSpecSchema = z.strictObject({
  ...style,
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
  header: z.string().max(200).optional(),
  footer: z.string().max(200).optional(),
  pageNumbers: z.boolean().default(false),
  blocks: z
    .array(
      z.discriminatedUnion('type', [
        z.strictObject({
          type: z.literal('title'),
          text: z.string().max(500),
          subtitle: z.string().max(500).optional(),
        }),
        z.strictObject({ type: z.literal('heading'), level: z.int().min(1).max(4), text: z.string().max(500) }),
        paragraph,
        list,
        table,
        z.strictObject({ type: z.literal('quote'), text }),
        z.strictObject({ type: z.literal('code'), text: z.string().max(50000) }),
        z.strictObject({ type: z.literal('divider') }),
        z.strictObject({ type: z.literal('pageBreak') }),
        z.strictObject({ type: z.literal('toc'), title: z.string().max(200).optional() }),
      ]),
    )
    .min(1)
    .max(5000),
});

const range = z
  .string()
  .regex(/^\$?[A-Z]{1,3}\$?[0-9]{1,7}(:\$?[A-Z]{1,3}\$?[0-9]{1,7})?$/, 'Use an A1 range such as B2:B50');
const cell = z.union([
  z.string().max(32767),
  z.number(),
  z.boolean(),
  z.null(),
  z
    .strictObject({
      value: z.union([z.string().max(32767), z.number(), z.boolean()]).optional(),
      formula: z.string().startsWith('=').max(8192).optional(),
      date: z.iso.date().optional(),
      format: z.string().max(100).optional(),
      bold: z.boolean().optional(),
      color: color.optional(),
      fill: color.optional(),
      link: z.url().optional(),
      note: z.string().max(2000).optional(),
    })
    .refine(
      value => [value.value, value.formula, value.date].filter(entry => entry !== undefined).length <= 1,
      'Use only one of value, formula, or date',
    ),
]);
export const workbookSpecSchema = z.strictObject({
  ...style,
  sheets: z
    .array(
      z.strictObject({
        name: z
          .string()
          .min(1)
          .max(31)
          .regex(/^[^\\/?*[\]:]+$/, 'Sheet names cannot contain \\ / ? * [ ] :'),
        columns: z
          .array(
            z.strictObject({
              header: z.string().max(255),
              width: z.number().min(1).max(255).optional(),
              format: z.string().max(100).optional(),
            }),
          )
          .max(200)
          .optional(),
        rows: z.array(z.array(cell).max(200)).max(20000).default([]),
        freezeHeader: z.boolean().default(true),
        filter: z.boolean().default(false),
        bandedRows: z.boolean().default(false),
        merges: z.array(range).max(500).default([]),
        dropdowns: z
          .array(
            z.strictObject({
              range,
              options: z
                .array(
                  z
                    .string()
                    .min(1)
                    .max(100)
                    .regex(/^[^,"]+$/, 'Dropdown options cannot contain commas or quotes'),
                )
                .min(1)
                .max(50),
            }),
          )
          .max(100)
          .default([]),
      }),
    )
    .min(1)
    .max(50),
});

const chart = z
  .strictObject({
    type: z.literal('chart'),
    kind: z.enum(['bar', 'column', 'line', 'pie', 'doughnut']),
    title: z.string().max(200).optional(),
    categories: z.array(z.string().max(100)).min(1).max(100),
    series: z
      .array(z.strictObject({ name: z.string().max(100), values: z.array(z.number()).min(1).max(100) }))
      .min(1)
      .max(12),
  })
  .refine(
    value => value.series.every(entry => entry.values.length === value.categories.length),
    'Each series needs one value per category',
  );
const slideBlock = z.discriminatedUnion('type', [paragraph, list, table, chart]);
export const presentationSpecSchema = z.strictObject({
  ...style,
  aspectRatio: z.enum(['16:9', '4:3']).default('16:9'),
  slideNumbers: z.boolean().default(false),
  footer: z.string().max(200).optional(),
  slides: z
    .array(
      z.strictObject({
        layout: z.enum(['title', 'section', 'content', 'two-column']).default('content'),
        title: z.string().max(300).optional(),
        subtitle: z.string().max(500).optional(),
        content: z.array(slideBlock).max(20).optional(),
        left: z.array(slideBlock).max(20).optional(),
        right: z.array(slideBlock).max(20).optional(),
        notes: z.string().max(20000).optional(),
        background: color.optional(),
      }),
    )
    .min(1)
    .max(200),
});

export const officeSpecSchemas = {
  docx: documentSpecSchema,
  xlsx: workbookSpecSchema,
  pptx: presentationSpecSchema,
} as const;

export class OfficeSpecError extends Error {}

/** Renders a JSON spec. Spec errors throw OfficeSpecError with a message the model can act on. */
export async function renderOfficeDocument(format: OfficeFormat, content: string): Promise<Uint8Array> {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new OfficeSpecError('The content is not valid JSON.');
  }
  const parsed = officeSpecSchemas[format].safeParse(json);
  if (!parsed.success) throw new OfficeSpecError(z.prettifyError(parsed.error).slice(0, 4000));
  const bytes =
    format === 'docx'
      ? await renderDocument(parsed.data as z.infer<typeof documentSpecSchema>)
      : format === 'xlsx'
        ? await renderWorkbook(parsed.data as z.infer<typeof workbookSpecSchema>)
        : await renderPresentation(parsed.data as z.infer<typeof presentationSpecSchema>);
  return stable(bytes);
}

const fixedDate = new Date('2000-01-01T00:00:00Z');
/**
 * The same spec must give the same bytes: a replayed Google proposal is compared byte for byte.
 * The libraries stamp the current time into entries, core properties, and embedded chart workbooks, and docx gives hyperlinks random relationship ids.
 */
async function stable(bytes: Uint8Array) {
  const source = await JSZip.loadAsync(bytes);
  const target = new JSZip();
  const links = new Map<string, string>();
  // pptxgenjs numbers chart parts with a counter shared by every deck in the process.
  const parts = /\b(chart|Microsoft_Excel_Worksheet)(\d+)\.(xml|xlsx)\b/g;
  const numbers = new Map<string, number[]>();
  for (const [, prefix, number] of Object.keys(source.files).join('\n').matchAll(parts))
    numbers.set(prefix!, [...new Set([...(numbers.get(prefix!) ?? []), Number(number)])]);
  const renumber = (value: string) =>
    value.replace(
      parts,
      (_, prefix: string, number: string, extension: string) =>
        `${prefix}${[...numbers.get(prefix)!].sort((a, b) => a - b).indexOf(Number(number)) + 1}.${extension}`,
    );
  for (const [name, renamed] of Object.keys(source.files)
    .map(name => [name, renumber(name)] as const)
    .sort((a, b) => (a[1] < b[1] ? -1 : 1))) {
    const entry = source.files[name]!;
    if (entry.dir) continue;
    let content: string | Uint8Array = await entry.async('uint8array');
    if (/\.(xml|rels)$/.test(name)) {
      content = renumber(new TextDecoder().decode(content))
        .replace(/<dcterms:(created|modified)\b[^>]*>[^<]*<\/dcterms:\1>/g, '')
        .replace(
          /"rId[A-Za-z0-9_-]{15,}"/g,
          id => links.get(id) ?? links.set(id, `"rIdLink${links.size + 1}"`).get(id)!,
        );
    }
    // A slide chart carries its data as an embedded workbook with its own timestamps.
    else if (name.endsWith('.xlsx')) content = await stable(content);
    target.file(renamed, content, { date: fixedDate, createFolders: false });
  }
  return target.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

function themeOf(spec: { theme: keyof typeof themes; accentColor?: string | undefined }): Theme {
  return { ...themes[spec.theme], ...(spec.accentColor ? { accent: spec.accentColor } : {}) };
}
/** Drops undefined entries; these libraries type optional options without undefined. */
const defined = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
const runs = (value: Text) =>
  typeof value === 'string'
    ? [{ text: value }]
    : value.map(entry => (typeof entry === 'string' ? { text: entry } : entry));

async function renderDocument(spec: z.infer<typeof documentSpecSchema>) {
  const theme = themeOf(spec);
  const inline = (value: Text, extra: { bold?: boolean; italics?: boolean; color?: string } = {}) =>
    runs(value).map(entry => {
      const options = defined({
        text: entry.text,
        bold: entry.bold ?? extra.bold,
        italics: entry.italic ?? extra.italics,
        strike: entry.strike,
        underline: entry.underline || entry.link ? {} : undefined,
        color: entry.color ?? (entry.link ? theme.accent : extra.color),
        font: entry.code ? 'Courier New' : undefined,
      });
      return entry.link
        ? new ExternalHyperlink({ link: entry.link, children: [new TextRun(options)] })
        : new TextRun(options);
    });
  let lists = 0;
  const listParagraphs = (items: ListItem[], reference: string, level: number): Paragraph[] =>
    items.flatMap(item => {
      const { text: value, items: children } =
        typeof item === 'object' && !Array.isArray(item) ? item : { text: item, items: undefined };
      return [
        new Paragraph({ children: inline(value), numbering: { reference, level: Math.min(level, 2) } }),
        ...listParagraphs(children ?? [], reference, level + 1),
      ];
    });
  const tableCell = (value: Text, header: boolean) =>
    new TableCell({
      children: [new Paragraph({ children: inline(value, header ? { bold: true, color: theme.headerText } : {}) })],
      ...(header ? { shading: { type: ShadingType.CLEAR, fill: theme.accent, color: 'auto' } } : {}),
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
    });
  const numbering: { reference: string; levels: ILevelsOptions[] }[] = [];
  const children = spec.blocks.flatMap((block): FileChild[] => {
    switch (block.type) {
      case 'title':
        return [
          new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: block.text })] }),
          ...(block.subtitle
            ? [
                new Paragraph({
                  children: [new TextRun({ text: block.subtitle, color: theme.muted, size: 28 })],
                  spacing: { after: 240 },
                }),
              ]
            : []),
        ];
      case 'heading':
        return [
          new Paragraph({
            heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][
              block.level - 1
            ]!,
            children: [new TextRun({ text: block.text })],
          }),
        ];
      case 'paragraph':
        return [
          new Paragraph(
            defined({
              children: inline(block.text),
              alignment:
                block.align === 'justify'
                  ? AlignmentType.JUSTIFIED
                  : block.align
                    ? AlignmentType[block.align.toUpperCase() as 'LEFT' | 'CENTER' | 'RIGHT']
                    : undefined,
            }),
          ),
        ];
      case 'list': {
        const reference = `list-${lists++}`;
        numbering.push({
          reference,
          levels: [0, 1, 2].map(level => ({
            level,
            format: block.ordered
              ? [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level]!
              : LevelFormat.BULLET,
            text: block.ordered ? `%${level + 1}.` : ['•', '◦', '▪'][level]!,
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        });
        return listParagraphs(block.items, reference, 0);
      }
      case 'table':
        return [
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              ...(block.header
                ? [new TableRow({ tableHeader: true, children: block.header.map(value => tableCell(value, true)) })]
                : []),
              ...block.rows.map(row => new TableRow({ children: row.map(value => tableCell(value, false)) })),
            ],
          }),
          new Paragraph({}),
        ];
      case 'quote':
        return [
          new Paragraph({
            children: inline(block.text, { italics: true, color: theme.muted }),
            indent: { left: 540 },
            border: { left: { style: BorderStyle.SINGLE, size: 18, color: theme.accent, space: 12 } },
          }),
        ];
      case 'code':
        return block.text.split('\n').map(
          line =>
            new Paragraph({
              children: [new TextRun({ text: line, font: 'Courier New', size: 20 })],
              shading: { type: ShadingType.CLEAR, fill: theme.band, color: 'auto' },
              spacing: { after: 0 },
            }),
        );
      case 'divider':
        return [
          new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: theme.muted, space: 1 } } }),
        ];
      case 'pageBreak':
        return [new Paragraph({ children: [new PageBreak()] })];
      case 'toc':
        return [new TableOfContents(block.title ?? 'Contents', { hyperlink: true, headingStyleRange: '1-3' })];
    }
  });
  const heading = (size: number) => ({
    run: { font: theme.headingFont, color: theme.accent, bold: true, size },
    paragraph: { spacing: { before: 240, after: 120 } },
  });
  const document = new Document({
    creator: 'TulipFarm',
    ...(spec.blocks.some(block => block.type === 'toc') ? { features: { updateFields: true } } : {}),
    styles: {
      default: {
        document: {
          run: { font: theme.bodyFont, color: theme.text, size: 22 },
          paragraph: { spacing: { after: 120 } },
        },
        title: { run: { font: theme.headingFont, color: theme.accent, bold: true, size: 56 } },
        heading1: heading(36),
        heading2: heading(30),
        heading3: heading(26),
        heading4: heading(23),
      },
      // Some viewers skip document defaults, so the Normal style repeats the body font.
      paragraphStyles: [{ id: 'Normal', name: 'Normal', run: { font: theme.bodyFont, color: theme.text, size: 22 } }],
    },
    numbering: { config: numbering },
    sections: [
      {
        properties: {
          page: {
            size: {
              orientation: spec.orientation === 'landscape' ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
            },
          },
        },
        ...(spec.header
          ? {
              headers: {
                default: new Header({
                  children: [
                    new Paragraph({
                      children: [new TextRun({ text: spec.header, color: theme.muted, size: 18 })],
                      alignment: AlignmentType.RIGHT,
                    }),
                  ],
                }),
              },
            }
          : {}),
        ...(spec.footer || spec.pageNumbers
          ? {
              footers: {
                default: new Footer({
                  children: [
                    new Paragraph({
                      alignment: AlignmentType.CENTER,
                      children: [
                        ...(spec.footer ? [new TextRun({ text: spec.footer, color: theme.muted, size: 18 })] : []),
                        ...(spec.footer && spec.pageNumbers
                          ? [new TextRun({ text: '  ·  ', color: theme.muted, size: 18 })]
                          : []),
                        ...(spec.pageNumbers
                          ? [new TextRun({ children: [PageNumber.CURRENT], color: theme.muted, size: 18 })]
                          : []),
                      ],
                    }),
                  ],
                }),
              },
            }
          : {}),
        children,
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

async function renderWorkbook(spec: z.infer<typeof workbookSpecSchema>) {
  const theme = themeOf(spec);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TulipFarm';
  // Nothing here evaluates formulas, so ask the opening app to calculate them instead of showing empty cached values.
  workbook.calcProperties.fullCalcOnLoad = true;
  for (const sheet of spec.sheets) {
    const header = sheet.columns?.length ? 1 : 0;
    const worksheet = workbook.addWorksheet(
      sheet.name,
      header && sheet.freezeHeader ? { views: [{ state: 'frozen', ySplit: 1 }] } : {},
    );
    worksheet.properties.defaultRowHeight = 18;
    if (sheet.columns) {
      worksheet.columns = sheet.columns.map(column => ({
        width: column.width ?? Math.min(Math.max(column.header.length + 4, 12), 60),
        ...(column.format ? { style: { numFmt: column.format } } : {}),
      }));
      const row = worksheet.addRow(sheet.columns.map(column => column.header));
      row.eachCell(target => {
        target.font = { name: theme.headingFont, bold: true, color: { argb: `FF${theme.headerText}` } };
        target.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${theme.accent}` } };
        target.alignment = { vertical: 'middle' };
      });
    }
    sheet.rows.forEach((values, index) => {
      const row = worksheet.getRow(index + header + 1);
      values.forEach((value, column) => {
        const target = row.getCell(column + 1);
        target.font = { name: theme.bodyFont, color: { argb: `FF${theme.text}` } };
        if (sheet.bandedRows && index % 2)
          target.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${theme.band}` } };
        if (value === null || typeof value !== 'object') {
          target.value = value;
          return;
        }
        target.value =
          value.formula !== undefined
            ? { formula: value.formula.slice(1) }
            : value.date !== undefined
              ? new Date(`${value.date}T00:00:00Z`)
              : (value.value ?? null);
        if (value.date !== undefined && !value.format) target.numFmt = 'yyyy-mm-dd';
        if (value.format) target.numFmt = value.format;
        if (value.bold || value.color)
          target.font = {
            ...target.font,
            ...(value.bold ? { bold: true } : {}),
            ...(value.color ? { color: { argb: `FF${value.color}` } } : {}),
          };
        if (value.fill) target.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${value.fill}` } };
        if (value.link) {
          target.value = { text: String(value.value ?? value.link), hyperlink: value.link };
          target.font = { ...target.font, underline: true, color: { argb: `FF${theme.accent}` } };
        }
        if (value.note) target.note = value.note;
      });
      row.commit();
    });
    for (const merge of sheet.merges) worksheet.mergeCells(merge);
    // exceljs supports range validations at runtime but leaves them out of its types.
    const validations = (
      worksheet as unknown as { dataValidations: { add(range: string, rule: ExcelJS.DataValidation): void } }
    ).dataValidations;
    for (const dropdown of sheet.dropdowns)
      validations.add(dropdown.range, {
        type: 'list',
        allowBlank: true,
        formulae: [`"${dropdown.options.join(',')}"`],
        showErrorMessage: true,
      });
    if (header && sheet.filter)
      worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns!.length } };
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

async function renderPresentation(spec: z.infer<typeof presentationSpecSchema>) {
  const theme = themeOf(spec);
  const deck = new Presentation();
  deck.author = 'TulipFarm';
  deck.layout = spec.aspectRatio === '4:3' ? 'LAYOUT_4x3' : 'LAYOUT_16x9';
  const width = 10,
    height = spec.aspectRatio === '4:3' ? 7.5 : 5.625;
  const textRuns = (value: Text, options: TextOptions = {}): TextProps[] =>
    runs(value).map(entry => ({
      text: entry.text,
      options: defined({
        ...options,
        bold: entry.bold ?? options.bold,
        italic: entry.italic,
        underline: entry.underline || entry.link ? { style: 'sng' as const } : undefined,
        strike: entry.strike ? ('sngStrike' as const) : undefined,
        color: entry.color ?? (entry.link ? theme.accent : options.color),
        ...(entry.code ? { fontFace: 'Courier New' } : {}),
        ...(entry.link ? { hyperlink: { url: entry.link } } : {}),
      }),
    }));
  const listRuns = (items: ListItem[], ordered: boolean, level: number): TextProps[] =>
    items.flatMap(item => {
      const { text: value, items: children } =
        typeof item === 'object' && !Array.isArray(item) ? item : { text: item, items: undefined };
      const parts = textRuns(value);
      parts[parts.length - 1]!.options = { ...parts[parts.length - 1]!.options, breakLine: true };
      parts[0]!.options = { ...parts[0]!.options, bullet: ordered ? { type: 'number' } : true, indentLevel: level };
      return [...parts, ...listRuns(children ?? [], ordered, level + 1)];
    });
  const blocks = (slide: Slide, content: z.infer<typeof slideBlock>[], x: number, w: number) => {
    let y = 1.25;
    const available = height - y - 0.35;
    const share = available / Math.max(content.length, 1);
    for (const block of content) {
      const base = {
        x,
        y,
        w,
        h: share,
        fontFace: theme.bodyFont,
        color: theme.text,
        fontSize: 18,
        valign: 'top' as const,
      };
      if (block.type === 'paragraph') slide.addText(textRuns(block.text), { ...base, align: block.align ?? 'left' });
      else if (block.type === 'list')
        slide.addText(listRuns(block.items, block.ordered ?? false, 0), { ...base, paraSpaceAfter: 6 });
      else if (block.type === 'chart') {
        const pie = block.kind === 'pie' || block.kind === 'doughnut';
        slide.addChart(
          block.kind === 'column' ? 'bar' : block.kind,
          block.series.map(entry => ({ name: entry.name, labels: block.categories, values: entry.values })),
          defined({
            x,
            y,
            w,
            h: share,
            barDir: block.kind === 'bar' ? 'bar' : 'col',
            title: block.title,
            showTitle: block.title !== undefined,
            titleFontFace: theme.headingFont,
            showLegend: pie || block.series.length > 1,
            legendPos: 'b' as const,
            showPercent: pie,
            catAxisLabelFontFace: theme.bodyFont,
            valAxisLabelFontFace: theme.bodyFont,
            chartColors: pie ? undefined : [theme.accent, theme.muted, theme.band, theme.text],
          }),
        );
      } else
        slide.addTable(
          [
            ...(block.header
              ? [
                  block.header.map(value => ({
                    text: textRuns(value, { bold: true, color: theme.headerText }),
                    options: { fill: { color: theme.accent } },
                  })),
                ]
              : []),
            ...block.rows.map((row, index) =>
              row.map(value => ({ text: textRuns(value), options: index % 2 ? { fill: { color: theme.band } } : {} })),
            ),
          ],
          {
            x,
            y,
            w,
            fontFace: theme.bodyFont,
            fontSize: 12,
            color: theme.text,
            border: { type: 'solid', pt: 0.5, color: 'D1D5DB' },
            autoPage: false,
          },
        );
      y += share;
    }
  };
  for (const entry of spec.slides) {
    const slide = deck.addSlide();
    slide.background = { color: entry.background ?? (entry.layout === 'section' ? theme.accent : theme.background) };
    if (spec.slideNumbers && entry.layout !== 'title')
      slide.slideNumber = {
        x: width - 0.8,
        y: height - 0.4,
        w: 0.5,
        h: 0.3,
        fontSize: 10,
        color: theme.muted,
        fontFace: theme.bodyFont,
      };
    if (spec.footer && entry.layout !== 'title')
      slide.addText(spec.footer, {
        x: 0.5,
        y: height - 0.4,
        w: width - 1.6,
        h: 0.3,
        fontSize: 10,
        color: theme.muted,
        fontFace: theme.bodyFont,
      });
    if (entry.layout === 'title' || entry.layout === 'section') {
      const color = entry.layout === 'section' ? theme.headerText : theme.accent;
      if (entry.title)
        slide.addText(entry.title, {
          x: 0.6,
          y: height / 2 - 1.1,
          w: width - 1.2,
          h: 1.2,
          fontFace: theme.headingFont,
          fontSize: 40,
          bold: true,
          color,
          align: entry.layout === 'title' ? 'center' : 'left',
        });
      if (entry.subtitle)
        slide.addText(entry.subtitle, {
          x: 0.6,
          y: height / 2 + 0.2,
          w: width - 1.2,
          h: 0.8,
          fontFace: theme.bodyFont,
          fontSize: 20,
          color: entry.layout === 'section' ? theme.headerText : theme.muted,
          align: entry.layout === 'title' ? 'center' : 'left',
        });
    } else {
      if (entry.title)
        slide.addText(entry.title, {
          x: 0.5,
          y: 0.3,
          w: width - 1,
          h: 0.8,
          fontFace: theme.headingFont,
          fontSize: 28,
          bold: true,
          color: theme.accent,
        });
      slide.addShape('rect', {
        x: 0.5,
        y: 1.1,
        w: 1.2,
        h: 0.05,
        fill: { color: theme.accent },
        line: { color: theme.accent },
      });
      if (entry.layout === 'two-column') {
        blocks(slide, entry.left ?? [], 0.5, width / 2 - 0.7);
        blocks(slide, entry.right ?? [], width / 2 + 0.2, width / 2 - 0.7);
      } else blocks(slide, entry.content ?? [], 0.5, width - 1);
    }
    if (entry.notes) slide.addNotes(entry.notes);
  }
  return new Uint8Array((await deck.write({ outputType: 'nodebuffer' })) as Buffer);
}
