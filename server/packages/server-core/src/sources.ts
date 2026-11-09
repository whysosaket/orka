import { addProjectSources } from "@portable/protocol";
import { Store, HttpError } from "./store.js";

export async function addSources(store: Store, user: string, raw: unknown) {
  const input = addProjectSources.parse(raw);
  return store.transaction(async (db) => {
    const project = await db.query(
      "select id,source_model from orka.projects where id=$1 for update",
      [input.projectId],
    );
    await store.member(user, input.projectId, db);
    if (project.rows[0]?.source_model !== 1)
      throw new HttpError(
        409,
        "Run the project-source migration before adding folders to this project",
      );
    const owner = await db.query(
      "select 1 from orka.members where project_id=$1 and user_id=$2 and role='owner'",
      [input.projectId, user],
    );
    if (!owner.rowCount)
      throw new HttpError(403, "Only project owners can add source folders");
    const count = await db.query(
      "select count(*)::int as count from orka.project_sources where project_id=$1 and id<>all($2::uuid[])",
      [input.projectId, input.sources.map((source) => source.id)],
    );
    if (count.rows[0].count + input.sources.length > 100)
      throw new HttpError(
        400,
        "A project can contain at most 100 source folders",
      );
    for (const source of input.sources) {
      const prior = await db.query(
        "select name from orka.project_sources where project_id=$1 and id=$2",
        [input.projectId, source.id],
      );
      if (prior.rowCount && prior.rows[0].name !== source.name)
        throw new HttpError(409, "Source ID already belongs to another folder");
      await db.query(
        "insert into orka.project_sources(project_id,id,name) values($1,$2,$3) on conflict do nothing",
        [input.projectId, source.id, source.name],
      );
    }
    return {
      sources: (
        await db.query(
          "select id,name from orka.project_sources where project_id=$1 order by name,id",
          [input.projectId],
        )
      ).rows,
    };
  });
}
