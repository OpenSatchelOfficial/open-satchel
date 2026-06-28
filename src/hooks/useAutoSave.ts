import { useEffect, useRef } from 'react'
import { useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'
import { useFormatStore } from '../stores/formatStore'
import { saveTabById } from '../App'
import { stateHasManualRedactions } from '../services/pdfManualRedactions'

export function isParagraphEditorActive(): boolean {
  if (typeof document === 'undefined') return false
  const active = document.activeElement as HTMLElement | null
  if (active?.isContentEditable && active.closest('[data-paragraph-id]')) return true
  return Array.from(document.querySelectorAll<HTMLElement>('[data-paragraph-id]'))
    .some((el) => el.isContentEditable && el.matches(':focus'))
}

export function useAutoSave(): void {
  const autoSaveEnabled = useUIStore((s) => s.autoSaveEnabled)
  const autoSaveInterval = useUIStore((s) => s.autoSaveInterval)
  const savingRef = useRef(false)

  useEffect(() => {
    if (!autoSaveEnabled) return

    const timer = setInterval(async () => {
      if (savingRef.current) return
      if (isParagraphEditorActive()) return
      savingRef.current = true

      try {
        const { tabs } = useTabStore.getState()
        const dirtyTabsWithPaths = tabs.filter((t) => t.isDirty && t.filePath)
        const safeDirtyTabsWithPaths = dirtyTabsWithPaths.filter((tab) => {
          if (tab.format !== 'pdf') return true
          const state = useFormatStore.getState().data[tab.id]
          return !stateHasManualRedactions(state as any)
        })

        if (safeDirtyTabsWithPaths.length === 0) {
          savingRef.current = false
          return
        }

        useUIStore.getState().setAutoSaveStatus('saving')

        for (const tab of safeDirtyTabsWithPaths) {
          await saveTabById(tab.id)
        }

        useUIStore.getState().setAutoSaveStatus('saved')

        // Clear the "saved" indicator after 3 seconds
        setTimeout(() => {
          const current = useUIStore.getState().autoSaveStatus
          if (current === 'saved') {
            useUIStore.getState().setAutoSaveStatus('idle')
          }
        }, 3000)
      } catch (err) {
        console.error('Auto-save failed:', err)
        useUIStore.getState().setAutoSaveStatus('idle')
      } finally {
        savingRef.current = false
      }
    }, autoSaveInterval)

    return () => clearInterval(timer)
  }, [autoSaveEnabled, autoSaveInterval])
}
