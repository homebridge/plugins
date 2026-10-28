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
 *   validate       Run as `node scripts/apply-verification.js validate` by Plugin Checks
 *                  before it checks the plugin. Checks the request form can be read:
 *                  the plugin name, that it is on npm, that the repo link is a GitHub
 *                  repo and the same one the package names, and that every question
 *                  was answered.
 *                  Input:  ISSUE_BODY (untrusted), GITHUB_TOKEN (read-only)
 *                  Output: { ok, plugin, hasIcon, errors }
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

// Every `### heading` in the body with the text under it
function getSections(body) {
  return [
    ...body.replace(/\r\n/g, '\n').matchAll(/^### (.+)$/gm),
  ]
    .map(match => ({
      heading: match[1].trim(),
      text: getSection(body, match[1].trim()),
    }))
}

// owner/repo from a GitHub URL or an npm `repository` value, or null
export function parseGitHubRepo(value) {
  const text = String(value || '').trim()
  const match = text.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i)
    || text.match(/^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i)
  return match
    ? `${match[1]}/${match[2]}`
    : null
}

/**
 * Checks a verification request's form can be read, before the plugin checks run.
 * Returns { ok, plugin, hasIcon, errors }; each error is posted on the issue.
 *
 *   getPackage async (plugin) => the npm package's latest manifest, or null if not on npm
 *   getRepo    async ('owner/repo') => the repo's current full name (following
 *              renames), or null if it does not exist or is private
 */
export async function validateRequest(body, { getPackage, getRepo }) {
  const errors = []
  const form = 'Please edit the request so it matches the [verification request form](https://github.com/homebridge/plugins/issues/new?template=1_verification-request.yml)'

  let plugin = null
  try {
    plugin = getPluginName(body)
  } catch (e) {
    if (!(e instanceof VerificationError)) {
      throw e
    }
    errors.push(`${e.message} ${form}, with only the npm package name under "Plugin Name".`)
  }

  const pkg = plugin && await getPackage(plugin)
  if (plugin && !pkg) {
    errors.push(`\`${plugin}\` was not found on npm. Please check the "Plugin Name" field.`)
  }

  const link = getSection(body, 'Link To GitHub Repo').split('\n')[0].trim()
  // Any address in the repo counts (…/tree/main, #readme), not an npm page or a bare name
  const linked = /^https:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+/i.test(link) && parseGitHubRepo(link)
  if (!linked) {
    errors.push('The "Link To GitHub Repo" field should be the repository\'s address, like `https://github.com/owner/homebridge-xyz`.')
  } else {
    const linkedRepo = await getRepo(linked)
    if (!linkedRepo) {
      errors.push(`\`${linked}\` was not found on GitHub. The repository must be public.`)
    } else if (pkg) {
      const packageRepo = parseGitHubRepo(typeof pkg.repository === 'string'
        ? pkg.repository
        : pkg.repository?.url)
      const packageResolved = packageRepo && await getRepo(packageRepo)
      if (!packageRepo) {
        errors.push(`\`${plugin}\` has no GitHub \`repository\` in its \`package.json\` on npm.`)
      } else if ((packageResolved || packageRepo).toLowerCase() !== linkedRepo.toLowerCase()) {
        errors.push(`The "Link To GitHub Repo" field is \`${linkedRepo}\`, but \`${plugin}\` on npm names \`${packageResolved || packageRepo}\` as its repository. They should be the same.`)
      }
    }
  }

  // The form's questions are the sections that start "The plugin" / "If the plugin"
  for (const { heading, text } of getSections(body)) {
    if (/^(?:if )?the plugin\b/i.test(heading) && (!text || /^(?:Choose an option\.\.\.|_No response_)$/.test(text))) {
      errors.push(`Please answer "${heading.slice(0, 120)}"`)
    }
  }

  return {
    ok: errors.length === 0,
    plugin,
    hasIcon: hasIcon(body),
    errors,
  }
}

// True when the optional icon field holds an image: embedded, or a link to an image file
// or an issue attachment. The same rule scripts/apply-icon-request.js uses to find it,
// so text pasted into the field (which may contain other links) is not taken for an icon.
export function hasIcon(body) {
  const section = getSection(body, 'Plugin Icon')
  return /<img[^>]*\ssrc="[^"]+"|!\[[^\]]*\]\([^)\s]+\)/.test(section)
    || [
      ...section.matchAll(/https:\/\/[^\s)<>"]+/g),
    ]
      .some(([link]) => /\.(?:png|jpe?g|webp)(?:\?|$)/i.test(link.replace(/[.,]+$/, '')) || link.includes('/user-attachments/assets/'))
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

async function getNpmPackage(plugin) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(plugin)}/latest`, {
    signal: AbortSignal.timeout(30_000),
  })
  if (res.status === 404) {
    return null
  }
  if (!res.ok) {
    throw new VerificationError(`Could not look up \`${plugin}\` on npm (HTTP ${res.status}); comment \`/check\` to try again later.`)
  }
  return res.json()
}

async function getGitHubRepo(fullName) {
  const res = await fetch(`https://api.github.com/repos/${fullName}`, {
    headers: process.env.GITHUB_TOKEN
      ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
      : {},
    signal: AbortSignal.timeout(30_000),
  })
  if (res.status === 404) {
    return null
  }
  if (!res.ok) {
    throw new VerificationError(`Could not look up \`${fullName}\` on GitHub (HTTP ${res.status}); comment \`/check\` to try again later.`)
  }
  return (await res.json()).full_name
}

function validate() {
  return validateRequest(process.env.ISSUE_BODY || '', { getPackage: getNpmPackage, getRepo: getGitHubRepo })
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
  const steps = { add, validate }
  const step = steps[process.argv[2]]

  let result
  try {
    if (!step) {
      throw new Error(`Usage: node scripts/apply-verification.js <${Object.keys(steps).join('|')}>`)
    }
    result = await step()
  } catch (e) {
    if (!(e instanceof VerificationError)) {
      console.error(e)
    }
    result = {
      ok: false,
      error: e instanceof VerificationError
        ? e.message
        : 'The step failed because of an unexpected error; see the workflow log.',
    }
  }
  // validate reports its problems as a list
  if (!result.ok && !result.errors) {
    result.errors = [result.error]
  }

  console.log(JSON.stringify(result, null, 2))
  if (process.env.RESULT_FILE) {
    fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify(result))
  }
}
