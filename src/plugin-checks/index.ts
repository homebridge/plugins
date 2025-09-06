/**
 * This is a quick script to do some basic checks on Homebridge plugins
 */

/* eslint-disable no-console */
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'

import { debug, getInput } from '@actions/core'
import { getOctokit } from '@actions/github'
import fs from 'fs-extra'

const __dirname = import.meta.dirname

interface CheckResults {
  passed: string[]
  failed: string[]
  version: string
  detailedFailures?: Array<{
    message: string
    config?: any
    scenario?: string
    isRuntimeFailure?: boolean
  }>
}

class PluginChecks {
  private static readonly DOCKER_IMAGE_NAME = 'check'
  private static readonly LABELS = {
    PENDING: 'pending',
    AWAITING_CHANGES: 'awaiting-changes',
    AWAITING_FINAL_REVIEW: 'awaiting-final-review',
  } as const

  private pluginName: string
  private passed: string[] = []
  private failed: string[] = []
  private version: string = ''
  private detailedFailures: CheckResults['detailedFailures'] = []

  async run() {
    try {
      const pluginName = getInput('plugin', { required: true }).toLowerCase()
      console.log('**************************')
      console.log(`Running checks for plugin: ${pluginName}.`)
      console.log('**************************')
      this.pluginName = pluginName
      await this.runTests()
    } catch (e) {
      this.failed.push(this.handleError(e))
    }

    // Construct the comment
    let comment: string = ''
    let allPassed: boolean = true

    if (this.failed.length) {
      comment += '🔴 The following checks failed:\n\n'

      // Group failures: runtime failures first (with details), then other failures
      const runtimeFailures = this.detailedFailures?.filter(f => f.isRuntimeFailure) || []
      const otherFailures = this.failed.filter(failure =>
        !this.detailedFailures?.some(df => df.message === failure && df.isRuntimeFailure),
      )

      // Show runtime failures with detailed explanations
      if (runtimeFailures.length > 0) {
        comment += '**Runtime Issues:**\n\n'

        for (const failure of runtimeFailures) {
          comment += '- ⚠️ Plugin crashes when started with the following configuration:\n\n'
          comment += '    ```json\n'
          const jsonLines = JSON.stringify(failure.config, null, 2).split('\n')
          comment += jsonLines.map(line => `    ${line}`).join('\n')
          comment += '\n    ```\n\n'
          comment += '    **Error:**\n    ```\n'
          // Extract just the error part after " - "
          const errorPart = failure.message.split(' - ').slice(1).join(' - ')
          comment += `    ${errorPart}`
          comment += '\n    ```\n\n'
          comment += '    This needs to be fixed so that the plugin does not send Homebridge into a crash-restart loop. The plugin could:\n'
          comment += '      - Handle missing required configuration gracefully with proper error messages\n'
          comment += '      - Provide sensible defaults for missing values\n'
          comment += '      - Validate configuration during startup and log helpful warnings\n\n'
        }

        if (otherFailures.length > 0) {
          comment += '**Other Issues:**\n\n'
          comment += otherFailures.map(e => `- ${e}`).join('\n')
          comment += '\n\n'
        }
      } else {
        // No runtime failures, show regular failure list
        comment += this.failed.map(e => `- ${e}`).join('\n')
        comment += '\n\n'
      }

      comment += '---\n\n'
    }

    if (this.passed.length) {
      comment += '🟢 The following checks passed:\n\n'
      comment += this.passed.map(e => `- ${e}`).join('\n')
      comment += '\n\n---\n\n'
    }

    if (this.passed.length && !this.failed.length) {
      comment += '🎉 All checks passed successfully, nice work! Your plugin and/or icon will now be manually reviewed by the Homebridge team.'
    } else {
      allPassed = false
      comment += '⚠️ Please action these failures and then comment `/check` to run the checks again. Let us know if you need any help.\n\n'
      comment += 'If updating your `package.json` and `config.schema.json` files, don\'t forget to publish a new version to NPM.'
    }

    if (this.version) {
      comment += `\n\nThese checks were run against v${this.version} of the plugin.`
    }

    // Add workflow run link if available
    const runId = process.env.GITHUB_RUN_ID
    const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com'
    const repository = process.env.GITHUB_REPOSITORY
    if (runId && repository) {
      comment += `\n\n[Workflow →](${serverUrl}/${repository}/actions/runs/${runId})`
    }

    await this.addComment(allPassed, comment)
  }

  async addComment(successful: boolean, comment: string) {
    const octokit = getOctokit(getInput('token'))

    const repository = process.env.GITHUB_REPOSITORY
    if (!repository) {
      throw new Error('GITHUB_REPOSITORY environment variable not set')
    }
    const [owner, repo] = repository.split('/')
    if (!owner || !repo) {
      throw new Error('Invalid GITHUB_REPOSITORY format')
    }
    debug(`repository: ${repository}`)

    const issueNumber = getInput('issue-number')

    // We will have an issue number if this is running as a GH action from an issue
    // Otherwise this will be running from a scheduled action to spot-check already-verified plugins
    if (issueNumber) {
      const restParams = {
        owner,
        repo,
        issue_number: Number.parseInt(issueNumber, 10),
      }

      // Add a comment to the issue
      await octokit.rest.issues.createComment({
        ...restParams,
        body: comment,
      })

      // Update labels based on success/failure
      await this.updateLabels(octokit, restParams, successful)
    } else {
      if (successful) {
        console.log('****************************')
        console.log(`Checks passed for plugin: ${this.pluginName}`)
        console.log('****************************')
      } else {
        console.log('****************************')
        console.error(`Checks failed for plugin: ${this.pluginName}:\n ${comment}`)
        console.log('****************************')
        process.exit(1)
      }
    }
  }

  async runTests() {
    // create container
    try {
      execSync(`docker build -t ${PluginChecks.DOCKER_IMAGE_NAME} .`, {
        cwd: __dirname,
        stdio: 'inherit',
      })
    } catch (e) {
      this.failed.push(`Failed to create container as ${this.handleError(e)}`)
      return
    }

    const resultsPath = resolve(__dirname, 'results')
    const checksJsonFile = resolve(resultsPath, 'results.json')

    await fs.mkdirp(resultsPath)

    // run tests
    try {
      const dockerArgs = [
        'run',
        '--rm',
        '-e',
        `HOMEBRIDGE_PLUGIN_NAME=${this.pluginName}`,
        '-v',
        `${resultsPath}:/results`,
        PluginChecks.DOCKER_IMAGE_NAME,
      ]

      execSync(`docker ${dockerArgs.join(' ')}`, {
        cwd: __dirname,
        stdio: 'inherit',
      })
    } catch (e) {
      console.error(`Failed to test plugin as ${this.handleError(e)}`)
    }

    if (await fs.pathExists(checksJsonFile)) {
      const checksJson = await fs.readJson(checksJsonFile)
      if (this.isValidCheckResults(checksJson)) {
        this.passed.push(...checksJson.passed)
        this.failed.push(...checksJson.failed)
        this.version = checksJson.version
        this.detailedFailures = checksJson.detailedFailures || []
      } else {
        this.failed.push('Invalid JSON results format')
      }
    } else {
      this.failed.push('JSON results file not found')
    }
  }

  private handleError(e: unknown): string {
    if (e instanceof Error) {
      return e.message
    }
    return String(e)
  }

  private isValidCheckResults(obj: any): obj is CheckResults {
    return obj
      && Array.isArray(obj.passed)
      && Array.isArray(obj.failed)
      && typeof obj.version === 'string'
      && (obj.detailedFailures === undefined || Array.isArray(obj.detailedFailures))
  }

  private async updateLabels(
    octokit: any,
    restParams: any,
    successful: boolean,
  ): Promise<void> {
    const labels = await octokit.rest.issues.listLabelsOnIssue(restParams)
    const existingLabels = new Set(labels.data.map((l: any) => l.name))

    const labelsToAdd = successful ? [PluginChecks.LABELS.AWAITING_FINAL_REVIEW] : [PluginChecks.LABELS.AWAITING_CHANGES]
    const labelsToRemove = successful 
      ? [PluginChecks.LABELS.AWAITING_CHANGES, PluginChecks.LABELS.PENDING] 
      : [PluginChecks.LABELS.PENDING, PluginChecks.LABELS.AWAITING_FINAL_REVIEW]

    // Add labels that don't exist
    for (const label of labelsToAdd) {
      if (!existingLabels.has(label)) {
        await octokit.rest.issues.addLabels({ ...restParams, labels: [label] })
      }
    }

    // Remove labels that exist
    for (const label of labelsToRemove) {
      if (existingLabels.has(label)) {
        await octokit.rest.issues.removeLabel({ ...restParams, name: label })
      }
    }
  }
}

// bootstrap and run
(async () => {
  const main = new PluginChecks()
  await main.run()
})()
