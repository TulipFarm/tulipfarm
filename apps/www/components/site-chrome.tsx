import { docsUrl, GITHUB_URL } from "@/lib/site";
import { Brand } from "./brand";
import { ArrowRight, Menu } from "./icons";

const links = [
  { label: "How it works", href: "/#how-it-works" },
  { label: "Examples", href: "/#examples" },
  { label: "Docs", href: docsUrl() },
  { label: "GitHub", href: GITHUB_URL },
];

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="site-container header-inner">
        <Brand />
        <nav className="desktop-nav" aria-label="Main">
          {links.map((link) => (
            <a key={link.label} href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>
        <div className="header-actions">
          <a className="button button-secondary button-small" href="/deploy">
            Start building <ArrowRight size={16} />
          </a>
          <details className="mobile-menu">
            <summary aria-label="Navigation menu">
              <Menu size={22} />
            </summary>
            <nav aria-label="Mobile">
              {links.map((link) => (
                <a key={link.label} href={link.href}>
                  {link.label}
                </a>
              ))}
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-container footer-main">
        <div>
          <Brand />
          <p>Your operations, built through chat.</p>
        </div>
        <nav aria-label="Footer">
          <a href="/deploy">Start building</a>
          <a href={docsUrl()}>Documentation</a>
          <a href={GITHUB_URL}>GitHub</a>
          <a href={docsUrl("/docs/security/telemetry")}>Data and telemetry</a>
        </nav>
      </div>
      <div className="site-container footer-note">
        <span>Built in the open. Run on your terms.</span>
        <span>TulipFarm</span>
      </div>
    </footer>
  );
}
