import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalize } from "@tulipfarm/schema";
import Ajv from "ajv";

export interface A2UIActionDescriptor {
  readonly version: "1";
  readonly action: string;
  readonly target: string;
  readonly destination: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly fields: readonly string[];
  readonly audience: readonly string[];
  readonly runId?: string;
  readonly stateKey?: string;
  readonly conversationId?: string;
  readonly nonce: string;
  readonly guardrailRevision: string;
  /** Signed server decision. A client-side DOM mutation cannot make this action invocable. */
  readonly disabled?: boolean;
  readonly stepUp?: boolean;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface A2UINonceStore {
  /** Atomically consumes a nonce. False means it was already used or cannot be verified. */
  consume(nonce: string, expiresAt: string): Promise<boolean>;
}

export interface A2UIAuthorizationRequest {
  readonly principal: string;
  readonly descriptor: A2UIActionDescriptor;
  readonly fields: readonly string[];
}

export type A2UIActionErrorCode =
  | "action_disabled"
  | "expired"
  | "guardrail_changed"
  | "invalid_descriptor"
  | "invalid_input"
  | "reauthentication_required"
  | "replayed"
  | "unauthorized"
  | "wrong_audience";

export class A2UIActionError extends Error {
  readonly name = "A2UIActionError";

  constructor(readonly code: A2UIActionErrorCode) {
    super(code);
  }
}

export interface AuthorizeA2UIActionInput {
  readonly token: string;
  readonly signingKey: string | Uint8Array;
  readonly principal: string;
  readonly input: unknown;
  readonly currentGuardrailRevision: string;
  readonly now?: Date;
  readonly nonceStore: A2UINonceStore;
  readonly reauthenticate: (principal: string, stepUp: boolean) => Promise<boolean>;
  readonly authorize: (request: A2UIAuthorizationRequest) => Promise<boolean>;
}

export interface AuthorizedA2UIAction {
  readonly descriptor: A2UIActionDescriptor;
  readonly input: Readonly<Record<string, unknown>>;
}

function digest(payload: string, key: string | Uint8Array): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

function encodeDescriptor(descriptor: A2UIActionDescriptor): string {
  return Buffer.from(canonicalize(descriptor), "utf8").toString("base64url");
}

export function signA2UIAction(descriptor: A2UIActionDescriptor, key: string | Uint8Array): string {
  const payload = encodeDescriptor(descriptor);
  return `${payload}.${digest(payload, key).toString("base64url")}`;
}

function isDescriptor(value: unknown): value is A2UIActionDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  return (
    d.version === "1" &&
    typeof d.action === "string" &&
    typeof d.target === "string" &&
    typeof d.destination === "string" &&
    typeof d.inputSchema === "object" &&
    d.inputSchema !== null &&
    Array.isArray(d.fields) &&
    d.fields.every((field) => typeof field === "string") &&
    Array.isArray(d.audience) &&
    d.audience.every((principal) => typeof principal === "string") &&
    typeof d.nonce === "string" &&
    typeof d.guardrailRevision === "string" &&
    (d.disabled === undefined || typeof d.disabled === "boolean") &&
    typeof d.issuedAt === "string" &&
    typeof d.expiresAt === "string"
  );
}

export function verifyA2UIAction(token: string, key: string | Uint8Array): A2UIActionDescriptor {
  const parts = token.split(".");
  if (parts.length !== 2) throw new A2UIActionError("invalid_descriptor");
  const [payload, encodedSignature] = parts;
  if (!payload || !encodedSignature) throw new A2UIActionError("invalid_descriptor");
  try {
    const signature = Buffer.from(encodedSignature, "base64url");
    const expected = digest(payload, key);
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
      throw new A2UIActionError("invalid_descriptor");
    }
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isDescriptor(parsed)) throw new A2UIActionError("invalid_descriptor");
    return parsed;
  } catch (error) {
    if (error instanceof A2UIActionError) throw error;
    throw new A2UIActionError("invalid_descriptor");
  }
}

function objectInput(input: unknown): Readonly<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new A2UIActionError("invalid_input");
  }
  return input as Readonly<Record<string, unknown>>;
}

/** Server-side gate. A valid signature never substitutes for live identity and Guardrail checks. */
export async function authorizeA2UIAction(
  request: AuthorizeA2UIActionInput
): Promise<AuthorizedA2UIAction> {
  const descriptor = verifyA2UIAction(request.token, request.signingKey);
  if (descriptor.disabled === true) throw new A2UIActionError("action_disabled");
  const now = request.now ?? new Date();
  if (!Number.isFinite(Date.parse(descriptor.expiresAt)) || now >= new Date(descriptor.expiresAt)) {
    throw new A2UIActionError("expired");
  }
  if (!descriptor.audience.includes(request.principal)) {
    throw new A2UIActionError("wrong_audience");
  }
  if (descriptor.guardrailRevision !== request.currentGuardrailRevision) {
    throw new A2UIActionError("guardrail_changed");
  }

  const input = objectInput(request.input);
  const fields = Object.keys(input).sort();
  if (fields.some((field) => !descriptor.fields.includes(field))) {
    throw new A2UIActionError("invalid_input");
  }
  const validate = new Ajv({ allErrors: true, strict: false }).compile(descriptor.inputSchema);
  if (!validate(input)) throw new A2UIActionError("invalid_input");
  if (!(await request.reauthenticate(request.principal, descriptor.stepUp ?? false))) {
    throw new A2UIActionError("reauthentication_required");
  }
  if (!(await request.authorize({ principal: request.principal, descriptor, fields }))) {
    throw new A2UIActionError("unauthorized");
  }
  if (!(await request.nonceStore.consume(descriptor.nonce, descriptor.expiresAt))) {
    throw new A2UIActionError("replayed");
  }
  return { descriptor, input };
}
