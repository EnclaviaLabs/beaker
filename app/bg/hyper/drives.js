import emitStream from 'emit-stream'
import EventEmitter from 'events'
import datEncoding from 'dat-encoding'
import { parseDriveUrl } from '../../lib/urls'
import _debounce from 'lodash.debounce'
import pda from 'pauls-dat-api2'
import { wait } from '../../lib/functions'
import * as logLib from '../logger'
import { listDrives } from '../filesystem/index'
const baseLogger = logLib.get()
const logger = baseLogger.child({category: 'hyper', subcategory: 'drives'})

// dbs
import * as archivesDb from '../dbs/archives'
import * as datDnsDb from '../dbs/dat-dns'

// hyperdrive modules
import * as daemon from './daemon'
import * as driveAssets from './assets'
import hyperDns from './dns'

// fs modules
import * as filesystem from '../filesystem/index'

// constants
// =

import { HYPERDRIVE_HASH_REGEX, DRIVE_MANIFEST_FILENAME } from '../../lib/const'
import { InvalidURLError, TimeoutError } from 'beaker-error-constants'

// typedefs
// =

/**
 * @typedef {import('./daemon').DaemonHyperdrive} DaemonHyperdrive
 */

// globals
// =

var driveLoadPromises = {} // key -> promise
var drivesEvents = new EventEmitter()

// exported API
// =

export const on = drivesEvents.on.bind(drivesEvents)
export const addListener = drivesEvents.addListener.bind(drivesEvents)
export const removeListener = drivesEvents.removeListener.bind(drivesEvents)

/**
 * @param {Object} opts
 * @return {Promise<void>}
 */
export async function setup () {
  // connect to the daemon
  await daemon.setup()

  datDnsDb.on('updated', ({key, name}) => {
    var drive = getDrive(key)
    if (drive) {
      drive.domain = name
    }
  })

  logger.info('Initialized dat daemon')
};

/**
 * @returns {NodeJS.ReadableStream}
 */
export function createEventStream () {
  return emitStream.toStream(drivesEvents)
};

/**
 * @param {string} key
 * @returns {Promise<string>}
 */
export function getDebugLog (key) {
  return '' // TODO needed? daemon.getDebugLog(key)
};

/**
 * @returns {NodeJS.ReadableStream}
 */
export function createDebugStream () {
  // TODO needed?
  // return daemon.createDebugStream()
};

// read metadata for the drive, and store it in the meta db
export async function pullLatestDriveMeta (drive, {updateMTime} = {}) {
  try {
    var key = drive.key.toString('hex')

    // trigger DNS update
    // confirmDomain(key) DISABLED

    var version = await drive.session.drive.version()
    if (version === drive.lastMetaPullVersion) {
      return
    }
    var lastMetaPullVersion = drive.lastMetaPullVersion
    drive.lastMetaPullVersion = version

    if (lastMetaPullVersion) {
      driveAssets.hasUpdates(drive, lastMetaPullVersion).then(hasAssetUpdates => {
        if (hasAssetUpdates) {
          driveAssets.update(drive)
        }
      })
    }

    // read the drive meta and size on disk
    var [manifest, oldMeta, size] = await Promise.all([
      drive.pda.readManifest().catch(_ => {}),
      archivesDb.getMeta(key),
      0//drive.pda.readSize('/')
    ])
    var {title, description, type, author, forkOf} = (manifest || {})
    var writable = drive.writable
    var mtime = updateMTime ? Date.now() : oldMeta.mtime
    var details = {title, description, type, forkOf, mtime, size, author, writable}

    // check for changes
    if (!hasMetaChanged(details, oldMeta)) {
      return
    }

    // write the record
    await archivesDb.setMeta(key, details)

    // emit the updated event
    details.url = 'hyper://' + key
    drivesEvents.emit('updated', {key, details, oldMeta})
    logger.info('Updated recorded metadata for hyperdrive', {key, details})
    return details
  } catch (e) {
    console.error('Error pulling meta', e)
  }
}

// drive creation
// =

/**
 * @returns {Promise<DaemonHyperdrive>}
 */
export async function createNewRootDrive () {
  var drive = await loadDrive(null, {visibility: 'private'})
  await pullLatestDriveMeta(drive)
  return drive
};

/**
 * @param {Object} [manifest]
 * @returns {Promise<DaemonHyperdrive>}
 */
export async function createNewDrive (manifest = {}) {
  // create the drive
  var drive = await loadDrive(null)

  // write the manifest and default datignore
  await Promise.all([
    drive.pda.writeManifest(manifest)
    // DISABLED drive.pda.writeFile('/.datignore', await settingsDb.get('default_dat_ignore'), 'utf8')
  ])

  // save the metadata
  await pullLatestDriveMeta(drive)

  return drive
}

/**
 * @param {string} srcDriveUrl
 * @param {Object} [opts]
 * @returns {Promise<DaemonHyperdrive>}
 */
export async function forkDrive (srcDriveUrl, opts = {}) {
  srcDriveUrl = fromKeyToURL(srcDriveUrl)

  // get the source drive
  var srcDrive
  var downloadRes = await Promise.race([
    (async function () {
      srcDrive = await getOrLoadDrive(srcDriveUrl)
      if (!srcDrive) {
        throw new Error('Invalid drive key')
      }
      // return srcDrive.session.drive.download('/') TODO needed?
    })(),
    new Promise(r => setTimeout(() => r('timeout'), 60e3))
  ])
  if (downloadRes === 'timeout') {
    throw new TimeoutError('Timed out while downloading source drive')
  }

  // fetch source drive meta
  var srcManifest = await srcDrive.pda.readManifest().catch(_ => {})
  srcManifest = srcManifest || {}

  // override any opts data
  var dstManifest = {
    title: (opts.title) ? opts.title : srcManifest.title,
    description: (opts.description) ? opts.description : srcManifest.description,
    forkOf: opts.detached ? undefined : fromKeyToURL(srcDriveUrl)
    // author: manifest.author
  }
  for (let k in srcManifest) {
    if (k === 'author') continue
    if (!dstManifest[k]) {
      dstManifest[k] = srcManifest[k]
    }
  }

  // create the new drive
  var dstDrive = await createNewDrive(dstManifest)

  // copy files
  var ignore = ['/.dat', '/.git', '/index.json']
  await pda.exportArchiveToArchive({
    srcArchive: srcDrive.session.drive,
    dstArchive: dstDrive.session.drive,
    skipUndownloadedFiles: false,
    ignore
  })

  return dstDrive
};

// drive management
// =

export async function loadDrive (key, opts) {
  // validate key
  if (key) {
    if (!Buffer.isBuffer(key)) {
      // existing dat
      key = await fromURLToKey(key, true)
      if (!HYPERDRIVE_HASH_REGEX.test(key)) {
        throw new InvalidURLError()
      }
      key = datEncoding.toBuf(key)
    }
  }

  // fallback to the promise, if possible
  var keyStr = key ? datEncoding.toStr(key) : null
  if (keyStr && keyStr in driveLoadPromises) {
    return driveLoadPromises[keyStr]
  }

  // run and cache the promise
  var p = loadDriveInner(key, opts)
  if (key) driveLoadPromises[keyStr] = p
  p.catch(err => {
    console.error('Failed to load drive', keyStr, err.toString())
  })

  // when done, clear the promise
  if (key) {
    const clear = () => delete driveLoadPromises[keyStr]
    p.then(clear, clear)
  }

  return p
}

// main logic, separated out so we can capture the promise
async function loadDriveInner (key, opts) {
  // create the drive session with the daemon
  var drive = await daemon.createHyperdriveSession({key})
  key = drive.key

  if (opts && opts.persistSession) {
    drive.persistSession = true
  }

  // fetch library settings
  var userSettings = null // TODO uwg datLibrary.getConfig(keyStr)
  // if (settingsOverride) {
  //   userSettings = Object.assign(userSettings || {}, settingsOverride)
  // }

  // put the drive on the network
  if (!userSettings || userSettings.visibility !== 'private') {
    drive.session.configureNetwork({
      announce: true,
      lookup: true,
      remember: false
    })
  }

  // fetch dns name if known
  // let dnsRecord = await datDnsDb.getCurrentByKey(datEncoding.toStr(key))
  // drive.domain = dnsRecord ? dnsRecord.name : undefined

  // update db
  archivesDb.touch(drive.key).catch(err => console.error('Failed to update lastAccessTime for drive', drive.key, err))
  if (!drive.writable) {
    await downloadHack(drive, DRIVE_MANIFEST_FILENAME)
  }
  await pullLatestDriveMeta(drive)
  driveAssets.update(drive)
  drive.pullLatestDriveMeta = opts => pullLatestDriveMeta(drive, opts)

  return drive
}

/**
 * HACK to work around the incomplete daemon-client download() method -prf
 */
async function downloadHack (drive, path) {
  if (!(await drive.pda.stat(path).catch(err => undefined))) return
  let fileStats = (await drive.session.drive.fileStats(path)).get(path)
  if (fileStats.downloadedBlocks >= fileStats.blocks) return
  await drive.session.drive.download(path)
  for (let i = 0; i < 10; i++) {
    await wait(500)
    fileStats = (await drive.session.drive.fileStats(path)).get(path)
    if (fileStats.downloadedBlocks >= fileStats.blocks) {
      return
    }
  }
}

export function getDrive (key) {
  key = fromURLToKey(key)
  return daemon.getHyperdriveSession({key})
}

export async function getDriveCheckout (drive, version) {
  var isHistoric = false
  var checkoutFS = drive
  if (typeof version !== 'undefined' && version !== null) {
    let seq = parseInt(version)
    if (Number.isNaN(seq)) {
      if (version === 'latest') {
        // ignore, we use latest by default
      } else {
        throw new Error('Invalid version identifier:' + version)
      }
    } else {
      let latestVersion = await drive.session.drive.version()
      if (version <= latestVersion) {
        checkoutFS = await daemon.createHyperdriveSession({
          key: drive.key,
          version,
          writable: false
        })
        // checkoutFS.domain = drive.domain
        isHistoric = true
      }
    }
  }
  return {isHistoric, checkoutFS}
};

export async function getOrLoadDrive (key, opts) {
  key = await fromURLToKey(key, true)
  var drive = getDrive(key)
  if (drive) return drive
  return loadDrive(key, opts)
}

export async function unloadDrive (key) {
  key =  fromURLToKey(key, false)
  daemon.closeHyperdriveSession({key})
};

export function isDriveLoaded (key) {
  key = fromURLToKey(key)
  return !!daemon.getHyperdriveSession({key})
}

// drive fetch/query
// =

export async function getDriveInfo (key, {ignoreCache} = {ignoreCache: false}) {
  // get the drive
  key = await fromURLToKey(key, true)
  var drive = getDrive(key)
  if (!drive && ignoreCache) {
    drive = await loadDrive(key)
  }
  var url = `hyper://${key}/`

  // fetch drive data
  var meta, manifest, driveInfo
  if (drive) {
    await drive.pullLatestDriveMeta()
    ;[meta, manifest, driveInfo] = await Promise.all([
      archivesDb.getMeta(key),
      drive.pda.readManifest().catch(_ => {}),
      drive.getInfo()
    ])
  } else {
    meta = await archivesDb.getMeta(key)
    driveInfo = {
      version: 0,
      peers: undefined
    }
  }
  manifest = manifest || {}
  if (filesystem.isRootUrl(url) && !meta.title) {
    meta.title = 'My System Drive'
  }
  meta.key = key
  meta.url = url
  // meta.domain = drive.domain TODO
  meta.links = manifest.links || {}
  meta.manifest = manifest
  meta.version = driveInfo.version
  meta.peers = driveInfo.peers

  return meta
}

export async function clearFileCache (key) {
  return {} // TODO daemon.clearFileCache(key, userSettings)
}

/**
 * @desc
 * Get the primary URL for a given dat URL
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
export async function getPrimaryUrl (url) {
  var key = await fromURLToKey(url, true)
  var datDnsRecord = await datDnsDb.getCurrentByKey(key)
  if (!datDnsRecord) return `hyper://${key}`
  return `hyper://${datDnsRecord.name}`
}

/**
 * @desc
 * Check that the drive's index.json `domain` matches the current DNS
 * If yes, write the confirmed entry to the dat_dns table
 *
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function confirmDomain (key) {
  // DISABLED
  // hyper: does not currently use DNS
  // -prf

  // // fetch the current domain from the manifest
  // try {
  //   var drive = await getOrLoadDrive(key)
  //   var datJson = await drive.pda.readManifest()
  // } catch (e) {
  //   return false
  // }
  // if (!datJson.domain) {
  //   await datDnsDb.unset(key)
  //   return false
  // }

  // // confirm match with current DNS
  // var dnsKey = await hyperDns.resolveName(datJson.domain)
  // if (key !== dnsKey) {
  //   await datDnsDb.unset(key)
  //   return false
  // }

  // // update mapping
  // await datDnsDb.update({name: datJson.domain, key})
  // return true
}

// helpers
// =

export function fromURLToKey (url, lookupDns = false) {
  if (Buffer.isBuffer(url)) {
    return url
  }
  if (HYPERDRIVE_HASH_REGEX.test(url)) {
    // simple case: given the key
    return url
  }

  var urlp = parseDriveUrl(url)
  if (urlp.protocol !== 'hyper:' && urlp.protocol !== 'dat:') {
    throw new InvalidURLError('URL must be a hyper: or dat: scheme')
  }
  if (!HYPERDRIVE_HASH_REGEX.test(urlp.host)) {
    if (!lookupDns) {
      throw new InvalidURLError('Hostname is not a valid hash')
    }
    return hyperDns.resolveName(urlp.host)
  }

  return urlp.host
}

export function fromKeyToURL (key) {
  if (typeof key !== 'string') {
    key = datEncoding.toStr(key)
  }
  if (!key.startsWith('hyper://')) {
    return `hyper://${key}/`
  }
  return key
}

function hasMetaChanged (m1, m2) {
  for (let k of ['title', 'description', 'forkOf', 'size', 'author', 'writable', 'mtime']) {
    if (!m1[k]) m1[k] = undefined
    if (!m2[k]) m2[k] = undefined
    if (k === 'forkOf') {
      if (!isUrlsEq(m1[k], m2[k])) {
        return true
      }
    } else {
      if (m1[k] !== m2[k]) {
        return true
      }
    }
  }
  return false
}

var isUrlsEqRe = /([0-9a-f]{64})/i
function isUrlsEq (a, b) {
  if (!a && !b) return true
  if (typeof a !== typeof b) return false
  var ma = isUrlsEqRe.exec(a)
  var mb = isUrlsEqRe.exec(b)
  return ma && mb && ma[1] === mb[1]
}