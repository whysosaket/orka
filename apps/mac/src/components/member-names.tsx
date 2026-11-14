import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { ProjectMember, Snapshot } from "../types.js";
import {
  governanceCall,
  memberLabel,
  type GovernanceCatalog,
} from "./project-permissions.js";

const MemberNames = createContext<{
  members: ProjectMember[];
  user?: Snapshot["user"];
  profile?: Snapshot["accountProfile"];
}>({ members: [] });
const noMembers: ProjectMember[] = [];

export function MemberNamesProvider({
  state,
  projectId,
  children,
}: {
  state: Snapshot;
  projectId: string;
  children: ReactNode;
}) {
  const scope = JSON.stringify([
    state.user,
    state.config?.apiUrl,
    state.profile,
    projectId,
  ]);
  const cached = state.governance?.find(
    (entry) => entry.projectId === projectId,
  )?.catalog.members;
  const [loaded, setLoaded] = useState<{
    scope: string;
    members: ProjectMember[];
  } | null>(null);
  const hasCachedMembers = cached !== undefined;
  useEffect(() => {
    if (!state.user || !projectId || hasCachedMembers) return;
    let active = true;
    void governanceCall<GovernanceCatalog>("catalog", { projectId })
      .then((catalog) => {
        if (active) setLoaded({ scope, members: catalog.members ?? [] });
      })
      .catch(() => {
        // Names are optional while offline or connected to an older server.
      });
    return () => {
      active = false;
    };
  }, [state.user, projectId, hasCachedMembers, scope]);
  const members =
    cached ?? (loaded?.scope === scope ? loaded.members : noMembers);
  return (
    <MemberNames.Provider
      value={{ members, user: state.user, profile: state.accountProfile }}
    >
      {children}
    </MemberNames.Provider>
  );
}

export function useMemberLabel(user: string | null) {
  const { members } = useContext(MemberNames);
  return useCallback(
    (id: string | null | undefined) =>
      id ? memberLabel(id, user, members) : "Unknown",
    [user, members],
  );
}

export function useMemberPhoto(id: string) {
  const { members, user, profile } = useContext(MemberNames);
  const member = members.find((member) => member.id === id);
  return (
    (id === user
      ? (profile?.avatarData ?? profile?.avatarPreview ?? profile?.avatarUrl)
      : null) ??
    member?.avatarData ??
    member?.avatarUrl
  );
}
