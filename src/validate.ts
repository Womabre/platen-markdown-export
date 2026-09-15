import * as fs from 'fs';
import { ExitError } from './errors';

export function validate(
    weasyprintPath: string | null,
    htmlFile: string | null,
    markdownFile: string | null,
    stylesheetPath: string | null,
    skipWeasyprint = false,
): void {
    if (!skipWeasyprint) {
        if (!weasyprintPath)
            throw new ExitError(
                'WeasyPrint not found. Run "platen-markdown-export --setup" to install it automatically, or install manually:\n' +
                '  macOS:   brew install weasyprint\n' +
                '  Windows: pip install weasyprint\n' +
                '  Linux:   apt install weasyprint  (or pip install weasyprint)',
                4,
            );

        if (!fs.existsSync(weasyprintPath))
            throw new ExitError(`WeasyPrint resolved to "${weasyprintPath}" but file does not exist`, 4);
    }

    if (htmlFile && !fs.existsSync(htmlFile))
        throw new ExitError(`HTML file not found: ${htmlFile}`, 3);

    if (markdownFile && !fs.existsSync(markdownFile))
        throw new ExitError(`Markdown file not found: ${markdownFile}`, 3);

    if (stylesheetPath && !fs.existsSync(stylesheetPath))
        throw new ExitError(`Stylesheet not found: ${stylesheetPath}`, 3);

    // Theme assets (CSS/HTML templates, logos) are validated by loadTheme()
    // when the active theme is loaded in main().
}
