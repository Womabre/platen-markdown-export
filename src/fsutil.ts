import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';

/**
 * The per-user Windows application directory `%LOCALAPPDATA%` / `%APPDATA%`
 * names, or null when neither it nor a home directory is available.
 *
 * Callers used to spell this `path.join(process.env.LOCALAPPDATA ?? '', …)`,
 * which does not degrade to "no candidate" — it degrades to a **relative** path.
 * `Programs/WeasyPrint/weasyprint.exe` is then resolved against the current
 * working directory, which for this tool is wherever the user's document lives.
 * As a lookup that is merely useless. But `installWeasyprintWindows` also
 * *creates* its install directory and unpacks an executable into it, so one
 * missing environment variable meant unpacking WeasyPrint into someone's
 * documents folder.
 *
 * Returning null lets a caller drop the candidate, or fail with a reason.
 * `%USERPROFILE%\AppData\<kind>` is the standard location these normally hold.
 *
 * Parameterised so the branches can be asserted off Windows, where the machine
 * running the suite never sets either variable.
 */
export function windowsAppDir(
    kind: 'Local' | 'Roaming',
    env: NodeJS.ProcessEnv = process.env,
    home: string = os.homedir(),
): string | null {
    const fromEnv = kind === 'Local' ? env.LOCALAPPDATA : env.APPDATA;
    if (fromEnv) return fromEnv;
    return home ? path.join(home, 'AppData', kind) : null;
}

/**
 * Path for a temp file that can be renamed onto `filePath`.
 *
 * A dot-file in the destination's own directory: it has to share a filesystem
 * with the destination for the rename to be atomic, and the leading dot keeps
 * it out of most globs and file watchers. The pid keeps two concurrent exports
 * of the same document from colliding.
 *
 * Exported because the file is not always written by us — WeasyPrint writes its
 * own output, and {@link commitFileAtomic} lands it the same way.
 */
export function tempSiblingPath(filePath: string): string {
    return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
}

/**
 * Renames a finished temp file onto its destination, preserving the
 * destination's existing permissions.
 *
 * `rename(2)` within one directory is atomic on POSIX, and Node's Windows
 * implementation passes MOVEFILE_REPLACE_EXISTING, so a reader sees either the
 * old file or the new one and never a half-written one.
 */
export function commitFileAtomic(tempPath: string, filePath: string): void {
    // rename() creates the destination fresh, so an existing file's
    // permissions would otherwise be replaced by the temp file's.
    try {
        fs.chmodSync(tempPath, fs.statSync(filePath).mode);
    } catch { /* destination is new, or the platform has no usable mode */ }
    fs.renameSync(tempPath, filePath);
}

/**
 * Writes a file by creating a sibling temp file and renaming it into place.
 *
 * `fs.writeFileSync` truncates the destination before it writes, so a crash,
 * a kill, or a full disk mid-write leaves the file empty or half-written. That
 * is unacceptable here because the export mutates the principal's own source
 * markdown (revision dates, the post-release bump, TOC attribute cleanup) —
 * and the VS Code extension runs that on every save.
 *
 * The temp file is removed on any failure, leaving the destination as it was.
 */
export function writeFileAtomic(filePath: string, data: string): void {
    const tmp = tempSiblingPath(filePath);

    try {
        // fsync before the rename, not just write-then-rename.
        //
        // `rename(2)` is atomic with respect to other readers, but not with
        // respect to a crash: the filesystem is free to persist the directory
        // entry before the file's contents, so a power loss between the two
        // can leave the destination pointing at a zero-length file. That is the
        // exact outcome this function exists to prevent, and it is the source
        // document — the principal's own markdown — on the other end of it.
        const fd = fs.openSync(tmp, 'w');
        try {
            fs.writeFileSync(fd, data, 'utf8');
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        commitFileAtomic(tmp, filePath);
    } catch (err) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
        throw err;
    }
}
