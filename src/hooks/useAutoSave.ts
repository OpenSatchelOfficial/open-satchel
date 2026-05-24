import { useEffect, useRef } from 'react'
import { useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'
import { saveTabById } from '../App'

export function useAutoSave(): void {
  const autoSaveEnabled = useUIStore((s) => s.autoSaveEnabled)
  const autoSaveInterval = useUIStore((s) => s.autoSaveInterval)
  const savingRef = useRef(false)

  useEffect(() => {
    if (!autoSaveEnabled) return

    const timer = setInterval(async () => {
      if (savingRef.current) return
      savingRef.current = true

      try {
        const { tabs } = useTabStore.getState()
        const dirtyTabsWithPaths = tabs.filter((t) => t.isDirty && t.filePath)

        if (dirtyTabsWithPaths.length === 0) {
          savingRef.current = false
          return
        }

        useUIStore.getState().setAutoSaveStatus('saving')

        for (const tab of dirtyTabsWithPaths) {
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
