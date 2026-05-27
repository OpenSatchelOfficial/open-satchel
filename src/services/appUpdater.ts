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

export async function installPendingAppUpdate(
  onProgress?: (progress: AppUpdateProgress) => void,
): Promise<void> {
  if (!pendingUpdate) {
    const result = await checkForAppUpdate()
    if (result.kind !== 'available' || !pendingUpdate) return
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

  try {
    await relaunch()
  } catch {
    // Windows exits during installer handoff, so this line is mostly for
    // macOS/Linux. If relaunch fails, the installed update is still staged.
  }
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
