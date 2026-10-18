import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { assertPackagedWebClient } = require('./verify-packaged-web-client.cjs')

const roots = []

function packagedResources({ index, assets = [], cli = true }) {
  const resourcesDir = mkdtempSync(join(tmpdir(), 'verify-packaged-web-client-'))
  roots.push(resourcesDir)
  const outDir = join(resourcesDir, 'app.asar.unpacked', 'out')
  if (cli) {
    mkdirSync(join(outDir, 'cli'), { recursive: true })
  }
  const webDir = join(outDir, 'web')
  mkdirSync(join(webDir, 'assets'), { recursive: true })
  if (index !== undefined) {
    writeFileSync(join(webDir, 'web-index.html'), index)
  }
  for (const asset of assets) {
    writeFileSync(join(webDir, asset), '')
  }
  return resourcesDir
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const INDEX =
  '<script type="module" src="./assets/web.js"></script>' +
  '<link rel="stylesheet" href="./assets/web.css">'

describe('assertPackagedWebClient', () => {
  it('passes a package whose unpacked web client loads every file it names', () => {
    const resourcesDir = packagedResources({
      index: INDEX,
      assets: ['assets/web.js', 'assets/web.css']
    })
    expect(() => assertPackagedWebClient(resourcesDir)).not.toThrow()
  })

  it('fails a package with no unpacked web-index.html', () => {
    expect(() => assertPackagedWebClient(packagedResources({}))).toThrow(/missing unpacked/)
  })

  it('fails a package whose page loads a file that was not shipped', () => {
    const resourcesDir = packagedResources({ index: INDEX, assets: ['assets/web.js'] })
    expect(() => assertPackagedWebClient(resourcesDir)).toThrow(/assets\/web\.css/)
  })

  it('fails a page that loads nothing, which is not a real build', () => {
    expect(() => assertPackagedWebClient(packagedResources({ index: '<html></html>' }))).toThrow(
      /references no/
    )
  })

  it('fails when the CLI the web root resolves from is not unpacked', () => {
    const resourcesDir = packagedResources({
      index: INDEX,
      assets: ['assets/web.js', 'assets/web.css'],
      cli: false
    })
    expect(() => assertPackagedWebClient(resourcesDir)).toThrow(/no unpacked CLI/)
  })
})
