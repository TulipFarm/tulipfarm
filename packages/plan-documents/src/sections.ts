import { z } from 'zod';
import { checkMermaid, mermaidSourceLimit } from './mermaid-check.ts';

export const planDocumentLimits = {
  summary: 1500,
  approach: 6000,
  risks: 8,
  riskText: 400,
  diagrams: 4,
  diagramTitle: 120,
  caption: 400,
  mermaid: mermaidSourceLimit,
} as const;

/** `plan` is reserved for the generated plan graph, which shares the rendered-diagram map with these keys. */
export const planDiagramKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'Use 1-48 lowercase letters, digits or hyphens.')
  .refine(key => key !== 'plan', 'The key "plan" is reserved for the plan graph.');

const summary = z.string().trim().min(1).max(planDocumentLimits.summary);
const approach = z.string().trim().max(planDocumentLimits.approach);
const riskText = z.string().trim().min(1).max(planDocumentLimits.riskText);

export const planRiskSchema = z.strictObject({ risk: riskText, mitigation: riskText });
export type PlanRisk = z.infer<typeof planRiskSchema>;

export const planDiagramSchema = z.strictObject({
  key: planDiagramKeySchema,
  title: z.string().trim().min(1).max(planDocumentLimits.diagramTitle),
  caption: z.string().trim().max(planDocumentLimits.caption).optional(),
  mermaid: z
    .string()
    .max(planDocumentLimits.mermaid)
    .superRefine((source, context) => {
      const check = checkMermaid(source);
      if (!check.ok) context.addIssue({ code: 'custom', message: check.reason });
    }),
});
export type PlanDiagram = z.infer<typeof planDiagramSchema>;

const risks = z.array(planRiskSchema).max(planDocumentLimits.risks);
const diagrams = z
  .array(planDiagramSchema)
  .max(planDocumentLimits.diagrams)
  .refine(list => new Set(list.map(diagram => diagram.key)).size === list.length, 'Diagram keys must be unique.');

/** The written parts of a plan document. Everything else in the document comes from the plan itself. */
export const planDocumentSectionsSchema = z.strictObject({
  summary,
  approach: approach.optional(),
  risks: risks.default([]),
  diagrams: diagrams.default([]),
});
export type PlanDocumentSections = z.infer<typeof planDocumentSectionsSchema>;
export type PlanDocumentSectionsInput = z.input<typeof planDocumentSectionsSchema>;

/** Replaces only the parts it names. `risks` and `diagrams` replace the whole list; `approach: null` removes it. */
export const planDocumentSectionsUpdateSchema = z
  .strictObject({
    summary: summary.optional(),
    approach: approach.nullable().optional(),
    risks: risks.optional(),
    diagrams: diagrams.optional(),
  })
  .refine(update => Object.values(update).some(value => value !== undefined), 'Change at least one section.');
export type PlanDocumentSectionsUpdate = z.infer<typeof planDocumentSectionsUpdateSchema>;

export function applySectionsUpdate(
  current: PlanDocumentSections,
  update: PlanDocumentSectionsUpdate,
): PlanDocumentSections {
  const { approach: currentApproach, ...rest } = current;
  const nextApproach = update.approach === undefined ? currentApproach : (update.approach ?? undefined);
  return planDocumentSectionsSchema.parse({
    ...rest,
    ...(update.summary !== undefined && { summary: update.summary }),
    ...(update.risks !== undefined && { risks: update.risks }),
    ...(update.diagrams !== undefined && { diagrams: update.diagrams }),
    ...(nextApproach && { approach: nextApproach }),
  });
}
