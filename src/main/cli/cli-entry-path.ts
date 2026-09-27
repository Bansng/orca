import { join } from 'node:path'

/** The JS entry this app's CLI launchers run under Electron's node mode. */
export function resolveHostCliEntryPath(app: {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}): string {
  // Why: mirrors the packaged launcher scripts (resources/*/bin) and the dev
  // launcher in cli-installer.ts — packaged builds ship the CLI entry outside
  // app.asar so Electron node mode can execute it directly.
  return app.isPackaged
    ? join(app.resourcesPath, 'app.asar.unpacked', 'out', 'cli', 'index.js')
    : join(app.appPath, 'out', 'cli', 'index.js')
}
