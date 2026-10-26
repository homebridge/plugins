/**
 * Applies the icon from an approved icon request to the repo: downloads the image,
 * makes it a 100x100 PNG in icons/, and adds it to plugin-icons.json. Run by the
 * Icon Request workflow.
 *
 * It also reads the verification request form's "Plugin Icon (Optional)" field, for
 * stage 2: applying an attached icon when a verification request gets `verified`.
 * The workflow does not trigger on that yet.
 *
 * Input:  ISSUE_BODY env var (the issue form body, untrusted).
 * Output: a JSON result on stdout and in RESULT_FILE when set:
 *         { ok, plugin, iconPath, updated, source, width, height } or { ok: false, error }
 */

import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import process from 'node:process'

import sharp from 'sharp'

const ICON_SIZE = 100
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024
const MIN_SOURCE_SIZE = 64
// Allowed difference between width and height before an image counts as not square
const SQUARE_TOLERANCE = 0.02

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
    throw new IconRequestError(`Could not read a valid plugin name from the "Plugin Name" field (found \`${name || 'nothing'}\`).`)
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

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) {
    throw new IconRequestError(`Downloading the icon failed with HTTP ${res.status}.`)
  }
  if (Number(res.headers.get('content-length')) > MAX_DOWNLOAD_BYTES) {
    throw new IconRequestError('The icon file is larger than 5 MB.')
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length > MAX_DOWNLOAD_BYTES) {
    throw new IconRequestError('The icon file is larger than 5 MB.')
  }
  return buffer
}

async function toIcon(buffer) {
  let meta
  try {
    meta = await sharp(buffer).metadata()
  } catch {
    throw new IconRequestError('The icon could not be read as an image. Please attach a PNG.')
  }
  if (!['png', 'jpeg', 'webp'].includes(meta.format)) {
    throw new IconRequestError(`The icon is a \`${meta.format}\` file. Please attach a square PNG.`)
  }
  const { width, height } = meta
  if (Math.abs(width - height) / Math.max(width, height) > SQUARE_TOLERANCE) {
    throw new IconRequestError(`The icon must be square; this one is ${width} × ${height} px.`)
  }
  if (Math.min(width, height) < MIN_SOURCE_SIZE) {
    throw new IconRequestError(`The icon is too small (${width} × ${height} px); it should be about ${ICON_SIZE} × ${ICON_SIZE} px.`)
  }
  const png = await sharp(buffer)
    .resize(ICON_SIZE, ICON_SIZE, { fit: 'cover' })
    .png({ compressionLevel: 9 })
    .toBuffer()
  return { png, width, height }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

async function main() {
  const body = process.env.ISSUE_BODY || ''
  const plugin = getPluginName(body)

  // Any plugin may have an icon, but it must be a real package, so a typo in the
  // name does not add an icon nothing will ever use
  const npm = await fetch(`https://registry.npmjs.org/${plugin.replace('/', '%2F')}`, { method: 'HEAD' })
  if (npm.status === 404) {
    throw new IconRequestError(`\`${plugin}\` was not found on npm. Please check the "Plugin Name" field.`)
  }
  if (!npm.ok) {
    throw new IconRequestError(`Could not check \`${plugin}\` on npm (HTTP ${npm.status}); please try again later.`)
  }

  const source = getIconUrl(body)
  const { png, width, height } = await toIcon(await download(source))

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
    ok: true,
    plugin,
    iconPath,
    updated,
    source,
    width,
    height,
  }
}

let result
try {
  result = await main()
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
