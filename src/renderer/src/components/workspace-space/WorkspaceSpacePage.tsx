import { useCallback, useEffect } from 'react'
import { ArrowLeft, HardDrive, X } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { WorkspaceSpaceManagerPanel } from '../status-bar/WorkspaceSpaceManagerPanel'
import { useAppStore } from '../../store'
import { hasVisibleOverlay } from '@/lib/visible-overlay'
import { translate } from '@/i18n/i18n'

export default function WorkspaceSpacePage(): React.JSX.Element {
  const closeSpacePage = useAppStore((state) => state.closeSpacePage)
  const isSeparateWindow = window.location.pathname.endsWith('/space.html')
  const close = useCallback((): void => {
    if (isSeparateWindow) {
      void window.api.workspaceSpace.closeWindow?.()
    } else {
      closeSpacePage()
    }
  }, [closeSpacePage, isSeparateWindow])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }
      // Why: confirmation dialogs own Escape first; page-level Escape should
      // only leave the full Space surface when no modal or popover is active.
      if (hasVisibleOverlay()) {
        return
      }
      const target = event.target instanceof HTMLElement ? event.target : null
      if (
        target?.matches('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
      ) {
        return
      }
      event.preventDefault()
      close()
    }

    // Why: tooltips can consume Escape before bubble listeners see it. Capture
    // keeps the first Escape reliable while still deferring to real overlays.
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [close])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
        <Button variant="ghost" size="sm" onClick={close} className="shrink-0">
          {isSeparateWindow ? <X className="size-3.5" /> : <ArrowLeft className="size-3.5" />}
          {isSeparateWindow
            ? translate('workspaceSpace.window.close', 'Close')
            : translate('auto.components.workspace.space.WorkspaceSpacePage.ecf72fdc3b', 'Back')}
        </Button>
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/30">
            <HardDrive className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-base font-semibold text-foreground">
                {translate(
                  'auto.components.workspace.space.WorkspaceSpacePage.45f6302dbc',
                  'Space'
                )}
              </h1>
              <Badge variant="secondary">
                {translate('auto.components.workspace.space.WorkspaceSpacePage.e8d6ba11ab', 'Beta')}
              </Badge>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {translate(
                'auto.components.workspace.space.WorkspaceSpacePage.8d0048e1cb',
                'See what uses space across your workspaces and what you can safely reclaim.'
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5 scrollbar-sleek">
        <div className="mx-auto max-w-7xl">
          <WorkspaceSpaceManagerPanel />
        </div>
      </div>
    </div>
  )
}
