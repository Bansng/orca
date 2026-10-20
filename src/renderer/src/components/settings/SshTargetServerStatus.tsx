import { ChevronDown } from 'lucide-react'
import type { SshTarget } from '../../../../shared/ssh-types'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'
import { sshHostServerStatusLine } from '@/ssh/ssh-host-server-status-copy'
import { SshHostChangedActions } from './SshHostChangedActions'
import { SshHostMoveAnywayAction } from './SshHostMoveAnywayAction'
import { SshHostNodeMirrorAction } from './SshHostNodeMirrorAction'
import { SshHostRestartServerAction } from './SshHostRestartServerAction'

/** Whether this SSH host's managed Orca server serves it, and why not when it doesn't. */
export function SshTargetServerStatus({
  target,
  onChanged
}: {
  target: SshTarget
  onChanged: () => void
}): React.JSX.Element | null {
  const state = useAppStore((s) => s.sshConnectionStates.get(target.id))
  const line = sshHostServerStatusLine(target, state)
  if (!line) {
    return null
  }
  const mirrorAction = (
    <SshHostNodeMirrorAction targetId={target.id} status={state?.managedServer} />
  )
  return (
    <div className="space-y-1">
      <p
        className={cn(
          'px-1 text-xs',
          line.tone === 'muted' && 'text-muted-foreground',
          line.tone === 'warning' && 'text-status-warning',
          line.tone === 'destructive' && 'text-destructive'
        )}
      >
        {line.text}
      </p>
      {line.hint ? <p className="px-1 text-xs text-muted-foreground">{line.hint}</p> : null}
      {line.detail ? (
        <Collapsible>
          {/* Why one row: the recovery sits beside Details, so it reads as part of this failure. */}
          <div className="flex flex-wrap items-center justify-between gap-2 pr-1">
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="xs" className="group">
                {translate('auto.components.settings.sshHostServer.failureDetails', 'Details')}
                <ChevronDown className="transition-transform group-data-[state=open]:rotate-180" />
              </Button>
            </CollapsibleTrigger>
            {mirrorAction}
          </div>
          <CollapsibleContent>
            <pre className="scrollbar-sleek max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {line.detail}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <div className="flex justify-end px-1 empty:hidden">{mirrorAction}</div>
      )}
      <SshHostChangedActions target={target} onChanged={onChanged} />
      <SshHostRestartServerAction status={state?.managedServer} onChanged={onChanged} />
      <SshHostMoveAnywayAction
        target={target}
        status={state?.managedServer}
        onChanged={onChanged}
      />
    </div>
  )
}
