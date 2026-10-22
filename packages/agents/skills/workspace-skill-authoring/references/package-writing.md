# Writing a reusable package

Start with the outcome and trigger, not a role or personality. A description should say what the skill does and when to choose it. Prefer a Workflow for a scheduled deterministic process; prefer Knowledge for facts; a skill supplies a reusable procedure.

Keep SKILL.md focused on the steps and decisions. Move detailed examples and domain guidance into references, and link only files that exist. Read resources only when relevant. Include a script only when deterministic code materially improves the task.

For edits, inspect the exact saved version first. skills.draft accepts a file patch: omitted files are preserved and content:null removes one file. Preserve upstream provenance and explain which local changes replace an upstream behavior. Never put credentials or copied private records into the package.

Fixed scripts receive JSON on standard input, run from /package, and write files under TULIPFARM_OUTPUT_DIR. Use relative local imports or /package paths. The image provides Bash, Python standard library, and Node built-ins. There is no network, package installation, workspace credential, or host filesystem access. Supported published outputs are UTF-8 text, Markdown, CSV, JSON, PNG, and JPEG; other formats are rejected.

Propose the exact package through skills.draft. The AI review is metered advice, not proof of safety. Only the human's Install and enable decision makes the package usable. Tool and source access remain separate.
