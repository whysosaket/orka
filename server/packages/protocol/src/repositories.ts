import { z } from "zod";

export const githubRepositoryId = z.string().regex(/^[1-9][0-9]{0,23}$/);
export const githubRepository = z.object({
  id: githubRepositoryId,
  fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  cloneUrl: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.origin === "https://github.com" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }),
  defaultBranch: z.string().max(255).nullable(),
  private: z.boolean(),
});
export type GitHubRepository = z.infer<typeof githubRepository>;
export const repositoryBinding = githubRepository.extend({
  revision: z.number().int().positive(),
  previousCloneUrls: z
    .array(githubRepository.shape.cloneUrl)
    .max(10)
    .optional(),
});
export type RepositoryBinding = z.infer<typeof repositoryBinding>;
export const repositoryRequestStatus = z.enum([
  "requested",
  "waiting_on_github",
  "invitation_pending",
  "verified",
  "rejected",
  "canceled",
  "expired",
]);
export const repositoryAccessRequest = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  sourceId: z.uuid(),
  requester: z.uuid(),
  githubId: z.string(),
  githubLogin: z.string(),
  repositoryId: githubRepositoryId,
  fullName: z.string(),
  reason: z.string(),
  status: repositoryRequestStatus,
  revision: z.number().int().positive(),
  note: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  canReview: z.boolean(),
});
export type RepositoryAccessRequest = z.infer<typeof repositoryAccessRequest>;
