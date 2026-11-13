import { z } from "zod";

export const projectSource = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(128),
    removedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const addProjectSources = z
  .object({
    projectId: z.uuid(),
    sources: z
      .array(projectSource.omit({ removedAt: true }))
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (
      new Set(input.sources.map((source) => source.id)).size !==
      input.sources.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate source ID" });
  });

export type ProjectSource = z.infer<typeof projectSource>;

export const removeProjectSource = z
  .object({ projectId: z.uuid(), sourceId: z.uuid() })
  .strict();
