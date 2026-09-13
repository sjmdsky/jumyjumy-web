# DESIGN.md

This document defines the visual design language, interaction guidelines, and information architecture for `jumyjumy-web`.

> **Site Language**: **ONLY English (`en`)**. All user-facing UI copy, placeholders, meta tags, and structured content must be strictly in English.

---

## 1. Design Philosophy: Extreme Minimalism (Zen & Content-First)

- **Positioning**: **Real-time AI Search** — every answer is drawn from the live web at the time it is asked, carries its sources, and shows when it was last updated. Copy, meta tags and UI states should reinforce "search, live, sourced", not "chatbot" or "Q&A forum".
- **Core Mission**: Eliminate all non-essential elements; focus 100% on "searching anything and getting a direct, current, sourced answer."
- **Zero Cognitive Load**: No cluttered sidebars, no carousels, no infinite recommendation feeds, no banner ads.
- **Extreme Performance & SEO**: Zero external web-font render blocking, zero redundant JS runtime, sub-second LCP (< 0.8s) and zero CLS.
- **Adaptive Dark Mode**: High-contrast, clean monochrome palette adapting seamlessly to `prefers-color-scheme`.

---

## 2. Information Architecture & Page Specs

The platform consists of only two page types:

```text
jumyjumy-web
├── 1. Homepage (/)                 -> Minimalist centered real-time search box
└── 2. Answer Detail (/q/<slug>-<id>) -> Focused, high-readability Q&A article
```

---

### 2.1 Homepage (`/`)

#### Visual Layout
- **Viewport Centering**: Centered vertically (optical golden ratio ~38vh - 42vh offset) and horizontally.
- **Minimalist Branding**: Stylized `JumyJumy` logo with twin capitalized chromatic gradient `"J"` letters and crisp monochrome `"umy"` body text.
- **Tagline**: `Real-time AI Search`
- **Meta**: `<title>JumyJumy — Real-time AI Search</title>`; description `Real-time AI search. Ask anything and get a direct answer drawn from the live web, with cited sources.`
- **Single Interactive Element (Search Box)**:
  - Generous input box (Height $\approx 56\text{px}$, pill radius) with subtle hairline border and smooth focus ring.
  - Placeholder: `Ask a question...`
  - Right-aligned minimal action arrow button.
  - Autofocus enabled on desktop viewport.
- **Footer**: Removed to keep the homepage purely minimal.

```text
+-------------------------------------------------------------+
|                                                             |
|                                                             |
|                          JumyJumy                           |
|                     Real-time AI Search                     |
|                                                             |
|        +-------------------------------------------+        |
|        |  Ask a question...                 [ -> ] |        |
|        +-------------------------------------------+        |
|                                                             |
|                                                             |
|                                                             |
+-------------------------------------------------------------+
```

---

### 2.2 Question Detail Page (`/q/<slug>-<id>`)

#### Visual Layout
- **Header**: Minimal single line with stylized brand logo `JumyJumy` linking back to `/`.
- **Main Container**: Optimal reading line length (`max-width: 720px`), centered with generous whitespace.
- **Question Title**: `<h1>` in clean, strong typography ($28\text{px} \sim 36\text{px}$, font-weight: 700, line-height: 1.3).
- **Metadata Row**: Publish/update date, reading time estimate, status badge.
- **Answer Body**:
  - Secure HTML rendered via `renderAnswer()`.
  - Body font size: $17\text{px} \sim 18\text{px}$, line-height: 1.75.
  - Code blocks (`<pre><code>`): Rounded corners, monospace font, horizontal scroll, dedicated light/dark backgrounds.
  - Blockquotes: $3\text{px}$ solid accent bar on left.
  - Links: Underlined, with `rel="nofollow noopener"`.
- **Authoritative Sources Section**:
  - Structured list under heading `Sources & References`.
  - Compact list with clean article titles and safe outbound links.
- **Footer**: Clean return to home link (`← Return to Search`).

---

## 3. Design Tokens

### 3.1 Color Palette

Monochrome foundation with subtle neutral gray tones:

| Token | Light Mode | Dark Mode | Purpose |
| :--- | :--- | :--- | :--- |
| `--color-bg` | `#ffffff` | `#0f1115` | Page background |
| `--color-bg-subtle` | `#f8f9fa` | `#181b20` | Code blocks, cards, badges |
| `--color-bg-input` | `#ffffff` | `#15181d` | Search input background |
| `--color-text-primary` | `#111827` | `#f3f4f6` | Headings, primary body text |
| `--color-text-secondary`| `#6b7280` | `#9ca3af` | Metadata, secondary copy |
| `--color-text-placeholder`| `#9ca3af` | `#6b7280` | Input placeholder |
| `--color-border` | `#e5e7eb` | `#2d333b` | Borders, dividers |
| `--color-border-hover` | `#9ca3af` | `#4b5563` | Hover / active border |
| `--color-border-focus` | `#111827` | `#f3f4f6` | Focus outline |
| `--color-accent` | `#111827` | `#f3f4f6` | Primary button / accent |
| `--color-accent-text` | `#ffffff` | `#0f1115` | Text inside accent buttons |
| `--logo-j1-gradient` | `linear-gradient(135deg, #f59e0b, #f97316, #fb7185)` | `linear-gradient(135deg, #fbbf24, #fb923c, #f43f5e)` | First 'J' sunset glow brand gradient |
| `--logo-j2-gradient` | `linear-gradient(135deg, #f97316, #fb7185, #f43f5e)` | `linear-gradient(135deg, #fb923c, #f43f5e, #fb7185)` | Second 'J' sunset glow brand gradient |

### 3.2 Typography

High-performance, zero-blocking modern system font stacks:

```css
--font-brand: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;

--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
             Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji";

--font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
             "Liberation Mono", "Courier New", monospace;
```

---

## 4. Accessibility & SEO Invariants

1. **A11y**:
   - High contrast ratios (WCAG AAA compliant).
   - Visible `:focus-visible` outlines for full keyboard navigation.
   - Screen reader accessible labels (`aria-label`) on all inputs and icon buttons.
2. **SEO**:
   - Valid Schema.org `QAPage` / `FAQPage` JSON-LD structured data on detail pages.
   - Semantic HTML5 tags (`<main>`, `<header>`, `<article>`, `<section>`, `<footer>`).
