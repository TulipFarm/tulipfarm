import { useState } from "react";
import { FormStatus } from "~/components/form-status";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Modal } from "~/components/ui/modal";
import { PanelEmpty, PanelRow } from "~/components/ui/panel";
import { Textarea } from "~/components/ui/textarea";
import { ApiError } from "~/lib/api";
import {
  completeOwnershipOperation,
  decideOwnershipApproval,
  emergencyOverrideOwnershipOperation,
  type OwnershipApproval,
} from "~/lib/teams";

export function OwnershipApprovalList({
  approvals,
  isCompanyAdmin = false,
  onChanged,
}: {
  approvals: OwnershipApproval[];
  isCompanyAdmin?: boolean;
  onChanged?: () => void;
}) {
  const [busyId, setBusyId] = useState<string>();
  const [notice, setNotice] = useState<{ tone: "error" | "success"; message: string } | null>(null);
  const [emergencyApproval, setEmergencyApproval] = useState<OwnershipApproval | null>(null);
  const [reason, setReason] = useState("");
  const [emergencyError, setEmergencyError] = useState<string | null>(null);

  async function decide(approval: OwnershipApproval, outcome: "approved" | "denied") {
    setBusyId(approval.approvalId);
    setNotice(null);
    try {
      const result = await decideOwnershipApproval(approval, outcome);
      const resultMessage =
        outcome === "denied"
          ? "Ownership operation denied."
          : result.completion.status === "completed"
            ? "Approval recorded and ownership updated."
            : result.completion.status === "ready"
              ? "Approval recorded. The operation is ready to complete."
              : "Approval recorded.";
      setNotice({ tone: "success", message: resultMessage });
      onChanged?.();
    } catch (error) {
      setNotice({ tone: "error", message: message(error, "Could not record this decision.") });
    } finally {
      setBusyId(undefined);
    }
  }

  async function complete(approval: OwnershipApproval) {
    setBusyId(approval.approvalId);
    setNotice(null);
    try {
      await completeOwnershipOperation(approval);
      setNotice({ tone: "success", message: "Ownership operation completed." });
      onChanged?.();
    } catch (error) {
      setNotice({ tone: "error", message: message(error, "Could not complete this operation.") });
    } finally {
      setBusyId(undefined);
    }
  }

  async function emergencyOverride() {
    if (!emergencyApproval) return;
    if (!reason.trim()) {
      setEmergencyError("Enter the emergency reason.");
      return;
    }
    setBusyId(emergencyApproval.approvalId);
    setEmergencyError(null);
    try {
      await emergencyOverrideOwnershipOperation(emergencyApproval, reason.trim());
      setEmergencyApproval(null);
      setReason("");
      setNotice({ tone: "success", message: "Emergency override completed." });
      onChanged?.();
    } catch (error) {
      setEmergencyError(message(error, "Could not complete the emergency override."));
    } finally {
      setBusyId(undefined);
    }
  }

  if (approvals.length === 0) return <PanelEmpty>No pending ownership Approvals.</PanelEmpty>;
  return (
    <>
      {notice ? <FormStatus tone={notice.tone}>{notice.message}</FormStatus> : null}
      {approvals.map((approval) => (
        <PanelRow key={approval.approvalId}>
          <div className="min-w-0">
            <p className="text-sm font-medium">{approval.preview}</p>
            <p className="text-xs text-muted-foreground">
              {approval.assetType} · {approval.decisions}/{approval.requiredDecisions} decisions ·
              expires <time dateTime={approval.expiresAt}>{formatDate(approval.expiresAt)}</time>
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <Badge variant={approval.risk === "high" ? "warning" : "neutral"}>
              {approval.risk} risk
            </Badge>
            {approval.canDecide ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busyId === approval.approvalId}
                  onClick={() => void decide(approval, "denied")}
                >
                  Deny
                </Button>
                <Button
                  type="button"
                  disabled={busyId === approval.approvalId}
                  onClick={() => void decide(approval, "approved")}
                >
                  Approve
                </Button>
              </>
            ) : null}
            {approval.readyToComplete ? (
              approval.action === "add_owner" || approval.action === "remove_owner" ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busyId === approval.approvalId}
                  onClick={() => void complete(approval)}
                >
                  Complete
                </Button>
              ) : (
                <p className="max-w-48 text-right text-xs text-muted-foreground">
                  {lifecycleCompletionMessage(approval.action)}
                </p>
              )
            ) : null}
            {isCompanyAdmin ? (
              <Button
                type="button"
                variant="destructive"
                disabled={busyId === approval.approvalId}
                onClick={() => {
                  setReason("");
                  setEmergencyError(null);
                  setEmergencyApproval(approval);
                }}
              >
                Emergency override
              </Button>
            ) : null}
          </div>
        </PanelRow>
      ))}
      <Modal
        open={emergencyApproval !== null}
        onClose={() => setEmergencyApproval(null)}
        title="Confirm emergency override"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void emergencyOverride();
          }}
        >
          <p className="text-sm font-medium text-destructive">
            This bypasses the remaining owner Approvals for this exact operation.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">{emergencyApproval?.preview}</p>
          <div className="mt-4">
            <Field label="Required reason" required>
              <Textarea value={reason} onChange={(event) => setReason(event.target.value)} />
            </Field>
          </div>
          {emergencyError ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {emergencyError}
            </p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busyId === emergencyApproval?.approvalId}
              onClick={() => setEmergencyApproval(null)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={busyId === emergencyApproval?.approvalId}
            >
              {busyId === emergencyApproval?.approvalId ? "Overriding…" : "Use emergency override"}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

function lifecycleCompletionMessage(
  action: Extract<OwnershipApproval["action"], "move" | "archive" | "delete">
): string {
  const verb = action === "move" ? "Move" : action === "archive" ? "Archive" : "Delete";
  return `${verb} the asset to complete this Approval.`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}
