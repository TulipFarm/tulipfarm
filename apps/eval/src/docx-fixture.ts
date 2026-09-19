import { crc32 } from "node:zlib";

export const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type DocxFixture =
  | { readonly precedingParagraphs: number }
  | { readonly variant: "malformed" | "empty" | "entry-limit" };

/** Independent OOXML fixture: the grounded content follows the requested preview-sized prefix. */
export function synthesizeDocxFixture(content: string, precedingParagraphs: number): Uint8Array {
  const paragraphs = [
    ...Array.from({ length: precedingParagraphs }, (_, index) => `Policy paragraph ${index + 1}.`),
    content,
  ];
  return storedZip(documentEntries(paragraphs));
}

export function synthesizeDocxRefusalFixture(
  variant: Extract<DocxFixture, { variant: string }>["variant"]
): Uint8Array {
  if (variant === "malformed") return storedZip(documentEntries(["Policy."])).slice(0, 64);
  if (variant === "empty") return storedZip(documentEntries([]));
  return storedZip({
    ...documentEntries(["Policy."]),
    ...Object.fromEntries(
      Array.from({ length: 510 }, (_, index) => [`customXml/item${index + 1}.xml`, "<item/>"])
    ),
  });
}

function documentEntries(paragraphs: readonly string[]): Readonly<Record<string, string>> {
  const escapeXml = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return {
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>",
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>",
    "word/document.xml":
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      paragraphs.map((text) => `<w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`).join("") +
      "<w:sectPr/></w:body></w:document>",
  };
}

/** Stored ZIP entries keep the fixture deterministic without importing the production writer. */
function storedZip(entries: Readonly<Record<string, string>>): Uint8Array {
  const local: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const filename = Buffer.from(name);
    const data = Buffer.from(content);
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    local.push(header, filename, data);
    directory.push(central, filename);
    offset += header.length + filename.length + data.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}
