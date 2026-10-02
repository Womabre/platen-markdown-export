/**
 * Copy buttons on code blocks — HTML export only.
 *
 * The button is created by a script in the exported page, never written into the
 * markup. That is what keeps the PDF clean without a single print rule: WeasyPrint
 * runs no JavaScript, so a document exported to both formats shares one body and
 * only the browser ever grows a button. (A PDF cannot carry a working clipboard
 * button anyway — that needs Acrobat-only PDF JavaScript.)
 *
 * Which blocks get one: `Copy Buttons` (frontmatter, default on) sets the
 * document default; a `copy` / `nocopy` word in a fence's info string lands on
 * its `<pre>` as `data-copy="on|off"` (markdown.ts) and overrides it.
 */

import { escHtml } from './frontmatter';
import { attrOf, findTags } from './attributes';
import { readableTextOn } from './color';
import { getActiveTheme, resolveStyleMainColor } from './theme';
import type { StyleFrontmatter } from './types';

/**
 * The colour that confirms a copy: the document's style colour, else the
 * theme's default palette — so an unstyled Platen document confirms in Platen's
 * navy, not in a colour no theme chose.
 */
export function copyAccentColor(style: string | StyleFrontmatter | null): string {
    return resolveStyleMainColor(style)
        ?? resolveStyleMainColor(getActiveTheme().defaultPalette)
        ?? '#2da44e';
}

/**
 * Styling borrows from the code block it sits on — `currentColor` for text and
 * border, `inherit` for the font family — so it reads as part of whatever
 * highlight.js theme the active theme picked, light or dark, with no per-theme
 * CSS. The label gets a size floor: print themes set code at 9pt, and .75em of
 * that is too small to hit. "Copied" is a filled pill in the theme's accent with
 * text picked for contrast against it, so it reads on a light or a dark block.
 */
export function buildCopyButtonCss(accent: string): string {
    const fill = escHtml(accent);
    const ink  = readableTextOn(accent);
    return `<style>
pre.has-copy-button { position: relative; }
pre.has-copy-button > .copy-button {
    position: absolute; top: .45em; right: .45em;
    padding: .2em .6em;
    font: inherit; font-size: max(.75em, 11px); line-height: 1.4;
    color: inherit;
    background: color-mix(in srgb, currentColor 6%, transparent);
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 4px;
    cursor: pointer;
    opacity: 0;
    transition: opacity .15s ease, border-color .15s ease;
}
pre.has-copy-button:hover > .copy-button,
pre.has-copy-button > .copy-button:focus-visible,
pre.has-copy-button > .copy-button.copied { opacity: 1; }
pre.has-copy-button > .copy-button:hover { border-color: currentColor; }
pre.has-copy-button > .copy-button.copied {
    color: ${ink}; background: ${fill}; border-color: ${fill};
}
@media (hover: none) { pre.has-copy-button > .copy-button { opacity: 1; } }
@media print { pre.has-copy-button > .copy-button { display: none; } }
</style>`;
}

/**
 * The script that adds the buttons. `textContent` is copied rather than
 * `innerText`: it is independent of layout, and it leaves out the CSS-counter
 * line numbers of `Code Line Numbers` and the button's own label (the button is
 * a sibling of `<code>`, not inside it).
 *
 * `navigator.clipboard` needs a secure context; a file opened from disk is one
 * in Chromium but not everywhere, so a hidden-textarea `execCommand('copy')`
 * is the fallback, and when both refuse the code is selected for a manual copy.
 */
export function buildCopyButtonScript(defaultOn: boolean): string {
    return `<script>
(function () {
  var DEFAULT_ON = ${defaultOn ? 'true' : 'false'};
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
  }
  function selectCode(code) {
    var range = document.createRange();
    range.selectNodeContents(code);
    var sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
  }
  function copy(text) {
    if (navigator.clipboard && window.isSecureContext)
      return navigator.clipboard.writeText(text).catch(function () { return fallbackCopy(text); });
    return fallbackCopy(text);
  }
  document.querySelectorAll('pre > code').forEach(function (code) {
    var pre  = code.parentElement;
    var flag = pre.getAttribute('data-copy');
    if (flag === 'off' || (flag !== 'on' && !DEFAULT_ON)) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-button';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy code to clipboard');
    var timer;
    btn.addEventListener('click', function () {
      copy(code.textContent.replace(/\\n$/, '')).then(function () {
        btn.textContent = 'Copied!'; btn.classList.add('copied');
      }, function () {
        // Clipboard refused (no permission, old browser): select the code so
        // one keystroke finishes the job.
        selectCode(code);
        btn.textContent = /Mac|iP/.test(navigator.platform) ? 'Press \u2318C' : 'Press Ctrl+C';
      }).then(function () {
        clearTimeout(timer);
        timer = setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
      });
    });
    pre.classList.add('has-copy-button');
    pre.appendChild(btn);
  });
})();
</script>`;
}

/**
 * Whether the document has any block the script would act on. A page with no
 * code, or with buttons off and no `copy` flag, ships neither script nor CSS.
 */
export function documentWantsCopyButtons(html: string, defaultOn: boolean): boolean {
    if (!/<pre\b[^>]*>\s*<code\b/i.test(html)) return false;
    return defaultOn || findTags(html, 'pre').some(tag => attrOf(tag, 'data-copy') === 'on');
}
