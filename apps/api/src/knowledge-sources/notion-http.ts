import type { NotionApiPort, NotionChange, NotionPage } from "@tulipfarm/integrations";

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

interface NotionHttpOptions {
  readonly accessToken: string;
  readonly workspaceId: string;
  readonly readerPropertyName?: string;
  readonly baseUrl?: string;
}

interface SearchResponse {
  readonly results?: readonly NotionPageResponse[];
}

interface NotionPageResponse {
  readonly id?: string;
  readonly archived?: boolean;
  readonly in_trash?: boolean;
  readonly url?: string;
  readonly last_edited_time?: string;
  readonly created_by?: { readonly id?: string };
  readonly last_edited_by?: { readonly id?: string };
  readonly properties?: Record<string, NotionPropertyResponse>;
}

interface NotionPropertyResponse {
  readonly type?: string;
  readonly title?: readonly { readonly plain_text?: string }[];
  readonly rich_text?: readonly { readonly plain_text?: string }[];
  readonly people?: readonly {
    readonly id?: string;
    readonly person?: { readonly email?: string };
  }[];
  readonly email?: string;
  readonly multi_select?: readonly { readonly name?: string }[];
  readonly select?: { readonly name?: string };
}

interface BlocksResponse {
  readonly results?: readonly {
    readonly type?: string;
    readonly [key: string]: unknown;
  }[];
}

function titleFrom(page: NotionPageResponse): string {
  for (const property of Object.values(page.properties ?? {})) {
    if (property.type !== "title") continue;
    const value = property.title
      ?.map((part) => part.plain_text)
      .filter((part): part is string => typeof part === "string")
      .join("");
    if (value) return value;
  }
  return page.id ?? "Untitled Notion page";
}

function classificationFrom(page: NotionPageResponse): readonly string[] | undefined {
  const values: string[] = [];
  for (const property of Object.values(page.properties ?? {})) {
    if (property.type === "select" && property.select?.name) values.push(property.select.name);
    for (const item of property.multi_select ?? []) {
      if (item.name) values.push(item.name);
    }
  }
  return values.length > 0 ? values : undefined;
}

function plainTextFromBlock(block: {
  readonly type?: string;
  readonly [key: string]: unknown;
}): string {
  const type = block.type;
  if (!type) return "";
  const value = block[type];
  if (typeof value !== "object" || value === null || !("rich_text" in value)) return "";
  const richText = (value as { readonly rich_text?: readonly { readonly plain_text?: string }[] })
    .rich_text;
  return (richText ?? [])
    .map((part) => part.plain_text)
    .filter((part): part is string => typeof part === "string")
    .join("");
}

function readersFromProperty(
  property: NotionPropertyResponse | undefined
): readonly { readonly userId: string }[] | undefined {
  if (property === undefined) return undefined;
  if (property.people !== undefined) {
    return property.people
      .map((person) => person.person?.email ?? person.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .map((userId) => ({ userId }));
  }
  if (property.email) return [{ userId: property.email }];
  const text = property.rich_text
    ?.map((part) => part.plain_text)
    .filter((part): part is string => typeof part === "string")
    .join(",");
  if (!text) return undefined;
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((userId) => ({ userId }));
}

export class NotionHttpKnowledgeApi implements NotionApiPort {
  private readonly baseUrl: string;

  constructor(private readonly options: NotionHttpOptions) {
    this.baseUrl = options.baseUrl?.replace(/\/+$/, "") ?? NOTION_API_BASE;
  }

  async listChanged(input: { cursor?: string; pageLimit: number }): Promise<{
    readonly changes: readonly NotionChange[];
    readonly nextCursor?: string;
  }> {
    const since = input.cursor ?? "1970-01-01T00:00:00.000Z";
    const response = await this.postJson<SearchResponse>("/search", {
      filter: { property: "object", value: "page" },
      sort: { direction: "ascending", timestamp: "last_edited_time" },
      page_size: input.pageLimit,
    });
    const changes = (response.results ?? [])
      .filter((page) => page.id && (page.last_edited_time ?? "") > since)
      .map((page) => ({
        pageId: page.id ?? "",
        cursor: page.last_edited_time ?? since,
        ...(page.archived || page.in_trash ? { deleted: true } : {}),
      }));
    return { changes, nextCursor: changes.at(-1)?.cursor ?? input.cursor };
  }

  async getPage(pageId: string): Promise<NotionPage | undefined> {
    const page = await this.getJson<NotionPageResponse>(
      `/pages/${encodeURIComponent(pageId)}`
    ).catch(() => undefined);
    if (page === undefined || !page.id || page.archived || page.in_trash) return undefined;
    const blocks = await this.getJson<BlocksResponse>(
      `/blocks/${encodeURIComponent(pageId)}/children?page_size=100`
    ).catch(() => ({ results: [] }));
    return {
      id: page.id,
      title: titleFrom(page),
      version: page.last_edited_time ?? "0",
      ownerExternalId: page.created_by?.id ?? page.last_edited_by?.id ?? "",
      lastEditedTime: page.last_edited_time ?? new Date(0).toISOString(),
      content: (blocks.results ?? []).map(plainTextFromBlock).filter(Boolean).join("\n\n"),
      ...(classificationFrom(page) === undefined
        ? {}
        : { classification: classificationFrom(page) }),
      ...(page.url === undefined ? {} : { webUrl: page.url }),
    };
  }

  async getPagePermissions(
    pageId: string
  ): Promise<readonly { readonly userId: string }[] | undefined> {
    if (!this.options.readerPropertyName) return undefined;
    const page = await this.getJson<NotionPageResponse>(
      `/pages/${encodeURIComponent(pageId)}`
    ).catch(() => undefined);
    return readersFromProperty(page?.properties?.[this.options.readerPropertyName]);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.accessToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    };
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() });
    if (!response.ok) throw new Error(`notion_api_error:${response.status}`);
    return (await response.json()) as T;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`notion_api_error:${response.status}`);
    return (await response.json()) as T;
  }
}
