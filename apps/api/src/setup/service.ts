// Bootstrap mode (INST-003b). "managed" = container-platform/BYO: no setup
// wizard, seed from env on boot. Anything else = "wizard" (CLI install default).
export function isManagedMode(): boolean {
  return (process.env.SETUP_MODE ?? "wizard").toLowerCase() === "managed";
}
