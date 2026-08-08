import { describe, expect, it } from "vitest";
import {
  GITHUB_DELIVERY_HEADER,
  GITHUB_SIGNATURE_HEADER,
  GitHubEventError,
  githubWebhookVerification,
  normalizeGitHubCheckRunEvent,
  normalizeGitHubIssueEvent,
  normalizeGitHubPullRequestEvent,
  normalizeGitHubPushEvent,
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

const prPayload = {
  action: "opened",
  pull_request: {
    number: 12,
    title: "Fix crash",
    body: "closes #41",
    state: "open",
    html_url: "https://github.com/tulip/farm/pull/12",
    merged: false,
    head: { ref: "fix-crash", sha: "abc123" },
    base: { ref: "main", sha: "def456" },
    labels: [{ name: "bug" }],
  },
  repository: { full_name: "tulip/farm", owner: { login: "tulip" }, name: "farm" },
  sender: { login: "reporter", id: 99 },
  installation: { id: 7 },
};

describe("normalizeGitHubPullRequestEvent", () => {
  it("projects the provider payload onto a typed pull request event", () => {
    expect(normalizeGitHubPullRequestEvent(prPayload)).toEqual({
      action: "opened",
      repository: { owner: "tulip", repo: "farm" },
      repositoryRef: "tulip/farm",
      installationId: "7",
      pullRequest: {
        number: 12,
        title: "Fix crash",
        body: "closes #41",
        state: "open",
        htmlUrl: "https://github.com/tulip/farm/pull/12",
        merged: false,
        headRef: "fix-crash",
        headSha: "abc123",
        baseRef: "main",
        labels: ["bug"],
      },
      sender: { login: "reporter", externalId: "99" },
    });
  });

  it("normalizes a missing body to an empty string rather than dropping the field", () => {
    const withoutBody = { ...prPayload, pull_request: { ...prPayload.pull_request, body: null } };
    expect(normalizeGitHubPullRequestEvent(withoutBody).pullRequest.body).toBe("");
  });

  it("refuses an unsupported action instead of guessing one", () => {
    expect(() => normalizeGitHubPullRequestEvent({ ...prPayload, action: "transferred" })).toThrow(
      expect.objectContaining({ code: "unsupported_action" })
    );
  });

  it("refuses a payload missing the installation, so scope can never be assumed", () => {
    const { installation: _installation, ...rest } = prPayload;
    expect(() => normalizeGitHubPullRequestEvent(rest)).toThrow(
      expect.objectContaining({ code: "malformed_payload" })
    );
  });

  it("refuses an issue payload fed to the pull request normalizer", () => {
    expect(() => normalizeGitHubPullRequestEvent(payload)).toThrow(GitHubEventError);
  });
});

const pushPayload = {
  ref: "refs/heads/main",
  before: "abc111",
  after: "abc222",
  repository: { full_name: "tulip/farm", owner: { login: "tulip" }, name: "farm" },
  sender: { login: "reporter", id: 99 },
  installation: { id: 7 },
  commits: [
    {
      id: "abc222",
      message: "fix crash",
      url: "https://github.com/tulip/farm/commit/abc222",
    },
  ],
};

describe("normalizeGitHubPushEvent", () => {
  it("projects the provider payload onto a typed push event", () => {
    expect(normalizeGitHubPushEvent(pushPayload)).toEqual({
      repository: { owner: "tulip", repo: "farm" },
      repositoryRef: "tulip/farm",
      installationId: "7",
      ref: "refs/heads/main",
      before: "abc111",
      after: "abc222",
      forced: false,
      deleted: false,
      commits: [
        {
          id: "abc222",
          message: "fix crash",
          url: "https://github.com/tulip/farm/commit/abc222",
        },
      ],
      sender: { login: "reporter", externalId: "99" },
    });
  });

  it("refuses a payload carrying an action, since push never sends one", () => {
    expect(() => normalizeGitHubPushEvent({ ...pushPayload, action: "opened" })).toThrow(
      expect.objectContaining({ code: "malformed_payload" })
    );
  });

  it("refuses a payload missing commits", () => {
    const { commits: _commits, ...rest } = pushPayload;
    expect(() => normalizeGitHubPushEvent(rest)).toThrow(
      expect.objectContaining({ code: "malformed_payload" })
    );
  });
});

const checkRunPayload = {
  action: "completed",
  check_run: {
    id: 555,
    name: "build",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/tulip/farm/runs/555",
    head_sha: "abc222",
  },
  repository: { full_name: "tulip/farm", owner: { login: "tulip" }, name: "farm" },
  sender: { login: "reporter", id: 99 },
  installation: { id: 7 },
};

describe("normalizeGitHubCheckRunEvent", () => {
  it("projects the provider payload onto a typed check run event", () => {
    expect(normalizeGitHubCheckRunEvent(checkRunPayload)).toEqual({
      action: "completed",
      repository: { owner: "tulip", repo: "farm" },
      repositoryRef: "tulip/farm",
      installationId: "7",
      checkRun: {
        id: 555,
        name: "build",
        status: "completed",
        conclusion: "success",
        htmlUrl: "https://github.com/tulip/farm/runs/555",
        headSha: "abc222",
      },
      sender: { login: "reporter", externalId: "99" },
    });
  });

  it("normalizes a null conclusion rather than dropping the field", () => {
    const inProgress = {
      ...checkRunPayload,
      action: "created",
      check_run: { ...checkRunPayload.check_run, conclusion: null },
    };
    expect(normalizeGitHubCheckRunEvent(inProgress).checkRun.conclusion).toBeNull();
  });

  it("refuses an unsupported action instead of guessing one", () => {
    expect(() => normalizeGitHubCheckRunEvent({ ...checkRunPayload, action: "deleted" })).toThrow(
      expect.objectContaining({ code: "unsupported_action" })
    );
  });

  it("refuses a payload missing the installation, so scope can never be assumed", () => {
    const { installation: _installation, ...rest } = checkRunPayload;
    expect(() => normalizeGitHubCheckRunEvent(rest)).toThrow(
      expect.objectContaining({ code: "malformed_payload" })
    );
  });
});
