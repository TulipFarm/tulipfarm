/// <reference types="vite/client" />

declare module "@fontsource-variable/jetbrains-mono";

interface ImportMetaEnv {
  // API base for the resource client (defaults to http://localhost:4010 when unset).
  readonly VITE_API_URL?: string;
  // Optional dev bearer token; when set, the resource client sends Authorization: Bearer <token>.
  readonly VITE_API_TOKEN?: string;
}
