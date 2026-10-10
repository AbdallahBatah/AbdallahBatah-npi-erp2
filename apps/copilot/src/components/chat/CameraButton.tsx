'use client';

import { useRef, type ChangeEvent } from 'react';
import { Camera } from 'lucide-react';
import { t } from '@/i18n/ar';
import { preparePhoto } from './photo';

export interface CameraButtonProps {
  /** Called with the prepared photo (downscaled by `preparePhoto` when the
   *  phone's original is too big). The composer wires this to the same
   *  `onAttach` the paperclip uses, so a camera photo takes the normal
   *  upload -> consent -> intake path and nothing else. */
  onCapture: (file: File) => void;
  /** Disabled together with the attach button: while an upload is in flight
   *  or a consent card is pending, a second document cannot be started. */
  disabled?: boolean;
}

/**
 * "Photograph the document" button (T-38, F-21): opens the phone's camera
 * through `<input type="file" accept="image/*" capture="environment">`, the
 * only camera API that needs no permission prompt of its own, no
 * `getUserMedia` stream and no extra dependency — the OS camera app takes the
 * photo and hands the file back.
 *
 * Shown below the `md` breakpoint only: the camera is a phone affordance, and
 * on a desktop `capture` is ignored so the button would just be a second file
 * picker next to the paperclip.
 *
 * The input is visually hidden with `sr-only`, not `display: none`, so the
 * test harness's `setInputFiles` still reaches it and so the click that
 * opens the native camera is a trusted user gesture on a rendered element.
 */
export function CameraButton({ onCapture, disabled = false }: CameraButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  function handleClick() {
    inputRef.current?.click();
  }

  async function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset first so the same photo can be retaken even if anything below
    // fails; `files` was already read into `file` above.
    e.target.value = '';
    if (!file) return;
    // `preparePhoto` never throws: on any failure it hands back the original.
    onCapture(await preparePhoto(file));
  }

  return (
    <div className="md:hidden">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        data-testid="camera-input"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleChange}
      />
      <button
        type="button"
        data-testid="camera-button"
        onClick={handleClick}
        disabled={disabled}
        title={t('chat.camera')}
        aria-label={t('chat.camera')}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-600 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-transparent"
      >
        <Camera className="h-5 w-5" aria-hidden="true" />
      </button>
    </div>
  );
}
