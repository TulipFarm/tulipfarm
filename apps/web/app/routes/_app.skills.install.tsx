import { Navigate } from "@remix-run/react";

// The installer moved into the Marketplace tab; keep the old /skills/install path working.
export default function SkillInstallRedirect() {
  return <Navigate to="/skills/marketplace" replace />;
}
