# 851手書き雑フォント (851tegakizatsu)

`851tegakizatsu-Regular-latin.woff2` is a **subset** of the 851手書き雑フォント
handwriting typeface. It is bundled because AntV Infographic's `hand-drawn`
theme asks for this family by name, and the library itself only loads it from a
remote CDN — which this tool's diagram renderers never reach.

| | |
| --- | --- |
| Author | ダーヤス (Dayasu) |
| Source | <https://pm85122.onamae.jp/851fontpage.html> |
| Original file | `851tegaki_zatsu_normal_0883.ttf`, version 0.883, 28.6 MB |
| SHA-256 of the original | `e5290d6583e1aef725f07921aad69b9eaa83cf3408273cf840ff31842d118f0e` |
| What ships here | Latin, Latin-1, Latin Extended-A, common punctuation, currency and arrows — 53 KB as WOFF2 |

## Terms

The author states them on the page above:

> 商用利用可です　チラシや同人誌や動画などにご自由にお使いください　特に許可はいりません
>
> 改造・再配布はご自由にどうぞ

Commercial use is permitted without asking, and modification and redistribution
are free — which is what makes this subset, and shipping it here, allowed. The
author keeps the copyright and asks only that nobody claim the font as their own
work; this file is that attribution. The font is provided as-is, with the author
disclaiming liability for any damage its use may cause.

## Regenerating the subset

The original was reduced with `pyftsubset` (fontTools):

```sh
pyftsubset 851tegaki_zatsu_normal_0883.ttf \
    --output-file=851tegakizatsu-Regular-latin.woff2 --flavor=woff2 \
    --layout-features='*' --name-IDs='*' \
    --unicodes='U+0020-007E,U+00A0-00FF,U+0100-017F,U+2010-2027,U+2030-205E,U+20A0-20BF,U+2122,U+2190-2193,U+2212,U+2264-2265,U+2022,U+2026'
```

A character outside that range — Japanese, for one — falls back to the next font
in the stack, which is where every other infographic's text is set: Arial.
