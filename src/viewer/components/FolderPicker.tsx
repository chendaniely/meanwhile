import { useRef } from 'react';
import {
  filesFromInput,
  pickFolder,
  supportsDirectoryPicker,
  type PickedFile,
} from '../media/folder.ts';

interface Props {
  onPicked: (files: PickedFile[]) => void;
  onError: (message: string) => void;
  label?: string;
  variant?: 'primary' | 'quiet';
}

/**
 * One button, two mechanisms.
 *
 * Chrome and Edge get `showDirectoryPicker`, which grants a real directory.
 * Safari and Firefox get `<input webkitdirectory>`, which is clunkier but
 * works. The user should not have to know which they are getting, so the
 * difference is one branch here and nothing anywhere else.
 */
export function FolderPicker({ onPicked, onError, label = 'Open folder', variant = 'primary' }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const modern = supportsDirectoryPicker();

  const handleClick = async () => {
    if (!modern) {
      inputRef.current?.click();
      return;
    }
    try {
      const files = await pickFolder();
      if (files === null) return; // cancelled; not an error
      if (files.length === 0) {
        onError(
          'That folder has no photos, videos, a GPX/TCX track, a manifest.json, or a notes/people CSV in it.',
        );
        return;
      }
      onPicked(files);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not read that folder.');
    }
  };

  return (
    <>
      <button
        type="button"
        className={variant === 'primary' ? 'button button--primary' : 'button'}
        onClick={() => void handleClick()}
      >
        {label}
      </button>
      {!modern && (
        <input
          ref={inputRef}
          type="file"
          // Not a standard React prop; the DOM attribute is what matters.
          {...{ webkitdirectory: '', directory: '' }}
          multiple
          hidden
          onChange={(event) => {
            const files = filesFromInput(event.target.value === '' ? null : event.target.files);
            if (files.length === 0)
              onError(
                'That folder has no photos, videos, a GPX/TCX track, a manifest.json, or a notes/people CSV in it.',
              );
            else onPicked(files);
            event.target.value = '';
          }}
        />
      )}
    </>
  );
}

/**
 * Pick loose files rather than a folder.
 *
 * Not every set of photos arrives as a tidy per-person folder — sometimes it
 * is twenty files someone AirDropped. These have no relative path, so they
 * all land in "unsorted", which is a visible, fixable state rather than a
 * silent one.
 */
export function FilePicker({
  onPicked,
  onError,
  label = 'Choose files',
}: Pick<Props, 'onPicked' | 'onError' | 'label'>) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <button type="button" className="button" onClick={() => inputRef.current?.click()}>
        {label}
      </button>
      {/* The extra extensions in `accept` are load-bearing. With only
          `image/*,video/*` the file dialog greys out a .gpx, a manifest.json,
          or a notes.csv/people.csv — the very files Save produces — so the
          sole route into the course view was opening a whole folder, and
          anyone handed a bare track or CSV had no way in at all. */}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*,video/*,.gpx,.tcx,.json,.csv"
        hidden
        data-testid="file-input"
        onChange={(event) => {
          const files = filesFromInput(event.target.files);
          if (files.length === 0) {
            onError(
              'None of those are photos, videos, a GPX/TCX track, a manifest.json, or a notes/people CSV.',
            );
          } else onPicked(files);
          event.target.value = '';
        }}
      />
    </>
  );
}
