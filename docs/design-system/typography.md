# Orka typography

Status: approved. Font family: Inter Variable. This scale is implemented in the native frontend through canonical tokens in `apps/mac/src/design-system.css` and semantic Tailwind typography styles.

Line height and letter spacing percentages are relative to the font size. Line height percentages are rounded for display; the CSS preserves the intended whole-pixel line heights.

| Text style   | Font size | Weight         | Line height | Letter spacing |
| ------------ | --------- | -------------- | ----------- | -------------- |
| `heading-lg` | 32px      | 600 · Semibold | 125%        | −2.5%          |
| `heading-md` | 28px      | 600 · Semibold | 128.6%      | −2%            |
| `heading-sm` | 24px      | 600 · Semibold | 133.3%      | −1.5%          |
| `heading-xs` | 20px      | 600 · Semibold | 140%        | −1%            |
| `body-xl`    | 20px      | 400 · Regular  | 140%        | −1%            |
| `body-lg`    | 18px      | 400 · Regular  | 144.4%      | −1%            |
| `body-md`    | 16px      | 400 · Regular  | 150%        | −0.5%          |
| `body-sm`    | 14px      | 400 · Regular  | 142.9%      | −0.5%          |
| `body-xs`    | 12px      | 400 · Regular  | 150%        | 0%             |
| `body-2xs`   | 10px      | 400 · Regular  | 140%        | 0%             |
| `label-md`   | 16px      | 500 · Medium   | 150%        | −0.5%          |
| `label-sm`   | 14px      | 500 · Medium   | 142.9%      | −0.5%          |
| `label-xs`   | 12px      | 500 · Medium   | 150%        | 0%             |
| `label-2xs`  | 10px      | 500 · Medium   | 140%        | 0%             |

Use 14px as the default for Orka's compact interface. Use 12px for supporting text and 10px only for compact metadata. Use Inter Variable throughout, including paths, file content, counters, and setup steps. Keep whitespace preserved in content previews and use tabular numbers where alignment matters.

Each named text style bundles size, weight, line height, and letter spacing. Color is independent and uses `text-primary`, `text-secondary`, `text-tertiary`, or the other agreed color roles.

Compact dialogs and gallery sections use `heading-xs`. Page titles, navigation, resource titles, and compact section headings use `label-sm`; field labels, small section labels, and checkbox labels use `label-xs`. Notification badges use `label-2xs`, while navigation counts and setup numbers use regular `body-2xs`. Labels alias the matching body metrics and explicitly use the medium weight token. Do not add local line-height or tracking overrides.

Sidebar status text uses `body-xs`, switching to `body-2xs` at the compact breakpoint. There is no 9px or 11px exception.

Resource reading uses `body-md` (16px/24px), including raw content, Markdown body, code, and tables. Preserve whitespace in raw content. Markdown H1 uses `heading-sm`, H2 uses `heading-xs`, and H3–H6 use `label-md`; HTML heading levels retain the document outline. Reader text uses primary color, with secondary reserved for supporting descriptions and blockquotes. Emphasis inside content may use the shared medium/semibold weight tokens without changing its size, line height, or tracking.

`typography.css` provides opt-in classes. Inter Variable must already be loaded by the consumer. CSS expresses letter spacing in `em`: −0.5% becomes `-0.005em`.

Button labels use the approved body sizes and spacing, with an approved component-specific medium weight. Approved button dimensions are documented separately in `button-sizes.md`.
