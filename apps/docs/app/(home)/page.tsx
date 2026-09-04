import type { Metadata } from "next";
import Link from "next/link";
import { InstallCommand } from "@/components/home/install-command";
import { Reveal } from "@/components/home/reveal";
import { TulipField } from "@/components/home/tulip-field";
import { appName, gitConfig } from "@/lib/shared";

export const metadata: Metadata = {
  title: "TulipFarm: build your business operating system by chatting",
  alternates: { canonical: "/" },
  description:
    "Self-host the workspace where chat turns your business operations into resources, agents, routines, and knowledge.",
  openGraph: {
    type: "website",
    siteName: appName,
    locale: "en_US",
    url: "/",
    title: "TulipFarm. Give your business a soul, then put it to work.",
    description:
      "Build business operations by chatting, keep them in a git-backed soul, and run them on your infrastructure.",
    images: ["/banner.webp"],
  },
};

const groundTruths = ["MIT licensed", "self-hosted", "model agnostic", "git-backed"] as const;

/**
 * The two beats of a build, in the order a reader meets them. `said` is what a person types into
 * Chat; `built` is the artifact the named forge commits. Both are real paths the product writes,
 * so neither is dressed as a screenshot.
 */
const buildBeats = [
  {
    said: "Create a support ticket resource type with priority, status, customer, and owner.",
    forge: "resource-forge",
    artifact: "resources/support-ticket/schema.yml",
    built: "becomes a resource type your team and agents can write records against.",
  },
  {
    said: "Create a support agent that triages new tickets and drafts the first reply.",
    forge: "agent-forge",
    artifact: "agents/support/AGENT.md",
    built: "becomes a named agent, ready for its first turn.",
  },
] as const;

const businessSystem = [
  {
    title: "Resources",
    description:
      "Describe customers, tickets, assets, or any other part of your business. TulipFarm creates the resource types; your team and agents create the records.",
    href: "/docs/using-tulipfarm/resources",
    cell: "photo",
  },
  {
    title: "Agents + Skills",
    description:
      "Create named agents for specific jobs, then give them reusable skills for the work only they need to know.",
    href: "/docs/using-tulipfarm/agents",
    cell: "accent",
  },
  {
    title: "Knowledge",
    description:
      "Keep operational context in searchable spaces and pages, with links and provenance your agents can use.",
    href: "/docs/using-tulipfarm/knowledge",
    cell: "plain",
  },
  {
    title: "Routines + Integrations",
    description:
      "Schedule repeatable operations and connect the third-party systems where the rest of your business already happens.",
    href: "/docs/using-tulipfarm/build-a-routine",
    cell: "wide",
  },
] as const;

const controlPoints = [
  {
    name: "self-hosted runtime",
    detail: "Run the published container with Docker or Podman, from a laptop to your own server.",
    href: "/docs/self-hosting",
  },
  {
    name: "readable history",
    detail:
      "Every definition lives in the git-backed soul, so changes stay inspectable and portable.",
    href: "/docs/using-tulipfarm/what-a-soul-is",
  },
  {
    name: "swappable model providers",
    detail: "Configure Anthropic, OpenAI, Azure Foundry, or an OpenAI-compatible endpoint.",
    href: "/docs/administration/how-model-routing-works",
  },
  {
    name: "encrypted credentials",
    detail: "Secrets use envelope encryption with AES-256-GCM and independently wrapped keys.",
    href: "/docs/security/encryption",
  },
] as const;

const footerLinks = [
  { label: "install", href: "/docs/self-hosting/install" },
  { label: "get started", href: "/docs/using-tulipfarm/build-your-first-thing" },
  { label: "deploy", href: "/docs/self-hosting" },
  { label: "security", href: "/docs/security/encryption" },
  { label: "privacy", href: "/docs/security/privacy" },
  { label: "docs", href: "/docs" },
];

export default function HomePage() {
  return (
    <div id="nd-page" className="tf-grain flex min-w-0 flex-1 flex-col overflow-x-clip">
      {/* Hero: asymmetric split. Brand wordmark, one proposition, one subtext, two links. The
          install panel is the hero's real visual, because it is the actual entry point. */}
      <section
        id="install"
        className="tf-ambient relative flex min-h-[calc(100dvh-3.5rem)] scroll-mt-20 flex-col"
      >
        <div className="mx-auto grid min-w-0 w-full max-w-6xl flex-1 gap-12 px-4 pt-16 pb-10 sm:px-6 sm:pt-20 lg:grid-cols-2 lg:items-center lg:gap-14 lg:py-14">
          <div className="min-w-0">
            <p
              className="text-sm font-bold tracking-tight text-fd-muted-foreground motion-safe:animate-rise"
              style={{ animationDelay: "80ms" }}
            >
              tulipfarm
              <span aria-hidden className="animate-cursor text-fd-primary">
                ▍
              </span>
            </p>
            <h1
              className="mt-5 text-balance text-4xl font-bold leading-[1.02] tracking-[-0.03em] sm:text-5xl lg:text-[4.25rem] motion-safe:animate-rise"
              style={{ animationDelay: "160ms" }}
            >
              Describe your business. Get the system that runs it.
            </h1>
            <p
              className="mt-6 max-w-[46ch] text-base leading-7 text-fd-muted-foreground sm:text-lg motion-safe:animate-rise"
              style={{ animationDelay: "240ms" }}
            >
              Chat turns your operations into resources, agents, routines, and knowledge, kept in a
              git-backed soul on your infrastructure.
            </p>
            <div
              className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3 text-sm motion-safe:animate-rise"
              style={{ animationDelay: "320ms" }}
            >
              <a
                href="#how-it-works"
                className="group min-h-11 content-center font-medium text-fd-primary transition-colors hover:text-fd-primary/80 active:text-fd-primary/70"
              >
                see how it works{" "}
                <span
                  aria-hidden
                  className="inline-block transition-transform duration-200 group-hover:translate-y-0.5"
                >
                  ↓
                </span>
              </a>
              <Link
                href="/docs"
                className="group min-h-11 content-center text-fd-muted-foreground transition-colors hover:text-fd-foreground"
              >
                read the docs{" "}
                <span
                  aria-hidden
                  className="inline-block transition-transform duration-200 group-hover:translate-x-0.5"
                >
                  →
                </span>
              </Link>
            </div>
          </div>
          <div className="min-w-0 motion-safe:animate-rise" style={{ animationDelay: "260ms" }}>
            <InstallCommand />
          </div>
        </div>

        <div className="relative h-36 w-full sm:h-44">
          <TulipField className="absolute inset-0 size-full" />
        </div>
      </section>

      {/* Ground truths: a full-width strip. Lives under the hero, never inside it. */}
      <section aria-label="What TulipFarm is" className="border-y border-fd-border">
        <ul className="mx-auto grid w-full max-w-6xl grid-cols-2 gap-x-6 px-4 font-mono text-xs text-fd-muted-foreground sm:grid-cols-4 sm:px-6">
          {groundTruths.map((truth) => (
            <li key={truth} className="flex min-h-12 items-center gap-2.5 py-3">
              <span aria-hidden className="text-fd-primary">
                ▪
              </span>
              {truth}
            </li>
          ))}
        </ul>
      </section>

      {/* How it works: an editorial two-beat. What you say, then what gets written. No step
          numbers, no terminal chrome, no invented status line. */}
      <section id="how-it-works" className="scroll-mt-16">
        <div className="mx-auto w-full max-w-6xl px-4 py-24 sm:px-6 sm:py-32">
          <Reveal className="max-w-3xl">
            <h2 className="text-balance text-2xl font-bold tracking-[-0.03em] sm:text-4xl">
              Say what the business needs. Watch the system take shape.
            </h2>
            <p className="mt-5 max-w-[46ch] text-pretty text-base leading-7 text-fd-muted-foreground">
              TulipFarm is built through chat. The forge asks for the missing details, writes the
              underlying definitions, commits them to the soul, and reconciles them live.
            </p>
          </Reveal>

          <div className="mt-14 grid gap-10 lg:gap-12">
            {buildBeats.map((beat, index) => (
              <Reveal key={beat.artifact} delay={index * 80}>
                <div className="grid gap-6 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:gap-14">
                  <blockquote className="border-s-2 border-fd-primary py-1 ps-5 text-lg leading-8 tracking-tight text-fd-foreground sm:text-xl sm:leading-9">
                    “{beat.said}”
                  </blockquote>
                  {/* The artifact is rendered as the file it actually is, rather than described in
                      a sentence, so the right column carries its own weight. */}
                  <figure className="overflow-hidden rounded-md border border-fd-border bg-fd-card">
                    <figcaption className="flex items-center gap-2 border-b border-fd-border px-4 py-2.5 font-mono text-xs">
                      <span className="text-fd-primary">{beat.forge}</span>
                      <span className="text-fd-muted-foreground">writes</span>
                    </figcaption>
                    <div className="px-4 py-3.5">
                      <p className="font-mono text-xs leading-5 [overflow-wrap:anywhere] text-fd-foreground">
                        {beat.artifact}
                      </p>
                      <p className="mt-3 flex gap-2 text-sm leading-6 text-fd-muted-foreground">
                        <span aria-hidden className="text-fd-primary">
                          →
                        </span>
                        <span>{beat.built}</span>
                      </p>
                    </div>
                  </figure>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* The business system: a bento with exactly four cells for four ideas, and real surface
          variation so it does not read as four identical cream cards. */}
      <section className="border-t border-fd-border">
        <div className="mx-auto w-full max-w-6xl px-4 py-24 sm:px-6 sm:py-32">
          <Reveal className="max-w-3xl">
            <h2 className="text-balance text-2xl font-bold tracking-[-0.03em] sm:text-4xl">
              One place for what your business is, knows, and does.
            </h2>
          </Reveal>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {businessSystem.map((item, index) => (
              <Reveal
                key={item.title}
                delay={Math.min(index * 60, 180)}
                className={
                  item.cell === "photo" || item.cell === "wide" ? "h-full sm:col-span-2" : "h-full"
                }
              >
                <Link
                  href={item.href}
                  className={`group relative flex h-full flex-col justify-end overflow-hidden rounded-lg border p-6 transition-colors duration-200 sm:p-8 active:translate-y-px ${
                    item.cell === "photo"
                      ? "min-h-72 border-fd-border text-white"
                      : item.cell === "accent"
                        ? "border-fd-primary/35 bg-fd-primary/12 hover:border-fd-primary/55 hover:bg-fd-primary/18"
                        : "border-fd-border bg-fd-card hover:border-fd-primary/30 hover:bg-fd-accent/60"
                  }`}
                >
                  {item.cell === "photo" ? (
                    <>
                      <picture className="absolute inset-0 -z-10 block">
                        <source srcSet="/banner.avif" type="image/avif" />
                        <source srcSet="/banner.webp" type="image/webp" />
                        <img
                          src="/banner.webp"
                          alt=""
                          width={1600}
                          height={900}
                          loading="lazy"
                          decoding="async"
                          className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                        />
                      </picture>
                      <div
                        aria-hidden
                        className="absolute inset-0 -z-10 bg-[linear-gradient(to_top,oklch(0_0_0/0.92)_0%,oklch(0_0_0/0.84)_34%,oklch(0_0_0/0.5)_66%,oklch(0_0_0/0.18)_100%)]"
                      />
                    </>
                  ) : null}
                  {/* Title and affordance share one row: a bare arrow on its own line reads as an
                      orphaned glyph rather than as the link it belongs to. */}
                  <div className="flex items-baseline justify-between gap-4">
                    <h3 className="text-lg font-semibold tracking-tight">{item.title}</h3>
                    <span
                      aria-hidden
                      className={`shrink-0 transition-transform duration-200 group-hover:translate-x-1 ${
                        item.cell === "photo" ? "text-white/80" : "text-fd-primary"
                      }`}
                    >
                      →
                    </span>
                  </div>
                  <p
                    className={`mt-3 max-w-prose text-sm leading-6 ${
                      item.cell === "photo" ? "text-white/85" : "text-fd-muted-foreground"
                    }`}
                  >
                    {item.description}
                  </p>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Control plane: a hairline row list. Deliberately not the bento family above. */}
      <section className="border-t border-fd-border bg-fd-card">
        <div className="mx-auto grid w-full max-w-6xl gap-12 px-4 py-24 sm:px-6 sm:py-32 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
          <Reveal>
            <h2 className="text-balance text-2xl font-bold tracking-[-0.03em] sm:text-4xl">
              Control is something you can inspect.
            </h2>
            <p className="mt-5 text-pretty text-base leading-7 text-fd-muted-foreground">
              Your operational definitions are files. Your business data is in PostgreSQL. Your
              model credentials stay encrypted. Nothing important is hidden behind a proprietary
              dashboard.
            </p>
          </Reveal>

          <div className="divide-y divide-fd-border border-y border-fd-border">
            {controlPoints.map((point, index) => (
              <Reveal key={point.name} delay={Math.min(index * 50, 150)}>
                <Link
                  href={point.href}
                  className="group grid gap-2 border-s-2 border-transparent px-3 py-5 transition-colors duration-200 hover:border-fd-primary hover:bg-fd-accent/60 active:bg-fd-accent sm:grid-cols-[13rem_1fr_auto] sm:items-baseline sm:gap-5 sm:px-5"
                >
                  <span className="font-mono text-sm font-medium">{point.name}</span>
                  <span className="text-sm leading-6 text-fd-muted-foreground">{point.detail}</span>
                  <span
                    aria-hidden
                    className="text-fd-primary transition-transform duration-200 group-hover:translate-x-1"
                  >
                    →
                  </span>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Closer: type-led, one CTA, one intent. Centred so the surrounding space reads as
          deliberate focus rather than as an unfilled right-hand column. */}
      <section className="tf-ambient border-t border-fd-border">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-4 py-28 text-center sm:px-6 sm:py-40">
          <Reveal className="flex flex-col items-center">
            <h2 className="text-balance text-3xl font-bold leading-[1.05] tracking-[-0.03em] sm:text-5xl">
              Give your business a soul. Put it to work.
            </h2>
            <p className="mt-6 max-w-[44ch] text-pretty text-base leading-7 text-fd-muted-foreground">
              Start with one operation. Keep building until the system fits the business, not the
              other way around.
            </p>
            <a
              href="#install"
              className="group mt-10 inline-flex min-h-12 w-max items-center gap-2 whitespace-nowrap rounded-sm bg-tf-fill px-7 text-sm font-medium text-tf-fill-foreground transition-colors duration-200 hover:bg-tf-fill-hover active:translate-y-px"
            >
              see install command
              <span
                aria-hidden
                className="inline-block transition-transform duration-200 group-hover:-translate-y-0.5"
              >
                ↑
              </span>
            </a>
          </Reveal>
        </div>
      </section>

      <footer className="border-t border-fd-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 text-xs text-fd-muted-foreground sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <p>tulipfarm. the AI-native business operating system.</p>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-3">
            {footerLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="min-h-11 content-center transition-colors hover:text-fd-foreground"
              >
                {link.label}
              </Link>
            ))}
            <a
              href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
              rel="noreferrer noopener"
              target="_blank"
              className="min-h-11 content-center transition-colors hover:text-fd-foreground"
            >
              github ↗
            </a>
            <a
              href="/llms.txt"
              className="min-h-11 content-center transition-colors hover:text-fd-foreground"
            >
              llms.txt
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
