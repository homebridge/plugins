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

class PluginChecks {
  private pluginName: string
  private passed: string[] = []
  private failed: string[] = []

  async run() {
    try {
      const pluginName = getInput('plugin', { required: true }).toLowerCase()
      console.log('**************************')
      console.log(`Running checks for plugin: ${pluginName}.`)
      console.log('**************************')
      if (pluginName) {
        this.pluginName = pluginName
        await this.runTests()
      } else {
        throw new Error('Could not determine plugin name.')
      }
    } catch (e) {
      this.failed.push(e.message)
    }

    // Construct the comment
    let comment: string = ''
    let allPassed: boolean = true

    if (this.failed.length) {
      comment += '🔴 The following checks failed:\n\n'
      comment += this.failed.map(e => `- ${e}`).join('\n')
      comment += '\n\n---\n\n'
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

    await this.addComment(allPassed, comment)

    setTimeout(() => {
      process.exit(0)
    }, 100)
  }

  async addComment(successful: boolean, comment: string) {
    const octokit = getOctokit(getInput('token'))

    const repository = process.env.GITHUB_REPOSITORY
    const repo = repository.split('/')
    debug(`repository: ${repository}`)

    const issueNumber = getInput('issue-number')

    // We will have an issue number if this is running as a GH action from an issue
    // Otherwise this will be running from a scheduled action to spot-check already-verified plugins
    if (issueNumber) {
      const restParams = {
        owner: repo[0],
        repo: repo[1],
        issue_number: Number.parseInt(issueNumber, 10),
      }

      // Add a comment to the issue
      await octokit.rest.issues.createComment({
        ...restParams,
        body: comment,
      })

      // Get the labels for the issue
      const labels = await octokit.rest.issues.listLabelsOnIssue({
        ...restParams,
      })

      if (successful) {
        // Add the `pending` label to the issue if it doesn't already have it
        if (!labels.data.find(label => label.name === 'pending')) {
          await octokit.rest.issues.addLabels({
            ...restParams,
            labels: ['pending'],
          })
        }

        // Remove `awaiting-changes` label if it exists
        if (labels.data.find(label => label.name === 'awaiting-changes')) {
          await octokit.rest.issues.removeLabel({
            ...restParams,
            name: 'awaiting-changes',
          })
        }
      } else {
        // Add the `awaiting-changes` label to the issue if it doesn't already have it
        if (!labels.data.find(label => label.name === 'awaiting-changes')) {
          await octokit.rest.issues.addLabels({
            ...restParams,
            labels: ['awaiting-changes'],
          })
        }

        // Remove `pending` label if it exists
        if (labels.data.find(label => label.name === 'pending')) {
          await octokit.rest.issues.removeLabel({
            ...restParams,
            name: 'pending',
          })
        }
      }
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
      execSync('docker build -t check .', {
        cwd: __dirname,
        stdio: 'inherit',
      })
    } catch (e) {
      this.failed.push(`Failed to create container as ${e.message}`)
      return
    }

    const resultsPath = resolve(__dirname, 'results')
    const checksJsonFile = resolve(resultsPath, 'results.json')

    await fs.mkdirp(resultsPath)

    // run tests
    try {
      execSync(`docker run --rm -e HOMEBRIDGE_PLUGIN_NAME=${this.pluginName} -v ${resultsPath}:/results check`, {
        cwd: __dirname,
        stdio: 'inherit',
      })
    } catch (e) {
      console.error(`Failed to test plugin as ${e.message}`)
    }

    if (await fs.pathExists(checksJsonFile)) {
      const checksJson = await fs.readJson(checksJsonFile) as { passed: string[], failed: string[] }
      this.passed.push(...checksJson.passed)
      this.failed.push(...checksJson.failed)
    } else {
      this.failed.push('JSON results file not found')
    }
  }
}

// bootstrap and run
(async () => {
  const main = new PluginChecks()
  await main.run()
})()
