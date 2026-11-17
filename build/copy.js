/* eslint no-console: off */
import fs from 'fs'
import path from 'path'
import * as Utils from './utils.js'

const COPY = {
  './src/manifest.json': {
    path: `${Utils.ADDON_PATH}/`,
    handler: handleManifest,
  },
  './src/_locales/dict.browser.json': {
    path: `${Utils.ADDON_PATH}/_locales/`,
    handler: handleLocales,
  },
  './src/assets/logo-native-dark.svg': `${Utils.ADDON_PATH}/assets/`,
  './src/assets/logo-native-light.svg': `${Utils.ADDON_PATH}/assets/`,
  './src/assets/logo-native.svg': `${Utils.ADDON_PATH}/assets/`,
  './src/assets/logo.svg': `${Utils.ADDON_PATH}/assets/`,
  './src/assets/group-page-favicon.svg': `${Utils.ADDON_PATH}/assets/`,
  './src/assets/snapshot-native.svg': `${Utils.ADDON_PATH}/assets/`,
  './src/assets/proxy-native.svg': `${Utils.ADDON_PATH}/assets/`,
  './src/assets/window-native.svg': `${Utils.ADDON_PATH}/assets/`,
}

/**
 * Build copy step
 */
async function build() {
  const entries = await parseEntries()
  await copyAllEntries(entries)
}

/**
 * Copy and watch files
 */
async function copyAndWatch() {
  const entries = await parseEntries()
  await copyAllEntries(entries)

  const tasks = entries
    .filter(e => !e.srcIsDir)
    .map(e => {
      e.files = [e.src]
      return e
    })

  Utils.watch(
    tasks,
    affectedTasks => changeHandler(affectedTasks),
    (task, file) => {
      Utils.log(`Copy: File ${file} was renamed, restart this script`)
      tasks.forEach(t => t.watchers.forEach(w => w.close()))
    }
  )
}

/**
 * Handle watched file updates
 */
async function changeHandler(changedFiles) {
  for (const info of changedFiles) {
    Utils.log(`Copy: Changed source: ${info.src}`)
    if (info.srcHandler) await info.srcHandler(info.src, info.dst)
    else await fs.promises.copyFile(info.src, info.dst)
  }
}

/**
 * Parse COPY entries
 */
async function parseEntries() {
  const entriesInfo = []
  for (const src of Object.keys(COPY)) {
    const srcStats = await fs.promises.stat(src)
    const info = { src, srcIsDir: srcStats.isDirectory() }

    const dst = COPY[src]
    let dstPath
    if (typeof dst === 'string') dstPath = dst
    else {
      dstPath = dst.path
      if (dst.handler) info.srcHandler = dst.handler
    }

    if (dstPath) {
      info.dst = path.resolve(dstPath)
      if (dstPath.endsWith('/')) {
        info.destDir = info.dst
        if (!info.srcIsDir) info.dst = path.join(info.dst, path.basename(src))
      } else {
        info.destDir = path.dirname(info.dst)
      }
    }

    entriesInfo.push(info)
  }
  return entriesInfo
}

/**
 * Copy all parsed entries
 */
async function copyAllEntries(entries) {
  for (const info of entries) {
    await copyEntry(info)
  }
}

/**
 * Copy a single entry or directory tree
 */
async function copyEntry(info) {
  await fs.promises.mkdir(info.destDir, { recursive: true })

  const normSrc = path.normalize(info.src)

  if (info.srcIsDir) {
    for (const f of await Utils.treeToList(normSrc)) {
      const destDir = path.normalize(f.dir.replace(normSrc, info.dst + path.sep))

      if (f.file) {
        const srcPath = path.join(f.dir, f.file)
        const dstPath = path.join(destDir, f.file)
        if (info.srcHandler) await info.srcHandler(srcPath, dstPath)
        else await fs.promises.copyFile(srcPath, dstPath)
      } else await fs.promises.mkdir(destDir, { recursive: true })
    }
  } else {
    if (info.srcHandler) await info.srcHandler(info.src, info.dst)
    else await fs.promises.copyFile(info.src, info.dst)
  }
}

/**
 * Main
 */
async function main() {
  Utils.log('Copy: Copying')

  if (Utils.IS_DEV) {
    await copyAndWatch()
    Utils.logOk('Copy: Watching')
  } else {
    await build()
    Utils.logOk('Copy: Done')
  }
}
main().catch(err => {
  Utils.logErr('Copy: Failed:', err)
  process.exitCode = 1
})

/**
 * Copy Chrome MV3 manifest.json cleanly without stripping MV3 keys
 */
async function handleManifest(srcPath, dstPath) {
  const srcData = await fs.promises.readFile(srcPath, 'utf-8')
  const data = JSON.parse(srcData)
  const dstData = JSON.stringify(data, null, 2) + '\n'
  await fs.promises.writeFile(dstPath, dstData, 'utf-8')
}

async function handleLocales(srcPath, dstPath) {
  const dirPath = path.dirname(dstPath)
  const srcData = await fs.promises.readFile(srcPath, 'utf-8')
  const jsonData = JSON.parse(srcData)

  const langs = {}

  for (const key of Object.keys(jsonData)) {
    const dict = jsonData[key]
    if (!dict || typeof dict !== 'object') {
      Utils.logErr(`Copy: Locales: No dictionary for: ${key}`)
      break
    }

    for (const lang of Object.keys(dict)) {
      if (!langs[lang]) langs[lang] = {}
      langs[lang][key] = { message: dict[lang] }
    }
  }

  for (const lang of Object.keys(langs)) {
    const dict = langs[lang]
    const jsonStr = JSON.stringify(dict)
    await fs.promises.mkdir(path.join(dirPath, lang), { recursive: true })
    await fs.promises.writeFile(path.join(dirPath, lang, 'messages.json'), jsonStr)
  }
}
