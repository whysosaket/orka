import type { EnvController } from "./use-environments.js";
export function Recipients({
  c,
  editable,
}: {
  c: EnvController;
  editable: boolean;
}) {
  const { members, grants, draft, user, busy, setGrants, toggle } = c;
  return (
    <fieldset className="env-recipients">
      <legend>Recipients · everyone selected can publish</legend>
      {members.map((member) => (
        <label key={member.id}>
          <input
            type="checkbox"
            checked={grants.includes(member.id)}
            disabled={
              !editable ||
              member.id === (draft?.manifest?.creator ?? user) ||
              Boolean(busy)
            }
            onChange={() => setGrants(toggle(grants, member.id))}
          />
          <span>
            {member.label}
            {member.id === user ? " (you)" : ""}
            <small>
              {member.devices.length
                ? `${member.devices.length} enrolled Mac${member.devices.length === 1 ? "" : "s"}`
                : "Needs to enable ENVs"}
            </small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
