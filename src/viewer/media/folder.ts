/**
 * Getting at a folder on the user's own disk.
 *
 * Two routes, because browser support is split:
 *
 *   - `showDirectoryPicker()` in Chrome, Edge, and Opera. Grants a handle to
 *     a real directory — `pickFolder` below reads it once and discards the
 *     handle rather than keeping it, so re-reading the same folder means
 *     calling the picker again (and a second permission prompt). Retaining
 *     the handle would let a re-read skip that prompt; nothing does today.
 *   - `<input type="file" webkitdirectory>` everywhere else, including
 *     Safari and Firefox. One-shot, gives a flat FileList carrying relative
 *     paths.
 *
 * Either way the files never leave the machine: this is a public site running
 * a completely private session.
 */

import {
  classify,
  isManifestFile,
  isNotesFile,
  isPeopleFile,
  isTrackFile,
} from '../../core/metadata.ts';

export interface PickedFile {
  /** Path relative to the granted folder root, e.g. "sam/IMG_4417.jpg". */
  path: string;
  file: File;
}

/** Minimal shape of the File System Access API, which TS's DOM lib omits. */
interface DirectoryHandle {
  kind: 'directory' | 'file';
  name: string;
  entries(): AsyncIterableIterator<[string, DirectoryHandle | FileHandle]>;
}
interface FileHandle {
  kind: 'directory' | 'file';
  name: string;
  getFile(): Promise<File>;
}

type PickerWindow = typeof globalThis & {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<DirectoryHandle>;
};

export function supportsDirectoryPicker(): boolean {
  return typeof (globalThis as PickerWindow).showDirectoryPicker === 'function';
}

/** Files macOS, Windows, and unzippers leave behind that are never media. */
function isJunk(name: string): boolean {
  return name.startsWith('.') || name === 'Thumbs.db' || name === '__MACOSX';
}

async function walk(dir: DirectoryHandle, prefix: string, out: PickedFile[]): Promise<void> {
  for await (const [name, handle] of dir.entries()) {
    if (isJunk(name)) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      await walk(handle as DirectoryHandle, path, out);
    } else if (
      classify(name) ||
      isTrackFile(name) ||
      isManifestFile(name) ||
      isNotesFile(name) ||
      isPeopleFile(name)
    ) {
      out.push({ path, file: await (handle as FileHandle).getFile() });
    }
  }
}

/**
 * Ask for a folder. Resolves to null if the user cancels.
 *
 * Throws only for genuine failures, so a cancelled picker is an ordinary
 * outcome rather than an error the UI has to apologize for.
 */
export async function pickFolder(): Promise<PickedFile[] | null> {
  const picker = (globalThis as PickerWindow).showDirectoryPicker;
  if (!picker) throw new Error('This browser cannot open a folder directly.');

  let root: DirectoryHandle;
  try {
    root = await picker({ mode: 'read' });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }

  const out: PickedFile[] = [];
  await walk(root, '', out);
  return sortByPath(out);
}

/**
 * The `<input webkitdirectory>` fallback.
 *
 * `webkitRelativePath` includes the chosen folder's own name as its first
 * segment, which would make every file appear to belong to a person named
 * after the folder. Strip it so both routes produce identical paths.
 */
export function filesFromInput(list: FileList | null): PickedFile[] {
  if (!list) return [];
  const out: PickedFile[] = [];
  for (const file of Array.from(list)) {
    const relative = file.webkitRelativePath || file.name;
    const path = relative.includes('/') ? relative.slice(relative.indexOf('/') + 1) : relative;
    if (path.split('/').some(isJunk)) continue;
    if (
      !classify(file.name) &&
      !isTrackFile(file.name) &&
      !isManifestFile(file.name) &&
      !isNotesFile(file.name) &&
      !isPeopleFile(file.name)
    ) {
      continue;
    }
    out.push({ path, file });
  }
  return sortByPath(out);
}

function sortByPath(files: PickedFile[]): PickedFile[] {
  return files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}
