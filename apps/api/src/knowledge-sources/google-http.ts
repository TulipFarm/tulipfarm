import type {
  DriveApiPort,
  DriveChange,
  DriveFile,
  DrivePermission,
  GoogleDocsApiPort,
  GoogleDocsChange,
  GoogleDocsDocument,
  GoogleDocsPermission,
} from "@tulipfarm/integrations";
import { canonicalHash } from "@tulipfarm/schema";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DOCS_MIME = "application/vnd.google-apps.document";

interface GoogleHttpOptions {
  readonly accessToken: string;
  readonly tenantId: string;
  readonly baseUrl?: string;
}

interface FileListResponse {
  readonly files?: readonly GoogleFileResponse[];
}

interface GoogleFileResponse {
  readonly id?: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly version?: string;
  readonly owners?: readonly { readonly emailAddress?: string; readonly permissionId?: string }[];
  readonly md5Checksum?: string;
  readonly modifiedTime?: string;
  readonly trashed?: boolean;
  readonly labelInfo?: {
    readonly labels?: readonly {
      readonly fields?: Record<
        string,
        { readonly stringValue?: string; readonly selection?: string }
      >;
    }[];
  };
}

interface PermissionListResponse {
  readonly permissions?: readonly {
    readonly type?: string;
    readonly emailAddress?: string;
    readonly domain?: string;
    readonly role?: string;
    readonly deleted?: boolean;
  }[];
}

function labels(file: GoogleFileResponse): readonly string[] | undefined {
  const values: string[] = [];
  for (const label of file.labelInfo?.labels ?? []) {
    for (const field of Object.values(label.fields ?? {})) {
      const value = field.stringValue ?? field.selection;
      if (value) values.push(value);
    }
  }
  return values.length > 0 ? values : undefined;
}

function owner(file: GoogleFileResponse): string {
  return file.owners?.[0]?.emailAddress ?? file.owners?.[0]?.permissionId ?? "";
}

function toDriveFile(file: GoogleFileResponse): DriveFile | undefined {
  if (!file.id || !file.name || !file.mimeType) return undefined;
  const version = file.version ?? file.modifiedTime ?? "0";
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    version,
    ownerExternalId: owner(file),
    contentHash: file.md5Checksum ?? canonicalHash({ id: file.id, version }),
    modifiedTime: file.modifiedTime ?? new Date(0).toISOString(),
    trashed: file.trashed === true,
    ...(labels(file) === undefined ? {} : { classification: labels(file) }),
  };
}

function permissionSubject(permission: {
  readonly type?: string;
  readonly emailAddress?: string;
  readonly domain?: string;
}): string | undefined {
  if (permission.type === "domain") return permission.domain;
  if (permission.type === "anyone") return "anyone";
  return permission.emailAddress;
}

function toDrivePermission(permission: {
  readonly type?: string;
  readonly emailAddress?: string;
  readonly domain?: string;
  readonly role?: string;
  readonly deleted?: boolean;
}): DrivePermission | undefined {
  if (permission.deleted) return undefined;
  if (
    permission.type !== "user" &&
    permission.type !== "group" &&
    permission.type !== "domain" &&
    permission.type !== "anyone"
  ) {
    return undefined;
  }
  const externalSubject = permissionSubject(permission);
  if (!externalSubject) return undefined;
  return {
    type: permission.type,
    externalSubject,
    role: permission.role ?? "reader",
  };
}

export class GoogleDriveHttpKnowledgeApi implements DriveApiPort {
  private readonly baseUrl: string;

  constructor(private readonly options: GoogleHttpOptions) {
    this.baseUrl = options.baseUrl?.replace(/\/+$/, "") ?? DRIVE_API_BASE;
  }

  async listChanges(input: { cursor?: string; pageLimit: number }): Promise<{
    readonly changes: readonly DriveChange[];
    readonly nextCursor?: string;
  }> {
    const since = input.cursor ?? "1970-01-01T00:00:00.000Z";
    const response = await this.getJson<FileListResponse>(
      `/files?pageSize=${input.pageLimit}&orderBy=modifiedTime` +
        `&q=${encodeURIComponent(`modifiedTime > '${since}'`)}` +
        "&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,modifiedTime)"
    );
    const changes = (response.files ?? [])
      .filter((file): file is GoogleFileResponse & { id: string } => typeof file.id === "string")
      .map((file) => ({
        fileId: file.id,
        cursor: file.modifiedTime ?? since,
      }));
    return { changes, nextCursor: changes.at(-1)?.cursor ?? input.cursor };
  }

  async getFile(fileId: string): Promise<DriveFile | undefined> {
    const file = await this.getJson<GoogleFileResponse>(
      `/files/${encodeURIComponent(fileId)}` +
        "?supportsAllDrives=true&fields=id,name,mimeType,version,owners(emailAddress,permissionId),md5Checksum,modifiedTime,trashed,labelInfo"
    ).catch(() => undefined);
    return file === undefined ? undefined : toDriveFile(file);
  }

  async getPermissions(fileId: string): Promise<readonly DrivePermission[] | undefined> {
    const response = await this.getJson<PermissionListResponse>(
      `/files/${encodeURIComponent(fileId)}/permissions?fields=permissions(type,emailAddress,domain,role,deleted)&supportsAllDrives=true`
    ).catch(() => undefined);
    if (response === undefined) return undefined;
    return (response.permissions ?? [])
      .map(toDrivePermission)
      .filter((permission): permission is DrivePermission => permission !== undefined);
  }

  async exportText(
    fileId: string
  ): Promise<{ readonly text: string; readonly mimeType: string } | undefined> {
    const response = await fetch(
      `${this.baseUrl}/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`,
      { headers: this.headers() }
    ).catch(() => undefined);
    if (response === undefined || !response.ok) return undefined;
    return { text: await response.text(), mimeType: "text/plain" };
  }

  protected headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.accessToken}`,
      Accept: "application/json",
    };
  }

  protected async getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() });
    if (!response.ok) throw new Error(`google_drive_api_error:${response.status}`);
    return (await response.json()) as T;
  }
}

export class GoogleDocsHttpKnowledgeApi implements GoogleDocsApiPort {
  private readonly drive: GoogleDriveHttpKnowledgeApi;

  constructor(options: GoogleHttpOptions) {
    this.drive = new GoogleDriveHttpKnowledgeApi(options);
  }

  async listChanged(input: { cursor?: string; pageLimit: number }): Promise<{
    readonly changes: readonly GoogleDocsChange[];
    readonly nextCursor?: string;
  }> {
    const drive = await this.drive.listChanges(input);
    const changes: GoogleDocsChange[] = [];
    for (const change of drive.changes) {
      const file = await this.drive.getFile(change.fileId);
      if (file === undefined || file.mimeType === DOCS_MIME) {
        changes.push({ documentId: change.fileId, cursor: change.cursor });
      }
    }
    return { changes, nextCursor: drive.nextCursor };
  }

  async getDocument(documentId: string): Promise<GoogleDocsDocument | undefined> {
    const file = await this.drive.getFile(documentId);
    if (file === undefined || file.mimeType !== DOCS_MIME) return undefined;
    const exported = await this.drive.exportText(documentId);
    return {
      id: file.id,
      title: file.name,
      version: file.version,
      ownerExternalId: file.ownerExternalId,
      modifiedTime: file.modifiedTime,
      contentHash: file.contentHash,
      text: exported?.text ?? "",
      trashed: file.trashed,
      ...(file.classification === undefined ? {} : { classification: file.classification }),
    };
  }

  async getDocumentPermissions(
    documentId: string
  ): Promise<readonly GoogleDocsPermission[] | undefined> {
    return this.drive.getPermissions(documentId);
  }
}
