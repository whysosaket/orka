import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckIcon, PlusIcon, SyncIcon, XIcon } from "@primer/octicons-react";
import type { Project } from "../types.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { IconButton } from "./icon-button.js";
import { Overlay } from "./overlay.js";
import { SearchField } from "./search-field.js";
import { SourceLabel } from "./source-label.js";
import { readSkillMarkdown } from "./skill-markdown.js";
import { projectLabel } from "./project-navigation.js";
import { SkillUsageCount, type SkillUsage } from "./skill-usage.js";
import { SortMenu } from "./sort-menu.js";
import { repositoryLabel } from "./project-sources.js";

interface GlobalSkill {
  id: string;
  name: string;
  path: string;
  sources: ("codex" | "claude")[];
  markdown: string;
  fileCount: number;
  exists: boolean;
  error: string | null;
}
interface Scan {
  skills: GlobalSkill[];
  errors: string[];
}
interface ImportResult {
  skillId: string;
  result?: { status: "draft" | "queued" | "local" };
  error?: string;
}
type Run = (action: () => Promise<unknown>) => Promise<void>;

export function GlobalSkillImport({
  project,
  busy,
  run,
  onReview,
}: {
  project: Project;
  busy: boolean;
  run: Run;
  onReview: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        className="global-skills-trigger"
        size="md"
        variant="primary"
        aria-label="Add global skills"
        title="Add global skills"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Icon icon={PlusIcon} />
        Add Global Skills
      </Button>
      {open && (
        <GlobalSkillsDialog
          project={project}
          busy={busy}
          run={run}
          onClose={() => setOpen(false)}
          onReview={() => {
            setOpen(false);
            onReview();
          }}
        />
      )}
    </>
  );
}

function GlobalSkillsDialog({
  project,
  busy,
  run,
  onClose,
  onReview,
}: {
  project: Project;
  busy: boolean;
  run: Run;
  onClose: () => void;
  onReview: () => void;
}) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [sourceId, setSourceId] = useState(
    project.sources?.find((source) => source.path)?.id ?? "",
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("usage");
  const [usage, setUsage] = useState<SkillUsage | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageError, setUsageError] = useState(false);
  const [pending, setPending] = useState("");
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [reviewable, setReviewable] = useState(false);
  const active = useRef(true);
  const locked = useRef(false);
  const generation = useRef(0);
  const usageLocked = useRef(false);
  const loadUsage = useCallback(async () => {
    if (usageLocked.current) return;
    usageLocked.current = true;
    setUsageLoading(true);
    setUsageError(false);
    try {
      const next = await invoke<SkillUsage>("global_skill_usage", {
        projectId: project.id,
      });
      if (active.current) setUsage(next);
    } catch {
      if (active.current) setUsageError(true);
    } finally {
      usageLocked.current = false;
      if (active.current) setUsageLoading(false);
    }
  }, [project.id]);
  const rescan = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const next = await invoke<Scan>("scan_global_skills", {
        projectId: project.id,
        sourceId: sourceId || undefined,
      });
      if (active.current && current === generation.current) {
        setScan(next);
        setSelected(
          (selected) =>
            new Set(
              [...selected].filter((id) =>
                next.skills.some(
                  (skill) => skill.id === id && !skill.exists && !skill.error,
                ),
              ),
            ),
        );
      }
    } catch (error) {
      if (active.current && current === generation.current)
        setError(`Couldn’t scan global skills: ${String(error)}`);
    } finally {
      if (active.current && current === generation.current) setLoading(false);
    }
  }, [project.id, sourceId]);
  useEffect(() => {
    active.current = true;
    void rescan();
    void loadUsage();
    return () => {
      active.current = false;
      generation.current += 1;
    };
  }, [rescan, loadUsage]);

  const skills = useMemo(
    () =>
      (scan?.skills ?? [])
        .map((skill) => {
          const { name, description } = readSkillMarkdown(skill.markdown);
          return {
            ...skill,
            folder: skill.name,
            name: name || skill.name,
            description,
          };
        })
        .sort(
          (a, b) =>
            (sort === "usage"
              ? (usage?.counts[b.id] ?? 0) - (usage?.counts[a.id] ?? 0)
              : 0) ||
            a.name.localeCompare(b.name) ||
            a.path.localeCompare(b.path),
        ),
    [scan, sort, usage],
  );
  const search = query.trim().toLocaleLowerCase();
  const visible = skills.filter((skill) =>
    [skill.name, skill.description, skill.folder, skill.path, ...skill.sources]
      .join(" ")
      .toLocaleLowerCase()
      .includes(search),
  );
  const connected = project.sources
    ? project.sources.some((source) => source.id === sourceId && source.path)
    : Boolean(project.path);
  const selectable = visible.filter((skill) => !skill.exists && !skill.error);
  const selectedSkills = skills.filter(
    (skill) => selected.has(skill.id) && !skill.exists && !skill.error,
  );
  const allVisibleSelected =
    selectable.length > 0 &&
    selectable.every((skill) => selected.has(skill.id));
  const add = async (chosen: typeof skills) => {
    if (locked.current) return;
    locked.current = true;
    setPending(chosen.length === 1 ? chosen[0].id : `${chosen.length} skills`);
    setError("");
    setMessage("");
    try {
      await run(async () => {
        const scope = {
          projectId: project.id,
          sourceId: sourceId || undefined,
        };
        const results: ImportResult[] =
          chosen.length === 1
            ? [
                {
                  skillId: chosen[0].id,
                  result: await invoke("add_global_skill", {
                    ...scope,
                    skillId: chosen[0].id,
                  }),
                },
              ]
            : (
                await invoke<{ results: ImportResult[] }>("add_global_skills", {
                  ...scope,
                  skillIds: chosen.map((skill) => skill.id),
                })
              ).results;
        if (!active.current) return;
        const succeeded = results.filter((item) => item.result);
        const ids = new Set(succeeded.map((item) => item.skillId));
        const folders = new Set(
          chosen
            .filter((skill) => ids.has(skill.id))
            .map((skill) => skill.folder),
        );
        setAdded((current) => new Set([...current, ...ids]));
        setSelected(
          (current) => new Set([...current].filter((id) => !ids.has(id))),
        );
        setScan(
          (current) =>
            current && {
              ...current,
              skills: current.skills.map((item) =>
                folders.has(item.name) ? { ...item, exists: true } : item,
              ),
            },
        );
        setReviewable(
          (current) =>
            current ||
            succeeded.some((item) => item.result?.status === "draft"),
        );
        const failures = results.filter((item) => item.error);
        if (failures.length)
          setError(
            failures
              .map(
                (item) =>
                  `${chosen.find((skill) => skill.id === item.skillId)?.name}: ${item.error}`,
              )
              .join("; "),
          );
        if (succeeded.length) {
          const name =
            chosen.length === 1 ? chosen[0].name : `${succeeded.length} skills`;
          const local = succeeded.filter(
            (item) => item.result?.status === "local",
          ).length;
          setMessage(
            succeeded.some((item) => item.result?.status === "draft")
              ? `${name} added on this Mac. Review changes to share with the project.`
              : local === succeeded.length
                ? `${name} added on this Mac. Skills sharing is off.`
                : `${name} added. Sharing queued; approval is requested only if permissions require it.`,
          );
        }
      });
    } catch (error) {
      if (active.current)
        setError(`Couldn’t complete adding skills: ${String(error)}`);
    } finally {
      locked.current = false;
      if (active.current) setPending("");
    }
  };

  return (
    <Overlay
      open
      title="Add global skills"
      className="global-skills-modal"
      onClose={() => !pending && onClose()}
    >
      <div className="global-skills-heading">
        <div>
          <h2>Add global skills</h2>
          <p>Choose skills for {projectLabel(project)}.</p>
        </div>
        <IconButton
          icon={XIcon}
          variant="tertiary"
          aria-label="Close global skills"
          disabled={Boolean(pending)}
          onClick={onClose}
        />
      </div>
      <div className="global-skills-toolbar">
        {Boolean(project.sources?.length) && (
          <select
            className="repository-filter"
            aria-label="Install into repository"
            disabled={Boolean(pending)}
            value={sourceId}
            onChange={(event) => {
              setSourceId(event.target.value);
              setAdded(new Set());
              setSelected(new Set());
              setScan(null);
              setMessage("");
              setReviewable(false);
            }}
          >
            {project.sources
              ?.filter((source) => source.path)
              .map((source) => (
                <option key={source.id} value={source.id}>
                  {repositoryLabel(project.sources ?? [], source.id)}
                </option>
              ))}
          </select>
        )}
        <SearchField
          aria-label="Search global skills"
          placeholder="Search global skills"
          value={query}
          onValueChange={setQuery}
        />
        <IconButton
          icon={SyncIcon}
          variant="secondary"
          aria-label="Scan again"
          title="Scan again"
          disabled={loading || Boolean(pending)}
          onClick={() => {
            void rescan();
            void loadUsage();
          }}
        />
        <SortMenu
          label="Sort global skills"
          size="md"
          variant="secondary"
          className="global-skills-sort"
          value={sort}
          onChange={setSort}
          options={[
            { value: "usage", label: "Most used" },
            { value: "name", label: "Name" },
          ]}
        />
      </div>
      <div className="global-skills-usage-status" role="status">
        {usageLoading ? (
          "Checking usage in local chat history…"
        ) : usageError ? (
          <>
            Usage unavailable. Skills can still be added.
            <Button
              size="sm"
              variant="tertiary"
              onClick={() => void loadUsage()}
            >
              Retry usage
            </Button>
          </>
        ) : usage?.partial ? (
          "Usage covers available history; some records could not be read."
        ) : null}
      </div>
      <div className="global-skills-feedback">
        {pending && (
          <p className="global-skills-notice" role="status">
            Adding{" "}
            {skills.find((skill) => skill.id === pending)?.name ?? pending}…
            This can wait for an active sync to finish.
          </p>
        )}
        {!(project.sources
          ? project.sources.some(
              (source) => source.id === sourceId && source.path,
            )
          : project.path) && (
          <p className="global-skills-notice">
            Connect a project folder to add skills.
          </p>
        )}
        {error && (
          <p className="global-skills-notice" role="alert">
            {error}
          </p>
        )}
        {scan?.errors.map((error, index) => (
          <p className="global-skills-notice" key={index} role="status">
            {error}
          </p>
        ))}
      </div>
      <div className="global-skills-selection">
        <label>
          <input
            type="checkbox"
            checked={allVisibleSelected}
            ref={(input) => {
              if (input)
                input.indeterminate =
                  !allVisibleSelected &&
                  selectable.some((skill) => selected.has(skill.id));
            }}
            disabled={
              loading ||
              busy ||
              Boolean(pending) ||
              !connected ||
              !selectable.length
            }
            onChange={() =>
              setSelected((current) => {
                const next = new Set(current);
                for (const skill of selectable) {
                  if (allVisibleSelected) next.delete(skill.id);
                  else next.add(skill.id);
                }
                return next;
              })
            }
          />
          Select all visible
        </label>
        <span>{selectedSkills.length} selected</span>
      </div>
      <div className="global-skills-list" aria-busy={loading}>
        {loading ? (
          <p role="status">Scanning Codex and Claude global skills…</p>
        ) : !scan ? null : !skills.length ? (
          <p role="status">No global skills found in Codex or Claude.</p>
        ) : !visible.length ? (
          <p role="status">No skills match your search.</p>
        ) : (
          <ul aria-label="Global skills">
            {visible.map((skill) => (
              <li key={skill.id} className="global-skill-row">
                <input
                  className="global-skill-checkbox"
                  type="checkbox"
                  aria-label={`Select skill: ${skill.name}`}
                  checked={selected.has(skill.id)}
                  disabled={
                    loading ||
                    busy ||
                    Boolean(pending) ||
                    !connected ||
                    skill.exists ||
                    Boolean(skill.error)
                  }
                  onChange={(event) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(skill.id);
                      else next.delete(skill.id);
                      return next;
                    })
                  }
                />
                <div className="global-skill-info">
                  <h3>{skill.name}</h3>
                  {skill.description && (
                    <p
                      className="global-skill-description"
                      title={skill.description}
                    >
                      {skill.description}
                    </p>
                  )}
                  <div className="global-skill-meta">
                    {skill.sources.map((source) => (
                      <SourceLabel key={source} source={source} />
                    ))}
                    {skill.fileCount > 1 && (
                      <span>{skill.fileCount} files</span>
                    )}
                    <SkillUsageCount count={usage?.counts[skill.id]} />
                  </div>
                  <small className="global-skill-path" title={skill.path}>
                    {skill.path}
                  </small>
                  {skill.error && <p>{skill.error}</p>}
                </div>
                <Button
                  size="sm"
                  disabled={
                    loading ||
                    busy ||
                    Boolean(pending) ||
                    !(project.sources
                      ? project.sources.some(
                          (source) => source.id === sourceId && source.path,
                        )
                      : project.path) ||
                    skill.exists ||
                    Boolean(skill.error)
                  }
                  aria-label={`${added.has(skill.id) ? "Added" : skill.exists ? "Already in project" : "Add to project"}: ${skill.name}`}
                  onClick={() => void add([skill])}
                >
                  {added.has(skill.id) ? (
                    <>
                      <Icon icon={CheckIcon} size="sm" />
                      Added
                    </>
                  ) : skill.exists ? (
                    "Already in project"
                  ) : pending === skill.id ? (
                    "Adding…"
                  ) : (
                    "Add to project"
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="global-skills-footer">
        <p role="status">{message}</p>
        <Button
          variant="primary"
          disabled={
            !selectedSkills.length ||
            loading ||
            busy ||
            Boolean(pending) ||
            !connected
          }
          onClick={() => void add(selectedSkills)}
        >
          Add selected
          {selectedSkills.length ? ` (${selectedSkills.length})` : ""}
        </Button>
        {reviewable && (
          <Button
            size="sm"
            disabled={Boolean(pending) || busy}
            onClick={onReview}
          >
            Review changes
          </Button>
        )}
        <Button disabled={Boolean(pending)} onClick={onClose}>
          Done
        </Button>
      </div>
    </Overlay>
  );
}
