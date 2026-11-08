const maxTextBytes = 65536;
const count = new Intl.NumberFormat('en-US');

function utf8Length(codePoint: number) {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

export function textLengthError(text: string) {
  if (text.length <= maxTextBytes / 3) return null;
  let bytes = 0;
  let characters = 0;
  let fit = 0;
  for (const character of text) {
    bytes += utf8Length(character.codePointAt(0)!);
    characters += 1;
    if (bytes <= maxTextBytes) fit = characters;
  }
  if (bytes <= maxTextBytes) return null;
  return `This message is ${count.format(characters)} characters. Keep it under ${count.format(fit)} characters.`;
}
