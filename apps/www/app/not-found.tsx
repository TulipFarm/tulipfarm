import { TulipMark } from "@/components/brand";
import { ArrowRight } from "@/components/icons";
import { docsUrl } from "@/lib/site";

export default function NotFound() {
  return (
    <main id="main-content" className="not-found marketing-page site-container">
      <div className="not-found-code" aria-hidden="true">
        <TulipMark size={46} />
        <span>404</span>
      </div>
      <h1>Page not found.</h1>
      <p>
        That link doesn&apos;t lead to a page here. Head back home, or look in the documentation.
      </p>
      <div className="hero-actions">
        <a href="/" className="button button-primary">
          Go home <ArrowRight size={17} />
        </a>
        <a href={docsUrl()} className="button button-secondary">
          Read the docs <ArrowRight size={17} />
        </a>
      </div>
    </main>
  );
}
