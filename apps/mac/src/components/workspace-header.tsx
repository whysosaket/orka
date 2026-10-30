import React from "react";
import { motion, useReducedMotion } from "motion/react";
import { SidebarCollapseIcon, SidebarExpandIcon } from "@primer/octicons-react";
import { Button } from "./button.js";
import { spring } from "../lib/springs.js";

const shown = { opacity: 1, scale: 1, filter: "blur(0px)" };
const hidden = { opacity: 0, scale: 0.6, filter: "blur(4px)" };
const enter = {
  type: "tween" as const,
  duration: spring.fast.duration,
  ease: "easeOut" as const,
};
const leave = {
  type: "tween" as const,
  ...spring.fast.exit,
  ease: "easeIn" as const,
};

export interface WorkspaceHeaderProps {
  title: string;
  collapsed: boolean;
  instant?: boolean;
  onToggle: (instant: boolean) => void;
  status?: React.ReactNode;
  repositoryFilter?: React.ReactNode;
}

/** Compact Figma shell header; the existing sync menu owns its diagnostics. */
export function WorkspaceHeader({
  title,
  collapsed,
  instant,
  onToggle,
  status,
  repositoryFilter,
}: WorkspaceHeaderProps) {
  const reduced = useReducedMotion();
  const instantTransition = reduced || instant ? { duration: 0 } : null;
  return (
    <header className="workspace-header" data-tauri-drag-region>
      <div className="workspace-heading" data-tauri-drag-region>
        <Button
          className="ui-icon-button sidebar-toggle"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          onClick={(event) => onToggle(event.detail === 0)}
          variant="tertiary"
          size="sm"
        >
          <span className="sidebar-toggle-icons" aria-hidden="true">
            <motion.span
              initial={false}
              animate={collapsed ? hidden : shown}
              transition={instantTransition ?? (collapsed ? leave : enter)}
            >
              <SidebarCollapseIcon size={16} />
            </motion.span>
            <motion.span
              initial={false}
              animate={collapsed ? shown : hidden}
              transition={instantTransition ?? (collapsed ? enter : leave)}
            >
              <SidebarExpandIcon size={16} />
            </motion.span>
          </span>
        </Button>
        <h1 data-tauri-drag-region>{title}</h1>
      </div>
      <div className="workspace-header-actions" data-tauri-drag-region>
        {repositoryFilter}
        {status}
      </div>
    </header>
  );
}
