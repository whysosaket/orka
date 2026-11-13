# Orka design system implementation

The native frontend now uses Pitch color tokens, the approved Inter Variable scale, and shared Button, Icon, and IconButton components. Existing command handlers and native workflow payloads are retained.

## Sources

- `apps/mac/src/design-system.css`: canonical color, typography, and button dimension tokens; shared control styles.
- `apps/mac/src/style.css`: app layout, navigation, input, resource, and overlay treatments.
- `apps/mac/tailwind.config.cjs`: semantic Tailwind colors and typography mapped to the canonical tokens. Existing color aliases remain compatible.
- `apps/mac/src/components/button.tsx`: text action control.
- `apps/mac/src/components/icon.tsx`: Primer Octicon glyph and its alignment container.
- `apps/mac/src/components/icon-button.tsx`: accessible square action control.

## Button

```tsx
<Button variant="primary" size="md" onClick={onCreate}>
  <Icon icon={Plus} />
  Add project
</Button>

<Button variant="tertiary" size="sm" onClick={onCancel}>
  Cancel
</Button>
```

Variants are `primary`, `secondary`, and `tertiary`; sizes are `lg`, `md`, and `sm`. Defaults are secondary/md. The default HTML type is `button`; use `type="submit"` explicitly in forms. Native disabled, focus, keyboard, ref, and click behavior is preserved. Secondary text and icon buttons keep their dark fill with no outer or inset shadows in any state. Tertiary text actions remain text only.

Text and icon buttons keep their resting size on hover. Background, color, and permitted shadow changes provide feedback without moving or resizing their labels and icons. Pointer press retains a 97% scale: press takes 100ms and release takes 160ms, using `cubic-bezier(0.23, 1, 0.32, 1)`. Disabled controls, keyboard focus, and reduced-motion interactions stay stationary. This follows the Emil design engineering guidance to reduce frequent hover motion and reserve scale for deliberate press feedback.

## Icon and IconButton

```tsx
// Standalone icon: foreground tone and glyph/container sizing.
<Icon icon={Folder} variant="secondary" size="md" />

// Square interactive icon control: the same backgrounds and states as Button.
<IconButton
  icon={Plus}
  variant="primary"
  size="lg"
  aria-label="Add project"
  onClick={onCreate}
/>

<IconButton
  icon={X}
  variant="tertiary"
  size="sm"
  aria-label="Close settings"
  onClick={onClose}
/>
```

Both icon components are separate files. Standalone Icon variants select primary, secondary, or tertiary text tones; `inherit` is the default so icons inside a white button use its dark label color. An optional `label` exposes a standalone icon to assistive technology; otherwise it is decorative. IconButton requires an accessible name and supports all three action treatments in all three sizes.

| Size | Button / icon-button height | Inline icon container | Octicon glyph | Icon/text gap |
| ---- | --------------------------- | --------------------- | ------------- | ------------- |
| lg   | 48px                        | 24px                  | 20px          | 8px           |
| md   | 40px                        | 20px                  | 16px          | 8px           |
| sm   | 32px                        | 18px                  | 14px          | 6px           |

Icon-only controls are square. Inline containers match the label line height. Octicon glyphs are filled with currentColor and stay centered. Within Button, the parent control's size determines the icon dimensions.

## Skill reader

The Skills detail (`apps/mac/src/components/skill-detail.tsx`) is a document column beside a 360px rail with Skill info and Files; below an 840px reader width it folds into one column with a meta line and a Files popover. Styles live in `apps/mac/src/components/skill-detail.css` as un-layered rules so they win over the shared `.resource-detail` layout.

- `SkillDetail`: title card from SKILL.md frontmatter, status pill, Formatted/Markdown segmented control for Markdown files, and the Skill info actions as separate `IconButton`s with accessible labels and `SkillActionTooltip` hover/focus descriptions.
- `SourceCard` and `FileDiffCard` (`file-diff.tsx`): read-only source with line numbers and Markdown tinting. Text comparisons use the actual `@pierre/diffs` React `FileDiff` through `pierre-diff.tsx`, with an Orka header, unified rows, green additions, red deletions, syntax highlighting, word emphasis, and expandable unchanged regions. Shadow-root styles consume Orka semantic tokens and IBM Plex Mono; rendering is read-only and all editing remains external. The bundled Shiki JavaScript engine requires no remote service, worker, or relaxed CSP. Older WebViews that lack Pierre’s CSS/JavaScript capabilities show a clear preview-unavailable message and retain Open in editor; the app’s macOS 12 minimum stays unchanged. Binary files keep their existing summary cards.
- `ReaderState` (`skill-state.tsx`): illustrated empty, error, and comparison states; the PNGs live in `apps/mac/public/skill-states`.
- `SkillReviewOverlay` (`skill-review-overlay.tsx`): the 640px right drawer for Review local edits (`submit-draft` publishes for Can edit, sends for approval for Suggest changes, and has no submit action for View only) and Review local update (`preview-install` → `apply-install` with the reviewed token). Both outgoing actions guard the reviewed files and shared revision; publication uses `publishIfAllowed`. Visibility rules are in `skill-review-state.ts`.

Render the loading region's children as a component, not inline elements: the skeleton pass clones element children through `React.Children.map`, which turns a Markdown string child into an array.

## Preview and validation

`components.html` is generated from the real React components and production CSS. From the repository root, run `npm run design:preview` to rebuild it. This does not open or mutate project data.

The button-state matrix compares default, hover, pressed, keyboard focus, and disabled appearances for text and icon buttons across all three variants. Its size selector switches between lg, md, and sm. Hover, pressed, and focus samples are pinned using rules derived from the production stylesheet; disabled samples use the native disabled attribute. The controls below the matrix remain interactive for trying mouse and keyboard states.

`dark-options.html` shows the approved three-surface Pitch palette. The app uses Pitch only; it does not gain a theme picker.

Native UI inspection is separate from browser fixture evidence; no cross-Mac sync claim is implied.

## Inputs and native review

TextField, SearchField, Textarea, and shared Field are now implemented. Review actual components in Orka Development through **Design system → Inputs**; Foundations and Buttons are available in the same gallery.

## Loading

Use `LoadingRegion` for pending content. Its measured skeletons share neutral
surface tokens, a soft blur, a fade toward the bottom, and a slow opacity pulse.
The same treatment applies to readers, conversations, skill pickers, members, and
settings. Reduced motion keeps placeholders static; available controls and content
stay usable.

Sessions, Memories, and Plans use `CollectionSkeleton` on first discovery, with
title and metadata shapes aligned to the collection rows, without visible loading
copy. Skills cards and Home updates show placeholders only for pending metadata,
keeping known content and navigation available. Decorative shapes stay out of the
accessibility tree; one status announces the pending collection. Background refresh
keeps existing rows visible. Empty and error states appear after the request
settles, with existing retry actions intact.

Local catalogs and project skill usage reuse fresh results and pending requests
across navigation for the configured sync interval. Changing that setting updates
freshness and the visible collection's refresh schedule without clearing loaded
rows or counts. Explicit refresh bypasses freshness. Account, service, profile,
source-folder, and relevant resource changes invalidate their scoped entries.
