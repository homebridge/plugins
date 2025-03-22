/**
 * Checks the Homebridge plugin in a Docker container
 */

/* eslint-disable no-console */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import fs from 'fs-extra'
import { satisfies } from 'semver'
import { request } from 'undici'

// eslint-disable-next-line no-new-func
const _importDynamic = new Function('modulePath', 'return import(modulePath)')
const __dirname = import.meta.dirname
const require = createRequire(import.meta.url)

class CheckHomebridgePlugin {
  failed: string[] = []
  passed: string[] = []

  packageName: string
  packageVersion: string
  testPath: string
  gitHubRepo: string
  gitHubAuthor: string

  constructor() {
    this.packageName = process.env.HOMEBRIDGE_PLUGIN_NAME as string
    this.packageVersion = '' as string
    this.testPath = '' as string
    this.gitHubRepo = '' as string
    this.gitHubAuthor = '' as string
  }

  async start() {
    try {
      await this.createTestArea()
      console.log('Created Test Area', this.failed.length)
      await this.install()
      console.log('Installed Plugin', this.failed.length)
      await this.testPkgJson()
      console.log('Tested Package JSON', this.failed.length)
      if (this.gitHubRepo && this.gitHubAuthor) {
        await this.testGibHubRepo()
        console.log('Tested GitHub Repository', this.failed.length)
      } else {
        console.log('Skipped Testing GitHub Repository')
      }
      await this.testNpmPackage()
      console.log('Tested NPM Package', this.failed.length)
      await this.testConfigSchema()
      console.log('Tested Config Schema', this.failed.length)
      await this.testDependencies()
      console.log('Tested Dependencies', this.failed.length)
    } catch (e: any) {
      console.log(e)
      this.failed.push(e.message)
    }

    await fs.writeJson('/results/results.json', {
      failed: this.failed,
      passed: this.passed,
      version: this.packageVersion,
    })

    process.exit(this.failed.length ? 1 : 0)
  }

  async createTestArea() {
    this.testPath = resolve(__dirname, 'test-area')

    if (await fs.pathExists(this.testPath)) {
      await fs.remove(this.testPath)
    }

    await fs.mkdirp(this.testPath)
    await fs.writeJson(join(this.testPath, 'package.json'), {
      private: true,
      name: 'test-area',
      description: 'n/a',
      version: '0.0.0',
    }, { spaces: 4 })
  }

  async install() {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn('npm', ['install', `${this.packageName}@latest`], {
        cwd: this.testPath,
        stdio: 'inherit',
      })

      proc.on('close', (code) => {
        if (code === 0) {
          this.passed.push('Installation: successfully installed')
          resolve()
        } else {
          this.failed.push(`Installation: failed to install [${code}]`)
          reject(new Error('Failed to install'))
        }
      })
    })
  }

  async testPkgJson() {
    try {
      const packageJSON = await fs.readJson(join(this.testPath, 'node_modules', this.packageName, 'package.json')) as any

      // Validate homepage: it should exist
      if (packageJSON.homepage && packageJSON.homepage.startsWith('https://')) {
        this.passed.push('Package JSON: `homepage` exists')
      } else {
        this.failed.push('Package JSON: `homepage` missing or does not start with `https://`')
      }

      // Validate bugs: it should exist and contain a URL
      if (packageJSON.bugs && packageJSON.bugs.url) {
        const parts = packageJSON.bugs.url.split('/')
        parts.pop()
        this.gitHubRepo = parts.pop()
        this.gitHubAuthor = parts.pop()
        this.packageVersion = packageJSON.version

        // Verify that the bugs.url starts with https://
        if (packageJSON.bugs.url.startsWith('https://')) {
          this.passed.push('Package JSON: `bugs.url` exists and seems a valid URL')
        } else {
          this.failed.push('Package JSON: `bugs.url` exists but does not start with `https://`')
        }
      } else {
        this.failed.push('Package JSON: `bugs.url` missing')
      }

      // Validate keywords: it should exist, contain 'homebridge-plugin' and have more besides that
      if (Array.isArray(packageJSON.keywords)) {
        const keywords = packageJSON.keywords as string[]
        if (keywords.includes('homebridge-plugin')) {
          if (keywords.length > 1) {
            this.passed.push('Package JSON: `keywords` exist and contain `\'homebridge-plugin\'`')
          } else {
            this.failed.push('Package JSON: more `keywords` apart from `\'homebridge-plugin\'` should exist')
          }
        } else {
          this.failed.push('Package JSON: `\'homebridge-plugin\'` in `keywords` missing')
        }
      } else {
        this.failed.push('Package JSON: `keywords` property missing')
      }

      // Validate scripts: no `preinstall`, `install` and `postinstall` scripts should be present
      if (typeof packageJSON.scripts === 'object') {
        if (packageJSON.scripts.preinstall) {
          this.failed.push('Package JSON: `\'preinstall\'` in `scripts` is not allowed')
        } else {
          this.passed.push('Package JSON: `\'preinstall\'` in `scripts` is not present')
        }
        if (packageJSON.scripts.install) {
          this.failed.push('Package JSON: `\'install\'` in `scripts` is not allowed')
        } else {
          this.passed.push('Package JSON: `\'install\'` in `scripts` is not present')
        }
        if (packageJSON.scripts.postinstall) {
          this.failed.push('Package JSON: `\'postinstall\'` in `scripts` is not allowed')
        } else {
          this.passed.push('Package JSON: `\'postinstall\'` in `scripts` is not present')
        }
      }

      // Validate engine versions
      if (packageJSON.engines) {
        if (packageJSON.engines.node) {
          try {
            // Obtain the latest Node.js versions
            const { body } = await request('https://nodejs.org/dist/index.json', {
              headers: {
                'User-Agent': 'Homebridge Plugin Checks',
              },
            })
            const versionList = await body.json() as any

            // Get the newest v20 and v22 in the list
            const latest20 = versionList.filter((x: { version: string }) => x.version.startsWith('v20'))[0].version as string
            const latest22 = versionList.filter((x: { version: string }) => x.version.startsWith('v22'))[0].version as string

            if (satisfies(latest20, packageJSON.engines.node)) {
              this.passed.push('Package JSON: `engines.node` property is compatible with Node 20')
            } else {
              this.failed.push('Package JSON: `engines.node` property is not compatible with Node 20')
            }
            if (satisfies(latest22, packageJSON.engines.node)) {
              this.passed.push('Package JSON: `engines.node` property is compatible with Node 22')
            } else {
              this.failed.push('Package JSON: `engines.node` property is not compatible with Node 22')
            }
          } catch (e: any) {
            this.failed.push(`Package JSON: failed to check Node compatibility as ${e.message}`)
          }
        } else {
          // ok
        }
        if (packageJSON.engines.homebridge) {
          try {
            // Get the latest Homebridge version
            const { body } = await request('https://registry.npmjs.org/homebridge', {
              headers: {
                accept: 'application/vnd.npm.install-v1+json', // only return minimal information
              },
            })

            const bodyJson = await body.json() as any
            const latestVersion = bodyJson['dist-tags'].latest as string

            if (satisfies(latestVersion, packageJSON.engines.homebridge)) {
              this.passed.push(`Package JSON: \`engines.homebridge\` property is compatible with Homebridge ${latestVersion}`)
            } else {
              this.failed.push(`Package JSON: \`engines.homebridge\` property is not compatible with Homebridge ${latestVersion}`)
            }
          } catch (e: any) {
            this.failed.push(`Package JSON: failed to check Homebridge compatibility as ${e.message}`)
          }
        } else {
          this.failed.push('Package JSON: `engines.homebridge` property missing')
        }
      } else {
        this.failed.push('Package JSON: `engines` property missing')
      }

      // Check if the plugin exports an initializer function
      let main = ''

      // figure out the main module
      // exports is available - https://nodejs.org/dist/latest-v14.x/docs/api/packages.html#packages_package_entry_points
      if (packageJSON.exports) {
        // main entrypoint - https://nodejs.org/dist/latest-v14.x/docs/api/packages.html#packages_main_entry_point_export
        if (typeof packageJSON.exports === 'string') {
          main = packageJSON.exports
        } else { // sub-path export - https://nodejs.org/dist/latest-v14.x/docs/api/packages.html#packages_subpath_exports
          // conditional exports - https://nodejs.org/dist/latest-v14.x/docs/api/packages.html#packages_conditional_exports
          const exports = packageJSON.exports.import || packageJSON.exports.require || packageJSON.exports.node || packageJSON.exports.default || packageJSON.exports['.']

          // check if conditional export is nested
          if (typeof exports !== 'string') {
            if (exports.import) {
              main = exports.import
            } else {
              main = exports.require || exports.node || exports.default
            }
          } else {
            main = exports
          }
        }
      }

      // exports search was not successful, fallback to package.main, using index.js as fallback
      if (!main) {
        main = packageJSON.main || './index.js'
      }

      // check if it is an ESM module
      const isESM = main.endsWith('.mjs') || (main.endsWith('.js') && packageJSON.type === 'module')
      const mainPath = join(this.testPath, 'node_modules', this.packageName, main)

      const pluginModules = isESM ? await _importDynamic(pathToFileURL(mainPath).href) : require(mainPath)

      if (typeof pluginModules === 'function') {
        this.passed.push('Package JSON: initializer function found')
      } else if (pluginModules && typeof pluginModules.default === 'function') {
        this.passed.push('Package JSON: initializer function found')
      } else {
        // not ok
        this.failed.push('Package JSON: no initializer function found')
      }
    } catch (e: any) {
      this.failed.push(`Package JSON: failed to import plugin as ${e.message}`)
    }
  }

  async testGibHubRepo() {
    try {
      // Undici request to GitHub API
      const { body } = await request(
        `https://api.github.com/repos/${this.gitHubAuthor}/${this.gitHubRepo}`,
        {
          headers: {
            'User-Agent': 'Homebridge Plugin Checks',
            'Accept': 'application/vnd.github+json',
          },
        },
      )
      const repoData = await body.json() as any

      // Check is public
      if (repoData.private) {
        this.failed.push('GitHub Repo: should not be private')
      } else {
        this.passed.push('GitHub Repo: repository is public')
      }

      // Check is not archived
      if (repoData.archived) {
        this.failed.push('GitHub Repo: should not be archived')
      } else {
        this.passed.push('GitHub Repo: repository is not archived')
      }

      // Are issues enabled?
      if (repoData.has_issues) {
        this.passed.push('GitHub Repo: issues are enabled')
      } else {
        this.failed.push('GitHub Repo: should have issues enabled')
      }

      // Check that there are some releases
      const { body: releases } = await request(
        `https://api.github.com/repos/${this.gitHubAuthor}/${this.gitHubRepo}/releases`,
        {
          headers: {
            'User-Agent': 'Homebridge Plugin Checks',
            'Accept': 'application/vnd.github+json',
          },
        },
      )
      const releaseData = await releases.json() as any

      if (releaseData.length > 0) {
        this.passed.push('GitHub Repo: contains releases')
      } else {
        this.failed.push('GitHub Repo: should contain releases')
      }
    } catch (e: any) {
      console.error(e)
      this.failed.push(`Github Repo: could not request information as ${e.message}`)
    }
  }

  async testNpmPackage() {
    try {
      const { body } = await request(`https://registry.npmjs.org/${encodeURIComponent(this.packageName).replace(/%40/g, '@')}`, {
        headers: {
          accept: 'application/vnd.npm.install-v1+json', // only return minimal information
        },
      })

      const bodyJson = await body.json() as any

      const latestVersion = bodyJson['dist-tags'].latest as string
      const deprecatedMessage = bodyJson.versions[latestVersion].deprecated as string

      if (deprecatedMessage) {
        this.failed.push('NPM Package: has been deprecated')
      } else {
        this.passed.push('NPM Package: has not been deprecated')
      }
    } catch (e: any) {
      this.failed.push(`NPM Package: could not request information as ${e.message}`)
    }
  }

  async testConfigSchema() {
    const schemaPath = join(this.testPath, 'node_modules', this.packageName, 'config.schema.json')

    if (await fs.pathExists(schemaPath)) {
      let configSchema: any

      try {
        configSchema = await fs.readJson(schemaPath)
        this.passed.push('Config Schema JSON: exists and is valid JSON')
      } catch (e) {
        this.failed.push('Config Schema JSON: does not contain valid JSON')
        return
      }

      if (typeof configSchema.pluginAlias === 'string') {
        this.passed.push('Config Schema JSON: contains a valid `pluginAlias`')
      } else {
        this.failed.push('Config Schema JSON: does not contain a valid `pluginAlias`')
      }

      if (configSchema.pluginType === 'platform') {
        this.passed.push('Config Schema JSON: the `pluginType` is set to `\'platform\'`')
      } else {
        this.failed.push('Config Schema JSON: the `pluginType` is not set to `\'platform\'`')
      }

      // Look for a schema->properties->name object
      if (configSchema.schema?.properties?.name && Object.keys(configSchema.schema.properties.name).length > 0) {
        this.passed.push('Config Schema JSON: contains a `name` schema property')
      } else {
        this.failed.push('Config Schema JSON: does not contain a `name` schema property')
      }
    } else {
      this.failed.push('Config Schema JSON: missing file')
    }
  }

  async testDependencies() {
    if (await fs.pathExists(join(this.testPath, 'node_modules', 'homebridge'))) {
      this.failed.push('Dependencies: `homebridge` was installed as a dependency')
    } else {
      this.passed.push('Dependencies: `homebridge` was not installed as a dependency')
    }

    if (await fs.pathExists(join(this.testPath, 'node_modules', 'hap-nodejs'))) {
      this.failed.push('Dependencies: `hap-nodejs` was installed as a dependency')
    } else {
      this.passed.push('Dependencies: `hap-nodejs` was not installed as a dependency')
    }
  }
}

const checkHomebridgePlugin = new CheckHomebridgePlugin()
checkHomebridgePlugin.start()
