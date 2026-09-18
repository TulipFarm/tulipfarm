# ADR-032: Operational credentials narrow service authority

Status: Accepted for the approved runtime deployment foundation, ticket 03. This extends
[authorization-design](authorization-design.md), ADR-009 and ADR-012 without introducing a
support grant or a hosting entitlement.

An explicitly requested operational API client uses the existing hash-only credential,
rotation, expiry and disable lifecycle. Its immutable business/installation scope is a
restriction, not a grant. The API-client row projects that restriction and lifecycle into
the durable service Principal, just as user lifecycle projects into user Principals.
Live Role assignments still supply every allow through the shared authorization engine.

The shared live authority resolver retains only exact, installation-scoped non-content
operational allows for this Principal; wildcard business grants cannot widen it. HTTP
authentication additionally denies undeclared operational surfaces, including internal
Worker callbacks, even when a legacy route only checks authentication. The first eligible
surface is the existing release update check. Missing deployment context or authorization
denies; shadow mode cannot remove this boundary. Tools consume the same narrowed live
Principal layer, and no business Tool or effect is added to the operational allowlist.

Ordinary Worker service clients retain their existing identity and callback permissions.
Neither service kind, administrator role, staff status, hosting mode nor a paid-service
relationship selects operational or support authority. Operational scope cannot be removed
or changed through client rotation, disable, or Principal registration.

Diagnostics expose typed version metadata and coarse failure reasons, not provider error
objects, arbitrary release text, business content or secrets. This is application-level
separation: an infrastructure host may still access its database, memory and disks.

Operational clients are refused at HTTP authentication before they can start a Turn. Existing
user and Worker Turn behavior is unchanged, so this extension does not alter the Eval Corpus
or retire its Baselines. Acceptance instead exercises the assembled API and real Tool dispatcher:
removing the live operational ceiling lets a wildcard Role execute the forbidden effect and
fails the regression test.
