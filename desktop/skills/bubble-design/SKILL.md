---
name: bubble-design
description: Load before creating or changing boards with the design_* tools. Layout, type, color, structure and copy guidance.
---

# Designing on the Bubble canvas

The design_* tools say what the canvas allows and where to work. This guide is about making the work good. When the user names a direction, their words win over everything here.

## 1. Read the request first

Decide the treatment before drawing anything.

- **Product UI** (settings, dashboards, flows, admin, most app screens): calm and precise. Real hierarchy, consistent spacing, a restrained palette. No hero, no decoration.
- **Editorial** (landing pages, launches, portfolios, campaign pages): a clear point of view, one bold idea, everything around it quiet.
- **Unsure**: a well-composed, restrained page is always acceptable; an over-designed one often isn't.

Settle three things in one line each before the first board: the subject, who it is for, and the single job of the page.

## 2. Start from what already exists

Precedence: the user's words, then the project's own design system, then your choices.

- If the conversation is in a code project, look for its system first: Tailwind config, CSS variables or theme files, a tokens file, component styles, brand assets. Reuse its colors, type, radii and spacing so the design can be built with what the codebase already has.
- If the document already has boards, match them: same tokens, type scale, spacing rhythm and component shapes. A new page should look like it belongs to the same product.
- Keep layer names and structure stable when revising, so comments and selections still point at the right things.

## 3. Boards

- One board per page or screen. Name boards by what people call them: "Home", "Pricing", "Checkout · Mobile".
- Default sizes: desktop 1440 wide, laptop 1280, tablet 768, phone 390 (844 tall for one screen). Let height follow the content for scrolling pages.
- Make responsive variants separate boards with the same content, not a squeezed copy.
- Build one board at a time: add it, preview it, then do the next.

## 4. Structure that edits well

People edit these boards by hand: they reorder, resize, change spacing and text. Structure the HTML so those edits behave.

- Use semantic sections (header, nav, main, section, footer) and give meaningful layers a `data-bubble-layer-name` ("Hero", "Pricing card", "Primary CTA").
- Lay out sibling groups with flex or grid and `gap`. Avoid per-element margins between siblings; they collapse and fight the spacing handles.
- Avoid absolute positioning except for true overlays (badges, floating decorations, sticky bars). Never position a whole layout absolutely.
- Avoid fixed heights on text containers; let content set height.
- Use readable class names (`.pricing-card`, not `.c3`); the Code tab shows them.
- Text that people will edit should sit directly in its own element (an `h1`, a `p`, a `span`), not split across many inline fragments.

## 5. Tokens first

Before the first board, write a compact token set as CSS variables on `:root` and derive every color and type decision from it:

- **Color**: 4–6 named tokens (background, surface, text, muted text, accent, and a line color if needed).
- **Type**: font tokens for each role (display, body, and a utility face for numbers or captions if useful) and a type scale you keep to.
- A one-line comment above them naming the layout idea.

Reuse the same tokens on every board in the document.

## 6. Typography

- Remote fonts don't load on the canvas. Use system stacks, or inline a font as a data-URL `@font-face` only when the brand truly needs it.
  - Sans: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif`
  - Serif: `"New York", Georgia, "Songti SC", "Noto Serif SC", serif`
  - Mono: `"SF Mono", ui-monospace, Menlo, Consolas, monospace`
- For Chinese text, keep line-height around 1.6–1.8 for body and avoid letter-spacing on CJK; reserve tight negative tracking for Latin display type.
- Running text near 65 Latin characters (about 30–40 CJK characters) per line.
- A real scale with few steps; headings with `text-wrap: balance`; uppercase labels with a little letter-spacing; `font-variant-numeric: tabular-nums` where digits line up.

## 7. Color and surfaces

- Choose neutrals deliberately. A grey with a slight bias toward the accent looks intentional; pure mid-grey looks unconsidered.
- One accent, used with intent. Semantic colors (success, warning, error) are separate from it.
- Use borders, fills, radius and shadow by role, to set off the one element that needs it. The same radius and shadow on every block flattens the page.
- Check contrast: body text at least 4.5:1 against its background.

## 8. Avoid the generated look

These patterns read as AI-made. Don't use them unless the user asks:

- Purple-to-blue gradient heroes, gradient text on headlines, glowing blurred blobs or floating spheres as filler.
- Warm cream with a serif display and a terracotta accent; near-black with a single neon accent.
- Everything centered; giant hero filling the first screen with little content.
- `rounded-lg` cards with soft shadows everywhere; colored accent bars on the side of cards.
- Emoji as icons or section markers; three identical feature cards with an icon, a title and two lines.
- Numbered markers (01 / 02 / 03) on things that aren't a real sequence.
- Inter or Space Grotesk as the default face.

Instead, ground the design in the subject: its real content, units, terms and conventions. Include at least one detail only this subject would have.

## 9. Content and images

- Real content only, never lorem ipsum. Use plausible names, numbers and copy from the subject's world.
- Images: inline SVG illustrations or icons, CSS shapes, or small data-URL images. No remote images.
- Draw icons as simple inline SVG with one stroke width, sized to the text they sit beside.

## 10. Writing the copy

- Write from the user's side of the screen: name things by what people recognize.
- Buttons say exactly what happens ("Start free trial", "Save changes").
- Short, plain sentences. Avoid em-dash asides, "not X but Y" framing and stock phrases.
- Match the language the user writes in.

## 11. Check once with a preview

After each board, preview it once and look for: text overflowing or clipped, elements overlapping, misaligned edges in repeated items, low contrast, an empty or stretched area, and anything from section 8. Fix what you find in one pass, then move on. Don't loop on previews; the user reviews and comments on the canvas.
