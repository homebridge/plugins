/**
 * Adds a plugin to verified-plugins.json when a maintainer adds the `verified` label to
 * a verification request. Used by the Plugin Verified workflow in two places:
 *
 *   checkApproval  Called by loadApproval from the workflow's `authorize` job, and again
 *                  from the `apply` job before committing. Reads the plugin name
 *                  from the request and decides whether it can be verified now: the
 *                  latest Plugin Checks comment passed, was run against the version
 *                  that is `latest` on npm, and the request has not been edited since.
 *                  A plugin that is already in verified-plugins.json (added by hand
 *                  before the label) is always accepted, so the label still closes the
 *                  request as it did before this workflow existed.
 *
 *   add            Run as `node scripts/apply-verification.js add` in the job that
 *                  pushes. Adds PLUGIN to verified-plugins.json.
 *                  Input:  PLUGIN
 *                  Output: { ok, plugin, unchanged } or { ok: false, error }, as JSON
 *                          to stdout and to RESULT_FILE when set.
 *
 * The icon from the form's "Plugin Icon (Optional)" field is handled by
 * scripts/apply-icon-request.js, as for icon requests.
 */

import fs from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// Same rule Homebridge uses to recognise a plugin package
export const PLUGIN_NAME = /^(?:@[a-z0-9][\w.-]*\/)?homebridge-[a-z0-9][\w.-]*$/

// Written by src/plugin-checks/index.ts as the very end of its results comment. Only
// that position counts: the comment also quotes plugin output (error messages in the
// failure list), so a marker anywhere else could be planted by the plugin.
const CHECK_MARKER = /<!-- plugin-checks (\{[^\n]*\}) -->\s*$/
const CHECK_HEADING = '### ℹ️ Check Details'

export class VerificationError extends Error {}

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

export function getPluginName(body) {
  const section = getSection(body, 'Plugin Name')
  const name = (section.split('\n').find(line => line.trim()) || '')
    .trim()
    .replace(/^`+|`+$/g, '')
    .toLowerCase()
  if (!PLUGIN_NAME.test(name)) {
    // Quoted back on the issue, so keep it short and unable to break out of the code span
    const found = name.replace(/`/g, '').slice(0, 80) || 'nothing'
    throw new VerificationError(`Could not read a valid plugin name from the "Plugin Name" field (found \`${found}\`).`)
  }
  return name
}

// True when the optional icon field holds a link or attachment rather than "_No response_"
export function hasIcon(body) {
  return /https:\/\//.test(getSection(body, 'Plugin Icon'))
}

/**
 * Reads a Plugin Checks results comment. Comments from before the marker was added
 * only give the version in prose, so those fall back to the headings.
 * Returns { ok, plugin, version }, with plugin null for older comments.
 */
export function readCheckComment(body) {
  const marker = body.match(CHECK_MARKER)
  if (marker) {
    try {
      const data = JSON.parse(marker[1])
      return {
        ok: data.ok === true,
        plugin: typeof data.plugin === 'string'
          ? data.plugin
          : null,
        version: typeof data.version === 'string'
          ? data.version
          : null,
      }
    } catch {}
  }
  return {
    ok: body.includes('### 🟢 Passed Checks') && !body.includes('### 🔴 Failed Checks'),
    plugin: null,
    // The last one: Check Details comes after the quoted plugin output
    version: [
      ...body.matchAll(/These checks were run against `v([^`]+)`/g),
    ].pop()?.[1] || null,
  }
}

export function isCheckComment(comment) {
  return comment.user?.login === 'github-actions[bot]' && comment.body?.includes(CHECK_HEADING)
}

/**
 * Decides whether a verification request can be applied. Never throws for a problem
 * with the request; returns { ready: false, refusal } instead, where the refusal is
 * posted on the issue.
 *
 *   body             the issue body
 *   labels           the issue's label names
 *   checkComment     the latest Plugin Checks comment ({ body, updated_at }), or null
 *   lastEditedAt     when the issue body was last edited, or null
 *   verified         the contents of verified-plugins.json
 *   authors          the contents of plugin-authors.json
 *   getLatestVersion async (plugin) => the npm `latest` version
 */
export async function checkApproval({ body, labels, checkComment, lastEditedAt, verified, authors, getLatestVersion }) {
  let plugin
  try {
    plugin = getPluginName(body || '')
  } catch (e) {
    if (e instanceof VerificationError) {
      return { ready: false, refusal: e.message }
    }
    throw e
  }
  const refuse = refusal => ({ ready: false, plugin, refusal })

  if (verified.includes(plugin)) {
    return {
      ready: true,
      plugin,
      alreadyVerified: true,
      hasIcon: false,
    }
  }
  if (labels.includes('pending')) {
    return refuse('The checks for this request are still running, or have not finished. Wait for the results (or comment `/check` to run them again), then add `verified` again.')
  }
  if (!checkComment) {
    return refuse('This request has not been checked yet. Comment `/check` to run the checks, then add `verified` again once they pass.')
  }
  const check = readCheckComment(checkComment.body)
  if (!check.ok) {
    return refuse('The latest checks of this request did not pass (see the results comment), so the plugin was not verified.')
  }
  if (check.plugin && check.plugin !== plugin) {
    return refuse(`The latest checks were run against \`${check.plugin}\`, but the request is for \`${plugin}\`. Comment \`/check\` to check the right plugin.`)
  }
  if (lastEditedAt && new Date(lastEditedAt) > new Date(checkComment.updated_at)) {
    return refuse('The request was edited after its last checks. Comment `/check` to run them again, then add `verified` again once they pass.')
  }
  if (!check.version) {
    return refuse('The latest checks did not record which version of the plugin they tested. Comment `/check` to run them again.')
  }
  let latest
  try {
    latest = await getLatestVersion(plugin)
  } catch {
    return refuse(`Could not look up the latest version of \`${plugin}\` on npm; please try again later.`)
  }
  if (latest !== check.version) {
    return refuse(`The checks were run against \`v${check.version}\`, but \`v${latest}\` is now the latest version on npm. Comment \`/check\` to check the new version, then add \`verified\` again once they pass.`)
  }
  // Scoped org plugins also need their original maintainer in plugin-authors.json,
  // which is a maintainer's call
  if (plugin.startsWith('@homebridge-plugins/') && !authors[plugin]) {
    return refuse(`\`${plugin}\` needs an entry in \`plugin-authors.json\` first. A maintainer will add it and verify the plugin.`)
  }
  return {
    ready: true,
    plugin,
    version: check.version,
    alreadyVerified: false,
    hasIcon: hasIcon(body),
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

async function getNpmLatestVersion(plugin) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(plugin)}/latest`, {
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    throw new Error(`npm returned HTTP ${res.status}`)
  }
  return (await res.json()).version
}

/**
 * Loads the request as it is now and runs checkApproval on it. Called from
 * actions/github-script (with its `github` and `context`), in a checkout of `latest`.
 * The workflow runs it twice: when the label is added, and again just before
 * committing, since the commit can wait in a queue behind other approvals.
 */
export async function loadApproval({ github, context }) {
  const repo = { owner: context.repo.owner, repo: context.repo.repo }
  const issueNumber = context.issue.number
  const { data: issue } = await github.rest.issues.get({ ...repo, issue_number: issueNumber })
  const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: issueNumber })
  const { repository } = await github.graphql(
    'query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { issue(number: $number) { lastEditedAt } } }',
    { ...repo, number: issueNumber },
  )
  return checkApproval({
    body: issue.body,
    labels: issue.labels.map(label => typeof label === 'string'
      ? label
      : label.name),
    checkComment: comments.findLast(isCheckComment) || null,
    lastEditedAt: repository.issue.lastEditedAt,
    verified: readJson('verified-plugins.json'),
    authors: readJson('plugin-authors.json'),
    getLatestVersion: getNpmLatestVersion,
  })
}

function add() {
  const plugin = process.env.PLUGIN || ''
  // Re-checked here: the name came from the issue body
  if (!PLUGIN_NAME.test(plugin)) {
    throw new VerificationError('The plugin name is not valid.')
  }
  const verified = readJson('verified-plugins.json')
  if (verified.includes(plugin)) {
    return { ok: true, plugin, unchanged: true }
  }
  verified.push(plugin)
  // sort-json-files.js sorts it and regenerates assets/
  fs.writeFileSync('verified-plugins.json', `${JSON.stringify(verified, null, 2)}\n`)
  return { ok: true, plugin, unchanged: false }
}

// Only runs as a command; the workflow also imports this file for checkApproval
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const steps = { add }
  const step = steps[process.argv[2]]

  let result
  try {
    if (!step) {
      throw new Error(`Usage: node scripts/apply-verification.js <${Object.keys(steps).join('|')}>`)
    }
    result = step()
  } catch (e) {
    if (!(e instanceof VerificationError)) {
      console.error(e)
    }
    result = {
      ok: false,
      error: e instanceof VerificationError
        ? e.message
        : 'The plugin could not be added because of an unexpected error; see the workflow log.',
    }
  }

  console.log(JSON.stringify(result, null, 2))
  if (process.env.RESULT_FILE) {
    fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify(result))
  }
}
