import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openCommand, describeError } from '../index';
import { ExitError } from '../errors';

/**
 * `--open` hands the finished file to the OS. The Windows branch is the one
 * that used to be wrong and the one the test machine can never exercise, so it
 * is asserted directly rather than through a spawn.
 */
describe('openCommand', () => {
    it('uses open(1) on macOS', () => {
        assert.deepEqual(openCommand('darwin', '/tmp/doc.pdf'), ['open', ['/tmp/doc.pdf']]);
    });

    it('uses xdg-open elsewhere', () => {
        assert.deepEqual(openCommand('linux', '/tmp/doc.pdf'), ['xdg-open', ['/tmp/doc.pdf']]);
    });

    it('passes the path as a single argument, never through a shell word split', () => {
        const [, args] = openCommand('darwin', '/tmp/Q1 & Q2.pdf');
        assert.deepEqual(args, ['/tmp/Q1 & Q2.pdf']);
    });

    describe('on Windows', () => {
        const win = (p: string) => openCommand('win32', p);

        it('uses PowerShell Start-Process with -LiteralPath', () => {
            const [cmd, args] = win('C:\\docs\\report.pdf');
            assert.equal(cmd, 'powershell');
            assert.ok(args.includes('-NoProfile'));
            assert.match(args.at(-1)!, /^Start-Process -LiteralPath '/);
        });

        // The bug: `cmd /c start "" <path>` re-parses through the shell, so an
        // ampersand in the filename split the command. `Q1 & Q2.pdf` is an
        // entirely ordinary document name.
        it('survives an ampersand in the filename', () => {
            const [, args] = win('C:\\docs\\Q1 & Q2.pdf');
            assert.equal(args.at(-1), "Start-Process -LiteralPath 'C:\\docs\\Q1 & Q2.pdf'");
        });

        it('survives other shell metacharacters', () => {
            for (const name of ['a^b.pdf', 'a|b.pdf', 'a>b.pdf', 'a(b).pdf', 'a%b%.pdf']) {
                const [, args] = win(`C:\\docs\\${name}`);
                assert.ok(args.at(-1)!.includes(name), name);
            }
        });

        it("escapes a single quote by doubling it, PowerShell's own convention", () => {
            const [, args] = win("C:\\docs\\it's here.pdf");
            assert.equal(args.at(-1), "Start-Process -LiteralPath 'C:\\docs\\it''s here.pdf'");
        });

        it('keeps the whole command as one argument, not shell-split', () => {
            const [, args] = win('C:\\docs\\a b.pdf');
            assert.equal(args.filter(a => a.startsWith('Start-Process')).length, 1);
        });
    });
});

// ── describeError ─────────────────────────────────────────────────────────────

/**
 * The single place that turns a thrown value into output and an exit code. It
 * was inline in the process's catch handler until `--watch` needed to report a
 * failed run the same way without exiting.
 */
describe('describeError', () => {
    it('carries an ExitError\'s own message and code', () => {
        assert.deepEqual(
            describeError(new ExitError('WeasyPrint failed', 4)),
            { text: 'WeasyPrint failed', code: 4 },
        );
    });

    it('keeps code 0 for the flags whose whole output is text', () => {
        assert.equal(describeError(new ExitError('Usage: ...', 0)).code, 0);
    });

    it('maps network failures to code 5', () => {
        for (const msg of ['getaddrinfo ENOTFOUND cdn.example', 'connect ECONNREFUSED', 'Request timed out: x']) {
            assert.equal(describeError(new Error(msg)).code, 5, msg);
        }
    });

    it('falls back to code 1 with a stack for anything else', () => {
        const r = describeError(new Error('boom'));
        assert.equal(r.code, 1);
        assert.match(r.text, /boom/);
    });

    it('handles a thrown non-Error', () => {
        assert.deepEqual(describeError('just a string'), { text: 'just a string', code: 1 });
    });
});
