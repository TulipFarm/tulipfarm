export type AuthBrokerDenialReason =
  | "unknown_step"
  | "invalid_state"
  | "missing_credentials"
  | "exchange_failed";

export class AuthBrokerError extends Error {
  slug?: string;
  webUrl?: string;

  constructor(
    readonly reason: AuthBrokerDenialReason,
    message: string,
    slug?: string
  ) {
    super(message);
    this.name = "AuthBrokerError";
    this.slug = slug;
  }
}
