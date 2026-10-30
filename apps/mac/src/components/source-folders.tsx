import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { FileDirectoryIcon, SearchIcon } from "@primer/octicons-react";
import { Button } from "./button.js";

export interface FolderCandidate {
  name: string;
  path: string;
}

export function useSourceFolders() {
  const [candidates, setCandidates] = useState<FolderCandidate[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [scanMessage, setScanMessage] = useState("");
  const merge = (items: FolderCandidate[]) =>
    setCandidates((previous) => [
      ...new Map(
        [...previous, ...items].map((item) => [item.path, item]),
      ).values(),
    ]);
  const choose = async () => {
    const picked = await open({
      directory: true,
      multiple: true,
      title: "Add source folders",
    });
    const paths = typeof picked === "string" ? [picked] : (picked ?? []);
    merge(
      paths.map((path) => ({
        path,
        name: path.split("/").filter(Boolean).at(-1) ?? path,
      })),
    );
    setFolders((previous) => [...new Set([...previous, ...paths])]);
  };
  const scan = async () => {
    const path = await open({
      directory: true,
      multiple: false,
      title: "Scan a parent folder for repositories",
    });
    if (typeof path !== "string") return;
    const found = await invoke<FolderCandidate[]>("scan_project_folders", {
      path,
    });
    merge(found);
    setScanMessage(
      found.length
        ? `Found ${found.length} repositories. Select the folders to add.`
        : "No repositories found directly inside this folder.",
    );
  };
  const toggle = (path: string) =>
    setFolders((previous) =>
      previous.includes(path)
        ? previous.filter((item) => item !== path)
        : [...previous, path],
    );
  const clear = () => {
    setCandidates([]);
    setFolders([]);
    setScanMessage("");
  };
  return { candidates, folders, choose, scan, toggle, clear, scanMessage };
}

export function SourceFolders({
  selection,
  busy,
  run,
}: {
  selection: ReturnType<typeof useSourceFolders>;
  busy: boolean;
  run: (action: () => Promise<unknown>) => void;
}) {
  return (
    <div className="source-folder-selection">
      <div className="source-folders-heading">
        <h3>Source folders</h3>
      </div>
      <div className="source-folder-list">
        {selection.candidates.map((candidate) => (
          <label
            className="source-folder-row"
            key={candidate.path}
            title={candidate.path}
          >
            <input
              type="checkbox"
              checked={selection.folders.includes(candidate.path)}
              disabled={busy}
              onChange={() => selection.toggle(candidate.path)}
            />
            <span className="source-folder-name">
              {candidate.name}
              <span className="source-folder-path">{candidate.path}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="actions">
        <Button
          disabled={busy}
          variant="secondary"
          onClick={() => run(selection.choose)}
        >
          <FileDirectoryIcon size={16} />
          Add folders
        </Button>
        <Button
          disabled={busy}
          variant="tertiary"
          onClick={() => run(selection.scan)}
        >
          <SearchIcon size={16} />
          Scan parent folder
        </Button>
      </div>
      {selection.scanMessage && (
        <p className="source-scan-message" role="status">
          {selection.scanMessage}
        </p>
      )}
    </div>
  );
}
