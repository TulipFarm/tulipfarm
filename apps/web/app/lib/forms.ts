import type { FormSubmissionResult, SubmitFormInput } from "@tulipfarm/surface/client";
import { apiWrite } from "./api";

export type FormSubmissionBody = Omit<SubmitFormInput, "formId" | "principal" | "submittedAt">;

export async function submitGovernedForm(
  formId: string,
  body: FormSubmissionBody
): Promise<FormSubmissionResult> {
  return apiWrite<FormSubmissionResult>(
    "POST",
    `/api/v1/forms/${encodeURIComponent(formId)}/submissions`,
    body
  );
}
