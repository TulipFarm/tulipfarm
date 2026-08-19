import type { Metadata } from "next";
import Link from "next/link";
import { InstallCommand } from "@/components/home/install-command";
import { Reveal } from "@/components/home/reveal";
import { TulipField } from "@/components/home/tulip-field";
import { appName, gitConfig } from "@/lib/shared";

export const metadata: Metadata = {
  title: "TulipFarm — Build your business operating system by chatting",
  alternates: { canonical: "/" },
  description:
    "Self-host the workspace where Chat turns your business operations into Resources, Agents, Routines, and Knowledge.",
  openGraph: {
    type: "website",
    siteName: appName,
    locale: "en_US",
    url: "/",
    title: "TulipFarm — Give your business a Soul. Put it to work.",
    description:
      "Build business operations by chatting, keep them in a git-backed Soul, and run them on your infrastructure.",
    images: ["/banner.webp"],
  },
};

const businessSystem = [
  {
    label: "model",
    title: "Resources",
    description:
      "Describe customers, tickets, assets, or any other part of your business. TulipFarm creates the Resource types; your team and Agents create the Records.",
    href: "/docs/using-tulipfarm/resources",
  },
  {
    label: "work",
    title: "Agents + Skills",
    description:
      "Create named Agents for specific jobs, then give them reusable Skills for the work only they need to know.",
    href: "/docs/using-tulipfarm/agents",
  },
  {
    label: "know",
    title: "Knowledge",
    description:
      "Keep operational context in searchable Spaces and Pages, with links and provenance your Agents can use.",
    href: "/docs/using-tulipfarm/knowledge",
  },
  {
    label: "run",
    title: "Routines + Integrations",
    description:
      "Schedule repeatable operations and connect the third-party systems where the rest of your business already happens.",
    href: "/docs/using-tulipfarm/build-a-routine",
  },
];

const controlPoints = [
  {
    name: "your infrastructure",
    detail: "Run the published container with Docker or Podman, from a laptop to your own server.",
    href: "/docs/self-hosting",
  },
  {
    name: "readable history",
    detail:
      "Every definition lives in the git-backed Soul, so changes stay inspectable and portable.",
    href: "/docs/using-tulipfarm/what-a-soul-is",
  },
  {
    name: "your model providers",
    detail: "Configure Anthropic, OpenAI, Azure Foundry, or an OpenAI-compatible endpoint.",
    href: "/docs/administration/how-model-routing-works",
  },
  {
    name: "encrypted credentials",
    detail: "Secrets use envelope encryption with AES-256-GCM and independently wrapped keys.",
    href: "/docs/security/encryption",
  },
];

const footerLinks = [
  { label: "install", href: "/docs/self-hosting/install" },
  { label: "get started", href: "/docs/using-tulipfarm/build-your-first-thing" },
  { label: "deploy", href: "/docs/self-hosting" },
  { label: "security", href: "/docs/security/encryption" },
  { label: "docs", href: "/docs" },
];

function SectionLabel({ children }: { children: string }) {
  return <p className="text-xs uppercase tracking-[0.2em] text-fd-muted-foreground">{children}</p>;
}

export default function HomePage() {
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-x-clip">
      <section
        id="install"
        className="relative flex min-h-[calc(100dvh-3.5rem)] scroll-mt-20 flex-col"
      >
        <div className="mx-auto grid min-w-0 w-full max-w-6xl flex-1 gap-12 px-4 pt-16 pb-10 sm:px-6 sm:pt-20 lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:gap-16 lg:py-14">
          <div className="min-w-0">
            <SectionLabel>[self-hosted business os]</SectionLabel>
            <h1
              className="mt-5 text-4xl font-bold tracking-tight sm:text-6xl motion-safe:animate-rise"
              style={{ animationDelay: "120ms" }}
            >
              tulipfarm
              <span aria-hidden className="animate-cursor text-fd-primary">
                ▍
              </span>
            </h1>
            <p
              className="mt-6 max-w-xl text-xl font-medium leading-8 tracking-tight sm:text-2xl motion-safe:animate-rise"
              style={{ animationDelay: "200ms" }}
            >
              Build the operating system your business actually needs—by describing it.
            </p>
            <p
              className="mt-5 max-w-xl text-sm leading-6 text-fd-muted-foreground sm:text-base motion-safe:animate-rise"
              style={{ animationDelay: "280ms" }}
            >
              Chat turns your operations into Resources, Agents, Routines, and Knowledge. TulipFarm
              keeps the definitions in your Soul and runs them on your infrastructure.
            </p>
            <div
              className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3 text-xs motion-safe:animate-rise"
              style={{ animationDelay: "360ms" }}
            >
              <a
                href="#how-it-works"
                className="min-h-11 content-center font-medium text-fd-primary transition-colors duration-150 hover:text-fd-primary/80"
              >
                [+] see how it works ↓
              </a>
              <Link
                href="/docs"
                className="min-h-11 content-center text-fd-muted-foreground transition-colors duration-150 hover:text-fd-foreground"
              >
                read the manual →
              </Link>
            </div>
          </div>
          <div className="min-w-0 motion-safe:animate-rise" style={{ animationDelay: "260ms" }}>
            <InstallCommand />
          </div>
        </div>

        <div className="border-y border-fd-border">
          <div className="mx-auto grid w-full max-w-6xl grid-cols-2 divide-x divide-y divide-fd-border px-4 text-center text-[11px] uppercase tracking-[0.12em] text-fd-muted-foreground sm:grid-cols-4 sm:divide-y-0 sm:px-6">
            <p className="py-3">MIT licensed</p>
            <p className="py-3">self-hosted</p>
            <p className="py-3">bring your own LLM</p>
            <p className="py-3">git-backed Soul</p>
          </div>
        </div>

        <div className="relative h-36 w-full sm:h-44">
          <TulipField className="absolute inset-0 size-full" />
        </div>
      </section>

      <section id="how-it-works" className="scroll-mt-16 border-t border-fd-border">
        <div className="mx-auto w-full max-w-6xl px-4 py-24 sm:px-6 sm:py-32">
          <Reveal className="max-w-3xl">
            <SectionLabel>[from request to operation]</SectionLabel>
            <h2 className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">
              Say what the business needs. Watch the system take shape.
            </h2>
            <p className="mt-5 text-sm leading-6 text-fd-muted-foreground sm:text-base">
              TulipFarm is built through Chat. Forges gather the missing details, write the
              underlying definitions, commit them to the Soul, and reconcile them live.
            </p>
          </Reveal>

          <Reveal delay={100} className="mt-12">
            <div className="overflow-hidden rounded-lg border border-fd-border bg-fd-card">
              <div className="grid border-b border-fd-border md:grid-cols-[8rem_1fr_1fr]">
                <p className="border-b border-fd-border p-4 text-xs uppercase tracking-[0.2em] text-fd-muted-foreground md:border-r md:border-b-0">
                  [01 ask]
                </p>
                <div className="border-b border-fd-border p-5 md:border-r md:border-b-0 sm:p-6">
                  <p className="text-xs text-fd-muted-foreground">you → Chat</p>
                  <p className="mt-3 text-sm leading-6 text-fd-foreground">
                    “Create a support ticket Resource type with priority, status, customer, and
                    owner.”
                  </p>
                </div>
                <div className="p-5 sm:p-6">
                  <p className="text-xs text-fd-muted-foreground">resource-forge</p>
                  <pre className="mt-3 overflow-x-auto text-[13px] leading-6 text-fd-foreground">
                    resources/support-ticket/schema.yml{"\n"}
                    <span className="text-fd-primary">✓ committed · reconciled · live</span>
                  </pre>
                </div>
              </div>
              <div className="grid md:grid-cols-[8rem_1fr_1fr]">
                <p className="border-b border-fd-border p-4 text-xs uppercase tracking-[0.2em] text-fd-muted-foreground md:border-r md:border-b-0">
                  [02 build]
                </p>
                <div className="border-b border-fd-border p-5 md:border-r md:border-b-0 sm:p-6">
                  <p className="text-xs text-fd-muted-foreground">you → same Chat</p>
                  <p className="mt-3 text-sm leading-6 text-fd-foreground">
                    “Create a support Agent that triages new tickets and drafts the first reply.”
                  </p>
                </div>
                <div className="p-5 sm:p-6">
                  <p className="text-xs text-fd-muted-foreground">agent-forge</p>
                  <pre className="mt-3 overflow-x-auto text-[13px] leading-6 text-fd-foreground">
                    agents/support/AGENT.md{"\n"}
                    <span className="text-fd-primary">✓ committed · ready for turns</span>
                  </pre>
                </div>
              </div>
            </div>
          </Reveal>

          <Reveal delay={160} className="mt-5">
            <p className="border-l-2 border-fd-primary py-2 pl-4 text-sm leading-6 text-fd-muted-foreground">
              The interface is Chat. The result is a readable business system you can inspect,
              version, back up, and run.
            </p>
          </Reveal>
        </div>
      </section>

      <section className="border-t border-fd-border">
        <div className="mx-auto w-full max-w-6xl px-4 py-24 sm:px-6 sm:py-32">
          <Reveal className="max-w-3xl">
            <SectionLabel>[the business system]</SectionLabel>
            <h2 className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">
              One place for what your business is, knows, and does.
            </h2>
          </Reveal>

          <div className="mt-12 border-y border-fd-border">
            {businessSystem.map((item, index) => (
              <Reveal key={item.label} delay={Math.min(index * 50, 150)}>
                <Link
                  href={item.href}
                  className="group grid min-h-28 gap-3 border-l-2 border-transparent px-3 py-6 transition-colors duration-150 hover:border-fd-primary hover:bg-fd-accent/60 sm:grid-cols-[7rem_11rem_1fr_auto] sm:items-baseline sm:gap-5 sm:px-5"
                >
                  <span className="text-xs uppercase tracking-[0.16em] text-fd-muted-foreground">
                    [{item.label}]
                  </span>
                  <span className="text-sm font-medium">{item.title}</span>
                  <span className="max-w-2xl text-sm leading-6 text-fd-muted-foreground">
                    {item.description}
                  </span>
                  <span
                    aria-hidden
                    className="text-fd-primary opacity-100 transition-transform duration-150 group-hover:translate-x-1 sm:opacity-0 sm:group-hover:opacity-100"
                  >
                    →
                  </span>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-fd-border bg-fd-card">
        <div className="mx-auto grid w-full max-w-6xl gap-12 px-4 py-24 sm:px-6 sm:py-32 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
          <Reveal>
            <SectionLabel>[control plane]</SectionLabel>
            <h2 className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">
              Control is something you can inspect.
            </h2>
            <p className="mt-5 text-sm leading-6 text-fd-muted-foreground">
              Your operational definitions are files. Your business data is in PostgreSQL. Your
              model credentials stay encrypted. Nothing important is hidden behind a proprietary
              dashboard.
            </p>
          </Reveal>

          <div className="border-y border-fd-border">
            {controlPoints.map((point, index) => (
              <Reveal key={point.name} delay={Math.min(index * 50, 150)}>
                <Link
                  href={point.href}
                  className="group grid gap-2 border-l-2 border-transparent px-3 py-5 transition-colors duration-150 hover:border-fd-primary hover:bg-fd-accent/60 sm:grid-cols-[11rem_1fr_auto] sm:items-baseline sm:gap-5 sm:px-5"
                >
                  <span className="text-sm font-medium">[{point.name}]</span>
                  <span className="text-sm leading-6 text-fd-muted-foreground">{point.detail}</span>
                  <span
                    aria-hidden
                    className="text-fd-primary transition-transform duration-150 group-hover:translate-x-1"
                  >
                    →
                  </span>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-fd-border">
        <div className="mx-auto w-full max-w-6xl px-4 py-24 sm:px-6 sm:py-32">
          <Reveal>
            <div className="grid overflow-hidden rounded-lg border border-fd-border bg-fd-card lg:grid-cols-[1.45fr_0.75fr]">
              <picture className="relative block aspect-[16/10] overflow-hidden border-b border-fd-border lg:aspect-auto lg:min-h-[30rem] lg:border-r lg:border-b-0">
                <source srcSet="/banner.avif" type="image/avif" />
                <source srcSet="/banner.webp" type="image/webp" />
                <img
                  src="/banner.webp"
                  alt="Rows of tulips on a farm at sunrise"
                  width={1600}
                  height={900}
                  loading="lazy"
                  decoding="async"
                  className="absolute inset-0 size-full object-cover"
                />
              </picture>
              <div className="flex flex-col justify-between gap-12 p-6 sm:p-8 lg:p-10">
                <div>
                  <SectionLabel>[the farm]</SectionLabel>
                  <h2 className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl">
                    Give it a Soul. Put it to work.
                  </h2>
                  <p className="mt-5 text-sm leading-6 text-fd-muted-foreground">
                    Start with one operation. Keep building until the system fits the business—not
                    the other way around.
                  </p>
                </div>
                <div className="flex flex-col gap-3">
                  <a
                    href="#install"
                    className="flex min-h-11 w-max items-center rounded-sm bg-fd-primary px-5 text-sm font-medium text-fd-primary-foreground transition-colors duration-150 hover:bg-fd-primary/90"
                  >
                    [+] install tulipfarm ↑
                  </a>
                  <Link
                    href="/docs/using-tulipfarm/build-your-first-thing"
                    className="flex min-h-11 items-center text-xs text-fd-muted-foreground transition-colors duration-150 hover:text-fd-foreground"
                  >
                    see the first ten minutes →
                  </Link>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      <footer className="border-t border-fd-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 text-xs text-fd-muted-foreground sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <p>tulipfarm — the AI-native business operating system</p>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-3">
            {footerLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="min-h-11 content-center transition-colors duration-150 hover:text-fd-foreground"
              >
                {link.label}
              </Link>
            ))}
            <a
              href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
              rel="noreferrer noopener"
              target="_blank"
              className="min-h-11 content-center transition-colors duration-150 hover:text-fd-foreground"
            >
              github ↗
            </a>
            <a
              href="/llms.txt"
              className="min-h-11 content-center transition-colors duration-150 hover:text-fd-foreground"
            >
              llms.txt
            </a>
          </nav>
        </div>
      </footer>
    </main>
  );
}
