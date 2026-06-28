import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

export type AppUpdateInfo = {
  currentVersion: string
  version: string
  date?: string
  body?: string
}

export type AppUpdateCheckResult =
  | { kind: 'available'; update: AppUpdateInfo }
  | { kind: 'current' }

export type AppUpdateProgress =
  | { kind: 'started'; contentLength?: number }
  | { kind: 'progress'; downloaded: number; contentLength?: number }
  | { kind: 'finished' }

let pendingUpdate: Update | null = null

function toInfo(update: Update): AppUpdateInfo {
  return {
    currentVersion: update.currentVersion,
    version: update.version,
    date: update.date,
    body: update.body,
  }
}

export async function checkForAppUpdate(): Promise<AppUpdateCheckResult> {
  const update = await check({ timeout: 15000 })
  pendingUpdate = update
  if (!update) return { kind: 'current' }
  return { kind: 'available', update: toInfo(update) }
}

/** Outcome of installPendingAppUpdate. 'staged' means the new version was
 *  downloaded and written to disk but the running app must restart to apply it. */
export type AppUpdateInstallOutcome = 'staged'

export async function installPendingAppUpdate(
  onProgress?: (progress: AppUpdateProgress) => void,
): Promise<AppUpdateInstallOutcome> {
  if (!pendingUpdate) {
    const result = await checkForAppUpdate()
    if (result.kind !== 'available' || !pendingUpdate) {
      throw new Error('No update is available to install.')
    }
  }

  let downloaded = 0
  let contentLength: number | undefined

  await pendingUpdate.downloadAndInstall((event: DownloadEvent) => {
    switch (event.event) {
      case 'Started':
        downloaded = 0
        contentLength = event.data.contentLength
        onProgress?.({ kind: 'started', contentLength })
        break
      case 'Progress':
        downloaded += event.data.chunkLength
        onProgress?.({ kind: 'progress', downloaded, contentLength })
        break
      case 'Finished':
        onProgress?.({ kind: 'finished' })
        break
    }
  })

  pendingUpdate = null

  // Reaching this point means the app is still running, so the new version is
  // staged on disk but not yet applied. We deliberately do NOT relaunch here:
  // an automatic restart could close the app while the user has unsaved work,
  // and on some Windows setups the installer handoff does not exit the app on
  // its own (which left earlier builds stuck on "Installing..." forever). The
  // caller shows a "restart to finish" prompt and applies the update via
  // restartToApplyUpdate() when the user is ready. On platforms where
  // downloadAndInstall exits the app during the handoff, this line is never
  // reached and the update applies seamlessly.
  return 'staged'
}

/** Apply a staged update by relaunching into the new version. Wired to the
 *  "Restart now" button on the update toast. The process normally exits before
 *  this resolves; if it throws, the update is still staged and closing and
 *  reopening the app applies it on the next launch. */
export async function restartToApplyUpdate(): Promise<void> {
  await relaunch()
}

export function humanUpdateError(error: unknown): string {
  const raw =
    typeof error === 'string'
      ? error
      : ((error as { message?: string } | null)?.message ?? String(error))
  const lower = raw.toLowerCase()
  if (
    (lower.includes('invoke') && lower.includes('undefined')) ||
    lower.includes('__tauri')
  ) {
    return 'App updates are available in the installed desktop app.'
  }
  if (lower.includes('signature')) {
    return 'The update signature did not verify. Nothing was installed.'
  }
  if (lower.includes('network') || lower.includes('failed to fetch') || lower.includes('request')) {
    return 'Could not reach the update feed. Try again later.'
  }
  if (lower.includes('no such host') || lower.includes('dns')) {
    return 'Could not resolve the update server.'
  }
  return raw
}
