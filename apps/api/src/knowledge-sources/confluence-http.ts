import type {
  ConfluenceApiPort,
  ConfluenceChange,
  ConfluencePage,
  ConfluencePagePermission,
} from "@tulipfarm/integrations";

const DEFAULT_API_BASE = "https://api.atlassian.com/ex/confluence";

interface ConfluenceHttpOptions {
  readonly accessToken: string;
  readonly cloudId: string;
  readonly baseUrl?: string;
}

interface SearchResponse {
  readonly results?: readonly {
    readonly id?: string;
    readonly status?: string;
    readonly version?: { readonly when?: string; readonly number?: number };
    readonly history?: { readonly lastUpdated?: { readonly when?: string } };
  }[];
}

interface PageResponse {
  readonly id?: string;
  readonly title?: string;
  readonly status?: string;
  readonly space?: { readonly id?: string; readonly key?: string };
  readonly version?: { readonly number?: number; readonly when?: string };
  readonly history?: {
    readonly createdBy?: { readonly accountId?: string };
    readonly lastUpdated?: { readonly when?: string };
  };
  readonly body?: { readonly storage?: { readonly value?: string } };
  readonly _links?: { readonly webui?: string; readonly base?: string };
  readonly ancestors?: readonly { readonly id?: string }[];
  readonly metadata?: {
    readonly labels?: { readonly results?: readonly { readonly name?: string }[] };
  };
}

interface RestrictionsResponse {
  readonly restrictions?: {
    readonly user?: { readonly results?: readonly { readonly accountId?: string }[] };
    readonly group?: {
      readonly results?: readonly { readonly id?: string; readonly name?: string }[];
    };
  };
}

interface SpacePermissionResponse {
  readonly results?: readonly {
    readonly subjects?: {
      readonly user?: { readonly results?: readonly { readonly accountId?: string }[] };
      readonly group?: {
        readonly results?: readonly { readonly id?: string; readonly name?: string }[];
      };
    };
    readonly operation?: { readonly operation?: string; readonly targetType?: string };
  }[];
}

interface GroupMembersResponse {
  readonly results?: readonly { readonly accountId?: string }[];
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function labelsFromPage(page: PageResponse): readonly string[] | undefined {
  const names = page.metadata?.labels?.results
    ?.map((label) => label.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  return names && names.length > 0 ? names : undefined;
}

function webUrl(page: PageResponse): string | undefined {
  const webui = page._links?.webui;
  if (!webui) return undefined;
  const base = page._links?.base;
  return base ? new URL(webui, base).toString() : webui;
}

/**
 * Confluence Cloud transport for Knowledge sync. It intentionally returns `undefined` when an
 * effective page ACL cannot be resolved, which makes sync remove content and fail closed.
 */
export class ConfluenceHttpKnowledgeApi implements ConfluenceApiPort {
  private readonly baseUrl: string;

  constructor(private readonly options: ConfluenceHttpOptions) {
    this.baseUrl =
      options.baseUrl?.replace(/\/+$/, "") ?? `${DEFAULT_API_BASE}/${options.cloudId}/wiki`;
  }

  async listChanged(input: { cursor?: string; pageLimit: number }): Promise<{
    readonly changes: readonly ConfluenceChange[];
    readonly nextCursor?: string;
  }> {
    const since = input.cursor ?? "1970-01-01T00:00:00.000Z";
    const cql = `type=page and lastmodified >= "${since}" order by lastmodified asc`;
    const response = await this.getJson<SearchResponse>(
      `/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${input.pageLimit}` +
        "&expand=version,history.lastUpdated"
    );
    const changes: ConfluenceChange[] = [];
    for (const result of response.results ?? []) {
      if (!result.id) continue;
      const cursor =
        result.history?.lastUpdated?.when ??
        result.version?.when ??
        (typeof result.version?.number === "number" ? String(result.version.number) : result.id);
      changes.push({
        pageId: result.id,
        cursor,
        ...(result.status === "trashed" ? { deleted: true } : {}),
      });
    }
    return { changes, nextCursor: changes.at(-1)?.cursor ?? input.cursor };
  }

  async getPage(pageId: string): Promise<ConfluencePage | undefined> {
    const page = await this.getJson<PageResponse>(
      `/rest/api/content/${encodeURIComponent(pageId)}` +
        "?expand=body.storage,version,space,history.createdBy,history.lastUpdated,metadata.labels"
    ).catch(() => undefined);
    if (!page || page.status === "trashed" || !page.id || !page.title || !page.space?.key) {
      return undefined;
    }
    const version = typeof page.version?.number === "number" ? String(page.version.number) : "0";
    return {
      id: page.id,
      title: page.title,
      spaceId: page.space.id ?? page.space.key,
      spaceKey: page.space.key,
      version,
      ownerAccountId: page.history?.createdBy?.accountId ?? "",
      updatedAt: page.history?.lastUpdated?.when ?? page.version?.when ?? new Date(0).toISOString(),
      content: stripHtml(page.body?.storage?.value ?? ""),
      ...(labelsFromPage(page) === undefined ? {} : { classification: labelsFromPage(page) }),
      ...(webUrl(page) === undefined ? {} : { webUrl: webUrl(page) }),
    };
  }

  async getPagePermissions(
    pageId: string
  ): Promise<readonly ConfluencePagePermission[] | undefined> {
    const page = await this.getJson<PageResponse>(
      `/rest/api/content/${encodeURIComponent(pageId)}?expand=space,ancestors`
    ).catch(() => undefined);
    if (page === undefined || !page.space?.key) return undefined;

    const spaceAccounts = await this.readSpaceAccounts(page.space.key);
    if (spaceAccounts === undefined) return undefined;
    let accounts = new Set(spaceAccounts);

    for (const restrictedId of [...(page.ancestors ?? []), { id: pageId }]) {
      if (!restrictedId.id) return undefined;
      const restricted = await this.readRestrictionAccounts(restrictedId.id);
      if (restricted === undefined) return undefined;
      if (restricted.length === 0) continue;
      const restrictedSet = new Set(restricted);
      accounts = new Set([...accounts].filter((accountId) => restrictedSet.has(accountId)));
    }

    return [...accounts].map((accountId) => ({ accountId }));
  }

  private async readSpaceAccounts(spaceKey: string): Promise<readonly string[] | undefined> {
    const space = await this.getJson<SpacePermissionResponse>(
      `/rest/api/space/${encodeURIComponent(spaceKey)}/permission`
    ).catch(() => undefined);
    if (space === undefined) return undefined;

    const accounts = new Set<string>();
    for (const permission of space.results ?? []) {
      if (permission.operation?.operation !== "read") continue;
      if (permission.operation?.targetType !== "space") continue;
      for (const user of permission.subjects?.user?.results ?? []) {
        if (user.accountId) accounts.add(user.accountId);
      }
      for (const group of permission.subjects?.group?.results ?? []) {
        const members = await this.readGroupMembers(group.id ?? group.name);
        if (members === undefined) return undefined;
        for (const accountId of members) accounts.add(accountId);
      }
    }
    return [...accounts];
  }

  private async readRestrictionAccounts(pageId: string): Promise<readonly string[] | undefined> {
    const response = await this.getJson<RestrictionsResponse>(
      `/rest/api/content/${encodeURIComponent(pageId)}/restriction/byOperation/read` +
        "?expand=restrictions.user,restrictions.group"
    ).catch(() => undefined);
    if (response === undefined) return undefined;
    const accounts = new Set<string>();
    for (const user of response.restrictions?.user?.results ?? []) {
      if (user.accountId) accounts.add(user.accountId);
    }
    for (const group of response.restrictions?.group?.results ?? []) {
      const members = await this.readGroupMembers(group.id ?? group.name);
      if (members === undefined) return undefined;
      for (const accountId of members) accounts.add(accountId);
    }
    return [...accounts];
  }

  private async readGroupMembers(
    groupIdOrName: string | undefined
  ): Promise<readonly string[] | undefined> {
    if (!groupIdOrName) return undefined;
    const path = groupIdOrName.startsWith("group-")
      ? `/rest/api/group/${encodeURIComponent(groupIdOrName)}/membersByGroupId`
      : `/rest/api/group/${encodeURIComponent(groupIdOrName)}/member`;
    const response = await this.getJson<GroupMembersResponse>(path).catch(() => undefined);
    return response?.results
      ?.map((member) => member.accountId)
      .filter((accountId): accountId is string => typeof accountId === "string");
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: ["Bearer", this.options.accessToken].join(" "),
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`confluence_api_error:${response.status}`);
    }
    return (await response.json()) as T;
  }
}
