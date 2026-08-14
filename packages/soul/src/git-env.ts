/** Strip host Git overrides so subprocesses cannot be redirected to another repo. */
const UNSAFE_GIT_ENV = new Set([
  "editor",
  "git_askpass",
  "git_config",
  "git_config_count",
  "git_config_global",
  "git_config_system",
  "git_dir",
  "git_editor",
  "git_exec_path",
  "git_external_diff",
  "git_pager",
  "git_proxy_command",
  "git_sequence_editor",
  "git_ssh",
  "git_ssh_command",
  "git_template_dir",
  "git_work_tree",
  "pager",
  "prefix",
  "ssh_askpass",
]);

/** `process.env` with every environment-injected Git override removed. */
export function hermeticGitEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || UNSAFE_GIT_ENV.has(key.toLowerCase())) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return { ...env, ...extra };
}
