import React, { useState } from "react";
import {
  ArrowRightIcon,
  FileDirectoryIcon,
  PlusIcon,
  XIcon,
} from "@primer/octicons-react";
import { Overlay } from "./overlay.js";
import { Button } from "./button.js";
import { Icon, type ControlSize } from "./icon.js";
import { IconButton } from "./icon-button.js";
import { TextField } from "./text-field.js";
import { SearchField } from "./search-field.js";
import { Textarea } from "./textarea.js";
import { Switch } from "./switch.js";
import "./design-system-gallery.css";

const samples = ["Design decisions", "Project setup", "Release notes"];
export default function DesignSystem({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState("Inputs");
  const [size, setSize] = useState<ControlSize>("md");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const results = samples.filter((item) =>
    item.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Overlay
      open
      onClose={onClose}
      title="Design system"
      className="design-system-gallery"
      onEscapeKeyDown={(event) => {
        // Radix handles Escape in the capture phase, before the input does.
        if (
          event.target instanceof HTMLInputElement &&
          event.target.type === "search" &&
          query
        ) {
          event.preventDefault();
          setQuery("");
        }
      }}
    >
      <header className="ds-header">
        <div>
          <h1>Design system</h1>
          <p>Actual app components · Inter Variable · Octicons</p>
        </div>
        <IconButton
          icon={XIcon}
          variant="tertiary"
          aria-label="Close design system"
          onClick={onClose}
        />
      </header>
      <nav className="ds-navigation" aria-label="Design system sections">
        {["Foundations", "Buttons", "Inputs"].map((item) => (
          <Button
            key={item}
            variant="tertiary"
            aria-pressed={section === item}
            onClick={() => setSection(item)}
          >
            {item}
          </Button>
        ))}
      </nav>
      <div className="ds-content">
        {section === "Foundations" && (
          <section>
            <h2>Corner radii</h2>
            <p>
              Buttons use 10/9/8px corners at LG/MD/SM. Fields retain the shared
              control radius.
            </p>
            <div className="ds-radii">
              {[
                ["none", "0px"],
                ["detail", "4px"],
                ["control", "9px"],
                ["surface", "12px"],
                ["overlay", "16px"],
                ["full", "9999px"],
              ].map(([token, value]) => (
                <div key={token}>
                  <div style={{ borderRadius: `var(--radius-${token})` }} />
                  <strong>{value}</strong>
                  <p>radius-{token}</p>
                </div>
              ))}
            </div>
            <h2>Surface and text</h2>
            <div className="ds-radii">
              {["primary", "secondary", "tertiary"].map((token) => (
                <div key={token}>
                  <div style={{ background: `var(--surface-${token})` }} />
                  <p>surface-{token}</p>
                </div>
              ))}
            </div>
            <p className="ds-type-primary">Primary text</p>
            <p className="ds-type-secondary">Secondary text</p>
            <p className="ds-type-tertiary">Tertiary text</p>
            <h2>Inter Variable</h2>
            <p className="ds-font-example">Create space for your next idea.</p>
            <p>Local font assets and the same typography tokens as Orka.</p>
          </section>
        )}
        {section === "Buttons" && (
          <section>
            <h2>Buttons and icons</h2>
            <p>
              Hover, press, or use Tab to inspect the real interaction states.
            </p>
            {(["lg", "md", "sm"] as const).map((buttonSize) => (
              <div className="ds-button-row" key={buttonSize}>
                <span>
                  {buttonSize} /{" "}
                  {buttonSize === "lg" ? 40 : buttonSize === "md" ? 36 : 32}px
                </span>
                {(
                  ["primary", "primary-brand", "secondary", "tertiary"] as const
                ).map((variant) => (
                  <React.Fragment key={variant}>
                    <Button variant={variant} size={buttonSize}>
                      {variant === "tertiary" ? null : (
                        <Icon icon={FileDirectoryIcon} />
                      )}
                      {variant}
                    </Button>
                    <IconButton
                      variant={variant}
                      size={buttonSize}
                      icon={PlusIcon}
                      aria-label={`${variant} ${buttonSize} add`}
                    />
                  </React.Fragment>
                ))}
              </div>
            ))}
          </section>
        )}
        {section === "Inputs" && (
          <>
            <div className="ds-section-heading">
              <div>
                <h2>Input fields</h2>
                <p>
                  Flat surfaces. Shared corners. Space between icon and text.
                </p>
              </div>
              <div
                className="ds-size-picker"
                role="group"
                aria-label="Input size"
              >
                {(["lg", "md", "sm"] as const).map((item) => (
                  <Button
                    key={item}
                    size="sm"
                    variant="tertiary"
                    aria-pressed={size === item}
                    onClick={() => setSize(item)}
                  >
                    {item}
                  </Button>
                ))}
              </div>
            </div>
            <div className="ds-live-grid">
              <form
                className="ds-demo"
                onSubmit={(event) => {
                  event.preventDefault();
                  setError(
                    name.trim() ? "" : "Enter a project name to continue.",
                  );
                  setMessage(
                    name.trim()
                      ? "Looks good. This example does not create a project."
                      : "",
                  );
                }}
                noValidate
              >
                <TextField
                  size={size}
                  label="Project name"
                  icon={FileDirectoryIcon}
                  placeholder="e.g. Website redesign"
                  value={name}
                  required
                  hint="Choose a name that is easy to recognize."
                  error={error}
                  onChange={(event) => {
                    setName(event.target.value);
                    setError("");
                    setMessage("");
                  }}
                />
                <div className="ds-form-action">
                  <Button type="submit" variant="primary" size={size}>
                    Continue
                    <Icon icon={ArrowRightIcon} />
                  </Button>
                </div>
                <p className="ds-message" role="status">
                  {message}
                </p>
              </form>
              <div className="ds-demo">
                <SearchField
                  label="Search sample resources"
                  placeholder="Search memories"
                  size={size}
                  value={query}
                  onValueChange={setQuery}
                />
                <p className="ds-search-count" role="status">
                  {results.length
                    ? `${results.length} sample resource${results.length === 1 ? "" : "s"}`
                    : "No matching sample resources"}
                </p>
                <ul className="ds-results">
                  {results.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
            <section className="ds-state-section">
              <h2>States</h2>
              <p>
                Hover and focus appearances are pinned for comparison. All other
                fields use their native behavior.
              </p>
              <div className="ds-states">
                <TextField
                  label="Default"
                  size={size}
                  icon={FileDirectoryIcon}
                  placeholder="Project name"
                />
                <TextField
                  label="Hover"
                  className="ds-hover"
                  size={size}
                  icon={FileDirectoryIcon}
                  placeholder="Project name"
                />
                <TextField
                  label="Focus"
                  className="ds-focus"
                  size={size}
                  icon={FileDirectoryIcon}
                  placeholder="Project name"
                />
                <TextField
                  label="Filled"
                  size={size}
                  icon={FileDirectoryIcon}
                  defaultValue="Website redesign"
                />
                <TextField
                  label="Error"
                  size={size}
                  icon={FileDirectoryIcon}
                  placeholder="Project name"
                  error="Enter a project name to continue."
                />
                <TextField
                  label="Disabled"
                  size={size}
                  icon={FileDirectoryIcon}
                  placeholder="Project name"
                  disabled
                />
                <TextField
                  label="Read-only"
                  size={size}
                  icon={FileDirectoryIcon}
                  defaultValue="Website redesign"
                  readOnly
                  hint="You can select and copy this value."
                />
              </div>
            </section>
            <section className="ds-state-section">
              <h2>Switches</h2>
              <div className="ds-states">
                <label className="ds-switch-row">
                  <span>Off</span>
                  <Switch />
                </label>
                <label className="ds-switch-row">
                  <span>On</span>
                  <Switch defaultChecked />
                </label>
                <label className="ds-switch-row">
                  <span>Disabled off</span>
                  <Switch disabled />
                </label>
                <label className="ds-switch-row">
                  <span>Disabled on</span>
                  <Switch defaultChecked disabled />
                </label>
              </div>
            </section>
            <section className="ds-state-section">
              <h2>Textarea</h2>
              <div className="ds-live-grid">
                <Textarea
                  label="Description"
                  placeholder="Add context for your collaborators…"
                  hint="Optional. Enter adds a new line; drag the corner to resize."
                  size={size}
                />
                <Textarea
                  label="Read-only description"
                  defaultValue="A shared workspace for project memories, skills, and sessions."
                  size={size}
                  readOnly
                />
              </div>
            </section>
            <p className="ds-footnote">
              {size === "lg"
                ? "40px height · 14px text · 20px icon container · 16px glyph · 12px gap"
                : size === "md"
                  ? "36px height · 14px text · 20px icon container · 16px glyph · 12px gap"
                  : "32px height · 12px text · 18px icon container · 14px glyph · 8px gap"}{" "}
              · 9px corners
            </p>
          </>
        )}
      </div>
    </Overlay>
  );
}
