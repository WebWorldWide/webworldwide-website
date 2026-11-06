# CMS design contract

The admin is a repeated-task tool for one editor. The design gives it a point of
view through proportion, typography, rules, and selection marks. It does not use
marketing scenes. The public site has its own look, and nothing here applies to
it.

## Purpose

Write, publish, and moderate quickly. The editor should always be able to answer
three questions at a glance: where am I, what is selected, and what is live.

## Art direction

**An editorial ledger on warm paper.** Navy ink sits on an off-white sheet. Page
titles are set large in a condensed serif over a single ink rule, with calm
condensed-caps metadata beneath. Selection is shown with a small precision mark,
not a filled pill.

## Reference roles

- **Locomotive** supplies the layout: an editorial hierarchy, a small label over
  a thin rule, plain navigation, and generous type contrast.
- **Remy Shoots** supplies the instrument detail: triangular selection markers,
  bracketed counts such as `Posts (24)`, condensed utility caps, and ruled
  tick marks.
- **Studio Loop** supplies the palette and metadata: a warm paper canvas, numbered
  groups, and key/value rows separated by hairlines (the editor inspector and the
  login masthead).
- **Original to this CMS:** the brand-blue accent and the globe mark. The post
  canvas keeps a reading serif because it previews the published article.

## Typography

| Role               | Face                                        | Use                                          |
| ------------------ | ------------------------------------------- | -------------------------------------------- |
| Display, signature | Instrument Serif 400 and italic; never bold | Page titles, post title, brand, empty states |
| Interface, reading | Archivo, wdth 100, weight 450–620           | Body text, buttons, form labels              |
| Utility labels     | Archivo, wdth 82, weight 600, +0.07em, caps | Section labels, table heads, status, counts  |
| Data               | Archivo with tabular figures                | Counts, dates, sizes                         |
| Code               | JetBrains Mono                              | Markdown source, kbd                         |

Page titles run 40–52px against 11px utility caps. That scale contrast is the
main source of hierarchy.

## Surfaces

- **Canvas and chrome:** warm paper (`--bg-page #f4f2ec`). The sidebar and top
  bar are the same paper, with only a hairline between them.
- **Content:** white sheets (`--surface`) with a 1px hairline and a 6px radius,
  and no drop shadows. Elevation is reserved for things that float: menus,
  modals, toasts, and drawers.
- **Rules:** hairlines (`--line-www`) divide rows. The page head ends in a 1px
  ink rule (`--rule`).
- **Accent:** brand blue, and only for action and selection. Danger is red;
  status uses the ok, warn, and danger tiers. Contrast tiers are documented in
  `tokens.css`.
- **Radii by function:** controls 6px, sheets 6px, floating surfaces 10px,
  status dots fully round. There are no pill buttons.
- **Icons:** Lucide line icons at a 1.75 stroke in currentColor, 18px in
  navigation and 16px in toolbars. The set is not mixed with other families.

## Signature interaction

- **Selection continuity:** the active navigation item, tab, and table row share
  one vocabulary of ink text, accent mark, and no fill.
- **View change:** the new view fades in and rises 6px over 240ms. With reduced
  motion it appears instantly.
- **Motion vocabulary:** controls take 140ms and panels take 240ms, all on one
  easing curve, `--ease: cubic-bezier(0.2, 0.7, 0.2, 1)`.

## Small screens

- The sidebar becomes a drawer.
- Page heads stack, with actions moving under the title.
- Stat strips reflow to two columns.
- The editor toolbar becomes a single horizontally scrolling row with 44px
  targets.
- The login masthead collapses to a compact wordmark above the form.

## Implementation

`public/css/studio.css` loads last and carries this contract: tokens,
surfaces, selection, and motion. `design.css` holds the type roles and the
density work that came before it.
