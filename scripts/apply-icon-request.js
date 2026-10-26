/**
 * Applies the icon from an approved icon request to the repo. Run by the Icon Approved
 * workflow in two steps, in separate jobs, so the untrusted image is never decoded in
 * a job that can push:
 *
 *   prepare  Reads the request, checks the plugin exists and that the requester is
 *            its developer, downloads the image and converts it to a 100x100 PNG.
 *            Runs without write access. The Icon Request Check workflow runs this on
 *            its own to tell the requester whether the request is ready.
 *            Input:  ISSUE_BODY (untrusted), ISSUE_AUTHOR, AUTHOR_IS_MAINTAINER,
 *                    GITHUB_TOKEN (read-only), ICON_FILE (where to write the PNG),
 *                    EXPECTED_SHA256 (optional: refuse unless the downloaded image
 *                    is the one the check approved)
 *            Output: { ok, plugin, source, sourceSha256, width, height, requester,
 *                    replaces } or { ok: false, error }
 *
 *   commit   Re-checks the prepared PNG without decoding it, then writes it to icons/
 *            and adds it to plugin-icons.json. Runs in the job that pushes.
 *            Input:  PREPARED (the prepare result), ICON_FILE
 *            Output: the prepare result plus { iconPath, updated }, or { ok: false, error }
 *
 * Both write their result as JSON to stdout and to RESULT_FILE when set.
 *
 * It also reads the verification request form's "Plugin Icon (Optional)" field, for
 * stage 2: applying an attached icon when a verification request gets `verified`.
 * The workflow does not trigger on that yet.
 */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import process from 'node:process'

const ICON_SIZE = 100
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 30_000
// Rejects images that are small on disk but decompress to something huge
const MAX_INPUT_PIXELS = 4096 * 4096
const MIN_SOURCE_SIZE = 64
// Allowed difference between width and height before an image counts as not square
const SQUARE_TOLERANCE = 0.02
// A 100x100 PNG from sharp is well under this; anything larger was not made by prepare
const MAX_ICON_BYTES = 200 * 1024
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')

// Only fetch images GitHub hosts for issues and repos; redirects from these hosts
// (to signed storage URLs) are followed
const ALLOWED_HOSTS = new Set([
  'github.com',
  'private-user-images.githubusercontent.com',
  'raw.githubusercontent.com',
  'user-images.githubusercontent.com',
])

// Same rule Homebridge uses to recognise a plugin package
const PLUGIN_NAME = /^(?:@[a-z0-9][\w.-]*\/)?homebridge-[a-z0-9][\w.-]*$/

class IconRequestError extends Error {}

// Returns the text under a `### <heading>` line, up to the next heading
function getSection(body, heading) {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(line => line.trim().toLowerCase().startsWith(`### ${heading.toLowerCase()}`))
  if (start === -1) {
    return ''
  }
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^#{2,3} /.test(line.trim()))
  return (end === -1
    ? rest
    : rest.slice(0, end)).join('\n').trim()
}

function getPluginName(body) {
  const section = getSection(body, 'Plugin Name')
  const name = (section.split('\n').find(line => line.trim()) || '')
    .trim()
    .replace(/^`+|`+$/g, '')
    .toLowerCase()
  if (!PLUGIN_NAME.test(name)) {
    // Quoted back on the issue, so keep it short and unable to break out of the code span
    const found = name.replace(/`/g, '').slice(0, 80) || 'nothing'
    throw new IconRequestError(`Could not read a valid plugin name from the "Plugin Name" field (found \`${found}\`).`)
  }
  return name
}

function getIconUrl(body) {
  const section = getSection(body, 'Plugin Icon')
  // Embedded images (<img src="..."> or ![alt](...)) win over bare links, which are
  // often to the npm page or repo; a bare link only counts if it looks like an image
  const embedded = [
    ...section.matchAll(/<img[^>]*\ssrc="([^"]+)"|!\[[^\]]*\]\(([^)\s]+)\)/g),
  ]
    .map(match => match[1] || match[2])
  const linked = [
    ...section.matchAll(/https:\/\/[^\s)<>"]+/g),
  ]
    .map(match => match[0].replace(/[.,]+$/, ''))
    .filter(link => /\.(?:png|jpe?g|webp)(?:\?|$)/i.test(link) || link.includes('/user-attachments/assets/'))
  const candidates = [
    ...embedded,
    ...linked,
  ]
    .map((link) => {
      try {
        return new URL(link)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  if (!candidates.length) {
    throw new IconRequestError('No image was found in the "Plugin Icon" field.')
  }

  const url = candidates.find(candidate => candidate.protocol === 'https:' && ALLOWED_HOSTS.has(candidate.hostname))
  if (!url) {
    throw new IconRequestError(`Icons must be attached to the issue or hosted on GitHub; \`${candidates[0].hostname}\` is not accepted.`)
  }
  // A github.com/<owner>/<repo>/blob/<ref>/<path> link is a web page; fetch the raw file
  const blob = url.hostname === 'github.com' && url.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/)
  if (blob) {
    return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`
  }
  return url.toString()
}

// The GitHub account that owns the package's repository, from its npm `repository` field
function getRepoOwner(repository) {
  const url = typeof repository === 'string'
    ? repository
    : repository?.url || ''
  const match = url.match(/github\.com[/:]([\w.-]+)\//i) || url.match(/^(?:github:)?([\w.-]+)\/[\w.-]+$/)
  return match
    ? match[1].toLowerCase()
    : null
}

// Checks the package exists, and that the requester is its developer: the owner of
// its GitHub repo, an npm maintainer with the same username, or a public member of the
// org that owns the repo. Maintainers of this repo may request icons for any plugin.
async function checkRequester(plugin) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(plugin)}/latest`, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  })
  if (res.status === 404) {
    throw new IconRequestError(`\`${plugin}\` was not found on npm. Please check the "Plugin Name" field.`)
  }
  if (!res.ok) {
    throw new IconRequestError(`Could not check \`${plugin}\` on npm (HTTP ${res.status}); please try again later.`)
  }
  const pkg = await res.json()

  const author = (process.env.ISSUE_AUTHOR || '').toLowerCase()
  if (process.env.AUTHOR_IS_MAINTAINER === 'true') {
    return 'a maintainer of this repo'
  }

  const owner = getRepoOwner(pkg.repository)
  if (owner && owner === author) {
    return 'the owner of the plugin\'s repository'
  }
  const maintainers = (pkg.maintainers || []).map(m => String(m.name || '').toLowerCase())
  if (maintainers.includes(author)) {
    return 'an npm maintainer of the plugin'
  }
  if (owner) {
    const member = await fetch(`https://api.github.com/orgs/${encodeURIComponent(owner)}/members/${encodeURIComponent(author)}`, {
      headers: process.env.GITHUB_TOKEN
        ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {},
      redirect: 'manual',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    })
    if (member.status === 204) {
      return `a member of ${owner}`
    }
  }

  throw new IconRequestError(`Could not confirm that @${process.env.ISSUE_AUTHOR} develops \`${plugin}\` `
    + `(repository owner: ${owner || 'unknown'}; npm maintainers: ${maintainers.join(', ') || 'none'}). `
    + 'Icons can only be requested by the plugin\'s developer; a maintainer can add this one by hand.')
}

async function download(url) {
  let res
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new IconRequestError(`Downloading the icon failed with HTTP ${res.status}.`)
    }
    if (Number(res.headers.get('content-length')) > MAX_DOWNLOAD_BYTES) {
      throw new IconRequestError('The icon file is larger than 5 MB.')
    }
    // Stop reading as soon as the limit is passed, whatever the server claimed
    const chunks = []
    let size = 0
    for await (const chunk of res.body) {
      size += chunk.length
      if (size > MAX_DOWNLOAD_BYTES) {
        throw new IconRequestError('The icon file is larger than 5 MB.')
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  } catch (e) {
    if (e?.name === 'TimeoutError') {
      throw new IconRequestError('Downloading the icon timed out.')
    }
    throw e
  }
}

async function toIcon(buffer) {
  // Only loaded here, so the commit step never loads an image decoder
  const { default: sharp } = await import('sharp')
  const options = { limitInputPixels: MAX_INPUT_PIXELS }

  let meta
  try {
    meta = await sharp(buffer, options).metadata()
  } catch (e) {
    if (/pixel limit/i.test(e?.message)) {
      throw new IconRequestError(`The icon is too large; it should be about ${ICON_SIZE} × ${ICON_SIZE} px.`)
    }
    throw new IconRequestError('The icon could not be read as an image. Please attach a PNG.')
  }
  if (!['png', 'jpeg', 'webp'].includes(meta.format)) {
    throw new IconRequestError(`The icon is a \`${meta.format}\` file. Please attach a square PNG.`)
  }
  const { width, height } = meta
  if (width * height > MAX_INPUT_PIXELS) {
    throw new IconRequestError(`The icon is too large (${width} × ${height} px); it should be about ${ICON_SIZE} × ${ICON_SIZE} px.`)
  }
  if (Math.abs(width - height) / Math.max(width, height) > SQUARE_TOLERANCE) {
    throw new IconRequestError(`The icon must be square; this one is ${width} × ${height} px.`)
  }
  if (Math.min(width, height) < MIN_SOURCE_SIZE) {
    throw new IconRequestError(`The icon is too small (${width} × ${height} px); it should be about ${ICON_SIZE} × ${ICON_SIZE} px.`)
  }
  const png = await sharp(buffer, options)
    .resize(ICON_SIZE, ICON_SIZE, { fit: 'cover' })
    .png({ compressionLevel: 9 })
    .toBuffer()
  return { png, width, height }
}

// Checks the bytes are a 100x100 PNG by reading its header, without decoding it
function checkPreparedPng(png) {
  if (png.length > MAX_ICON_BYTES || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new IconRequestError('The prepared icon is not a valid PNG.')
  }
  if (png.toString('latin1', 12, 16) !== 'IHDR' || png.readUInt32BE(16) !== ICON_SIZE || png.readUInt32BE(20) !== ICON_SIZE) {
    throw new IconRequestError(`The prepared icon is not ${ICON_SIZE} × ${ICON_SIZE} px.`)
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

async function prepare() {
  const body = process.env.ISSUE_BODY || ''
  const plugin = getPluginName(body)
  const requester = await checkRequester(plugin)
  const source = getIconUrl(body)
  const image = await download(source)

  // Fingerprint of the original image, so an approval can insist on the image the
  // check showed rather than whatever the issue holds by then
  const sourceSha256 = createHash('sha256').update(image).digest('hex')
  if (process.env.EXPECTED_SHA256 && process.env.EXPECTED_SHA256 !== sourceSha256) {
    throw new IconRequestError('The icon has changed since the request was last checked. Please review the new icon before approving it.')
  }

  const { png, width, height } = await toIcon(image)
  fs.writeFileSync(process.env.ICON_FILE, png)
  return {
    ok: true,
    plugin,
    source,
    sourceSha256,
    width,
    height,
    requester,
    replaces: readJson('plugin-icons.json')[plugin] || null,
  }
}

async function commit() {
  const prepared = JSON.parse(process.env.PREPARED || '{}')
  // Re-checked here: the prepare job is the one that handled untrusted input
  if (!PLUGIN_NAME.test(prepared.plugin || '')) {
    throw new IconRequestError('The prepared plugin name is not valid.')
  }
  const { plugin } = prepared
  const png = fs.readFileSync(process.env.ICON_FILE)
  checkPreparedPng(png)

  const icons = readJson('plugin-icons.json')
  const iconPath = icons[plugin] || `icons/${plugin.split('/').pop()}.png`
  const owner = Object.keys(icons).find(key => key !== plugin && icons[key] === iconPath)
  if (owner) {
    throw new IconRequestError(`\`${iconPath}\` is already used by \`${owner}\`; this one needs to be added by hand.`)
  }

  const updated = fs.existsSync(iconPath)
  fs.writeFileSync(iconPath, png)
  icons[plugin] = iconPath
  fs.writeFileSync('plugin-icons.json', `${JSON.stringify(icons, null, 2)}\n`)

  return {
    ...prepared,
    iconPath,
    updated,
  }
}

const steps = { prepare, commit }
const step = steps[process.argv[2]]

let result
try {
  if (!step) {
    throw new Error(`Usage: node scripts/apply-icon-request.js <${Object.keys(steps).join('|')}>`)
  }
  result = await step()
} catch (e) {
  if (!(e instanceof IconRequestError)) {
    console.error(e)
  }
  result = {
    ok: false,
    error: e instanceof IconRequestError
      ? e.message
      : 'The icon could not be applied because of an unexpected error; see the workflow log.',
  }
}

console.log(JSON.stringify(result, null, 2))
if (process.env.RESULT_FILE) {
  fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify(result))
}
