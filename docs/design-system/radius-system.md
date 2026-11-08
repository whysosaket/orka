# Corner radius system

Status: updated November 7. Buttons use the approved size-specific 10/9/8px radii; fields retain the canonical 9px radius-control token.

| Token            | Value  | Use                                                          |
| ---------------- | ------ | ------------------------------------------------------------ |
| `radius-none`    | 0px    | Flush panes and edge-to-edge content                         |
| `radius-detail`  | 4px    | Small tags, keyboard keys, nested utilities                  |
| `radius-control` | 9px    | MD buttons, inputs, search, textareas, and selectors         |
| `radius-surface` | 12px   | Cards, popovers, and the workspace canvas                    |
| `radius-list`    | 15px   | Approved Settings source-folder list                         |
| `radius-overlay` | 16px   | Dialogs and large floating panels                            |
| `radius-full`    | 9999px | Avatars, status dots, and intentionally pill-shaped elements |

Buttons and IconButtons use LG 10px, MD 9px, and SM 8px across all interaction states. Other controls retain their existing semantic radius. A textarea remains a control even when its height grows. Do not make an icon button circular merely because it is square. Parent and child roles choose their own radius; do not invent intermediate values to make every nested corner concentric.

The input proposal uses flat surfaces without resting, hover, or error borders. Hover changes the fill; focus retains the approved muted 1px outline with 2px offset. Error feedback uses the Octicon AlertIcon and a specific message. Input icon-container-to-text gaps are proposed at 12px for lg/md and 8px for sm. Button gaps remain approved at 8px/8px/6px.

## Native review plan

1. Establish approved radius roles in the canonical design-system stylesheet. Replace radius literals in shared components without changing their handlers.
2. Add a development-only Design System screen inside Orka, with Foundations, Buttons, and Inputs sections. Render the same React components and local font assets that the app uses. Keep examples isolated from project data and native commands.
3. Add the field components to that screen. Review actual focus, typing, selection, hover, validation, disabled, and read-only behavior at the native 1160 × 800 and 900 × 640 window sizes.
4. Once the components are approved, apply them to existing app flows. Keep HTML for written proposals and handoff; use the native gallery for final visual review.

The development-only native Design System screen is implemented. Shared buttons, fields, and the workspace canvas use the new tokens; a wholesale migration of other app containers is not included. `radius.css` supplies the standalone review tokens. Inter Variable was verified in Chrome's rendered-font report for the HTML heading, input, and button; native WebView review remains a separate step.
