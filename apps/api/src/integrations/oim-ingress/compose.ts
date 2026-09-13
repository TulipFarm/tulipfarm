import type { FastifyInstance } from "fastify";
import {
  type OimWebhookManagementRoutesDeps,
  registerOimWebhookManagementRoutes,
} from "./management-routes";
import { type OimIngressRoutesDeps, registerOimIngressRoutes } from "./routes";

export interface OimIngressApiFeatureDeps {
  readonly receiver: OimIngressRoutesDeps;
  readonly management: OimWebhookManagementRoutesDeps;
}

export async function registerOimIngressApiFeature(
  app: FastifyInstance,
  deps: OimIngressApiFeatureDeps
): Promise<void> {
  await registerOimIngressRoutes(app, deps.receiver);
  registerOimWebhookManagementRoutes(app, deps.management);
}
