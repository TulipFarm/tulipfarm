// A fake `codex app-server` for the Codex Subscription Provider's tests.
//
// The real one is a native binary that needs a live ChatGPT subscription, so the protocol is what
// gets tested rather than the vendor. It reads a scenario and a log path from
// `globalThis.__TF_FAKE`, set by a one-line wrapper the test generates and points TF_CODEX_BIN at.
// Not from the environment: the jail strips everything not on its allowlist, which is exactly the
// behaviour under test — a test channel that survived it would be proving the opposite.
//
// Every message received is appended to the log, which is how the tests assert on request payloads
// — `thread/start`'s sandbox settings, `dynamicTools` names, injected replay items — that are
// otherwise invisible from outside the subprocess. The child's own environment is logged first, so
// the jail itself can be asserted on.
//
// Scenario shape:
//   responses:  { [method]: result }            — replies to client requests (default {})
//   onTurnStart: Array<
//       | { notify: string, params: object, delayMs?: number }
//       | { request: string, params: object, delayMs?: number }
//     >                                          — emitted after turn/start is answered
//   exitAfterTurnStart: number                   — exit with this code instead of scripting
//   ignoreSigterm: true                          — used to prove the SIGKILL escalation
//   stderr: string                               — written to stderr before anything else
//   garbage: true                                — emit a non-JSON line first
//   rotateAuth: string                           — rewrite $CODEX_HOME/auth.json mid-turn, the way
//                                                  a real access-token refresh does

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const { scenarioPath, logPath } = globalThis.__TF_FAKE;
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));

appendFileSync(logPath, `${JSON.stringify({ __env: process.env, __cwd: process.cwd() })}\n`);

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (scenario.ignoreSigterm) process.on("SIGTERM", () => {});
if (scenario.stderr) process.stderr.write(scenario.stderr);
if (scenario.garbage) process.stdout.write("this is not json\n");

let nextId = 1000;

async function script() {
  for (const step of scenario.onTurnStart ?? []) {
    if (step.delayMs) await sleep(step.delayMs);
    if (step.notify) {
      send({ method: step.notify, params: step.params ?? {} });
    } else if (step.request) {
      send({ id: nextId++, method: step.request, params: step.params ?? {} });
    }
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  appendFileSync(logPath, `${line}\n`);

  // A response to something we asked (e.g. turn/interrupt is a client request, not this).
  if (message.id !== undefined && !message.method) return;
  if (message.id === undefined) return; // a notification from the client, e.g. `initialized`

  const result = scenario.responses?.[message.method] ?? {};
  send({ id: message.id, result });

  if (message.method === "turn/start") {
    if (scenario.rotateAuth && process.env.CODEX_HOME) {
      writeFileSync(join(process.env.CODEX_HOME, "auth.json"), scenario.rotateAuth, {
        mode: 0o600,
      });
    }
    if (typeof scenario.exitAfterTurnStart === "number") {
      setTimeout(() => process.exit(scenario.exitAfterTurnStart), 10);
      return;
    }
    void script();
  }
});
