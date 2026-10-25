import { z } from "zod";

export const agentRoleSchema = z.enum([
  "orchestrator", "reference-review", "concept", "quality-review",
]);
export const childRoleSchema = agentRoleSchema.exclude(["orchestrator"]);
export const qualityCriterionSchema = z.enum([
  "goal_semantics", "subject_preservation", "composition_constraints", "visible_defects",
]);
export const qualityIssueSchema = z.object({
  criterion: qualityCriterionSchema,
  score: z.number().int().min(0).max(2),
  status: z.enum(["pass", "revise", "unable_to_judge"]),
  evidence: z.string().min(1).max(4000),
  snapshotId: z.string().min(1),
  inputSnapshotId: z.string().min(1).optional(),
  region: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).optional(),
}).strict();
export const childIssueSchema = z.union([
  qualityIssueSchema,
  z.object({
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(4000),
    snapshotId: z.string().min(1).optional(),
    evidence: z.string().max(4000).optional(),
  }).strict(),
]);
/** The only authority-free data a child may return. It never contains executable commands. */
export const childResultSchema = z.object({
  recommendations: z.array(z.string().max(8000)).max(20),
  selectedSnapshotIds: z.array(z.string().min(1)).max(40),
  issues: z.array(childIssueSchema).max(40),
}).strict();
export const qualityResultSchema = childResultSchema.extend({
  issues: z.array(qualityIssueSchema).length(4).refine(
    (issues) => new Set(issues.map((issue) => issue.criterion)).size === 4,
    "质量检查必须覆盖四个不同维度",
  ),
});
export type AgentRole = z.infer<typeof agentRoleSchema>;
export type ChildRole = z.infer<typeof childRoleSchema>;
export type ChildResult = z.infer<typeof childResultSchema>;
export type QualityIssue = z.infer<typeof qualityIssueSchema>;
