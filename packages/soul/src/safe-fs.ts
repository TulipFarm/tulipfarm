import { readFile, realpath } from "node:fs/promises";
import { sep } from "node:path";

function contains(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

export async function readContainedFile(rootPath: string, filePath: string): Promise<string> {
  const [root, target] = await Promise.all([realpath(rootPath), realpath(filePath)]);
  if (!contains(root, target)) {
    throw new Error(`refusing to read path outside the Soul repository: ${filePath}`);
  }
  return readFile(target, "utf8");
}
