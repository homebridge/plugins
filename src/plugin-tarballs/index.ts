/* eslint-disable no-console */
import { exec } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import util from 'node:util'

import { Octokit } from '@octokit/core'
import axios from 'axios'
import fs from 'fs-extra'

const __dirname = import.meta.dirname

const execAsync = util.promisify(exec)

export interface Plugin {
  name: string
  valid: boolean
  version: string | null
  packaged: boolean
}

class PluginTarballs {
  private octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  })

  private githubProjectOwner = 'homebridge'
  private githubProjectRepo = 'verified'
  private targetRelease = 'v1.0.0'

  private workDir = path.join(__dirname, 'work')

  private pluginList: string[] = []
  private pluginMap: Plugin[] = []

  private pluginsSuccessfullyUpdated: Plugin[] = []
  private pluginsNotProcessed: { plugin: Plugin, error: string }[] = []

  private release: {
    id: number
    tag_name: string
    upload_url: string
    assets: {
      id: number
      name: string
      label: string
      created_at: string
      updated_at: string
      browser_download_url: string
      download_count: number
      size: number
    }[]
  }

  private releaseStats: {
    [key: string]: {
      downloadCount: number
      versions: {
        [key: string]: {
          created: string
          size: number
          downloadCount: number
        }
      }
    }
  } = {}

  /**
   * Plugins to exclude from bundling
   */
  private pluginFilter: string[] = [
    'homebridge-config-ui-x',
    'homebridge-music', // darwin only
  ]

  /**
   * Non-verified plugins / packages to bundle
   * Typically for a non-verified plugin to be included it should have > 100 downloads per week
   */
  private additionalPlugins: string[] = [
    'homebridge',
    'homebridge-broadlink-rm-pro',
    'homebridge-http-switch',
    'homebridge-daikin-esp8266',
    'homebridge-esp8266-fan',
    '@oznu/homebridge-esp8266-garage-door',
  ]

  async run() {
    try {
      await this.getGitHubRelease(this.targetRelease)
      await this.getVerifiedPluginsList()
      await this.getLatestVersions()
      await this.bundlePlugins()
      await this.uploadAssets()
      await this.removeOldAssets()
      await this.updateRelease()
      await this.generateDownloadStats()
    } catch (e) {
      console.error('Error', e.message, e)
      process.exit(1)
    }
  }

  /**
   * Get the verified plugins list
   */
  async getVerifiedPluginsList() {
    const response = await axios.get<string[]>('https://raw.githubusercontent.com/homebridge/plugins/latest/verified-plugins.json')
    this.pluginList = response.data.filter(x => !this.pluginFilter.includes(x))
    console.log(`Processing ${this.pluginList.length} verified plugins...`)

    // add additional plugins, checking to make sure we are not adding duplicates
    for (const plugin of this.additionalPlugins) {
      if (!this.pluginList.includes(plugin)) {
        this.pluginList.push(plugin)
      }
    }
  }

  /**
   * Get the 'latest' version for the plugins
   */
  async getLatestVersions() {
    for (const pluginName of this.pluginList) {
      try {
        const response = await axios.get(`https://registry.npmjs.org/${pluginName}/latest`)

        const plugin: Plugin = {
          name: pluginName,
          valid: true,
          version: response.data.version,
          packaged: false,
        }

        // check if an update is required
        if (
          this.release.assets.find(x => x.name === this.pluginAssetName(plugin, 'tar.gz'))
          && this.release.assets.find(x => x.name === this.pluginAssetName(plugin, 'sha256'))
        ) {
          console.log(`${plugin.name} v${plugin.version} is up to date.`)
        } else {
          this.pluginMap.push(plugin)
        }
      } catch (e) {
        console.log(`ERROR: ${pluginName}`, e.message)
        this.pluginsNotProcessed.push({ plugin: { name: pluginName, valid: false, version: null, packaged: false }, error: e.message })
      }
    }
  }

  /**
   * Get the GitHub release for the project
   * @param {string} tag
   */
  async getGitHubRelease(tag: string) {
    const response = await this.octokit.request('GET /repos/{owner}/{repo}/releases', {
      owner: this.githubProjectOwner,
      repo: this.githubProjectRepo,
    })

    this.release = response.data.find(x => x.tag_name === tag)
    if (!this.release) {
      throw new Error(`Release with tag "${tag}" does not exist`)
    }
  }

  /**
   * Update the GitHub Release
   */
  async updateRelease() {
    if (this.pluginsSuccessfullyUpdated.length > 0 || this.pluginsNotProcessed.length > 0) {
      try {
        await this.octokit.request('PATCH /repos/{owner}/{repo}/releases/{release_id}', {
          owner: this.githubProjectOwner,
          repo: this.githubProjectRepo,
          release_id: this.release.id,
          name: `Plugin Tarballs ${new Date().toISOString().split('T')[0]}`,
          body: 'Recently updated plugins:\n\n'
            + `${this.pluginsSuccessfullyUpdated.map(x => `- ${x.name}@${x.version}`).join('\n')}\n`
            + '---\n'
            + 'Plugins not processed:\n\n'
            + `${this.pluginsNotProcessed.map(x => `- ${x.plugin.name} - ${x.error}`).join('\n')}`,
        })
        console.log('Updated release.')
      } catch (e) {
        console.error('Could not update release title', e.message)
      }
    }
  }

  /**
   * Generate a file to keep track of the total number of downloads
   */
  async generateDownloadStats() {
    const pluginBundleAssets = this.release.assets.filter(x => x.name.endsWith('.tar.gz'))
    const releaseStatsAsset = this.release.assets.find(x => x.name === 'download-statistics.json')

    if (releaseStatsAsset) {
      const response = await axios.get(`${releaseStatsAsset.browser_download_url}?date=${new Date().getTime()}`)
      this.releaseStats = response.data
    }

    for (const asset of pluginBundleAssets) {
      const assetPlugin = asset.label.substring(0, asset.label.lastIndexOf('@'))
      const assetVersion = asset.label.substring(asset.label.lastIndexOf('@') + 1, asset.label.length).split('.tar.gz')[0]

      // initialise the plugin if we have not seen it before
      if (!this.releaseStats[assetPlugin]) {
        this.releaseStats[assetPlugin] = {
          downloadCount: 0,
          versions: {},
        }
      }

      // set / update the stats for the current version being processed
      this.releaseStats[assetPlugin].versions[assetVersion] = {
        downloadCount: asset.download_count,
        size: asset.size,
        created: asset.created_at,
      }

      // update the total download count
      this.releaseStats[assetPlugin].downloadCount = 0
      for (const version of Object.values(this.releaseStats[assetPlugin].versions)) {
        this.releaseStats[assetPlugin].downloadCount += version.downloadCount
      }
    }

    // remove the old download-statistics.json
    if (releaseStatsAsset) {
      await this.deleteAsset(releaseStatsAsset)
    }

    // upload the new download-statistics.json
    await this.octokit.request('POST /repos/{owner}/{repo}/releases/{release_id}/assets', {
      owner: this.githubProjectOwner,
      repo: this.githubProjectRepo,
      url: this.release.upload_url,
      release_id: this.release.id,
      name: 'download-statistics.json',
      label: 'download-statistics.json',
      headers: {
        'content-type': 'application/json',
      },
      data: JSON.stringify(this.releaseStats),
    })

    console.log('Updated download-statistics.json...')
  }

  /**
   * Create a bundle for the verified plugins
   */
  async bundlePlugins() {
    console.log(`Generating update bundles for ${this.pluginMap.length} plugins...`)
    for (const plugin of this.pluginMap) {
      const targetDir = path.join(this.workDir, `${plugin.name.replace('/', '@')}@${plugin.version}`)

      try {
        if (!await fs.pathExists(path.join(this.workDir, this.pluginAssetName(plugin, 'tar.gz'))) || !await fs.pathExists(path.join(this.workDir, this.pluginAssetName(plugin, 'sha256')))) {
          console.log('Target:', targetDir)

          // refresh target directory
          await fs.remove(targetDir)
          await fs.mkdirp(targetDir)

          // create temp package.json
          await fs.writeJson(path.join(targetDir, 'package.json'), { private: true })

          // install plugin
          await execAsync(`npm install ${plugin.name}@${plugin.version} --omit=dev`, {
            cwd: targetDir,
            env: Object.assign({
              npm_config_audit: 'false',
              npm_config_fund: 'false',
              npm_config_update_notifier: 'false',
              npm_config_auto_install_peers: 'true',
              npm_config_global_style: 'true',
              npm_config_ignore_scripts: 'true',
              npm_config_package_lock: 'false',
              npm_config_loglevel: 'error',
            }, process.env),
          })

          // remove temp package.json and node_modules/.package-lock.json
          await fs.remove(path.join(targetDir, 'package.json'))
          await fs.remove(path.join(targetDir, 'node_modules', '.package-lock.json'))

          // package plugin
          await execAsync(`tar -C ${targetDir}/node_modules --owner=0 --group=0 --format=posix -czf ${this.pluginAssetName(plugin, 'tar.gz')} .`, {
            cwd: this.workDir,
          })

          // shasum 256 the package
          await execAsync(`shasum -a 256 ${this.pluginAssetName(plugin, 'tar.gz')} > ${this.pluginAssetName(plugin, 'sha256')}`, {
            cwd: this.workDir,
          })

          // remove target directory
          await fs.remove(targetDir)
        }
        plugin.packaged = true
      } catch (e) {
        console.log(`Failed to pack ${plugin.name}`, e.message)
        await fs.remove(targetDir)
        await fs.remove(path.join(this.workDir, this.pluginAssetName(plugin, 'tar.gz')))
        await fs.remove(path.join(this.workDir, this.pluginAssetName(plugin, 'sha256')))
      }
    }
  }

  /**
   * Upload assets to GitHub release
   */
  async uploadAssets() {
    for (const plugin of this.pluginMap) {
      for (const assetType of ['tar.gz', 'sha256']) {
        const assetName = this.pluginAssetName(plugin, assetType)
        const assetPath = path.join(this.workDir, assetName)

        const existingAsset = this.release.assets.find(x => x.name === assetName)
        if (existingAsset) {
          await this.deleteAsset(existingAsset)
        }

        const fileBuffer = await fs.readFile(assetPath)

        try {
          const response = await this.octokit.request('POST /repos/{owner}/{repo}/releases/{release_id}/assets', {
            owner: this.githubProjectOwner,
            repo: this.githubProjectRepo,
            url: this.release.upload_url,
            release_id: this.release.id,
            name: assetName,
            label: `${plugin.name}@${plugin.version}.${assetType}`,
            headers: {
              'content-type': 'application/octet-stream',
            },
            data: fileBuffer,
          })

          console.log(`Uploaded ${assetName}`)

          // note the plugin update as successful
          if (assetType === 'tar.gz') {
            this.pluginsSuccessfullyUpdated.push(plugin)
          }

          // handle rate limit of GitHub API - 1000 requests per hour in GitHub Actions.
          if (response?.headers?.['x-ratelimit-remaining'] === '0') {
            console.log('GitHub API Rate Limit Exhausted. Remaining plugins will be processed next run.')
            process.exit(0)
          }
        } catch (e) {
          console.error('Failed to upload asset:', assetName, e.messsage)
        }
      }
    }
  }

  /**
   * Delete previous versions of the assets
   */
  async removeOldAssets() {
    for (const plugin of this.pluginMap) {
      for (const assetType of ['tar.gz', 'sha256']) {
        const assetsToRemove = this.release
          .assets
          .filter((x) => {
            // find old assets (this will not include the assets we just uploaded!)
            return x.label.substring(0, x.label.lastIndexOf('@')) === plugin.name && x.name.endsWith(assetType)
          })
          .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) // sort by oldest to newest

        // remove the previously newest asset (last item in array), preventing it from being deleted
        assetsToRemove.pop()

        for (const asset of assetsToRemove) {
          await this.deleteAsset(asset)
        }
      }
    }
  }

  /**
   * Delete a release asset
   * @param {object} asset
   * @param {number} asset.id
   * @param {string} asset.name
   */
  async deleteAsset(asset: { id: number, name: string }) {
    try {
      await this.octokit.request('DELETE /repos/{owner}/{repo}/releases/assets/{asset_id}', {
        owner: this.githubProjectOwner,
        repo: this.githubProjectRepo,
        asset_id: asset.id,
      })
      console.log(`Purged ${asset.name}...`)
    } catch (e) {
      console.error('Failed to delete asset:', asset.name, e.messsage)
    }
  }

  pluginAssetName(plugin: Plugin, ext: string) {
    return `${plugin.name.replace('/', '@')}-${plugin.version}.${ext}`
  }
}

// bootstrap and run
(async () => {
  const main = new PluginTarballs()
  await main.run()
})()
