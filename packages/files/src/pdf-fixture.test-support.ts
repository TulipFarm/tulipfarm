import { createHash } from "node:crypto";

export type PdfFixtureVariant = "text" | "scan" | "mixed" | "encrypted" | "malformed" | "layout";

const escapeText = (text: string) =>
  text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
const latin1 = (value: string) => Buffer.from(value, "latin1");
const digest = (value: Uint8Array) => createHash("md5").update(value).digest();

function rc4(key: Uint8Array, bytes: Uint8Array): Buffer {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let swap = 0;
  for (let index = 0; index < 256; index += 1) {
    swap = (swap + state[index] + key[index % key.length]) % 256;
    [state[index], state[swap]] = [state[swap], state[index]];
  }
  let index = 0;
  swap = 0;
  return Buffer.from(
    bytes.map((value) => {
      index = (index + 1) % 256;
      swap = (swap + state[index]) % 256;
      [state[index], state[swap]] = [state[swap], state[index]];
      return value ^ state[(state[index] + state[swap]) % 256];
    })
  );
}

function encryption() {
  const padding = Buffer.from(
    "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a",
    "hex"
  );
  const password = (value: string) => Buffer.concat([latin1(value), padding]).subarray(0, 32);
  const id = digest(latin1("tulipfarm-synthetic-pdf"));
  const owner = rc4(digest(password("fixture-owner")).subarray(0, 5), password("fixture-reader"));
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);
  const key = digest(Buffer.concat([password("fixture-reader"), owner, permissions, id])).subarray(
    0,
    5
  );
  return {
    id: id.toString("hex"),
    dictionary: `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString("hex")}> /U <${rc4(key, padding).toString("hex")}> /P -4 >>`,
    stream: (object: number, value: string) => {
      const suffix = Buffer.from([object & 255, (object >> 8) & 255, (object >> 16) & 255, 0, 0]);
      return rc4(digest(Buffer.concat([key, suffix])).subarray(0, 10), latin1(value)).toString(
        "latin1"
      );
    },
  };
}

/** Independent PDF producer with actual image pages, xrefs, and password-encrypted streams. */
export function externalPdf(
  variant: PdfFixtureVariant = "text",
  content = "The warranty lasts 47 days."
): Uint8Array {
  if (variant === "malformed") return new Uint8Array(latin1("%PDF-1.4\nnot a document\n%%EOF"));
  if (!/^[\x20-\x7e\n\r\t]*$/.test(content)) throw new Error("PDF fixture content must be ASCII");
  const secured = variant === "encrypted" ? encryption() : undefined;
  const objects: string[] = ["", ""];
  const add = (body: string) => objects.push(body);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const mono = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
  const stream = (value: string, dictionary = "") => {
    const id = objects.length + 1;
    const data = secured?.stream(id, value) ?? value;
    return add(`<< /Length ${latin1(data).length} ${dictionary} >>\nstream\n${data}\nendstream`);
  };
  const pageIds: number[] = [];
  const imageOnly = variant === "scan" ? [true] : variant === "mixed" ? [false, true] : [false];
  for (const [index, image] of imageOnly.entries()) {
    const width = index === 0 ? 612 : 420;
    const height = index === 0 ? 792 : 594;
    let imageResource = "";
    let commands: string;
    if (image) {
      const imageId = stream(
        "ffffff000000000000ffffff>",
        "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode"
      );
      imageResource = `/XObject << /Scan ${imageId} 0 R >>`;
      commands = `q ${width} 0 0 ${height} 0 0 cm /Scan Do Q`;
    } else if (variant === "layout") {
      commands =
        "BT /F2 24 Tf 72 720 Td (Approval handbook) Tj ET\n" +
        `BT /F1 12 Tf 72 680 Td (${escapeText(content)}) Tj ET\n` +
        "BT /F3 10 Tf 72 640 Td (if ready:) Tj 0 -14 Td (    publish\\(\\)) Tj ET\n" +
        "BT /F2 12 Tf 72 590 Td (Region) Tj 180 0 Td (Amount) Tj ET\n" +
        "BT /F1 12 Tf 72 570 Td (Pune) Tj 180 0 Td (731) Tj ET";
    } else {
      commands = `BT /F1 12 Tf 72 720 Td (${escapeText(content)}) Tj ET`;
    }
    const contents = stream(commands);
    pageIds.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R /F3 ${mono} 0 R >> ${imageResource} >> /Contents ${contents} 0 R >>`
      )
    );
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  const encryptId = secured === undefined ? undefined : add(secured.dictionary);
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(latin1(pdf).length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const start = latin1(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  const security =
    secured === undefined ? "" : `/Encrypt ${encryptId} 0 R /ID [<${secured.id}><${secured.id}>]`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${security} >>\nstartxref\n${start}\n%%EOF`;
  return new Uint8Array(latin1(pdf));
}
