import { systemPreferences, shell } from 'electron';

/**
 * macOS-only. Returns whether the OS's Screen Recording permission (TCC) is
 * currently granted to this app — null on any other platform, or if the
 * check itself fails for any reason (treated as "unknown", not "denied", so
 * callers don't fire a false-positive warning off a transient API hiccup).
 *
 * This matters specifically because the Mac build is unsigned (no Apple
 * Developer certificate) — macOS ties this permission to the app's code
 * signature, so it does not reliably carry over across auto-updates the way
 * it would for a signed app. A user who granted it once can silently lose it
 * again after the next update, with no error and no visible symptom besides
 * screenshots quietly no longer being captured.
 */
export function getScreenRecordingGranted(): boolean | null {
  if (process.platform !== 'darwin') return null;
  try {
    return systemPreferences.getMediaAccessStatus('screen') === 'granted';
  } catch {
    return null;
  }
}

/** Deep-links straight to the Screen Recording pane so re-granting is one click, not a manual hunt through System Settings. */
export function openScreenRecordingSettings(): void {
  if (process.platform !== 'darwin') return;
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture').catch(() => {});
}
