#!/usr/bin/env node
import http from "node:http";

const port = Number(process.env.E2E_LLM_PORT ?? 4899);

function toolResponse(name, args) {
  const body = {
    id: `e2e-${Date.now()}`,
    object: "chat.completion.chunk",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call-${Date.now()}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
  return `data: ${JSON.stringify(body)}\n\ndata: ${JSON.stringify({ ...body, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
}

function textResponse(text) {
  const id = `e2e-${Date.now()}`;
  const chunks = [
    {
      id,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

function choose(messages) {
  const last = messages.at(-1) ?? {};
  if (last.role === "tool") return textResponse("Completed by the deterministic E2E model.");
  const prompt = String(last.content ?? "").toLowerCase();
  if (prompt.includes("resource")) {
    return toolResponse("create_resource_type", {
      name: `agent-resource-${Date.now()}`,
      schema: "type: object\nproperties:\n  label:\n    type: string\nrequired: [label]\n",
    });
  }
  if (prompt.includes("space") || prompt.includes("knowledge")) {
    return toolResponse("create_space", {
      name: `agent-space-${Date.now()}`,
      description: "Created by the deterministic E2E model",
    });
  }
  return textResponse("E2E mocked response");
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "e2e-mock", object: "model", owned_by: "e2e" }],
      })
    );
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  let raw = "";
  request.on("data", (chunk) => (raw += chunk));
  request.on("end", () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      response.writeHead(400).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.end(choose(body.messages ?? []));
  });
});

server.listen(port, "0.0.0.0", () => console.log(`E2E mock LLM listening on ${port}`));
