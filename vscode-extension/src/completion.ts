import * as vscode from 'vscode';
import { themePathArgs, parseStyleList, type ExportSettings, type ThemeEntry } from './core';
import {
    parseFrontmatterSchema, completionContext, presentKeys, keySuggestions, findKey, keyAt, topLevelValue,
    type SchemaKey,
} from './frontmatter-schema';

/**
 * Completion and hover for frontmatter keys in Markdown documents.
 *
 * Red Hat's YAML extension would be the natural home, but it does not look
 * inside Markdown: redhat-developer/vscode-yaml#207 has been open since 2019,
 * and its maintainers' position is that a Markdown extension should forward the
 * requests. So the extension answers them itself, from the CLI's
 * `--frontmatter-schema` — never from a key list of its own.
 *
 * Every answer is cached per CLI, since the key list only changes when the CLI
 * does, and cleared by `clearCompletionCache` when a setting that picks the CLI
 * or its themes changes.
 */

interface CompletionCli { command: string; baseArgs: string[] }

/** What the providers need from the rest of the extension. */
export interface CompletionHost {
    enabled(): boolean;
    readSettings(): ExportSettings;
    resolveCli(target: vscode.Uri): CompletionCli | undefined;
    queryCli(command: string, args: string[], cwd?: string): Promise<string | null>;
    listThemes(anchor: vscode.Uri): Promise<ThemeEntry[]>;
}

const schemaCache = new Map<string, Promise<SchemaKey[]>>();
const styleCache = new Map<string, Promise<string[]>>();

/** Forgets every cached answer — the CLI, its environment or its theme roots changed. */
export function clearCompletionCache(): void {
    schemaCache.clear();
    styleCache.clear();
}

const cliKey = (cli: CompletionCli, extra: string[]): string => JSON.stringify([cli.command, ...cli.baseArgs, ...extra]);

function schemaFor(host: CompletionHost, cli: CompletionCli): Promise<SchemaKey[]> {
    const args = [...cli.baseArgs, '--frontmatter-schema'];
    const key = cliKey(cli, args);
    let pending = schemaCache.get(key);
    if (!pending) {
        // An older CLI refuses the flag; that caches as "no keys" until the CLI
        // setting changes, rather than re-spawning it on every keystroke.
        pending = host.queryCli(cli.command, args).then(parseFrontmatterSchema);
        schemaCache.set(key, pending);
    }
    return pending;
}

function stylesFor(host: CompletionHost, cli: CompletionCli, theme: string | null): Promise<string[]> {
    const args = [...cli.baseArgs, ...themePathArgs(host.readSettings().themePaths),
                  ...(theme ? ['--theme', theme] : []), '--list-styles', '--json'];
    const key = cliKey(cli, args);
    let pending = styleCache.get(key);
    if (!pending) {
        pending = host.queryCli(cli.command, args).then(parseStyleList);
        styleCache.set(key, pending);
    }
    return pending;
}

const linesOf = (doc: vscode.TextDocument): string[] =>
    Array.from({ length: doc.lineCount }, (_, i) => doc.lineAt(i).text);

/** The values to offer after `Key: ` — from the schema, or asked of the CLI for Theme and Style. */
async function valuesFor(
    host: CompletionHost, cli: CompletionCli, doc: vscode.TextDocument, lines: string[], key: SchemaKey,
): Promise<string[]> {
    const name = key.key.toLowerCase();
    if (name === 'theme') {
        const themes = await host.listThemes(doc.uri);
        return [...new Set(themes.map(t => t.displayName ?? t.name))];
    }
    if (name === 'style') {
        // The theme a document names is the one its styles come from; the
        // `theme` setting overrides it in an export, so it does here too.
        const forced = (vscode.workspace.getConfiguration('platenMarkdownExport').get<string>('theme') || '').trim();
        return stylesFor(host, cli, forced || topLevelValue(lines, 'Theme'));
    }
    return key.values;
}

function markdownFor(key: SchemaKey): vscode.MarkdownString {
    const md = new vscode.MarkdownString(`**${key.key}**\n\n${key.description}`);
    if (key.values.length && key.values.length <= 8) {
        md.appendMarkdown(`\n\nValues: ${key.values.map(v => `\`${v}\``).join(', ')}`);
    }
    return md;
}

export function registerFrontmatterCompletion(host: CompletionHost): vscode.Disposable {
    const selector: vscode.DocumentSelector = { language: 'markdown', scheme: 'file' };

    const completion: vscode.CompletionItemProvider = {
        async provideCompletionItems(doc, position) {
            if (!host.enabled()) { return; }
            const lines = linesOf(doc);
            // Decided from the text before anything is spawned, so typing prose
            // in the body never starts a CLI process.
            const context = completionContext(lines, position.line, position.character);
            if (!context) { return; }

            const cli = host.resolveCli(doc.uri);
            if (!cli) { return; }
            const keys = await schemaFor(host, cli);
            if (!keys.length) { return; }

            const range = new vscode.Range(position.line, context.start, position.line, position.character);

            if (context.kind === 'key') {
                return keySuggestions(keys, presentKeys(lines, position.line)).map(k => {
                    const item = new vscode.CompletionItem(k.key, vscode.CompletionItemKind.Property);
                    item.insertText = `${k.key}: `;
                    item.filterText = k.key;
                    item.range = range;
                    item.documentation = markdownFor(k);
                    // Offer the value list straight after the key goes in.
                    if (k.values.length || ['theme', 'style'].includes(k.key.toLowerCase())) {
                        item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest values' };
                    }
                    return item;
                });
            }

            const key = findKey(keys, context.key);
            if (!key) { return; }
            const values = await valuesFor(host, cli, doc, lines, key);
            // `Key:value` is not a YAML mapping, so a value picked straight after
            // the colon brings its own space.
            const pad = lines[position.line][context.start - 1] === ':' ? ' ' : '';
            return values.map((value, i) => {
                const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.Value);
                item.insertText = pad + value;
                item.filterText = pad + value;
                item.range = range;
                item.sortText = String(i).padStart(3, '0');
                return item;
            });
        },
    };

    const hover: vscode.HoverProvider = {
        async provideHover(doc, position) {
            if (!host.enabled()) { return; }
            const lines = linesOf(doc);
            const name = keyAt(lines, position.line, position.character);
            if (!name) { return; }
            const cli = host.resolveCli(doc.uri);
            if (!cli) { return; }
            const key = findKey(await schemaFor(host, cli), name);
            if (!key) { return; }
            const start = lines[position.line].indexOf(name);
            return new vscode.Hover(markdownFor(key),
                new vscode.Range(position.line, start, position.line, start + name.length));
        },
    };

    return vscode.Disposable.from(
        vscode.languages.registerCompletionItemProvider(selector, completion, ' '),
        vscode.languages.registerHoverProvider(selector, hover),
    );
}
