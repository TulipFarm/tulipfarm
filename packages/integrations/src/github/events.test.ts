import { describe, expect, it } from "vitest";
import {
  GITHUB_DELIVERY_HEADER,
  GITHUB_SIGNATURE_HEADER,
  GitHubEventError,
  githubWebhookVerification,
  normalizeGitHubIssueEvent,
} from "./events";

const payload = {
  action: "opened",
  issue: {
    number: 41,
    title: "Crash on save",
    body: "steps to reproduce",
    state: "open",
    html_url: "https://github.com/tulip/farm/issues/41",
    labels: [{ name: "bug" }, { name: "needs-triage" }],
    user: { login: "reporter", id: 99 },
  },
  repository: { full_name: "tulip/farm", owner: { login: "tulip" }, name: "farm" },
  sender: { login: "reporter", id: 99 },
  installation: { id: 7 },
};

describe("githubWebhookVerification", () => {
  it("declares GitHub's signed-webhook ergonomics and never a polling credential", () => {
    expect(githubWebhookVerification("secret://github/webhook")).toEqual({
      method: "hmac_sha256",
      secretRef: "secret://github/webhook",
      signatureHeader: GITHUB_SIGNATURE_HEADER,
      signatureFormat: "sha256={signature}",
    });
  });

  it("names the delivery header the ingress deduplicates on", () => {
    expect(GITHUB_DELIVERY_HEADER).toBe("x-github-delivery");
  });
});

describe("normalizeGitHubIssueEvent", () => {
  it("projects the provider payload onto a typed issue event", () => {
    expect(normalizeGitHubIssueEvent(payload)).toEqual({
      action: "opened",
      repository: { owner: "tulip", repo: "farm" },
      repositoryRef: "tulip/farm",
      installationId: "7",
      issue: {
        number: 41,
        title: "Crash on save",
        body: "steps to reproduce",
        state: "open",
        htmlUrl: "https://github.com/tulip/farm/issues/41",
        labels: ["bug", "needs-triage"],
      },
      sender: { login: "reporter", externalId: "99" },
    });
  });

  it("normalizes a missing body to an empty string rather than dropping the field", () => {
    const withoutBody = { ...payload, issue: { ...payload.issue, body: null } };
    expect(normalizeGitHubIssueEvent(withoutBody).issue.body).toBe("");
  });

  it("refuses an unsupported action instead of guessing one", () => {
    expect(() => normalizeGitHubIssueEvent({ ...payload, action: "transferred" })).toThrow(
      expect.objectContaining({ code: "unsupported_action" })
    );
  });

  it("refuses a payload missing the repository", () => {
    const { repository: _repository, ...rest } = payload;
    expect(() => normalizeGitHubIssueEvent(rest)).toThrow(GitHubEventError);
  });

  it("refuses a payload missing the installation, so scope can never be assumed", () => {
    const { installation: _installation, ...rest } = payload;
    expect(() => normalizeGitHubIssueEvent(rest)).toThrow(
      expect.objectContaining({ code: "malformed_payload" })
    );
  });

  it("refuses a payload whose sender cannot be identified", () => {
    const { sender: _sender, ...rest } = payload;
    expect(() => normalizeGitHubIssueEvent(rest)).toThrow(GitHubEventError);
  });

  it("does not echo payload values in the denial message", () => {
    try {
      normalizeGitHubIssueEvent({ ...payload, action: "transferred" });
      expect.unreachable("expected denial");
    } catch (error) {
      expect((error as Error).message).not.toContain("Crash on save");
    }
  });
});
