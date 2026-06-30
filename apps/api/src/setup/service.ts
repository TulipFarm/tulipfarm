// Headless boot: all three required together trigger automatic seeding and skip the wizard.
// Container platforms (Cloud Run, Fly, App Service) supply all three via platform env config.
// curl|bash installs supply none → wizard opens.
// Partial: ADMIN creds set but no LLM_API_KEY → fail loud in production; allowed in dev
// (developer configures LLM via Settings after first boot).
export function isHeadlessBoot(): boolean {
  return !!(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && process.env.LLM_API_KEY);
}

export function isProductionMode(): boolean {
  return process.env.NODE_ENV === "production";
}
