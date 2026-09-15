import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';

interface SharpTarget { os: string; cpu: string }
interface PackageManifest { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }

/** The helpers `vscode-extension/scripts/bundle.js` exports for testing. */
interface BundleScript {
    pruneToPaths(pkgDir: string, keep: string[]): void;
    bundleRoots(manifest: PackageManifest): string[];
    missingRoots(dir: string, manifest: PackageManifest): string[];
    reachablePackages(
        rootDeps: string[],
        manifestDeps: (name: string) => string[],
        keepOnly?: Record<string, string[]>,
    ): Set<string>;
    sharpPackagesFor(targets: SharpTarget[]): Set<string>;
    parseTargets(argv: string[]): { targets: SharpTarget[]; narrow: boolean };
    ALL_SHARP_TARGETS: SharpTarget[];
    KEEP_ONLY: Record<string, string[]>;
}

// The VS Code extension's bundler is plain CommonJS build tooling outside src/,
// so it is required rather than imported. It guards its own `main()`, so this
// only pulls in the helpers. The shape above is named rather than inlined so
// this stays a one-liner — `eslint-disable-next-line` covers the next LINE, and
// a multi-line destructuring puts the `require()` out of its reach.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bundleScript = require('../../vscode-extension/scripts/bundle.js') as BundleScript;

const {
    pruneToPaths, bundleRoots, missingRoots, reachablePackages, sharpPackagesFor, parseTargets, ALL_SHARP_TARGETS, KEEP_ONLY,
} = bundleScript;

let tmpDir: string;

before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pme-bundle-test-')); });
after(()  => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

/** Builds a throwaway package tree and returns its root. */
function makePackage(name: string, files: Record<string, string>): string {
    const root = path.join(tmpDir, name);
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(root, ...rel.split('/'));
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
    return root;
}

const exists = (root: string, rel: string) => fs.existsSync(path.join(root, ...rel.split('/')));

describe('pruneToPaths', () => {
    it('keeps the listed files and deletes everything else', () => {
        const pkg = makePackage('keep-only', {
            'package.json':          '{"name":"x"}',
            'dist/wanted.min.js':    'KEEP',
            'dist/unwanted.mjs':     'DROP',
            'dist/chunks/a.mjs':     'DROP',
            'src/index.ts':          'DROP',
            'docs/guide.md':         'DROP',
            'README.md':             'DROP',
        });

        pruneToPaths(pkg, ['package.json', 'dist/wanted.min.js']);

        assert.ok(exists(pkg, 'package.json'));
        assert.ok(exists(pkg, 'dist/wanted.min.js'));
        assert.equal(fs.readFileSync(path.join(pkg, 'dist', 'wanted.min.js'), 'utf8'), 'KEEP');

        for (const gone of ['dist/unwanted.mjs', 'dist/chunks', 'src', 'docs', 'README.md'])
            assert.ok(!exists(pkg, gone), `${gone} should have been pruned`);
    });

    it('keeps the ancestor directory of a kept file', () => {
        const pkg = makePackage('ancestors', {
            'package.json':      '{}',
            'a/b/c/kept.js':     'KEEP',
            'a/b/c/dropped.js':  'DROP',
            'a/b/other/x.js':    'DROP',
        });

        pruneToPaths(pkg, ['package.json', 'a/b/c/kept.js']);

        assert.ok(exists(pkg, 'a/b/c/kept.js'));
        assert.ok(!exists(pkg, 'a/b/c/dropped.js'));
        assert.ok(!exists(pkg, 'a/b/other'));
    });

    it('throws rather than shipping a bundle missing the file it came for', () => {
        const pkg = makePackage('missing', { 'package.json': '{}', 'dist/real.js': 'x' });
        // A prune that quietly removed the target would only fail later, at
        // render time, on the user's machine.
        assert.throws(() => pruneToPaths(pkg, ['package.json', 'dist/absent.js']));
    });
});

describe('KEEP_ONLY against the real dependency tree', () => {
    // Pins the claim the prune rests on: the CLI reads these packages as files,
    // and the listed paths are the ones it reads. If mermaid restructures its
    // dist/, this fails here rather than in a shipped .vsix.
    it('every kept path exists in the installed package', () => {
        for (const [pkg, keep] of Object.entries(KEEP_ONLY)) {
            let pkgDir: string;
            try {
                pkgDir = path.dirname(require.resolve(`${pkg}/package.json`, { paths: [__dirname] }));
            } catch {
                continue;   // dependency not installed in this checkout
            }
            for (const rel of keep) {
                assert.ok(
                    fs.existsSync(path.join(pkgDir, ...rel.split('/'))),
                    `${pkg}: KEEP_ONLY lists "${rel}", which does not exist`,
                );
            }
        }
    });

    it('lists the mermaid bundle that mermaid.ts actually resolves', () => {
        // Mirrors the require.resolve in src/mermaid.ts — the two must not drift.
        assert.ok(KEEP_ONLY.mermaid?.includes('dist/mermaid.min.js'));
        assert.ok(KEEP_ONLY.mermaid?.includes('package.json'), 'require.resolve needs the manifest');
    });
});

// ── reachablePackages ─────────────────────────────────────────────────────────
//
// Decides what the bundler DELETES, so the cost of a wrong answer is a
// MODULE_NOT_FOUND on a user's machine. The graph is supplied as a plain lookup
// so these run on a fixture, not on a staged node_modules tree.

describe('reachablePackages', () => {
    /** `manifestDeps` over a literal graph. */
    const graph = (g: Record<string, string[]>) => (name: string) => g[name] ?? [];

    it('follows the dependency graph transitively', () => {
        const reachable = reachablePackages(['a'], graph({ a: ['b'], b: ['c'], c: [] }), {});
        assert.deepEqual([...reachable].sort(), ['a', 'b', 'c']);
    });

    it('leaves out a package nothing depends on', () => {
        const reachable = reachablePackages(['a'], graph({ a: ['b'], b: [], orphan: [] }), {});
        assert.equal(reachable.has('orphan'), false);
    });

    it('treats a KEEP_ONLY package as a leaf — this is the whole point', () => {
        // mermaid is read as a file, never require()d, so its dependency tree is
        // unreachable even though npm installed it.
        const reachable = reachablePackages(
            ['mermaid', 'sharp'],
            graph({ mermaid: ['cytoscape', 'es-toolkit'], sharp: [], cytoscape: [], 'es-toolkit': [] }),
            { mermaid: ['dist/mermaid.min.js'] },
        );

        assert.equal(reachable.has('mermaid'), true, 'the package itself is still needed');
        assert.equal(reachable.has('cytoscape'), false);
        assert.equal(reachable.has('es-toolkit'), false);
    });

    it('keeps a package that a KEEP_ONLY package shares with a real dependent', () => {
        // katex is both a mermaid dependency and a direct dependency of the CLI.
        const reachable = reachablePackages(
            ['mermaid', 'katex'],
            graph({ mermaid: ['katex'], katex: [] }),
            { mermaid: ['package.json'] },
        );
        assert.equal(reachable.has('katex'), true);
    });

    it('survives a dependency cycle', () => {
        const reachable = reachablePackages(['a'], graph({ a: ['b'], b: ['a'] }), {});
        assert.deepEqual([...reachable].sort(), ['a', 'b']);
    });

    it('tolerates a name with no manifest', () => {
        // An optional dependency for another platform is declared but not installed.
        const reachable = reachablePackages(['a'], graph({ a: ['not-installed'] }), {});
        assert.equal(reachable.has('not-installed'), true);
    });

    it('keeps every sharp platform binary reachable through optionalDependencies', () => {
        // bundleMultiPlatformSharp injects @img packages for platforms the build
        // host does not use. They must not read as orphans.
        const platforms = ['@img/sharp-darwin-arm64', '@img/sharp-linux-x64', '@img/sharp-win32-x64'];
        const reachable = reachablePackages(['sharp'], graph({ sharp: platforms }), KEEP_ONLY);

        for (const p of platforms) assert.equal(reachable.has(p), true, `${p} must survive`);
    });
});

// ── bundleRoots / missingRoots ────────────────────────────────────────────────

describe('bundleRoots', () => {
    it('roots the walk on optionalDependencies as well as dependencies', () => {
        const roots = bundleRoots({ dependencies: { a: '1' }, optionalDependencies: { b: '1' } });
        assert.deepEqual(roots.sort(), ['a', 'b']);
    });

    it('keeps an optional dependency that nothing else depends on — the playwright regression', () => {
        // Rooted on `dependencies` alone, playwright was an orphan and the prune
        // deleted it from every .vsix.
        const manifest = { dependencies: { sharp: '1' }, optionalDependencies: { playwright: '1' } };
        const reachable = reachablePackages(bundleRoots(manifest),
            name => ({ playwright: ['playwright-core'] } as Record<string, string[]>)[name] ?? [], {});
        assert.equal(reachable.has('playwright'), true);
        assert.equal(reachable.has('playwright-core'), true);
    });

    it('includes every optionalDependency the CLI really declares', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as PackageManifest;
        const optional = Object.keys(manifest.optionalDependencies ?? {});
        assert.ok(optional.includes('playwright'), 'playwright is expected to be an optionalDependency');
        for (const name of optional) assert.ok(bundleRoots(manifest).includes(name), `${name} must be a bundle root`);
    });
});

describe('missingRoots', () => {
    it('names a root with no package on disk, optional ones included', () => {
        const dir = makePackage('missing-roots', {
            'node_modules/sharp/package.json': '{}',
            'node_modules/@antv/infographic/package.json': '{}',
        });
        const manifest = {
            dependencies: { sharp: '1', '@antv/infographic': '1' },
            optionalDependencies: { playwright: '1' },
        };
        assert.deepEqual(missingRoots(dir, manifest), ['playwright']);
    });

    it('is empty when every root is there', () => {
        const dir = makePackage('all-roots', {
            'node_modules/sharp/package.json': '{}',
            'node_modules/playwright/package.json': '{}',
        });
        assert.deepEqual(missingRoots(dir, { dependencies: { sharp: '1' }, optionalDependencies: { playwright: '1' } }), []);
    });
});

// ── Platform targeting ────────────────────────────────────────────────────────

describe('parseTargets', () => {
    it('defaults to a universal bundle that narrows nothing', () => {
        const { targets, narrow } = parseTargets([]);
        assert.deepEqual(targets, ALL_SHARP_TARGETS);
        assert.equal(narrow, false);
    });

    it('treats an explicit "all" the same way', () => {
        const { targets, narrow } = parseTargets(['--target', 'all']);
        assert.deepEqual(targets, ALL_SHARP_TARGETS);
        assert.equal(narrow, false, 'a universal build must not delete the host binary');
    });

    it('narrows to a single named target', () => {
        const { targets, narrow } = parseTargets(['--target', 'win32-x64']);
        assert.deepEqual(targets, [{ os: 'win32', cpu: 'x64' }]);
        assert.equal(narrow, true);
    });

    it('accepts every target it advertises', () => {
        for (const t of ALL_SHARP_TARGETS) {
            const { targets } = parseTargets(['--target', `${t.os}-${t.cpu}`]);
            assert.deepEqual(targets, [t]);
        }
    });

    it('throws on an unknown target rather than silently building a universal one', () => {
        // Silently falling back would ship a 5-platform .vsix under a
        // platform-specific filename — worse than failing the build.
        assert.throws(() => parseTargets(['--target', 'solaris-sparc']), /unknown --target/);
    });

    it('throws rather than exiting the process, like the other helpers', () => {
        assert.throws(() => parseTargets(['--target', 'nope']), Error);
    });
});

describe('sharpPackagesFor', () => {
    it('pairs a darwin/linux target with its libvips package', () => {
        assert.deepEqual(
            [...sharpPackagesFor([{ os: 'darwin', cpu: 'arm64' }])].sort(),
            ['sharp-darwin-arm64', 'sharp-libvips-darwin-arm64'],
        );
    });

    it('asks for no libvips on win32, which links it statically', () => {
        assert.deepEqual([...sharpPackagesFor([{ os: 'win32', cpu: 'x64' }])], ['sharp-win32-x64']);
    });

    it('covers every advertised target with a matching binary', () => {
        const all = sharpPackagesFor(ALL_SHARP_TARGETS);
        for (const t of ALL_SHARP_TARGETS) assert.ok(all.has(`sharp-${t.os}-${t.cpu}`));
    });

    it('never names @img/colour, which is not a platform package', () => {
        assert.equal(sharpPackagesFor(ALL_SHARP_TARGETS).has('colour'), false);
    });
});
