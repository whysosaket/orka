# Orka button sizes

Status: updated for the approved November 7 Settings library. The native app and component gallery use these dimensions; older standalone palette specimens retain their historical measurements. Typography is approved separately in `typography.md`. The native frontend now consumes the same dimensions through the shared Button, Icon, and IconButton components; see `components.md`.

All variants use Inter Variable at 500 (Medium). Primary, Primary Brand, secondary, and tertiary buttons share the same size rules. A button's visual emphasis is independent of its size.

| Size | Text size reference | Font size | Line height | Letter spacing | Vertical padding, each side | Horizontal padding, each side | Height |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `button-lg` | `body-sm` | 14px | 20px | −0.5% | 10px | 16px | 40px |
| `button-md` | `body-sm` | 14px | 20px | −0.5% | 8px | 14px | 36px |
| `button-sm` | `body-xs` | 12px | 150% / 18px | 0% | 7px | 12px | 32px |

Height equals line height plus vertical padding on both sides; buttons have no border. Preserve whole-pixel line heights in implementation rather than using the rounded display percentages to calculate heights.

Use `button-md` by default, `button-sm` in compact toolbars and lists, and `button-lg` for prominent actions with more space. Tertiary buttons use Surface tertiary and use the same padding to align with the other variants.

The component can use `size="lg"`, `size="md"`, and `size="sm"`; the corresponding token groups can be `button-lg-*`, `button-md-*`, and `button-sm-*` (for example `button-md-font-size` and `button-md-padding-x`).

## Icon alignment

| Size | Button height | Inline icon container | Octicon glyph | Icon/text gap | Icon-only button |
| --- | --- | --- | --- | --- | --- |
| `lg` | 40px | 20 × 20px | 16 × 16px | 8px | 40 × 40px |
| `md` | 36px | 20 × 20px | 16 × 16px | 8px | 36 × 36px |
| `sm` | 32px | 18 × 18px | 14 × 14px | 6px | 32 × 32px |

An inline icon container matches the text line height. The Octicon glyph is centered inside it. Equal vertical padding then gives icon and text the same vertical center. Octicons are filled paths: fill with currentColor, no stroke, and inherit the label color.

An icon-only button uses the full corresponding button height for both width and height, with its icon centered. It requires an accessible name. Tertiary buttons use Surface tertiary.

Use `.action` for the default md size, `.action.size-lg` for lg, and `.action.size-sm` for sm. `.action.size-md` is an explicit equivalent of the default. Add `.icon-only` for a square icon button. Wrap each SVG in `.button-icon`. Size tokens include `button-md-icon-container`, `button-md-icon-size`, `button-md-gap`, `button-md-height`, and the equivalent lg/sm names.

Historical standalone measurements covered 1160, 900, 390, and 320px. Those specimens predate the November 7 sizes. Current React rendering was checked at 1440, 1160, and 900px, with shared controls also inspected in the development gallery.

Buttons use existing neutral100 for Primary and copper500 for Primary Brand. Their foreground remains stable on hover. LG/MD/SM radii are 10/9/8px. Keyboard focus remains visible.
