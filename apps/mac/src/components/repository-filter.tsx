import React, { useRef } from "react";
import * as Select from "@radix-ui/react-select";
import { CheckIcon, ChevronDownIcon, RepoIcon } from "@primer/octicons-react";
import {
  useFluidHover,
  useRegisterFluidHoverItem,
} from "../hooks/use-fluid-hover.js";
import { Button } from "./button.js";
import { FluidHoverHighlight } from "./fluid-hover-highlight.js";
import { repositoryLabel } from "./project-sources.js";

function RepositoryOption({
  value,
  label,
  index,
  registerItem,
}: {
  value: string;
  label: string;
  index: number;
  registerItem: ReturnType<typeof useFluidHover>["registerItem"];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useRegisterFluidHoverItem(registerItem, index, ref);
  return (
    <Select.Item
      ref={ref}
      value={value}
      textValue={label}
      title={label}
      className="repository-menu-option"
    >
      <Select.ItemText>{label}</Select.ItemText>
      <span className="repository-menu-check">
        <Select.ItemIndicator>
          <CheckIcon size={16} aria-hidden="true" />
        </Select.ItemIndicator>
      </span>
    </Select.Item>
  );
}

function RepositoryOptions({
  repositories,
}: {
  repositories: { id: string; name: string }[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(ref, { axis: "y", gapClick: false });
  return (
    <Select.Viewport
      ref={ref}
      className="repository-menu-options"
      {...hover.handlers}
    >
      <FluidHoverHighlight hover={hover} className="project-menu-hover" />
      {[{ id: "all", name: "All repositories" }, ...repositories].map(
        (repository, index) => (
          <RepositoryOption
            key={repository.id}
            value={repository.id}
            label={
              repositoryLabel(repositories, repository.id) ?? repository.name
            }
            index={index}
            registerItem={hover.registerItem}
          />
        ),
      )}
    </Select.Viewport>
  );
}

export function RepositoryFilter({
  repositories,
  value,
  onChange,
}: {
  repositories: { id: string; name: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const label = repositoryLabel(repositories, value) ?? "All repositories";
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger asChild>
        <Button
          size="sm"
          className="workspace-repository-filter"
          aria-label="Filter by repository"
          title={label}
        >
          <RepoIcon size={16} aria-hidden="true" />
          <Select.Value>
            <span className="repository-filter-label">{label}</span>
          </Select.Value>
          <Select.Icon asChild>
            <ChevronDownIcon size={14} aria-hidden="true" />
          </Select.Icon>
        </Button>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="repository-menu"
          aria-label="Repositories"
        >
          <RepositoryOptions repositories={repositories} />
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
