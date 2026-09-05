import type { FileService } from "@tulipfarm/files";

export async function startFileBlobCleanup(
  files: Pick<FileService, "cleanupBlobs" | "cleanupExpiredDrafts">,
  log: { error(obj: unknown, msg?: string): void }
): Promise<() => void> {
  const report = (error: unknown) => log.error({ error }, "File blob cleanup failed");
  const clean = async () => {
    await files.cleanupExpiredDrafts().catch(report);
    await files.cleanupBlobs().catch(report);
  };
  await clean();

  let running = false;
  const interval = setInterval(() => {
    if (running) return;
    running = true;
    void clean()
      .catch(report)
      .finally(() => {
        running = false;
      });
  }, 5_000);
  interval.unref?.();
  return () => clearInterval(interval);
}
