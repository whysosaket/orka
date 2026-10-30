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
| --- | --- | --- | --- | --- |
| lg | 48px | 24px | 20px | 8px |
| md | 40px | 20px | 16px | 8px |
| sm | 32px | 18px | 14px | 6px |

Icon-only controls are square. Inline containers match the label line height. Octicon glyphs are filled with currentColor and stay centered. Within Button, the parent control's size determines the icon dimensions.

## Preview and validation

`components.html` is generated from the real React components and production CSS. From the repository root, run `npm run design:preview` to rebuild it. This does not open or mutate project data.

The button-state matrix compares default, hover, pressed, keyboard focus, and disabled appearances for text and icon buttons across all three variants. Its size selector switches between lg, md, and sm. Hover, pressed, and focus samples are pinned using rules derived from the production stylesheet; disabled samples use the native disabled attribute. The controls below the matrix remain interactive for trying mouse and keyboard states.

`dark-options.html` shows the approved three-surface Pitch palette. The app uses Pitch only; it does not gain a theme picker.

 Native UI inspection is separate from browser fixture evidence; no cross-Mac sync claim is implied.

## Inputs and native review

TextField, SearchField, Textarea, and shared Field are now implemented. Review actual components in Orka Development through **Design system → Inputs**; Foundations and Buttons are available in the same gallery.
