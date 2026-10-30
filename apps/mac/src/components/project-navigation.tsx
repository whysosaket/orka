import React from "react";
import * as Popover from "@radix-ui/react-popover";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  CheckIcon,
  ChevronDownIcon,
  CommentDiscussionIcon,
  FileDirectoryIcon,
  FileIcon,
  HomeIcon,
  KeyIcon,
  LogIcon,
  VersionsIcon,
} from "@primer/octicons-react";
import type { Resource } from "@portable/protocol";
import type { Project, ProjectPage } from "../types.js";
import { displayText } from "./resource-presentation.js";
import { ENV_ENABLED } from "../lib/features.js";
import { spring } from "../lib/springs.js";
import {
  useFluidHover,
  useRegisterFluidHoverItem,
} from "../hooks/use-fluid-hover.js";
import { FluidHoverHighlight } from "./fluid-hover-highlight.js";

const sections = [
  { kind: "home", label: "Home", icon: HomeIcon },
  { kind: "memory", label: "Memories", icon: VersionsIcon },
  { kind: "skill", label: "Skills", icon: FileIcon },
  { kind: "session", label: "Sessions", icon: CommentDiscussionIcon },
  { kind: "plan", label: "Plans", icon: LogIcon },
  { kind: "env", label: "ENVs", icon: KeyIcon },
] as const;
type NavigationSection = (typeof sections)[number];

export function projectLabel(project: Project): string {
  return displayText(
    project.role === "owner"
      ? project.name
      : (project.localName ?? project.name),
  );
}

type RegisterItem = ReturnType<typeof useFluidHover>["registerItem"];

/** Adapt existing shared action buttons without replacing their behavior. */
function ProjectActions({
  children,
  onActivate,
}: {
  children: React.ReactNode;
  onActivate: () => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const hover = useFluidHover(ref, {
    axis: "y",
    isItemDisabled: (element) => element.matches(":disabled"),
  });
  const register = hover.registerItem;
  React.useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    let registered: HTMLButtonElement[] = [];
    const sync = () => {
      const buttons = Array.from(
        root.querySelectorAll<HTMLButtonElement>("button"),
      );
      if (
        buttons.length === registered.length &&
        buttons.every((button, index) => button === registered[index])
      )
        return;
      registered.forEach((_, index) => register(index, null));
      registered = buttons;
      registered.forEach((button, index) => register(index, button));
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      registered.forEach((_, index) => register(index, null));
    };
  }, [register]);
  return (
    <div
      ref={ref}
      className="project-menu-actions"
      role="group"
      aria-label="Project actions"
      {...hover.handlers}
      onClick={(event) => {
        const button = (event.target as HTMLElement).closest("button");
        if (
          button &&
          !button.disabled &&
          !button.classList.contains("copy-link-button")
        )
          onActivate();
      }}
    >
      <FluidHoverHighlight hover={hover} className="project-menu-hover" />
      {children}
    </div>
  );
}

function ProjectOption({
  project,
  selected,
  index,
  registerItem,
  onChoose,
}: {
  project: Project;
  selected: boolean;
  index: number;
  registerItem: RegisterItem;
  onChoose: () => void;
}) {
  const ref = React.useRef<HTMLButtonElement>(null);
  useRegisterFluidHoverItem(registerItem, index, ref);
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      className="project-menu-item"
      onClick={onChoose}
    >
      <FileDirectoryIcon size={16} aria-hidden="true" />
      <span>{projectLabel(project)}</span>
      {selected && <CheckIcon size={16} aria-hidden="true" />}
    </button>
  );
}

function ProjectPicker({
  projects,
  projectId,
  collapsed,
  actions,
  onProjectChange,
}: {
  projects: Project[];
  projectId: string;
  collapsed: boolean;
  actions?: React.ReactNode;
  onProjectChange: (id: string) => void;
}) {
  const selected = projects.find((p) => p.id === projectId);
  const label = selected ? projectLabel(selected) : "Select project";
  const [open, setOpen] = React.useState(false);
  const [keyboard, setKeyboard] = React.useState(false);
  const reduced = useReducedMotion();
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const actionActivated = React.useRef(false);
  const listRef = React.useRef<HTMLDivElement>(null);
  const focusEdge = React.useRef<"first" | "last" | null>(null);
  const typeahead = React.useRef({ text: "", time: 0 });
  const listId = React.useId();
  const hover = useFluidHover(listRef, {
    axis: "y",
    isItemDisabled: (el) => el.matches(":disabled"),
  });
  const options = () =>
    Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ??
        [],
    );
  const onKeys = (event: React.KeyboardEvent) => {
    const items = options(),
      index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
              items.length;
      items[next]?.focus();
    } else if (
      event.key.length === 1 &&
      event.key !== " " &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      const now = performance.now();
      typeahead.current.text =
        (now - typeahead.current.time < 600 ? typeahead.current.text : "") +
        event.key.toLowerCase();
      typeahead.current.time = now;
      const query = Array.from(typeahead.current.text).every(
        (character) => character === typeahead.current.text[0],
      )
        ? typeahead.current.text[0]
        : typeahead.current.text;
      [...items.slice(index + 1), ...items.slice(0, index + 1)]
        .find((x) => x.textContent?.trim().toLowerCase().startsWith(query))
        ?.focus();
    }
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          role="combobox"
          aria-controls={open ? listId : undefined}
          aria-haspopup="listbox"
          aria-expanded={open}
          className="project-selector"
          data-selected={Boolean(selected)}
          disabled={!projects.length && !actions}
          aria-label={collapsed ? "Select project: " + label : "Select project"}
          title={label}
          onPointerDown={() => setKeyboard(false)}
          onKeyDown={(event) => {
            setKeyboard(true);
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              focusEdge.current =
                event.key === "Home"
                  ? "first"
                  : event.key === "End"
                    ? "last"
                    : null;
              setOpen(true);
            }
          }}
        >
          <FileDirectoryIcon
            className="project-selector-symbol"
            size={16}
            aria-hidden="true"
          />
          <span className="project-selector-label">{label}</span>
          <motion.span
            className="project-selector-chevron"
            initial={false}
            animate={{ rotate: open ? 180 : 0 }}
            transition={reduced || keyboard ? { duration: 0 } : spring.fast}
          >
            <ChevronDownIcon size={16} aria-hidden="true" />
          </motion.span>
        </button>
      </Popover.Trigger>
      <Popover.Portal forceMount>
        <AnimatePresence>
          {open && (
            <Popover.Content
              forceMount
              asChild
              side="bottom"
              align="start"
              sideOffset={6}
              collisionPadding={12}
              aria-label="Project menu"
              onKeyDownCapture={() => setKeyboard(true)}
              onPointerDownCapture={() => setKeyboard(false)}
              onCloseAutoFocus={(event) => {
                if (actionActivated.current) {
                  // The action already restored its stable trigger before opening
                  // another surface. An exiting menu must not steal that focus.
                  event.preventDefault();
                  actionActivated.current = false;
                }
              }}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                const items = options();
                (focusEdge.current
                  ? items[focusEdge.current === "last" ? items.length - 1 : 0]
                  : (items.find(
                      (x) => x.getAttribute("aria-selected") === "true",
                    ) ?? items[0])
                )?.focus();
                focusEdge.current = null;
              }}
            >
              <motion.div
                className="project-menu"
                initial={false}
                animate={{ opacity: 1 }}
                transition={{ duration: 0 }}
                exit={{ opacity: 0, transition: { duration: 0 } }}
              >
                <div
                  id={listId}
                  role="listbox"
                  aria-label="Projects"
                  className="project-menu-options"
                  ref={listRef}
                  onKeyDown={onKeys}
                  {...hover.handlers}
                >
                  <FluidHoverHighlight
                    hover={hover}
                    className="project-menu-hover"
                  />
                  {projects.map((project, index) => (
                    <ProjectOption
                      key={project.id}
                      project={project}
                      selected={project.id === projectId}
                      index={index}
                      registerItem={hover.registerItem}
                      onChoose={() => {
                        onProjectChange(project.id);
                        setOpen(false);
                      }}
                    />
                  ))}
                </div>
                {actions && (
                  <ProjectActions
                    onActivate={() => {
                      actionActivated.current = true;
                      triggerRef.current?.focus();
                      setOpen(false);
                    }}
                  >
                    {actions}
                  </ProjectActions>
                )}
              </motion.div>
            </Popover.Content>
          )}
        </AnimatePresence>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Section({
  item,
  index,
  count,
  selected,
  collapsed,
  disabled,
  registerItem,
  onNavigate,
}: {
  item: NavigationSection;
  index: number;
  count?: number;
  selected: boolean;
  collapsed: boolean;
  disabled: boolean;
  registerItem: RegisterItem;
  onNavigate: (kind: ProjectPage, keyboard: boolean) => void;
}) {
  const ref = React.useRef<HTMLButtonElement>(null);
  useRegisterFluidHoverItem(registerItem, index, ref);
  const Icon = item.icon;
  return (
    <button
      ref={ref}
      type="button"
      className="project-section"
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
      aria-current={selected ? "page" : undefined}
      disabled={disabled}
      onClick={(event) => onNavigate(item.kind, event.detail === 0)}
    >
      <Icon
        className="project-section-icon"
        size={16}
        aria-hidden="true"
        focusable="false"
      />
      <span>{item.label}</span>
      {count !== undefined && <small>{count}</small>}
    </button>
  );
}

export function ProjectNavigation({
  projects,
  projectId,
  activeKind,
  resources,
  onProjectChange,
  onNavigate,
  collapsed,
  actions,
}: {
  projects: Project[];
  projectId: string;
  activeKind: ProjectPage;
  resources: Resource[];
  onProjectChange: (id: string) => void;
  onNavigate: (kind: ProjectPage) => void;
  collapsed: boolean;
  actions?: React.ReactNode;
}) {
  const reduced = useReducedMotion(),
    selected = projects.find((project) => project.id === projectId);
  const visibleSections = sections.filter(
    (item) => ENV_ENABLED || item.kind !== "env",
  );
  const [instant, setInstant] = React.useState(true);
  const listRef = React.useRef<HTMLElement>(null);
  const hover = useFluidHover(listRef, {
    axis: "y",
    isItemDisabled: (el) => el.matches(":disabled"),
  });
  const activeIndex = visibleSections.findIndex(
    ({ kind }) => kind === activeKind,
  );
  const counts = React.useMemo(() => {
    const result: Partial<Record<Resource["kind"], number>> = {};
    for (const r of resources)
      if (r.projectId === projectId && !r.deleted)
        result[r.kind] = (result[r.kind] ?? 0) + 1;
    return result;
  }, [resources, projectId]);
  return (
    <>
      <div className="project-navigation-header" data-tauri-drag-region>
        <ProjectPicker
          projects={projects}
          projectId={projectId}
          collapsed={collapsed}
          actions={actions}
          onProjectChange={onProjectChange}
        />
      </div>
      <nav
        ref={listRef}
        className="project-sections"
        aria-label={
          selected ? projectLabel(selected) + " resources" : "Project resources"
        }
        style={
          { "--active-index": Math.max(0, activeIndex) } as React.CSSProperties
        }
        {...hover.handlers}
      >
        <motion.div
          className="project-section-highlight"
          layout="position"
          layoutDependency={activeIndex}
          transition={reduced || instant ? { duration: 0 } : spring.moderate}
          aria-hidden="true"
          hidden={!selected || activeIndex < 0}
        />
        <FluidHoverHighlight
          hover={hover}
          className="project-hover-highlight"
        />
        {visibleSections.map((item, index) => (
          <Section
            key={item.kind}
            item={item}
            index={index}
            count={
              item.kind === "home" || item.kind === "env"
                ? undefined
                : (counts[item.kind] ?? 0)
            }
            selected={Boolean(selected && activeKind === item.kind)}
            collapsed={collapsed}
            disabled={!selected}
            registerItem={hover.registerItem}
            onNavigate={(kind, keyboard) => {
              setInstant(keyboard);
              onNavigate(kind);
            }}
          />
        ))}
      </nav>
    </>
  );
}
