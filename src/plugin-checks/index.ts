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
  manualReview?: string[]
  version: string
  detailedFailures?: Array<{
    message: string
    config?: any
    scenario?: string
    isRuntimeFailure?: boolean
    isNetworkResilienceTest?: boolean
  }>
  httpRequests?: Array<{
    url: string
    method: string
    timestamp: string
    scenario: string
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
  private manualReview: string[] = []
  private version: string = ''
  private detailedFailures: CheckResults['detailedFailures'] = []
  private httpRequests: CheckResults['httpRequests'] = []

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
      comment += '### 🔴 Failed Checks\n\n'

      // Group failures: runtime failures first (with details), then other failures
      const runtimeFailures = this.detailedFailures?.filter(f => f.isRuntimeFailure) || []
      const otherFailures = this.failed.filter(failure =>
        !this.detailedFailures?.some(df => df.message === failure && df.isRuntimeFailure),
      )

      // Show runtime failures with detailed explanations
      if (runtimeFailures.length > 0) {
        comment += '**Runtime Issues:**\n\n'

        for (const failure of runtimeFailures) {
          if (failure.isNetworkResilienceTest) {
            // Special handling for network resilience test failures
            comment += '- ⚠️ Plugin crashes when network requests fail:\n\n'
            comment += '    **Test scenario:** Network resilience test with simulated HTTP failures\n\n'
            comment += '    **Configuration used:**\n'
            comment += '    ```json\n'
            const jsonLines = JSON.stringify(failure.config, null, 2).split('\n')
            comment += jsonLines.map(line => `    ${line}`).join('\n')
            comment += '\n    ```\n\n'
            comment += '    **Error:**\n    ```\n'
            // Extract just the error part after " - "
            const errorPart = failure.message.split(' - ').slice(1).join(' - ')
            // Ensure all lines are properly indented for markdown
            const indentedError = errorPart.split('\n').map(line => `    ${line}`).join('\n')
            comment += indentedError
            comment += '\n    ```\n\n'
            comment += '    This test simulates network failures to verify the plugin handles HTTP errors gracefully. The plugin should:\n'
            comment += '     - Implement proper error handling for all HTTP requests\n'
            comment += '     - Use try-catch blocks or .catch() handlers for promises\n'
            comment += '     - Provide fallback behavior when external services are unavailable\n'
            comment += '     - Log errors appropriately without crashing Homebridge\n'
            comment += '     - Consider implementing retry logic with exponential backoff\n\n'
          } else {
            // Standard configuration issue handling
            comment += '- ⚠️ Plugin crashes when started with the following configuration:\n\n'
            comment += '    ```json\n'
            const jsonLines = JSON.stringify(failure.config, null, 2).split('\n')
            comment += jsonLines.map(line => `    ${line}`).join('\n')
            comment += '\n    ```\n\n'
            comment += '    **Error:**\n    ```\n'
            // Extract just the error part after " - "
            const errorPart = failure.message.split(' - ').slice(1).join(' - ')
            // Ensure all lines are properly indented for markdown
            const indentedError = errorPart.split('\n').map(line => `    ${line}`).join('\n')
            comment += indentedError
            comment += '\n    ```\n\n'
            comment += '    This needs to be fixed so that the plugin does not send Homebridge into a crash-restart loop. The plugin could:\n'
            comment += '    - Handle missing required configuration gracefully with proper error messages\n'
            comment += '    - Provide sensible defaults for missing values\n'
            comment += '    - Validate configuration during startup and log helpful warnings\n\n'
          }
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
    }

    if (this.passed.length) {
      comment += '### 🟢 Passed Checks\n\n'
      comment += this.passed.map(e => `- ${e}`).join('\n')
      comment += '\n\n'
    }

    if (this.manualReview.length) {
      comment += '### 🔍 For Manual Review\n\n'
      comment += 'The following items were detected and require manual review. We understand that these items may be false positives.\n\n'
      comment += this.manualReview.map(e => `- ${e}`).join('\n')
      comment += '\n\n'
    }

    comment += '### ℹ️ Check Details\n\n'
    if (this.version) {
      comment += `- These checks were run against \`v${this.version}\` of the plugin.\n`
    } else {
      comment += '- The version of the plugin tested could not be determined.\n'
    }

    // Add workflow run link if available
    const runId = process.env.GITHUB_RUN_ID
    const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com'
    const repository = process.env.GITHUB_REPOSITORY
    if (runId && repository) {
      comment += `- Link to the run workflow: [visit →](${serverUrl}/${repository}/actions/runs/${runId}).\n`
    } else {
      comment += '- Link to the run workflow could not be determined.\n'
    }

    // Add HTTP requests summary if available
    const httpSummary = this.formatHttpRequestsSummary()
    if (httpSummary) {
      comment += httpSummary
    }

    comment += '\n\n### 📋 Next Steps\n\n'

    if (this.passed.length && !this.failed.length) {
      comment += 'All checks passed successfully, nice work! Your plugin and/or icon will now be manually reviewed by the Homebridge team.'
    } else {
      allPassed = false
      comment += '- Please action these failures and then comment `/check` to run the checks again.\n'
      comment += '- If updating your `package.json` and `config.schema.json` files, don\'t forget to publish a new version to NPM.\n'
      comment += '- Remember this is an automatic script: if you think something has been marked as a failure in error, let us know with a reply.\n'
      comment += '- Feel free to ask any questions you have by replying to this issue.'
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
        this.manualReview.push(...(checksJson.manualReview || []))
        this.version = checksJson.version
        this.detailedFailures = checksJson.detailedFailures || []
        this.httpRequests = checksJson.httpRequests || []
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
      && (obj.httpRequests === undefined || Array.isArray(obj.httpRequests))
  }

  private formatHttpRequestsSummary(): string {
    if (!this.httpRequests || this.httpRequests.length === 0) {
      return ''
    }

    // Group requests by URL
    const requestsByUrl = new Map<string, { methods: Set<string>, scenarios: Set<string>, count: number }>()

    for (const request of this.httpRequests) {
      const url = request.url
      // Normalize URL - remove any query parameters for grouping
      const urlWithoutQuery = url.split('?')[0]

      if (!requestsByUrl.has(urlWithoutQuery)) {
        requestsByUrl.set(urlWithoutQuery, {
          methods: new Set(),
          scenarios: new Set(),
          count: 0,
        })
      }

      const entry = requestsByUrl.get(urlWithoutQuery)!
      entry.methods.add(request.method)
      entry.scenarios.add(request.scenario)
      entry.count++
    }

    // Format the output
    let summary = '- External HTTP requests detected:\n'

    // Sort URLs for consistent output
    const sortedUrls = [...requestsByUrl.keys()].toSorted()

    for (const url of sortedUrls) {
      const entry = requestsByUrl.get(url)!
      const methods = [...entry.methods].toSorted().join(', ')
      const scenarios = [...entry.scenarios].toSorted().join(', ')

      summary += `  - 📡 \`${url}\`\n`
      summary += `     Methods: \`${methods}\` | Count: \`${entry.count}\` | Scenarios: ${scenarios}\n`
    }

    return summary
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
