import { BootSequence } from "@/components/home/boot-sequence";
import { Reveal } from "@/components/home/reveal";
import { TulipField } from "@/components/home/tulip-field";
import { gitConfig } from "@/lib/shared";
import Link from "next/link";

const seeAlso = [
  {
    name: "soul",
    href: "/docs/concepts/soul",
    desc: "The git-backed configuration store that defines an instance.",
  },
  {
    name: "resources",
    href: "/docs/concepts/resources",
    desc: "Schema-defined data types and the records that fill them.",
  },
  {
    name: "agents",
    href: "/docs/concepts/agents",
    desc: "The actors that run turns, each defined by an AGENT.md file.",
  },
  {
    name: "skills",
    href: "/docs/concepts/skills",
    desc: "Reusable instructions agents load on demand, audited before they land.",
  },
  {
    name: "knowledge",
    href: "/docs/concepts/knowledge",
    desc: "The searchable corpus agents draw on, backed by vector search.",
  },
  {
    name: "llm tiers",
    href: "/docs/concepts/llm",
    desc: "How TulipFarm chooses a model and falls back across providers.",
  },
  {
    name: "secrets",
    href: "/docs/concepts/secrets",
    desc: "Encrypted storage for the credentials your instance needs.",
  },
  {
    name: "guides",
    href: "/docs/guides",
    desc: "Task recipes — define a resource, install a skill, configure providers.",
  },
  {
    name: "reference",
    href: "/docs/reference",
    desc: "Environment variables and the commands that run the project.",
  },
];

function SectionLabel({ children }: { children: string }) {
  return <p className="text-xs uppercase tracking-[0.2em] text-fd-muted-foreground">{children}</p>;
}

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      {/* ── Hero: the manpage header above a living ASCII tulip field ─────────── */}
      <section className="relative flex min-h-[calc(100dvh-3.5rem)] flex-col">
        <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-4 pt-20 pb-10 sm:px-6">
          <p
            className="text-xs uppercase tracking-[0.2em] text-fd-muted-foreground motion-safe:animate-rise"
            style={{ animationDelay: "100ms" }}
          >
            tulipfarm(1) · user commands
          </p>
          <h1
            className="mt-4 text-4xl font-bold tracking-tight sm:text-6xl motion-safe:animate-rise"
            style={{ animationDelay: "180ms" }}
          >
            tulipfarm
            <span aria-hidden className="animate-cursor text-fd-primary">
              ▍
            </span>
          </h1>
          <p
            className="mt-5 max-w-xl text-base text-fd-muted-foreground sm:text-lg motion-safe:animate-rise"
            style={{ animationDelay: "260ms" }}
          >
            The AI-native business operating system. Install it, give it a soul, put it to work.
          </p>
          <p
            className="mt-4 text-xs text-fd-muted-foreground motion-safe:animate-rise"
            style={{ animationDelay: "330ms" }}
          >
            <span aria-hidden className="text-fd-primary">
              ●
            </span>{" "}
            ready · self-hosted · agents standing by
          </p>
          <div
            className="mt-8 flex flex-wrap gap-3 motion-safe:animate-rise"
            style={{ animationDelay: "400ms" }}
          >
            <Link
              href="/docs"
              className="rounded-sm bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-colors duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-fd-primary/90"
            >
              [+] read the docs
            </Link>
            <Link
              href="/docs/getting-started"
              className="rounded-sm border border-fd-border bg-fd-card px-5 py-2.5 text-sm font-medium transition-colors duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-fd-accent"
            >
              $ get started
            </Link>
          </div>
        </div>
        {/* The field is the signature moment: it sways in the wind and parts around the cursor. */}
        <div className="relative h-48 w-full sm:h-60">
          <TulipField className="absolute inset-0 size-full" />
        </div>
      </section>

      {/* ── Install: real commands from the getting-started guide, typed live ─── */}
      <section className="border-t border-fd-border">
        <div className="mx-auto grid w-full max-w-5xl gap-10 px-4 py-24 sm:px-6 sm:py-32 md:grid-cols-[1fr_1.2fr] md:items-center">
          <Reveal className="flex flex-col gap-4">
            <SectionLabel>[install]</SectionLabel>
            <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
              Ten minutes to a running farm.
            </h2>
            <p className="text-sm leading-6 text-fd-muted-foreground">
              One script installs PostgreSQL 17 + pgvector, plants your soul repository at{" "}
              <code className="text-fd-foreground">~/.tulipfarm/soul</code>, and generates your
              bootstrap secrets. <code className="text-fd-foreground">pnpm dev</code> boots the API
              and the web UI; the first account you create is the admin.
            </p>
            <Link
              href="/docs/getting-started"
              className="group text-sm font-medium text-fd-primary"
            >
              [+] get started
              <span
                aria-hidden
                className="inline-block transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] group-hover:translate-x-1"
              >
                {" "}
                →
              </span>
            </Link>
          </Reveal>
          <Reveal delay={120}>
            <BootSequence />
          </Reveal>
        </div>
      </section>

      {/* ── Mental model: the soul / runtime split as two terminal panes ───────── */}
      <section className="border-t border-fd-border">
        <div className="mx-auto w-full max-w-5xl px-4 py-24 sm:px-6 sm:py-32">
          <Reveal className="flex flex-col gap-4">
            <SectionLabel>[mental model]</SectionLabel>
            <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
              Two halves. Files on one side, a runtime on the other.
            </h2>
            <p className="max-w-2xl text-sm leading-6 text-fd-muted-foreground">
              Everything you configure is a file in the soul; everything your business produces is a
              record in the datastore. Edit the soul, and the runtime reconciles it on boot.
            </p>
          </Reveal>
          <Reveal delay={120} className="mt-10">
            <div className="grid divide-y divide-fd-border overflow-hidden rounded-lg border border-fd-border md:grid-cols-2 md:divide-x md:divide-y-0">
              <div className="flex flex-col gap-4 bg-fd-card p-6 sm:p-8">
                <p className="text-xs uppercase tracking-[0.2em] text-fd-muted-foreground">
                  [the soul]
                </p>
                <pre className="overflow-x-auto text-[13px] leading-6 text-fd-muted-foreground">
                  <span className="text-fd-foreground">~/.tulipfarm/soul</span>
                  {"\n"}├─ resources/{"   "}what your business is{"\n"}├─ agents/
                  {"      "}who does the work{"\n"}├─ skills/{"      "}what they know how to do
                  {"\n"}└─ knowledge/{"   "}what they can look up
                </pre>
                <p className="text-sm leading-6 text-fd-muted-foreground">
                  A git repository. Every change to what your instance knows and can do is a commit.
                </p>
              </div>
              <div className="flex flex-col gap-4 bg-fd-card p-6 sm:p-8">
                <p className="text-xs uppercase tracking-[0.2em] text-fd-muted-foreground">
                  [the runtime]
                </p>
                <pre className="overflow-x-auto text-[13px] leading-6 text-fd-muted-foreground">
                  <span className="text-fd-foreground">api</span>
                  {"       "}:4010{"   "}rest + agent turns{"\n"}
                  <span className="text-fd-foreground">web</span>
                  {"       "}:4000{"   "}the workspace{"\n"}
                  <span className="text-fd-foreground">workers</span>
                  {"           "}schedules + queues{"\n"}
                  <span className="text-fd-foreground">postgres</span>
                  {"          "}records + vectors
                </pre>
                <p className="text-sm leading-6 text-fd-muted-foreground">
                  Loads the soul, stores your records, indexes your knowledge, and runs agent turns
                  against your LLM providers.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── See also: the manpage index into the docs ──────────────────────────── */}
      <section className="border-t border-fd-border">
        <div className="mx-auto w-full max-w-5xl px-4 py-24 sm:px-6 sm:py-32">
          <Reveal className="flex flex-col gap-4">
            <SectionLabel>[see also]</SectionLabel>
            <h2 className="text-xl font-bold tracking-tight sm:text-2xl">
              Every concept, documented.
            </h2>
          </Reveal>
          <div className="mt-10 flex flex-col divide-y divide-fd-border border-y border-fd-border">
            {seeAlso.map((row, i) => (
              <Reveal key={row.name} delay={Math.min(i * 40, 200)}>
                <Link
                  href={row.href}
                  className="group flex items-baseline gap-4 border-l-2 border-transparent px-3 py-4 transition-colors duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:border-fd-primary hover:bg-fd-accent/60 sm:px-4"
                >
                  <span className="w-28 shrink-0 text-sm font-medium sm:w-32">
                    <span className="text-fd-muted-foreground">[</span>
                    {row.name}
                    <span className="text-fd-muted-foreground">]</span>
                  </span>
                  <span className="flex-1 text-sm leading-6 text-fd-muted-foreground">
                    {row.desc}
                  </span>
                  <span
                    aria-hidden
                    className="-translate-x-1 text-sm text-fd-primary opacity-0 transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] group-hover:translate-x-0 group-hover:opacity-100"
                  >
                    →
                  </span>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Closing: the farm at sunrise, one last call ────────────────────────── */}
      <section className="border-t border-fd-border">
        <div className="mx-auto w-full max-w-5xl px-4 py-24 sm:px-6 sm:py-32">
          <Reveal>
            <div className="relative aspect-[16/10] overflow-hidden rounded-lg border border-fd-border ring-1 ring-fd-primary/10 sm:aspect-[2/1]">
              <picture>
                <source srcSet="/banner.avif" type="image/avif" />
                <source srcSet="/banner.webp" type="image/webp" />
                <img
                  src="/banner.webp"
                  alt=""
                  width={1600}
                  height={900}
                  loading="lazy"
                  decoding="async"
                  className="absolute inset-0 size-full object-cover"
                />
              </picture>
              <div
                aria-hidden
                className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/25 to-transparent"
              />
              <div className="absolute inset-x-0 bottom-0 flex flex-col gap-4 p-5 sm:flex-row sm:items-end sm:justify-between sm:p-8">
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs uppercase tracking-[0.2em] text-white/70">[the farm]</p>
                  <p className="text-xl font-bold tracking-tight text-white sm:text-2xl">
                    Put it to work.
                  </p>
                </div>
                <Link
                  href="/docs"
                  className="w-max rounded-sm bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-colors duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-fd-primary/90"
                >
                  [+] read the docs
                </Link>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Footer ─────────────────────────────────────────────────────────────── */}
      <footer className="border-t border-fd-border">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-2 px-4 py-8 text-xs text-fd-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>tulipfarm — the AI-native business operating system</p>
          <div className="flex gap-4">
            <a
              href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
              rel="noreferrer noopener"
              target="_blank"
              className="transition-colors duration-150 hover:text-fd-foreground"
            >
              github ↗
            </a>
            <a href="/llms.txt" className="transition-colors duration-150 hover:text-fd-foreground">
              llms.txt
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}
