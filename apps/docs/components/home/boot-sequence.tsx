"use client";

import { useEffect, useRef, useState } from "react";
import { SITE_URL } from "@/lib/shared";

/**
 * A terminal window that types out the real one-line install from
 * `scripts/install.sh` when scrolled into view. Commands type character by
 * character; output lines land whole. Plays once; `prefers-reduced-motion`
 * (or a disconnected IntersectionObserver) shows the finished transcript.
 */

type Line =
  | { kind: "cmd"; text: string }
  | { kind: "ok"; text: string }
  | { kind: "svc"; text: string }
  | { kind: "out"; text: string };

const LINES: Line[] = [
  { kind: "cmd", text: `curl -fsSL ${SITE_URL}/install.sh | sudo bash` },
  { kind: "ok", text: "container engine detected" },
  { kind: "ok", text: "secrets generated → /opt/tulipfarm/.env" },
  { kind: "ok", text: "postgres 17 + pgvector ready" },
  { kind: "ok", text: "soul planted at /opt/tulipfarm/soul" },
  { kind: "svc", text: "app  http://localhost:8080" },
  { kind: "cmd", text: "curl http://localhost:8080/readyz" },
  { kind: "out", text: '{ "status": "ok" }' },
  { kind: "out", text: "open http://localhost:8080 to create your admin" },
];

function Prompt() {
  return <span className="text-fd-muted-foreground">$ </span>;
}

function FinishedLine({ line }: { line: Line }) {
  switch (line.kind) {
    case "cmd":
      return (
        <div>
          <Prompt />
          <span className="text-fd-foreground">{line.text}</span>
        </div>
      );
    case "ok":
      return (
        <div className="pl-4">
          <span className="text-fd-primary">✓ </span>
          <span className="text-fd-muted-foreground">{line.text}</span>
        </div>
      );
    case "svc":
      return (
        <div className="pl-4">
          <span className="text-fd-primary">● </span>
          <span className="text-fd-foreground">{line.text}</span>
        </div>
      );
    case "out":
      return <div className="pl-4 text-fd-muted-foreground">{line.text}</div>;
  }
}

export function BootSequence() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [done, setDone] = useState(0);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let cancelled = false;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });

    async function run() {
      for (let i = 0; i < LINES.length; i++) {
        if (cancelled) return;
        const line = LINES[i];
        if (line.kind === "cmd") {
          await sleep(i === 0 ? 350 : 550);
          for (let c = 1; c <= line.text.length; c++) {
            if (cancelled) return;
            setTyped(line.text.slice(0, c));
            await sleep(14);
          }
          await sleep(160);
          setTyped("");
        } else {
          await sleep(190);
        }
        if (cancelled) return;
        setDone(i + 1);
      }
    }

    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          setDone(LINES.length);
        } else {
          run();
        }
      },
      { threshold: 0.35 }
    );
    io.observe(el);

    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, []);

  const next = done < LINES.length ? LINES[done] : null;

  return (
    <div ref={rootRef} className="rounded-lg border border-fd-border bg-fd-card p-1">
      <div className="flex items-baseline justify-between px-3 py-2">
        <span className="text-xs uppercase tracking-[0.2em] text-fd-muted-foreground">
          [install]
        </span>
        <span className="text-xs text-fd-muted-foreground">/opt/tulipfarm</span>
      </div>
      <pre className="min-h-[16.5rem] overflow-x-auto rounded-md border border-fd-border bg-fd-background p-4 text-[13px] leading-6">
        {LINES.slice(0, done).map((line, i) => (
          <FinishedLine key={i} line={line} />
        ))}
        {next?.kind === "cmd" && (
          <div>
            <Prompt />
            <span className="text-fd-foreground">{typed}</span>
            <span aria-hidden className="text-fd-primary">
              ▍
            </span>
          </div>
        )}
        {next && next.kind !== "cmd" && (
          <div className="pl-4" aria-hidden>
            <span className="text-fd-primary">▍</span>
          </div>
        )}
        {!next && (
          <div>
            <Prompt />
            <span aria-hidden className="animate-cursor text-fd-primary">
              ▍
            </span>
          </div>
        )}
      </pre>
    </div>
  );
}
