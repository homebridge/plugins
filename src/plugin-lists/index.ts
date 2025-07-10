/* eslint-disable no-console */
import process from 'node:process'

import { Octokit } from '@octokit/core'
import axios from 'axios'

export interface Plugin {
  name: string
  valid: boolean
  version: string | null
  packaged: boolean
}

class PluginLists {
  private octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  })

  private pluginList: string[] = []
  private pluginNpmResponses: Record<string, any> = {}

  private pluginsArchived: string[] = []
  private pluginsDeprecated: string[] = []
  private pluginsGitHubMissing: string[] = []

  private logRed(message: string) {
    console.log(`\x1B[31m${message}\x1B[0m`)
  }

  private logGreen(message: string) {
    console.log(`\x1B[32m${message}\x1B[0m`)
  }

  private logYellow(message: string) {
    console.log(`\x1B[33m${message}\x1B[0m`)
  }

  public async run() {
    try {
      await this.getVerifiedPluginsList()
      await this.checkNpmDeprecated()
      await this.checkGitHubArchived()
      await this.logResults()
    } catch (e) {
      this.logRed(`Error: ${e.message}`)
      this.logRed(e)
      process.exit(1)
    }
  }

  /**
   * Get the verified plugins list
   */
  private async getVerifiedPluginsList(): Promise<void> {
    const response = await axios.get<string[]>('https://raw.githubusercontent.com/homebridge/plugins/latest/verified-plugins.json')
    this.pluginList = response.data
    console.log(`Processing ${this.pluginList.length} verified plugins...`)
    console.log(' ')
  }

  private async getGitHubRepoFromNpm(packageName: string): Promise<{ author: string | null, repo: string | null }> {
    try {
      const { url, homepage, bugs } = this.pluginNpmResponses[packageName]
      let author: string = null
      let repo: string = null

      // Try if the url is set
      if (url?.includes('github.com')) {
        const match = url.match(/github\.com\/([^/]+)\/([^/]+)/)
        if (match) {
          author = match[1]
          repo = match[2]
        }
      } else if (homepage?.includes('github.com')) {
        const match = homepage.match(/github\.com\/([^/]+)\/([^/]+)/)
        if (match) {
          author = match[1]
          repo = match[2]
        }
      } else if (bugs?.includes('github.com')) {
        const match = bugs.match(/github\.com\/([^/]+)\/([^/]+)/)
        if (match) {
          author = match[1]
          repo = match[2]
        }
      }

      return { author, repo }
    } catch (error) {
      this.logRed(`* Error fetching package.json for ${packageName}: ${error.message}.`)
      return { author: null, repo: null }
    }
  }

  private async isNpmDeprecated(packageName: string): Promise<boolean> {
    try {
      const response = await axios.get(`https://registry.npmjs.org/${packageName}`)
      this.pluginNpmResponses[packageName] = {
        url: response.data.repository?.url?.replace(/^git(?::\/\/)?|\.git$/g, '').replaceAll('+', ''),
        homepage: response.data.homepage?.replace(/\.git$/, '').replace('#readme').replace('#README'),
        bugs: response.data.repository?.bugs?.url?.replace(/\.git$/, '').replace('/issues'),
      }

      const latestVersion = response.data['dist-tags'].latest as string
      const deprecatedMessage = response.data.versions[latestVersion].deprecated as string

      return !!deprecatedMessage
    } catch (error) {
      this.logRed(`* ${packageName} could not be checked as ${error.message}.`)
      return false
    }
  }

  private async isGitHubArchived(packageName: string): Promise<boolean> {
    try {
      // If the package name doesn't include the author, fetch it from npm
      const { author, repo } = await this.getGitHubRepoFromNpm(packageName)

      if (!author || !repo) {
        return false
      }

      const response = await this.octokit.request('GET /repos/{owner}/{repo}', {
        owner: author,
        repo,
      })

      return response.data.archived || false
    } catch (error) {
      if (error.status === 404) {
        this.pluginsGitHubMissing.push(packageName)
        this.logRed(`* ${packageName} appears to be missing on GitHub.`)
      } else {
        this.logRed(`* ${packageName} could not be checked ${error.message}.`)
      }
      return false
    }
  }

  private async checkNpmDeprecated(): Promise<void> {
    console.log('Checking npm for deprecated plugins...')
    for (const plugin of this.pluginList) {
      if (await this.isNpmDeprecated(plugin)) {
        this.pluginsDeprecated.push(plugin)
        this.logYellow(`* ${plugin} is deprecated on npm.`)
      } else {
        console.log(`* ${plugin} is not deprecated on npm.`)
      }
    }
    console.log(' ')
  }

  private async checkGitHubArchived(): Promise<void> {
    console.log('Checking GitHub for archived plugins...')
    for (const plugin of this.pluginList) {
      if (await this.isGitHubArchived(plugin)) {
        this.pluginsArchived.push(plugin)
        this.logYellow(`* ${plugin} is archived on GitHub.`)
      } else {
        console.log(`* ${plugin} is not archived on GitHub.`)
      }
    }
    console.log(' ')
  }

  private async logResults(): Promise<void> {
    console.log('Results')
    console.log('* NPM Deprecated Plugins:')
    if (this.pluginsDeprecated.length > 0) {
      this.pluginsDeprecated.forEach(plugin => this.logYellow(`   * ${plugin}`))
    } else {
      this.logGreen('   * No deprecated plugins found.')
    }
    console.log(' ')

    console.log('* GitHub Archived Plugins:')
    if (this.pluginsArchived.length > 0) {
      this.pluginsArchived.forEach(plugin => this.logYellow(`   * ${plugin}`))
    } else {
      this.logGreen('   * No archived plugins found.')
    }
    console.log(' ')

    console.log('* GitHub Missing Plugins:')
    if (this.pluginsGitHubMissing.length > 0) {
      this.pluginsGitHubMissing.forEach(plugin => this.logYellow(`   * ${plugin}`))
    } else {
      this.logGreen('   * No missing plugins found.')
    }

    console.log(' ')
    console.log('Counts')
    console.log(`* NPM Deprecated plugins: ${this.pluginsDeprecated.length}.`)
    console.log(`* GitHub Archived plugins: ${this.pluginsArchived.length}.`)
    console.log(`* GitHub Missing plugins: ${this.pluginsGitHubMissing.length}.`)
    console.log(`* Total verified plugins: ${this.pluginList.length}.`)
  }
}

// bootstrap and run
(async () => {
  const main = new PluginLists()
  await main.run()
})()
