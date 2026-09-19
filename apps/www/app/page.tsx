import type { Metadata } from "next";
import { TulipMark } from "@/components/brand";
import { BusinessDemo } from "@/components/business-demo";
import { ArrowRight, Check, RotateCcw, ShieldCheck, Text, X } from "@/components/icons";
import { businessExamples } from "@/lib/examples";
import { docsUrl, SITE_URL } from "@/lib/site";

export const metadata: Metadata = { alternates: { canonical: SITE_URL } };

const questions = [
  {
    question: "Is this a chatbot or a business tool?",
    answer:
      "Chat is how you build and use your business system. TulipFarm stores records, configures agents, and runs routines. The work persists after you close the chat.",
  },
  {
    question: "Do I need to write code?",
    answer:
      "You describe the resource types, agents, and routines you want in chat. TulipFarm builds them. Installing and maintaining the self-hosted instance still requires an operator.",
  },
  {
    question: "Where does my data go?",
    answer:
      "Your instance runs on your infrastructure. Agent actions can send data to the model providers and integrations you authorize. Product telemetry has a separate, documented policy.",
    link: {
      label: "Read the data and telemetry policy",
      href: docsUrl("/docs/security/telemetry"),
    },
  },
  {
    question: "What do I need to get started?",
    answer:
      "A supported host and access to a model provider. The setup guide helps you choose a deployment target and walks through installation. Hosting and model usage are your responsibility.",
    link: { label: "Start building", href: "/deploy" },
  },
];

export default function HomePage() {
  return (
    <main id="main-content" className="marketing-page">
      <section className="opening site-container" aria-labelledby="hero-title">
        <h1 id="hero-title">
          Your business. <span>Built in chat.</span>
        </h1>
        <p className="opening-description">
          Describe what your business needs. Build it in chat, then let agents handle the
          day-to-day.
        </p>
        <div className="hero-actions">
          <a className="button button-primary" href="/deploy">
            Start building <ArrowRight size={18} />
          </a>
          <a className="hero-secondary" href="#examples">
            See what you can build <ArrowRight className="down-arrow" size={16} />
          </a>
        </div>
      </section>

      <BusinessDemo examples={businessExamples} />

      <section
        className="work-section site-container"
        id="how-it-works"
        aria-label="Agents and routines"
      >
        <article className="capability-card agent-capability">
          <div className="capability-copy">
            <h2>
              Give an agent a job.
              <br />
              Not every permission.
            </h2>
            <p>
              Let it read and update tickets. Keep refunds with your team. You set the tools and
              boundaries.
            </p>
            <a href={docsUrl("/docs/using-tulipfarm/agents")} className="text-link">
              Meet your agents <ArrowRight size={16} />
            </a>
          </div>
          <figure className="authority-map">
            <div className="authority-agent">
              <span className="authority-glyph">
                <ShieldCheck size={30} />
              </span>
              <strong>Support agent</strong>
            </div>
            <svg
              className="authority-connections"
              viewBox="0 0 600 56"
              preserveAspectRatio="none"
              fill="none"
              aria-hidden="true"
            >
              <path d="M300 0V20M100 56V32Q100 20 112 20H488Q500 20 500 32V56M300 20V56" />
            </svg>
            <ul className="authority-branches">
              <li>
                <Check size={16} />
                Read tickets
              </li>
              <li>
                <Check size={16} />
                Update tickets
              </li>
              <li className="authority-denied">
                <X size={15} />
                No refund tool
              </li>
            </ul>
            <figcaption>Illustrated example of an agent&apos;s authority.</figcaption>
          </figure>
        </article>
        <article className="capability-card routine-capability">
          <div className="capability-copy">
            <h2>
              Some work
              <br />
              should repeat itself.
            </h2>
            <p>Schedule a daily review. Come back to a summary of what needs your attention.</p>
            <a href={docsUrl("/docs/using-tulipfarm/routines")} className="text-link">
              Make it a routine <ArrowRight size={16} />
            </a>
          </div>
          <figure className="routine-map">
            <ol>
              <li>
                <span className="routine-glyph">
                  <RotateCcw size={20} />
                </span>
                <span>
                  <strong>Every day</strong>
                  <small>A schedule starts the run</small>
                </span>
              </li>
              <li>
                <span className="routine-glyph">
                  <ShieldCheck size={20} />
                </span>
                <span>
                  <strong>Review open tickets</strong>
                  <small>Your support agent does the work</small>
                </span>
              </li>
              <li>
                <span className="routine-glyph">
                  <Text size={20} />
                </span>
                <span>
                  <strong>A summary to review</strong>
                  <small>You can inspect the run</small>
                </span>
              </li>
            </ol>
            <figcaption>Example routine, not a live run.</figcaption>
          </figure>
        </article>
      </section>

      <section className="control-section site-container" aria-labelledby="control-title">
        <div className="control-heading">
          <h2 id="control-title">
            Self-hosted.
            <br />
            <span>On your terms.</span>
          </h2>
          <a href={docsUrl("/docs/security")} className="text-link">
            Read about security <ArrowRight size={17} />
          </a>
        </div>
        <div className="control-details">
          <article>
            <h3>Your infrastructure</h3>
            <p>Run TulipFarm on a host you control, with your own model provider connections.</p>
          </article>
          <article>
            <h3>Your permissions</h3>
            <p>
              Scope an agent&apos;s authority. Keep sensitive actions behind the approvals you
              configure.
            </p>
          </article>
          <article>
            <h3>Your audit trail</h3>
            <p>
              Review routine runs and their events. Configuration changes have a git-backed history.
            </p>
          </article>
        </div>
      </section>

      <section className="faq-section site-container" aria-labelledby="faq-title">
        <h2 id="faq-title">A few things to know.</h2>
        <div className="faq-list">
          {questions.map(({ question, answer, link }) => (
            <details key={question}>
              <summary>
                {question}
                <span aria-hidden="true">+</span>
              </summary>
              <div>
                <p>{answer}</p>
                {link && (
                  <a className="text-link" href={link.href}>
                    {link.label}
                    <ArrowRight size={16} />
                  </a>
                )}
              </div>
            </details>
          ))}
        </div>
      </section>

      <section className="closing-section site-container" aria-labelledby="closing-title">
        <span className="closing-mark">
          <TulipMark size={45} />
        </span>
        <h2 id="closing-title">What will you build first?</h2>
        <p>Set up TulipFarm, then bring your first request.</p>
        <a className="button button-primary" href="/deploy">
          Start building <ArrowRight size={18} />
        </a>
      </section>
    </main>
  );
}
