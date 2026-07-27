/* eslint-disable no-console */
import { execFile } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import util from 'node:util'

import { Octokit } from '@octokit/core'
import axios from 'axios'
import fs from 'fs-extra'

const __dirname = import.meta.dirname

const execFileAsync = util.promisify(execFile)

export interface Plugin {
  name: string
  valid: boolean
  version: string | null
  packaged: boolean
}

interface Release {
  id: number
  tag_name: string
  upload_url: string
  assets: {
    id: number
    name: string
    label: string | null
    created_at: string
    updated_at: string
    browser_download_url: string
    download_count: number
    size: number
  }[]
}

class PluginTarballs {
  private octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  })

  private githubProjectOwner = 'homebridge'
  private githubProjectRepo = 'plugins'

  // New primary releases
  private targetNewScoped = 'v2.0.0'
  private targetNewUnscopedAM = 'v2.0.0-1'
  private targetNewUnscopedNZ = 'v2.0.0-2'

  // Old releases (backward compat)
  private targetOldUnscoped = 'v1.0.0'
  private targetOldScoped = 'v1.0.0-1'

  private newReleases!: Release[] // [scoped, unscoped-am, unscoped-nz]
  private oldReleases!: Release[] // [unscoped, scoped]

  private workDir = path.join(__dirname, 'work')

  private pluginList: string[] = []
  private pluginMap: Plugin[] = []

  private pluginsSuccessfullyUpdated: Plugin[] = []
  private pluginsNotProcessed: { plugin: Plugin, error: string }[] = []

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

  private logRed(message: string) {
    console.log(`\x1B[31m${message}\x1B[0m`)
  }

  private logGreen(message: string) {
    console.log(`\x1B[32m${message}\x1B[0m`)
  }

  private logYellow(message: string) {
    console.log(`\x1B[33m${message}\x1B[0m`)
  }

  /**
   * Get the new release for a plugin based on its name
   */
  private getNewReleaseForPlugin(pluginName: string): Release {
    if (pluginName.startsWith('@')) {
      return this.newReleases[0] // v2.0.0
    }
    const ch = pluginName.startsWith('homebridge-')
      ? pluginName.charAt(11)
      : pluginName.charAt(0)
    return ch < 'n'
      ? this.newReleases[1] // v2.0.0-1
      : this.newReleases[2] // v2.0.0-2
  }

  /**
   * Get the old release for a plugin based on its name (for backward compat)
   */
  private getOldReleaseForPlugin(pluginName: string): Release | undefined {
    if (pluginName.startsWith('@')) {
      return this.oldReleases[1] // v1.0.0-1
    }
    return this.oldReleases[0] // v1.0.0
  }

  public async run(): Promise<void> {
    try {
      await this.getGitHubReleases()
      await this.getVerifiedPluginsList()
      await this.removeUnverifiedAssets()
      await this.removeAssetsForOlderReleases()
      await this.getLatestVersions()
      await this.bundlePlugins()
      await this.uploadAssets()
      await this.uploadAssetsToOldReleases()
      await this.removeOldAssets()
      await this.updateRelease()
      await this.generateDownloadStats()
    } catch (e) {
      console.error('Error', (e as Error).message, e)
      process.exit(1)
    }
  }

  /**
   * Get the verified plugins list
   */
  private async getVerifiedPluginsList(): Promise<void> {
    const response = await axios.get<string[]>('https://raw.githubusercontent.com/homebridge/plugins/latest/verified-plugins.json')
    this.pluginList = response.data.filter(x => !this.pluginFilter.includes(x))
    const verifiedPluginsCount = this.pluginList.length

    // Add additional plugins, checking to make sure we are not adding duplicates
    this.additionalPlugins.forEach((plugin) => {
      if (!this.pluginList.includes(plugin)) {
        this.pluginList.push(plugin)
      }
    })

    console.log(`Processing ${this.pluginList.length} plugins (${verifiedPluginsCount} verified and ${this.pluginList.length - verifiedPluginsCount} additional plugins)...`)
  }

  /**
   * Remove assets that are no longer in the verified list
   */
  private async removeUnverifiedAssets(): Promise<void> {
    const verifiedPluginsSet = new Set(this.pluginList)
    let assetsRemoved = 0

    for (const release of [...this.newReleases, ...this.oldReleases]) {
      console.log(`Removing any unverified assets from the ${release.assets.length} total assets in the ${release.tag_name} release...`)

      for (const asset of release.assets) {
        // Ignore GitHub-specific assets
        if (asset.name === 'download-statistics.json') {
          continue
        }

        // Extract plugin name from asset label
        const assetPlugin = (asset.label ?? '').substring(0, (asset.label ?? '').lastIndexOf('@'))

        // Check if the plugin is not in the verified list
        if (!verifiedPluginsSet.has(assetPlugin)) {
          await this.deleteAsset(asset)

          console.log(`Removing unverified asset: ${asset.name} (${assetPlugin})`)
          assetsRemoved += 1
        }
      }
    }

    console.log(`Removed ${assetsRemoved} unverified assets over all the releases.`)
  }

  /**
   * Get the 'latest' version for the plugins — check against NEW releases only
   */
  private async getLatestVersions(): Promise<void> {
    for (const pluginName of this.pluginList) {
      try {
        const response = await axios.get(`https://registry.npmjs.org/${pluginName}/latest`)

        const plugin: Plugin = {
          name: pluginName,
          valid: true,
          version: response.data.version,
          packaged: false,
        }

        const release = this.getNewReleaseForPlugin(pluginName)

        // Check if an update is required
        if (
          release.assets.some(x => x.name === this.pluginAssetName(plugin, 'tar.gz'))
          && release.assets.some(x => x.name === this.pluginAssetName(plugin, 'sha256'))
        ) {
          console.log(`${plugin.name} v${plugin.version} is up to date.`)
        } else {
          this.pluginMap.push(plugin)
        }
      } catch (e) {
        console.log(`ERROR: ${pluginName}`, (e as Error).message)
        this.pluginsNotProcessed.push({ plugin: { name: pluginName, valid: false, version: null, packaged: false }, error: (e as Error).message })
      }
    }
  }

  /**
   * Remove assets for older releases, keeping only the most recent version
   */
  private async removeAssetsForOlderReleases(): Promise<void> {
    for (const release of [...this.newReleases, ...this.oldReleases]) {
      const pluginAssetsMap: {
        [pluginName: string]: {
          version: string
          assets: Release['assets']
        }[]
      } = {}

      // Group assets by plugin name and version
      for (const asset of release.assets) {
        const pluginName = (asset.label ?? '').substring(0, (asset.label ?? '').lastIndexOf('@'))
        const version = (asset.label ?? '')
          .substring((asset.label ?? '').lastIndexOf('@') + 1, (asset.label ?? '').length)
          .replace('.tar.gz', '')
          .replace('.sha256', '')

        if (!pluginAssetsMap[pluginName]) {
          pluginAssetsMap[pluginName] = []
        }

        let versionGroup = pluginAssetsMap[pluginName].find(group => group.version === version)
        if (!versionGroup) {
          versionGroup = { version, assets: [] }
          pluginAssetsMap[pluginName].push(versionGroup)
        }

        versionGroup.assets.push(asset)
      }

      // Iterate over each plugin and remove assets for older versions
      for (const [pluginName, versionGroups] of Object.entries(pluginAssetsMap)) {
        // Sort versions by creation date (newest first)
        versionGroups.sort((a, b) => {
          const dateA = new Date(a.assets[0].created_at).getTime()
          const dateB = new Date(b.assets[0].created_at).getTime()
          return dateB - dateA
        })

        // Keep the two most recent versions' assets (the README documents
        // that the two most recent versions of a plugin are retained)
        versionGroups.splice(0, 2)

        // Delete assets for older versions
        for (const group of versionGroups) {
          console.log(`Deleting older assets for plugin ${pluginName} version ${group.version} from release ${release.tag_name}...`)
          for (const asset of group.assets) {
            await this.deleteAsset(asset)
            console.log(`Deleted older asset: ${asset.name} for plugin ${pluginName}`)
          }
        }
      }
    }
  }

  /**
   * Get the GitHub releases for the project
   */
  private async getGitHubReleases(): Promise<void> {
    const response = await this.octokit.request('GET /repos/{owner}/{repo}/releases', {
      owner: this.githubProjectOwner,
      repo: this.githubProjectRepo,
    })

    const findRelease = (tag: string): Release => {
      const release = response.data.find(x => x.tag_name === tag)
      if (!release) {
        throw new Error(`Release with tag "${tag}" does not exist`)
      }
      return release
    }

    this.newReleases = [
      findRelease(this.targetNewScoped),
      findRelease(this.targetNewUnscopedAM),
      findRelease(this.targetNewUnscopedNZ),
    ]

    this.oldReleases = [
      findRelease(this.targetOldUnscoped),
      findRelease(this.targetOldScoped),
    ]
  }

  private releaseNameMap: Record<string, string> = {
    [this.targetNewScoped]: 'Plugin Tarballs (Scoped)',
    [this.targetNewUnscopedAM]: 'Plugin Tarballs (Unscoped; A-M)',
    [this.targetNewUnscopedNZ]: 'Plugin Tarballs (Unscoped; N-Z)',
    [this.targetOldUnscoped]: 'Plugin Tarballs (Legacy Unscoped)',
    [this.targetOldScoped]: 'Plugin Tarballs (Legacy Scoped)',
  }

  /**
   * Update the GitHub Release
   */
  private async updateRelease(): Promise<void> {
    for (const release of [...this.newReleases, ...this.oldReleases]) {
      try {
        const dateStr = new Date().toISOString().split('T')[0]
        const label = this.releaseNameMap[release.tag_name] || 'Plugin Tarballs'

        let body = 'All plugins are up to date.'
        if (this.pluginsSuccessfullyUpdated.length > 0 || this.pluginsNotProcessed.length > 0) {
          body = 'Recently updated plugins:\n\n'
            + `${this.pluginsSuccessfullyUpdated.map(x => `- ${x.name}@${x.version}`).join('\n')}\n`
            + '---\n'
            + 'Plugins not processed:\n\n'
            + `${this.pluginsNotProcessed.map(x => `- ${x.plugin.name} - ${x.error}`).join('\n')}`
        }

        await this.octokit.request('PATCH /repos/{owner}/{repo}/releases/{release_id}', {
          owner: this.githubProjectOwner,
          repo: this.githubProjectRepo,
          release_id: release.id,
          name: `${label} ${dateStr}`,
          body,
        })
        console.log(`Updated release ${release.tag_name}.`)
      } catch (e) {
        console.error(`Could not update release ${release.tag_name}`, (e as Error).message)
      }
    }
  }

  /**
   * Generate a file to keep track of the total number of downloads
   */
  private async generateDownloadStats(): Promise<void> {
    for (const release of [...this.newReleases, ...this.oldReleases]) {
      this.releaseStats = {}

      const pluginBundleAssets = release.assets.filter(x => x.name.endsWith('.tar.gz'))
      const releaseStatsAsset = release.assets.find(x => x.name === 'download-statistics.json')

      if (releaseStatsAsset) {
        const response = await axios.get(`${releaseStatsAsset.browser_download_url}?date=${Date.now()}`)
        this.releaseStats = response.data
      }

      for (const asset of pluginBundleAssets) {
        const assetPlugin = (asset.label ?? '').substring(0, (asset.label ?? '').lastIndexOf('@'))
        const assetVersion = (asset.label ?? '').substring((asset.label ?? '').lastIndexOf('@') + 1, (asset.label ?? '').length).split('.tar.gz')[0]

        // Initialize the plugin if we have not seen it before
        if (!this.releaseStats[assetPlugin]) {
          this.releaseStats[assetPlugin] = {
            downloadCount: 0,
            versions: {},
          }
        }

        // Set / update the stats for the current version being processed
        this.releaseStats[assetPlugin].versions[assetVersion] = {
          downloadCount: asset.download_count,
          size: asset.size,
          created: asset.created_at,
        }

        // Update the total download count
        this.releaseStats[assetPlugin].downloadCount = 0
        for (const version of Object.values(this.releaseStats[assetPlugin].versions)) {
          this.releaseStats[assetPlugin].downloadCount += version.downloadCount
        }
      }

      // Remove the old download-statistics.json
      if (releaseStatsAsset) {
        await this.deleteAsset(releaseStatsAsset)
      }

      // Upload the new download-statistics.json
      await this.octokit.request('POST /repos/{owner}/{repo}/releases/{release_id}/assets', {
        owner: this.githubProjectOwner,
        repo: this.githubProjectRepo,
        url: release.upload_url,
        release_id: release.id,
        name: 'download-statistics.json',
        label: 'download-statistics.json',
        headers: {
          'content-type': 'application/json',
        },
        data: JSON.stringify(this.releaseStats),
      })

      console.log(`Updated download-statistics.json for ${release.tag_name}...`)
    }
  }

  /**
   * Create a bundle for the verified plugins
   */
  private async bundlePlugins(): Promise<void> {
    console.log(`Generating update bundles for ${this.pluginMap.length} plugins...`)
    for (const plugin of this.pluginMap) {
      const targetDir = path.join(this.workDir, `${plugin.name.replace('/', '@')}@${plugin.version}`)

      try {
        if (!await fs.pathExists(path.join(this.workDir, this.pluginAssetName(plugin, 'tar.gz'))) || !await fs.pathExists(path.join(this.workDir, this.pluginAssetName(plugin, 'sha256')))) {
          console.log('Target:', targetDir)

          // Refresh target directory
          await fs.remove(targetDir)
          await fs.mkdirp(targetDir)

          // Create temp package.json
          await fs.writeJson(path.join(targetDir, 'package.json'), { private: true })

          // Install plugin
          await execFileAsync('npm', ['install', `${plugin.name}@${plugin.version}`, '--omit=dev'], {
            cwd: targetDir,
            env: {
              ...process.env,
              npm_config_audit: 'false',
              npm_config_fund: 'false',
              npm_config_update_notifier: 'false',
              npm_config_auto_install_peers: 'true',
              npm_config_global_style: 'true',
              npm_config_ignore_scripts: 'true',
              npm_config_package_lock: 'false',
              npm_config_loglevel: 'error',
            },
          })

          // Remove temp package.json and node_modules/.package-lock.json
          await fs.remove(path.join(targetDir, 'package.json'))
          await fs.remove(path.join(targetDir, 'node_modules', '.package-lock.json'))

          // Package plugin
          await execFileAsync('tar', ['-C', `${targetDir}/node_modules`, '--owner=0', '--group=0', '--format=posix', '-czf', this.pluginAssetName(plugin, 'tar.gz'), '.'], {
            cwd: this.workDir,
          })

          // Shasum 256 the package
          const { stdout: shasum } = await execFileAsync('shasum', ['-a', '256', this.pluginAssetName(plugin, 'tar.gz')], {
            cwd: this.workDir,
          })
          await fs.writeFile(path.join(this.workDir, this.pluginAssetName(plugin, 'sha256')), shasum)

          // Remove target directory
          await fs.remove(targetDir)
        }
        plugin.packaged = true
      } catch (e) {
        console.log(`Failed to pack ${plugin.name}`, (e as Error).message)
        await fs.remove(targetDir)
        await fs.remove(path.join(this.workDir, this.pluginAssetName(plugin, 'tar.gz')))
        await fs.remove(path.join(this.workDir, this.pluginAssetName(plugin, 'sha256')))
        // Surface the failure in the release notes rather than letting it pass
        // silently now that the upload step skips unpacked plugins.
        this.pluginsNotProcessed.push({ plugin, error: (e as Error).message })
      }
    }
  }

  /**
   * Upload assets to the new GitHub releases
   */
  private async uploadAssets(): Promise<void> {
    for (const plugin of this.pluginMap) {
      // Packing can fail for reasons outside our control — most often an author
      // unpublishing the version we resolved from the registry. The partial
      // artefacts were cleaned up, so reading them here would throw ENOENT and
      // fail the whole run, discarding the plugins that packed perfectly well.
      if (!plugin.packaged) {
        continue
      }

      let allAssetsUploaded = true
      let rateLimitExhausted = false

      for (const assetType of ['tar.gz', 'sha256']) {
        const assetName = this.pluginAssetName(plugin, assetType)
        const assetPath = path.join(this.workDir, assetName)

        const release = this.getNewReleaseForPlugin(plugin.name)

        const existingAsset = release.assets.find(x => x.name === assetName)
        if (existingAsset) {
          await this.deleteAsset(existingAsset)
        }

        const fileBuffer = await fs.readFile(assetPath)

        try {
          const response = await this.octokit.request('POST /repos/{owner}/{repo}/releases/{release_id}/assets', {
            owner: this.githubProjectOwner,
            repo: this.githubProjectRepo,
            url: release.upload_url,
            release_id: release.id,
            name: assetName,
            label: `${plugin.name}@${plugin.version}.${assetType}`,
            headers: {
              'content-type': 'application/octet-stream',
            },
            data: fileBuffer,
          })

          console.log(`Uploaded ${assetName} to ${release.tag_name}`)

          // Handle rate limit of GitHub API - 1000 requests per hour in GitHub Actions.
          if (response?.headers?.['x-ratelimit-remaining'] === '0') {
            rateLimitExhausted = true
          }
        } catch (e) {
          allAssetsUploaded = false
          console.error('Failed to upload asset:', assetName, (e as Error).message)
        }
      }

      // Only note the plugin update as successful once both the tarball and
      // its checksum have been uploaded
      if (allAssetsUploaded) {
        this.pluginsSuccessfullyUpdated.push(plugin)
      }

      if (rateLimitExhausted) {
        console.log('GitHub API Rate Limit Exhausted. Remaining plugins will be processed next run.')
        process.exit(0)
      }
    }
  }

  /**
   * Best-effort upload of assets to old releases for backward compatibility.
   * Only updates plugins that already have assets on the old release (can't add new ones — old releases are at the limit).
   */
  private async uploadAssetsToOldReleases(): Promise<void> {
    for (const plugin of this.pluginsSuccessfullyUpdated) {
      const oldRelease = this.getOldReleaseForPlugin(plugin.name)
      if (!oldRelease) {
        continue
      }

      // Check if the plugin already has assets on the old release
      const existingTarGz = oldRelease.assets.find(x =>
        (x.label ?? '').substring(0, (x.label ?? '').lastIndexOf('@')) === plugin.name && x.name.endsWith('.tar.gz'),
      )
      if (!existingTarGz) {
        console.log(`Skipping old release upload for ${plugin.name} — not present on ${oldRelease.tag_name}`)
        continue
      }

      try {
        for (const assetType of ['tar.gz', 'sha256']) {
          const assetName = this.pluginAssetName(plugin, assetType)
          const assetPath = path.join(this.workDir, assetName)

          // Delete old version assets
          const oldAssets = oldRelease.assets.filter(x =>
            (x.label ?? '').substring(0, (x.label ?? '').lastIndexOf('@')) === plugin.name && x.name.endsWith(assetType),
          )
          for (const oldAsset of oldAssets) {
            await this.deleteAsset(oldAsset)
          }

          // Upload new version asset
          const fileBuffer = await fs.readFile(assetPath)
          await this.octokit.request('POST /repos/{owner}/{repo}/releases/{release_id}/assets', {
            owner: this.githubProjectOwner,
            repo: this.githubProjectRepo,
            url: oldRelease.upload_url,
            release_id: oldRelease.id,
            name: assetName,
            label: `${plugin.name}@${plugin.version}.${assetType}`,
            headers: {
              'content-type': 'application/octet-stream',
            },
            data: fileBuffer,
          })

          console.log(`Uploaded ${assetName} to old release ${oldRelease.tag_name}`)
        }
      } catch (e) {
        console.log(`Best-effort upload to old release failed for ${plugin.name}: ${(e as Error).message}`)
      }
    }
  }

  /**
   * Delete previous versions of the assets
   */
  private async removeOldAssets(): Promise<void> {
    for (const release of [...this.newReleases, ...this.oldReleases]) {
      for (const plugin of this.pluginMap) {
        for (const assetType of ['tar.gz', 'sha256']) {
          const assetsToRemove = release
            .assets
            .filter((x) => {
              // Find old assets (this will not include the assets we just uploaded!)
              return (x.label ?? '').substring(0, (x.label ?? '').lastIndexOf('@')) === plugin.name && x.name.endsWith(assetType)
            })
            .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) // sort by oldest to newest

          // Remove the previously newest asset (last item in array), preventing it from being deleted
          assetsToRemove.pop()

          for (const asset of assetsToRemove) {
            await this.deleteAsset(asset)
          }
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
  private async deleteAsset(asset: { id: number, name: string }): Promise<void> {
    try {
      await this.octokit.request('DELETE /repos/{owner}/{repo}/releases/assets/{asset_id}', {
        owner: this.githubProjectOwner,
        repo: this.githubProjectRepo,
        asset_id: asset.id,
      })
      console.log(`Purged ${asset.name}...`)
    } catch (e) {
      console.error('Failed to delete asset:', asset.name, (e as Error).message)
    }
  }

  private pluginAssetName(plugin: Plugin, ext: string) {
    return `${plugin.name.replace('/', '@')}-${plugin.version}.${ext}`
  }
}

// Bootstrap and run
(async () => {
  const main = new PluginTarballs()
  await main.run()
})()
