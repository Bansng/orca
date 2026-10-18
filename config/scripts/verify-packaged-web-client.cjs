const { existsSync, readFileSync } = require('node:fs')
const { join, posix } = require('node:path')

const WEB_CLIENT_INDEX = 'web-index.html'
const REMEDY = 'Run pnpm build:web (build:desktop and build:release already do).'

function failure(message) {
  return new Error(`[verify-packaged-web-client] ${message}`)
}

/** The relative files web-index.html loads; the page is useless if any is missing. */
function referencedAssets(html) {
  const assets = new Set()
  for (const match of html.matchAll(/\b(?:src|href)=["']\.\/([^"'?#]+)/g)) {
    assets.add(posix.normalize(match[1]))
  }
  return [...assets]
}

/**
 * Why: orcad serves the browser client by path from the CLI's own app root, and it runs on plain
 * Node, which cannot read app.asar. So the page and everything it loads must be unpacked beside
 * out/cli, or `orca serve` comes up with no web client (#30100).
 */
function assertPackagedWebClient(resourcesDir) {
  const outDir = join(resourcesDir, 'app.asar.unpacked', 'out')
  if (!existsSync(join(outDir, 'cli'))) {
    throw failure(`no unpacked CLI at ${join(outDir, 'cli')}; the web client root resolves from it`)
  }
  const webRoot = join(outDir, 'web')
  const indexPath = join(webRoot, WEB_CLIENT_INDEX)
  if (!existsSync(indexPath)) {
    throw failure(`missing unpacked ${indexPath}. ${REMEDY}`)
  }
  const assets = referencedAssets(readFileSync(indexPath, 'utf8'))
  if (assets.length === 0) {
    throw failure(`${indexPath} references no ./ assets. ${REMEDY}`)
  }
  const missing = assets.filter(
    (asset) => asset.startsWith('..') || !existsSync(join(webRoot, ...asset.split('/')))
  )
  if (missing.length > 0) {
    throw failure(`${indexPath} loads files missing from ${webRoot}: ${missing.join(', ')}`)
  }
  console.log(`[verify-packaged-web-client] OK — ${String(assets.length)} asset(s) unpacked`)
}

module.exports = { assertPackagedWebClient }
