# Platen brand assets

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="platen-wordmark-white.svg">
  <img alt="Platen" src="platen-wordmark.svg" width="320">
</picture>

The logo is a serif **P** with two lines of text under its bowl. There are four
drawings, and each comes in a black file and a white copy.

| File | What it is | Use it for |
| ---- | ---------- | ---------- |
| `platen-wordmark.svg` | The logo, followed by "laten" | README headers, docs, title bars — anywhere with room for the name. |
| `platen-logo.svg` | The P and its two lines | Where the name is already on the page. Also favicons: it is the one that still reads at 16 px. |
| `platen-icon-filled.svg` | The logo in a solid rounded square, letter in the opposite colour | App and Marketplace icons, avatars. Solid, so it holds up on any background. **≥ 24 px.** |
| `platen-icon-transparent.svg` | The same square with the letter cut out | On a flat background you control — whatever is behind the icon shows through the letter. **≥ 24 px.** |

Every file has a `-white.svg` copy: the ink is white, and in `platen-icon-filled-white.svg`
the letter turns black. Pick by background — black files on light, white copies on dark.

**The 24 px floor is measured.** Below it, the two lines inside the square run together
into one grey bar. Use `platen-logo.svg` there instead of scaling an icon down.

## Setting the colour

Each file sets its colour once, so there is one place to change it.

**Inline SVG** — pasted into an HTML page. The ink is `fill="currentColor"` on the `<svg>`
element, so the mark takes the text colour around it: put `color: #b91c1c` on a parent
and the logo turns red, and a dark theme that changes `color` changes the logo with it.
A CSS `fill` on the `<svg>` works too.

**A file you are editing.** Change that one `fill` attribute on `<svg>`.
`platen-icon-filled.svg` has a second one, `fill="#fff"` on the `<g>` that holds the
letter. Change both when you invert it — a light ink with the letter still white makes
the letter disappear.

**`<img>`, `<picture>` and Markdown images.** CSS cannot reach inside an image file, so
`currentColor` there is always black. Use the `-white.svg` copy on dark backgrounds, and
switch between the two with `<picture>`, as the top of this file does:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="platen-wordmark-white.svg">
  <img alt="Platen" src="platen-wordmark.svg" width="320">
</picture>
```

Give an `<img>` a `width` or `height`. The files don't have a fixed size of their own
(`width="100%"`), so without one a browser falls back to its default 300 × 150 box.

## Changing the logo

The sources are Affinity Designer files (`platen-logo.af`, `platen-wordmark.af`,
`platen-icon.af`). Nothing in this folder is edited by hand:

1. Edit the `.af` file.
2. Export SVG over the same file name in this folder.
3. Run `npm run brand`.

Affinity puts a colour on every path it exports. `npm run brand`
(`scripts/brand-svgs.js`) rewrites each export so the colour sits in the one place
described above, and regenerates every `-white.svg`. It is safe to run twice. Edit a
white copy by hand and the next run overwrites it.

The same run renders `vscode-extension/icon.png` (256 px) from `platen-icon-filled.svg`.
The VS Code packager refuses SVG icons, so the extension needs a PNG, and generating it
keeps it in step with the drawing.

The script moves a colour only when a whole group shares it. If an export has a single
differently coloured shape, the script stops and says so — group the shapes that share a
colour in Affinity and export again.

**The `.af` files are not in git** (`.gitignore`). The SVGs are all this repository
has, so keep the Affinity sources backed up somewhere else.

## What these are not

**Not the theme placeholder.** `themes/acme-logo-*.svg` is a stand-in *customer* brand
for the theme tree — the thing a user replaces with their own logo. Don't point a theme
at these files; keeping them apart is what stops the tool's own identity leaking into
the demo brand.

**Source folder not published.** `package.json`'s `files` field ships `dist/`,
`themes/` and `assets/`, so this folder stays out of the npm package. The
[`Platen` house theme](../themes/platen/README.md) ships copies of the black and
white wordmark and logo in its own `logos/` folder. Refresh those four copies
after updating the brand assets. Other themes keep their customer placeholders.

**Not covered by the code licence.** The MIT licence covers the code. The logo
identifies the project — if you fork it, replace the logo.
