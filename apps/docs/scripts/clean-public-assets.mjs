import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Remove only the old distribution copies; a reused checkout must not republish them from docs.
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
for (const filename of [
  "install.sh",
  "uninstall.sh",
  "install.ps1",
  "docker-compose.yml",
  "env.example",
  "deploy.txt",
  "kubernetes-values.yaml",
  "azure-containerapp.yaml",
  "schemas",
]) {
  rmSync(resolve(publicDir, filename), { force: true, recursive: true });
}
