export const SANDBOX_RUNTIME_LANGUAGES = ["shell", "typescript", "python"] as const;

export type SandboxRuntimeLanguage = (typeof SANDBOX_RUNTIME_LANGUAGES)[number];

export interface SandboxRuntimeProfile {
  readonly id: string;
  /** OCI image digest, never a mutable tag. */
  readonly imageDigest: string;
  readonly languages: readonly SandboxRuntimeLanguage[];
  readonly commands: readonly string[];
}

export type SandboxRuntimeProfileErrorCode =
  | "duplicate_runtime_profile"
  | "invalid_runtime_profile"
  | "runtime_profile_not_found"
  | "runtime_requirement_unavailable";

export class SandboxRuntimeProfileError extends Error {
  constructor(
    readonly code: SandboxRuntimeProfileErrorCode,
    readonly profileId: string,
    readonly requirement?: string
  ) {
    super(
      requirement === undefined ? `${code}:${profileId}` : `${code}:${profileId}:${requirement}`
    );
    this.name = "SandboxRuntimeProfileError";
  }
}

const PROFILE_ID = /^[a-z][a-z0-9-]{0,127}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMAND = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/;

function immutableProfile(profile: SandboxRuntimeProfile): SandboxRuntimeProfile {
  if (
    !PROFILE_ID.test(profile.id) ||
    !IMAGE_DIGEST.test(profile.imageDigest) ||
    profile.languages.length === 0 ||
    new Set(profile.languages).size !== profile.languages.length ||
    profile.languages.some((language) => !SANDBOX_RUNTIME_LANGUAGES.includes(language)) ||
    new Set(profile.commands).size !== profile.commands.length ||
    profile.commands.some((command) => !COMMAND.test(command))
  ) {
    throw new SandboxRuntimeProfileError("invalid_runtime_profile", profile.id);
  }
  return Object.freeze({
    ...profile,
    languages: Object.freeze([...profile.languages]),
    commands: Object.freeze([...profile.commands]),
  });
}

export class SandboxRuntimeProfileRegistry {
  private readonly profiles = new Map<string, SandboxRuntimeProfile>();

  constructor(profiles: readonly SandboxRuntimeProfile[]) {
    for (const input of profiles) {
      const profile = immutableProfile(input);
      if (this.profiles.has(profile.id)) {
        throw new SandboxRuntimeProfileError("duplicate_runtime_profile", profile.id);
      }
      this.profiles.set(profile.id, profile);
    }
  }

  get(id: string): SandboxRuntimeProfile | undefined {
    return this.profiles.get(id);
  }

  require(id: string, requiredCommands: readonly string[] = []): SandboxRuntimeProfile {
    const profile = this.profiles.get(id);
    if (profile === undefined) {
      throw new SandboxRuntimeProfileError("runtime_profile_not_found", id);
    }
    const available = new Set(profile.commands);
    for (const requirement of requiredCommands) {
      if (!available.has(requirement)) {
        throw new SandboxRuntimeProfileError("runtime_requirement_unavailable", id, requirement);
      }
    }
    return profile;
  }
}

export function shellTsPythonV1(imageDigest: string): SandboxRuntimeProfile {
  return immutableProfile({
    id: "shell-ts-python-v1",
    imageDigest,
    languages: ["shell", "typescript", "python"],
    commands: ["bash", "curl", "jq", "node", "python3", "tsx"],
  });
}
