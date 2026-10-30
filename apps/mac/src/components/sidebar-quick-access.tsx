import React from "react";
import {
  GearIcon,
  PersonAddIcon,
  PlusCircleIcon,
  type Icon as Octicon,
} from "@primer/octicons-react";
import {
  useFluidHover,
  useRegisterFluidHoverItem,
} from "../hooks/use-fluid-hover.js";
import { FluidHoverHighlight } from "./fluid-hover-highlight.js";

function QuickAction({
  icon: Icon,
  text,
  label,
  run,
  index,
  registerItem,
  collapsed,
}: {
  icon: Octicon;
  text: string;
  label: string;
  run: () => void;
  index: number;
  registerItem: ReturnType<typeof useFluidHover>["registerItem"];
  collapsed: boolean;
}) {
  const ref = React.useRef<HTMLButtonElement>(null);
  useRegisterFluidHoverItem(registerItem, index, ref);
  return (
    <button
      ref={ref}
      type="button"
      className="navigation-action"
      aria-label={label}
      title={collapsed ? label : undefined}
      onClick={(event) => {
        event.currentTarget.focus();
        run();
      }}
    >
      <Icon className="navigation-action-icon" size={16} aria-hidden="true" />
      <span>{text}</span>
    </button>
  );
}

/** The Figma bottom navigation keeps all three existing destinations. */
export function SidebarQuickAccess({
  collapsed,
  onSettings,
  onCreate,
  onJoin,
}: {
  collapsed: boolean;
  onSettings: () => void;
  onCreate: () => void;
  onJoin: () => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const hover = useFluidHover(ref, { axis: "y" });
  const entries = [
    { label: "Settings", text: "Settings", icon: GearIcon, run: onSettings },
    {
      label: "Join project",
      text: "Join Project",
      icon: PersonAddIcon,
      run: onJoin,
    },
    {
      label: "Add project",
      text: "Add project",
      icon: PlusCircleIcon,
      run: onCreate,
    },
  ];
  return (
    <div ref={ref} className="sidebar-bottom" {...hover.handlers}>
      <FluidHoverHighlight hover={hover} className="project-hover-highlight" />
      {entries.map((entry, index) => (
        <QuickAction
          key={entry.label}
          {...entry}
          index={index}
          registerItem={hover.registerItem}
          collapsed={collapsed}
        />
      ))}
    </div>
  );
}
