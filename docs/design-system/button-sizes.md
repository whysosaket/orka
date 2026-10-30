# Orka button sizes

Status: approved and implemented in the standalone HTML specimen and palette CSS exports. Typography is approved separately in `typography.md`. The native frontend now consumes the same dimensions through the shared Button, Icon, and IconButton components; see `components.md`.

All variants use Inter Variable at 500 (Medium). Primary, secondary, and tertiary buttons share the same size rules. A button's visual emphasis is independent of its size.

| Size | Text size reference | Font size | Line height | Letter spacing | Vertical padding, each side | Horizontal padding, each side | Height |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `button-lg` | `body-md` | 16px | 150% / 24px | −0.5% | 12px | 20px | 48px |
| `button-md` | `body-sm` | 14px | 142.9% / 20px | −0.5% | 10px | 16px | 40px |
| `button-sm` | `body-xs` | 12px | 150% / 18px | 0% | 7px | 12px | 32px |

Height equals line height plus vertical padding on both sides; buttons have no border. Preserve whole-pixel line heights in implementation rather than using the rounded display percentages to calculate heights.

Use `button-md` by default, `button-sm` in compact toolbars and lists, and `button-lg` for prominent actions with more space. Tertiary buttons remain text only and use the same padding to align with the other variants.

The component can use `size="lg"`, `size="md"`, and `size="sm"`; the corresponding token groups can be `button-lg-*`, `button-md-*`, and `button-sm-*` (for example `button-md-font-size` and `button-md-padding-x`).

## Icon alignment

| Size | Button height | Inline icon container | Octicon glyph | Icon/text gap | Icon-only button |
| --- | --- | --- | --- | --- | --- |
| `lg` | 48px | 24 × 24px | 20 × 20px | 8px | 48 × 48px |
| `md` | 40px | 20 × 20px | 16 × 16px | 8px | 40 × 40px |
| `sm` | 32px | 18 × 18px | 14 × 14px | 6px | 32 × 32px |

An inline icon container matches the text line height. The Octicon glyph is centered inside it. Equal vertical padding then gives icon and text the same vertical center. Octicons are filled paths: fill with currentColor, no stroke, and inherit the label color.

An icon-only button uses the full corresponding button height for both width and height, with its icon centered. It requires an accessible name. Tertiary buttons remain text only.

Use `.action` for the default md size, `.action.size-lg` for lg, and `.action.size-sm` for sm. `.action.size-md` is an explicit equivalent of the default. Add `.icon-only` for a square icon button. Wrap each SVG in `.button-icon`. Size tokens include `button-md-icon-container`, `button-md-icon-size`, `button-md-gap`, `button-md-height`, and the equivalent lg/sm names.

Browser measurements confirmed button heights, square icon-only controls, icon containers, glyph sizes, and vertical centering at widths 1160, 900, 390, and 320px. These checks apply to the standalone specimen, not the native app.
