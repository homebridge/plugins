/**
 * Checks the Homebridge plugin in a Docker container
 */

/* eslint-disable no-console */
import type { ChildProcess } from 'node:child_process'

import { Buffer } from 'node:buffer'
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

interface PackageJSON {
  name?: string
  version?: string
  homepage?: string
  bugs?: {
    url?: string
  }
  keywords?: string[]
  scripts?: Record<string, string>
  engines?: {
    node?: string
    homebridge?: string
  }
  main?: string
  exports?: string | Record<string, any>
  type?: string
}

interface NodeVersion {
  version: string
}

interface NPMPackageInfo {
  'dist-tags': {
    latest: string
  }
  'versions': Record<string, {
    deprecated?: string
  }>
}

interface GitHubRepo {
  private: boolean
  archived: boolean
  has_issues: boolean
}

interface ConfigSchema {
  pluginAlias?: string
  pluginType?: string
  schema?: {
    properties?: {
      name?: Record<string, any>
      [key: string]: any
    }
    required?: string[]
    [key: string]: any
  }
}

interface TestResults {
  failed: string[]
  passed: string[]
  manualReview: string[]
  version: string
  detailedFailures?: DetailedFailure[]
  httpRequests?: HttpRequest[]
}

interface DetailedFailure {
  message: string
  config?: any
  scenario?: string
  isRuntimeFailure?: boolean
  isNetworkResilienceTest?: boolean
}

interface RuntimeTestScenario {
  name: string
  config?: any
  expectStartup: boolean
  description: string
  mockNetworkFailures?: boolean
  expectPluginToLoad?: boolean
}

interface HomebridgeConfig {
  bridge: {
    name: string
    username: string
    port: number
    pin: string
  }
  accessories: any[]
  platforms: any[]
}

interface TestResult {
  success: boolean
  error?: string
  logs: string[]
  duration: number
  httpRequests?: HttpRequest[]
  pluginLoaded?: boolean
  suspiciousFileAccess?: any[]
}

interface HttpRequest {
  url: string
  method: string
  timestamp: string
  scenario: string
}

class CheckHomebridgePlugin {
  private static readonly CONSTANTS = {
    URLS: {
      NODE_DIST: 'https://nodejs.org/dist/index.json',
      NPM_REGISTRY: 'https://registry.npmjs.org',
      GITHUB_API: 'https://api.github.com',
    },
    HEADERS: {
      USER_AGENT: 'Homebridge Plugin Checks',
      NPM_ACCEPT: 'application/vnd.npm.install-v1+json',
      GITHUB_ACCEPT: 'application/vnd.github+json',
    },
    REQUIRED_KEYWORD: 'homebridge-plugin',
    FORBIDDEN_SCRIPTS: ['preinstall', 'install', 'postinstall'],
    REQUIRED_PLUGIN_TYPE: 'platform',
    FORBIDDEN_DEPENDENCIES: ['homebridge', 'hap-nodejs'],
    RESULTS_PATH: '/results/results.json',
    RUNTIME_TEST_TIMEOUT: 60000, // 60 seconds for real Homebridge (to catch restart loops)
    HOMEBRIDGE_STARTUP_TIMEOUT: 30000, // 30 seconds to allow plugins to fully initialize
    HOMEBRIDGE_PORT_BASE: 51826, // Base port for test instances
  } as const

  private failed: string[] = []
  private passed: string[] = []
  private manualReview: string[] = []
  private detailedFailures: DetailedFailure[] = []
  private readonly packageName: string
  private packageVersion = ''
  private npmLatestVersion = ''
  private testPath = ''
  private gitHubRepo = ''
  private gitHubAuthor = ''
  private configSchema: ConfigSchema | null = null
  private allHttpRequests: HttpRequest[] = []

  constructor() {
    const pluginName = process.env.HOMEBRIDGE_PLUGIN_NAME
    if (!pluginName) {
      throw new Error('HOMEBRIDGE_PLUGIN_NAME environment variable is required')
    }
    this.packageName = pluginName
  }

  async start(): Promise<void> {
    try {
      await this.runAllTests()
    } catch (e) {
      console.error(e)
      this.failed.push(this.handleError(e))
    }

    await this.saveResults()

    // Display results if in debug mode
    if (process.env.DEBUG) {
      this.displayResults()
    }

    // Display HTTP requests summary
    this.displayHttpRequestSummary()

    process.exit(this.failed.length ? 1 : 0)
  }

  private async runAllTests(): Promise<void> {
    const staticTests = [
      { name: 'Created Test Area', method: () => this.createTestArea() },
      { name: 'Installed Plugin', method: () => this.install() },
      { name: 'Tested Package JSON', method: () => this.testPackageJson() },
      { name: 'Tested NPM Package', method: () => this.testNpmPackage() },
      { name: 'Tested GitHub Version Sync', method: () => this.testGitHubVersionSync() },
      { name: 'Tested Config Schema', method: () => this.testConfigSchema() },
      { name: 'Tested Dependencies', method: () => this.testDependencies() },
      { name: 'Tested Security Vulnerabilities', method: () => this.testSecurityVulnerabilities() },
      { name: 'Tested Code Safety', method: () => this.testCodeSafety() },
      { name: 'Tested Permissions', method: () => this.testPermissions() },
    ]

    // Run static analysis tests first
    for (const test of staticTests) {
      await test.method()
      console.log(test.name, this.failed.length)
    }

    // Only run expensive runtime tests if all static tests passed
    if (this.failed.length === 0) {
      console.log('All static tests passed - proceeding with runtime testing...')
      await this.testRuntimeBehavior()
      console.log('Tested Runtime Behavior', this.failed.length)
    } else {
      console.log(`Skipping runtime tests due to ${this.failed.length} static test failures`)
    }

    // GitHub repo test is conditional
    if (this.gitHubRepo && this.gitHubAuthor) {
      await this.testGitHubRepo()
      console.log('Tested GitHub Repository', this.failed.length)
    } else {
      console.log('Skipped Testing GitHub Repository')
    }
  }

  private async createTestArea(): Promise<void> {
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

  private async install(): Promise<void> {
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

  private async testPackageJson(): Promise<void> {
    try {
      const packageJSON = await this.readPackageJson()

      this.validateHomepage(packageJSON)
      this.validateBugsUrl(packageJSON)
      this.validateKeywords(packageJSON)
      this.validateScripts(packageJSON)
      await this.validateEngineVersions(packageJSON)
      await this.validatePluginInitializer(packageJSON)
    } catch (e) {
      this.failed.push(`Package JSON: failed to process as ${this.handleError(e)}`)
    }
  }

  private async readPackageJson(): Promise<PackageJSON> {
    const packagePath = join(this.testPath, 'node_modules', this.packageName, 'package.json')
    return await fs.readJson(packagePath) as PackageJSON
  }

  private validateHomepage(packageJSON: PackageJSON): void {
    if (packageJSON.homepage?.startsWith('https://')) {
      this.passed.push('Package JSON: `homepage` exists')
    } else {
      this.failed.push('Package JSON: `homepage` missing or does not start with `https://`')
    }
  }

  private validateBugsUrl(packageJSON: PackageJSON): void {
    if (packageJSON.bugs?.url) {
      const bugsUrl = packageJSON.bugs.url

      if (bugsUrl.startsWith('https://')) {
        this.passed.push('Package JSON: `bugs.url` exists and seems a valid URL')

        // Extract GitHub info from URL format: https://github.com/author/repo/... or https://www.github.com/author/repo/...
        const parts = bugsUrl.split('/')
        // parts[0] = 'https:', parts[1] = '', parts[2] = 'github.com' or 'www.github.com'
        // parts[3] = author, parts[4] = repo
        if (parts.length >= 5 && (parts[2] === 'github.com' || parts[2] === 'www.github.com')) {
          this.gitHubAuthor = parts[3] || ''
          this.gitHubRepo = parts[4] || ''
        } else {
          this.gitHubAuthor = ''
          this.gitHubRepo = ''
        }
        this.packageVersion = packageJSON.version || ''
      } else {
        this.failed.push('Package JSON: `bugs.url` exists but does not start with `https://`')
      }
    } else {
      this.failed.push('Package JSON: `bugs.url` missing')
    }
  }

  private validateKeywords(packageJSON: PackageJSON): void {
    if (Array.isArray(packageJSON.keywords)) {
      const keywords = packageJSON.keywords
      if (keywords.includes(CheckHomebridgePlugin.CONSTANTS.REQUIRED_KEYWORD)) {
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
  }

  private validateScripts(packageJSON: PackageJSON): void {
    if (typeof packageJSON.scripts === 'object' && packageJSON.scripts) {
      for (const script of CheckHomebridgePlugin.CONSTANTS.FORBIDDEN_SCRIPTS) {
        if (packageJSON.scripts[script]) {
          this.failed.push(`Package JSON: \`'${script}'\` in \`scripts\` is not allowed`)
        } else {
          this.passed.push(`Package JSON: \`'${script}'\` in \`scripts\` is not present`)
        }
      }
    }
  }

  private async validateEngineVersions(packageJSON: PackageJSON): Promise<void> {
    if (!packageJSON.engines) {
      this.failed.push('Package JSON: `engines` property missing')
      return
    }

    await this.validateNodeVersion(packageJSON.engines.node)
    await this.validateHomebridgeVersion(packageJSON.engines.homebridge)
  }

  private async validateNodeVersion(nodeVersion?: string): Promise<void> {
    if (!nodeVersion) {
      return
    }

    try {
      const { body } = await request(CheckHomebridgePlugin.CONSTANTS.URLS.NODE_DIST, {
        headers: {
          'User-Agent': CheckHomebridgePlugin.CONSTANTS.HEADERS.USER_AGENT,
        },
      })
      const versionList = await body.json() as NodeVersion[]

      const latest20 = versionList.find(x => x.version.startsWith('v20'))?.version
      const latest22 = versionList.find(x => x.version.startsWith('v22'))?.version
      const latest24 = versionList.find(x => x.version.startsWith('v24'))?.version

      if (latest20 && satisfies(latest20, nodeVersion)) {
        this.passed.push('Package JSON: `engines.node` property is compatible with Node 20')
      } else {
        this.failed.push('Package JSON: `engines.node` property is not compatible with Node 20')
      }

      if (latest22 && satisfies(latest22, nodeVersion)) {
        this.passed.push('Package JSON: `engines.node` property is compatible with Node 22')
      } else {
        this.failed.push('Package JSON: `engines.node` property is not compatible with Node 22')
      }

      if (latest24 && satisfies(latest24, nodeVersion)) {
        this.passed.push('Package JSON: `engines.node` property is compatible with Node 24')
      } else {
        this.failed.push('Package JSON: `engines.node` property is not compatible with Node 24')
      }
    } catch (e) {
      this.failed.push(`Package JSON: failed to check Node compatibility as ${this.handleError(e)}`)
    }
  }

  private async validateHomebridgeVersion(homebridgeVersion?: string): Promise<void> {
    if (!homebridgeVersion) {
      this.failed.push('Package JSON: `engines.homebridge` property missing')
      return
    }

    try {
      const { body } = await request(`${CheckHomebridgePlugin.CONSTANTS.URLS.NPM_REGISTRY}/homebridge`, {
        headers: {
          accept: CheckHomebridgePlugin.CONSTANTS.HEADERS.NPM_ACCEPT,
        },
      })

      const bodyJson = await body.json() as NPMPackageInfo
      const latestVersion = bodyJson['dist-tags'].latest

      if (satisfies(latestVersion, homebridgeVersion)) {
        this.passed.push(`Package JSON: \`engines.homebridge\` property is compatible with Homebridge ${latestVersion}`)
      } else {
        this.failed.push(`Package JSON: \`engines.homebridge\` property is not compatible with Homebridge ${latestVersion}`)
      }
    } catch (e) {
      this.failed.push(`Package JSON: failed to check Homebridge compatibility as ${this.handleError(e)}`)
    }
  }

  private async validatePluginInitializer(packageJSON: PackageJSON): Promise<void> {
    try {
      const mainPath = this.resolveMainModule(packageJSON)
      const pluginModules = await this.loadPluginModule(mainPath, packageJSON.type === 'module')

      if (typeof pluginModules === 'function' || (pluginModules && typeof pluginModules.default === 'function')) {
        this.passed.push('Package JSON: initializer function found')
      } else {
        this.failed.push('Package JSON: no initializer function found')
      }
    } catch (e) {
      this.failed.push(`Package JSON: failed to import plugin as ${this.handleError(e)}`)
    }
  }

  private resolveMainModule(packageJSON: PackageJSON): string {
    let main = ''

    // Handle exports field
    if (packageJSON.exports) {
      if (typeof packageJSON.exports === 'string') {
        main = packageJSON.exports
      } else {
        const exports = packageJSON.exports.import
          || packageJSON.exports.require
          || packageJSON.exports.node
          || packageJSON.exports.default
          || packageJSON.exports['.']

        if (typeof exports !== 'string') {
          main = exports?.import || exports?.require || exports?.node || exports?.default
        } else {
          main = exports
        }
      }
    }

    // Fallback to main field or default
    if (!main) {
      main = packageJSON.main || './index.js'
    }

    return join(this.testPath, 'node_modules', this.packageName, main)
  }

  private async loadPluginModule(mainPath: string, isESM?: boolean): Promise<any> {
    const shouldUseESM = mainPath.endsWith('.mjs') || (mainPath.endsWith('.js') && isESM)

    if (shouldUseESM) {
      return await _importDynamic(pathToFileURL(mainPath).href)
    } else {
      return require(mainPath)
    }
  }

  private async testGitHubRepo(): Promise<void> {
    try {
      const repoUrl = `${CheckHomebridgePlugin.CONSTANTS.URLS.GITHUB_API}/repos/${this.gitHubAuthor}/${this.gitHubRepo}`
      const { body } = await request(repoUrl, {
        headers: {
          'User-Agent': CheckHomebridgePlugin.CONSTANTS.HEADERS.USER_AGENT,
          'Accept': CheckHomebridgePlugin.CONSTANTS.HEADERS.GITHUB_ACCEPT,
        },
      })
      const repoData = await body.json() as GitHubRepo

      this.validateRepoStatus(repoData)
      await this.validateRepoReleases()
    } catch (e) {
      console.error(e)
      this.failed.push(`GitHub Repo: could not request information as ${this.handleError(e)}`)
    }
  }

  private validateRepoStatus(repoData: GitHubRepo): void {
    // Check visibility
    if (repoData.private) {
      this.failed.push('GitHub Repo: should not be private')
    } else {
      this.passed.push('GitHub Repo: repository is public')
    }

    // Check archived status
    if (repoData.archived) {
      this.failed.push('GitHub Repo: should not be archived')
    } else {
      this.passed.push('GitHub Repo: repository is not archived')
    }

    // Check issues enabled
    if (repoData.has_issues) {
      this.passed.push('GitHub Repo: issues are enabled')
    } else {
      this.failed.push('GitHub Repo: should have issues enabled')
    }
  }

  private async validateRepoReleases(): Promise<void> {
    try {
      const releasesUrl = `${CheckHomebridgePlugin.CONSTANTS.URLS.GITHUB_API}/repos/${this.gitHubAuthor}/${this.gitHubRepo}/releases`
      const { body } = await request(releasesUrl, {
        headers: {
          'User-Agent': CheckHomebridgePlugin.CONSTANTS.HEADERS.USER_AGENT,
          'Accept': CheckHomebridgePlugin.CONSTANTS.HEADERS.GITHUB_ACCEPT,
        },
      })
      const releaseData = await body.json() as any[]

      if (releaseData.length > 0) {
        this.passed.push('GitHub Repo: contains releases')
      } else {
        this.failed.push('GitHub Repo: should contain releases')
      }
    } catch (e) {
      this.failed.push(`GitHub Repo: could not check releases as ${this.handleError(e)}`)
    }
  }

  private async validateGitHubPackageJsonVersion(): Promise<void> {
    try {
      const packageJsonUrl = `${CheckHomebridgePlugin.CONSTANTS.URLS.GITHUB_API}/repos/${this.gitHubAuthor}/${this.gitHubRepo}/contents/package.json`
      const { body } = await request(packageJsonUrl, {
        headers: {
          'User-Agent': CheckHomebridgePlugin.CONSTANTS.HEADERS.USER_AGENT,
          'Accept': CheckHomebridgePlugin.CONSTANTS.HEADERS.GITHUB_ACCEPT,
        },
      })
      const packageJsonData = await body.json() as any

      if (packageJsonData.message && packageJsonData.message.includes('Not Found')) {
        this.failed.push('GitHub Repo: package.json file not found')
        return
      }

      // Check if content exists
      if (!packageJsonData.content) {
        this.failed.push('GitHub Repo: could not retrieve package.json content from GitHub API')
        return
      }

      // Decode the base64 content
      const packageJsonContent = Buffer.from(packageJsonData.content, 'base64').toString()
      const gitHubPackageJson = JSON.parse(packageJsonContent) as PackageJSON

      if (!gitHubPackageJson.version) {
        this.failed.push('GitHub Repo: package.json does not contain a version property')
        return
      }

      // Get NPM latest version from our already fetched data
      const npmVersion = this.npmLatestVersion
      const githubVersion = gitHubPackageJson.version

      if (!npmVersion) {
        this.failed.push('GitHub Repo: NPM version not available for comparison')
        return
      }

      if (npmVersion === githubVersion) {
        this.passed.push(`GitHub Repo: version in package.json (v${githubVersion}) matches NPM version (v${npmVersion})`)
      } else {
        this.failed.push(`GitHub Repo: version mismatch - NPM has v${npmVersion} but GitHub package.json has v${githubVersion}`)
      }
    } catch (e) {
      this.failed.push(`GitHub Repo: could not check package.json version as ${this.handleError(e)}`)
    }
  }

  private async testNpmPackage(): Promise<void> {
    try {
      const npmUrl = `${CheckHomebridgePlugin.CONSTANTS.URLS.NPM_REGISTRY}/${encodeURIComponent(this.packageName).replace(/%40/g, '@')}`
      const { body } = await request(npmUrl, {
        headers: {
          accept: CheckHomebridgePlugin.CONSTANTS.HEADERS.NPM_ACCEPT,
        },
      })

      const bodyJson = await body.json() as NPMPackageInfo
      const latestVersion = bodyJson['dist-tags'].latest
      this.npmLatestVersion = latestVersion
      const deprecatedMessage = bodyJson.versions[latestVersion]?.deprecated

      if (deprecatedMessage) {
        this.failed.push('NPM Package: has been deprecated')
      } else {
        this.passed.push('NPM Package: has not been deprecated')
      }
    } catch (e) {
      this.failed.push(`NPM Package: could not request information as ${this.handleError(e)}`)
    }
  }

  private async testGitHubVersionSync(): Promise<void> {
    // Only run this test if we have GitHub repo information
    if (!this.gitHubRepo || !this.gitHubAuthor) {
      console.log('Skipped Testing GitHub Version Sync')
      return
    }

    // Skip version sync test if NPM version is not available (package might not be published yet)
    if (!this.npmLatestVersion) {
      this.passed.push('GitHub Repo: version sync check skipped (package not yet published to NPM)')
      console.log('Skipped GitHub version sync - package not published to NPM')
      return
    }

    await this.validateGitHubPackageJsonVersion()
  }

  private async testConfigSchema(): Promise<void> {
    const schemaPath = join(this.testPath, 'node_modules', this.packageName, 'config.schema.json')

    if (!await fs.pathExists(schemaPath)) {
      this.failed.push('Config Schema JSON: missing file')
      return
    }

    try {
      const configSchema = await fs.readJson(schemaPath) as ConfigSchema
      this.configSchema = configSchema // Store for runtime testing
      this.passed.push('Config Schema JSON: exists and is valid JSON')

      // Validate that it's a proper JSON Schema
      this.validateJsonSchema(configSchema)

      this.validateConfigSchema(configSchema)
    } catch (e) {
      this.failed.push('Config Schema JSON: does not contain valid JSON')
    }
  }

  private validateJsonSchema(configSchema: any): void {
    // Use require to load AJV since it has complex exports
    const Ajv = require('ajv')

    // Initialize AJV with draft-07 support (commonly used for config.schema.json)
    const ajv = new Ajv({ strict: false, allErrors: true })

    // Check if it has a schema property which should be a valid JSON Schema
    if (!configSchema.schema || typeof configSchema.schema !== 'object') {
      this.failed.push('Config Schema JSON: missing or invalid `schema` property')
      return
    }

    // Basic JSON Schema validation - check for common schema properties
    const schema = configSchema.schema

    // Check for common mistake: using 'required' as a boolean property on fields
    const hasRequiredBooleanError = this.checkForRequiredBooleanMistake(schema)

    // Validate it's a valid JSON Schema by compiling it
    try {
      ajv.compile(schema)
      this.passed.push('Config Schema JSON: contains valid JSON Schema')
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)

      // Check if this is the common 'required must be array' error pattern
      if (error.includes('required must be array') && hasRequiredBooleanError) {
        this.failed.push(
          'Config Schema JSON: schema is invalid - `required` should not be a boolean property on individual fields. '
          + 'In JSON Schema, `required` must be an array at the object level listing required property names. '
          + 'Remove `"required": true/false` from individual properties and use `"required": ["property1", "property2"]` at the object level instead.',
        )
        return
      }

      // Check for 'items must be array' or 'items must match' errors which often mean invalid properties on array schemas
      if (error.includes('items must be array') || error.includes('items must match a schema')) {
        this.failed.push(
          'Config Schema JSON: schema is invalid - array schemas have invalid properties. '
          + 'Arrays in JSON Schema should only have `type`, `items`, `minItems`, `maxItems`, etc. '
          + 'Remove invalid properties like `"required": true/false` from array definitions. '
          + 'The `items` property should define the schema for array elements, not be set to a boolean.',
        )
        return
      }

      // Split AJV validation errors by comma for better formatting
      const errorParts = error.split(', ').map(part => part.trim()).filter(part => part)

      // Filter out repetitive 'required must be array' errors if there are many
      const requiredErrors = errorParts.filter(part => part.includes('required must be array'))
      const otherErrors = errorParts.filter(part => !part.includes('required must be array'))

      if (requiredErrors.length > 3) {
        // Consolidate repetitive required errors
        const consolidatedErrors = [
          ...otherErrors,
          `${requiredErrors.length} instances of: required must be array (should not use 'required' as a boolean property on fields)`,
        ]

        if (consolidatedErrors.length > 1) {
          this.failed.push(`Config Schema JSON: schema is invalid:\n  - ${consolidatedErrors.join('\n  - ')}`)
        } else {
          this.failed.push(`Config Schema JSON: ${consolidatedErrors[0]}`)
        }
      } else if (errorParts.length > 1) {
        // Format as a main error with sub-bullets for each validation issue
        this.failed.push(`Config Schema JSON: schema is invalid:\n  - ${errorParts.join('\n  - ')}`)
      } else {
        // Single error, keep it simple
        this.failed.push(`Config Schema JSON: ${error}`)
      }
    }

    // Check for common JSON Schema properties that should be present
    if (schema.type && typeof schema.type === 'string') {
      this.passed.push('Config Schema JSON: schema has valid `type` property')
    } else if (!schema.oneOf && !schema.anyOf && !schema.allOf) {
      // Only require 'type' if it's not using combinators
      this.failed.push('Config Schema JSON: schema missing `type` property')
    }

    // Validate properties if it's an object schema
    if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
      this.passed.push('Config Schema JSON: schema has valid `properties` for object type')
    } else if (schema.type === 'object' && !schema.properties) {
      this.failed.push('Config Schema JSON: object schema missing `properties`')
    }
  }

  private checkForRequiredBooleanMistake(schema: any, path = ''): boolean {
    if (!schema || typeof schema !== 'object') {
      return false
    }

    // Check if this level has a 'required' property that's a boolean
    if ('required' in schema && typeof schema.required === 'boolean') {
      return true
    }

    // Recursively check properties
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [key, value] of Object.entries(schema.properties)) {
        if (this.checkForRequiredBooleanMistake(value, `${path}.properties.${key}`)) {
          return true
        }
      }
    }

    // Check items for arrays
    if (schema.items) {
      if (Array.isArray(schema.items)) {
        for (let i = 0; i < schema.items.length; i++) {
          if (this.checkForRequiredBooleanMistake(schema.items[i], `${path}.items[${i}]`)) {
            return true
          }
        }
      } else if (this.checkForRequiredBooleanMistake(schema.items, `${path}.items`)) {
        return true
      }
    }

    // Check combinators
    for (const combinator of ['oneOf', 'anyOf', 'allOf']) {
      if (schema[combinator] && Array.isArray(schema[combinator])) {
        for (let i = 0; i < schema[combinator].length; i++) {
          if (this.checkForRequiredBooleanMistake(schema[combinator][i], `${path}.${combinator}[${i}]`)) {
            return true
          }
        }
      }
    }

    return false
  }

  private validateConfigSchema(configSchema: ConfigSchema): void {
    // Validate pluginAlias
    if (typeof configSchema.pluginAlias === 'string') {
      this.passed.push('Config Schema JSON: contains a valid `pluginAlias`')
    } else {
      this.failed.push('Config Schema JSON: does not contain a valid `pluginAlias`')
    }

    // Validate pluginType
    if (configSchema.pluginType === CheckHomebridgePlugin.CONSTANTS.REQUIRED_PLUGIN_TYPE) {
      this.passed.push('Config Schema JSON: the `pluginType` is set to `\'platform\'`')
    } else {
      this.failed.push('Config Schema JSON: the `pluginType` is not set to `\'platform\'`')
    }

    // Validate name schema property
    if (configSchema.schema?.properties?.name && Object.keys(configSchema.schema.properties.name).length > 0) {
      this.passed.push('Config Schema JSON: contains a `name` schema property')
    } else {
      this.failed.push('Config Schema JSON: does not contain a `name` schema property')
    }
  }

  private async testDependencies(): Promise<void> {
    for (const dep of CheckHomebridgePlugin.CONSTANTS.FORBIDDEN_DEPENDENCIES) {
      const depPath = join(this.testPath, 'node_modules', dep)

      if (await fs.pathExists(depPath)) {
        this.failed.push(`Dependencies: \`${dep}\` was installed as a dependency`)
      } else {
        this.passed.push(`Dependencies: \`${dep}\` was not installed as a dependency`)
      }
    }
  }

  private async testSecurityVulnerabilities(): Promise<void> {
    try {
      // Run npm audit to check for vulnerabilities
      const auditCommand = 'npm audit --json'
      const auditResult = require('node:child_process').execSync(auditCommand, {
        cwd: this.testPath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const audit = JSON.parse(auditResult)
      const vulnerabilities = audit.metadata?.vulnerabilities || {}

      const critical = vulnerabilities.critical || 0
      const high = vulnerabilities.high || 0
      const moderate = vulnerabilities.moderate || 0
      const low = vulnerabilities.low || 0

      // Only fail for critical vulnerabilities
      if (critical > 0) {
        this.failed.push(`Security: found ${critical} critical vulnerabilities in dependencies`)
      }

      // High-severity vulnerabilities go to manual review
      if (high > 0) {
        this.manualReview.push(`Security: found ${high} high-severity vulnerabilities in dependencies (manual review recommended)`)
      }

      // Report overall status
      if (critical === 0 && high === 0 && moderate === 0 && low === 0) {
        this.passed.push('Security: no known vulnerabilities in dependencies')
      } else if (critical === 0) {
        this.passed.push(`Security: no critical vulnerabilities (${high} high, ${moderate} moderate, ${low} low)`)
      }
    } catch (e) {
      // npm audit returns non-zero exit code when vulnerabilities are found
      // Try to parse the output anyway
      const errorStr = e.toString()
      if (errorStr.includes('npm audit')) {
        try {
          const output = e.stdout?.toString() || e.output?.toString() || ''
          if (output) {
            const audit = JSON.parse(output)
            const vulnerabilities = audit.metadata?.vulnerabilities || {}
            const critical = vulnerabilities.critical || 0
            const high = vulnerabilities.high || 0
            const moderate = vulnerabilities.moderate || 0
            const low = vulnerabilities.low || 0

            // Only fail for critical vulnerabilities
            if (critical > 0) {
              this.failed.push(`Security: found ${critical} critical vulnerabilities in dependencies`)
            }

            // High-severity vulnerabilities go to manual review
            if (high > 0) {
              this.manualReview.push(`Security: found ${high} high-severity vulnerabilities in dependencies (manual review recommended)`)
            }

            // Report overall status
            if (critical === 0) {
              this.passed.push(`Security: no critical vulnerabilities (${high} high, ${moderate} moderate, ${low} low)`)
            }
          }
        } catch {
          // If we can't parse, skip this test
          console.log('Could not parse npm audit output')
        }
      }
    }
  }

  private async testCodeSafety(): Promise<void> {
    const pluginPath = join(this.testPath, 'node_modules', this.packageName)

    // Patterns that could indicate security issues
    const dangerousPatterns = [
      { pattern: /\beval\s*\(/, message: 'uses eval() which can be a security risk', severity: 'high' },
      { pattern: /new\s+Function\s*\(/, message: 'uses Function constructor which can be a security risk', severity: 'high' },
      { pattern: /require\s*\([^'"][^)]*\)/, message: 'uses dynamic require() which could load arbitrary code', severity: 'medium' },
      { pattern: /child_process\.(?:exec|execSync)\s*\([^'"]/, message: 'uses exec with potentially unsafe input', severity: 'high' },
      { pattern: /\.createReadStream\s*\([^'"]/, message: 'reads files with dynamic paths', severity: 'low' },
      { pattern: /\.readFileSync?\s*\([^'"]/, message: 'reads files with dynamic paths', severity: 'low' },
    ]

    const suspiciousFilePatterns = [
      { pattern: /\.ssh[/\\]/, message: 'accesses SSH directory', severity: 'critical' },
      { pattern: /\.aws[/\\]/, message: 'accesses AWS credentials', severity: 'critical' },
      { pattern: /id_rsa/, message: 'accesses SSH keys', severity: 'critical' },
      { pattern: /private[_\-]?key/i, message: 'accesses private keys', severity: 'critical' },
      { pattern: /\.env/, message: 'accesses environment files', severity: 'high' },
      { pattern: /\/etc\/passwd/, message: 'accesses system files', severity: 'critical' },
    ]

    try {
      // Get all JS/TS files in the plugin
      const files = await this.getAllCodeFiles(pluginPath)
      const findings: { file: string, message: string, severity: string }[] = []

      for (const file of files) {
        try {
          const content = await fs.readFile(file, 'utf8')
          const relativePath = file.replace(`${pluginPath}/`, '')

          // Skip minified files and dependencies
          if (relativePath.includes('node_modules/') || relativePath.includes('.min.')) {
            continue
          }

          // Check for dangerous code patterns
          for (const { pattern, message, severity } of dangerousPatterns) {
            if (pattern.test(content)) {
              findings.push({ file: relativePath, message, severity: severity || 'medium' })
            }
          }

          // Check for suspicious file access
          for (const { pattern, message, severity } of suspiciousFilePatterns) {
            if (pattern.test(content)) {
              findings.push({ file: relativePath, message, severity: severity || 'high' })
            }
          }
        } catch {
          // Skip files we can't read
        }
      }

      // Group all findings by severity for manual review
      const criticalFindings = findings.filter(f => f.severity === 'critical')
      const highFindings = findings.filter(f => f.severity === 'high')
      const mediumFindings = findings.filter(f => f.severity === 'medium')

      // All findings go to manual review - nothing fails automatically

      // Add critical findings to manual review
      if (criticalFindings.length > 0) {
        const patterns = [...new Set(criticalFindings.map(f => f.message))]
        for (const pattern of patterns) {
          const files = criticalFindings.filter(f => f.message === pattern)
          const fileList = [...new Set(files.map(f => f.file))].slice(0, 2).join(', ')
          const moreFiles = files.length > 2 ? ` and ${files.length - 2} more` : ''
          this.manualReview.push(`Security [Critical]: ${pattern} in ${fileList}${moreFiles}`)
        }
      }

      // Add high severity findings to manual review
      if (highFindings.length > 0) {
        const patterns = [...new Set(highFindings.map(f => f.message))]
        for (const pattern of patterns) {
          const files = highFindings.filter(f => f.message === pattern)
          const fileList = [...new Set(files.map(f => f.file))].slice(0, 2).join(', ')
          const moreFiles = files.length > 2 ? ` and ${files.length - 2} more` : ''
          this.manualReview.push(`Security: ${pattern} in ${fileList}${moreFiles}`)
        }
      }

      // Add medium severity findings to manual review
      if (mediumFindings.length > 0) {
        const patterns = [...new Set(mediumFindings.map(f => f.message))]
        for (const pattern of patterns) {
          const files = mediumFindings.filter(f => f.message === pattern)
          const count = files.length
          this.manualReview.push(`Security: ${pattern} found in ${count} file${count > 1 ? 's' : ''}`)
        }
      }

      // Report overall status
      if (findings.length === 0) {
        this.passed.push('Security: no unsafe code patterns detected')
      } else {
        this.passed.push('Security: code patterns flagged for manual review')
      }
    } catch (e) {
      // Don't fail the whole test if we can't scan
      console.log('Could not scan for code safety:', this.handleError(e))
    }
  }

  private async testPermissions(): Promise<void> {
    try {
      const packageJsonPath = join(this.testPath, 'node_modules', this.packageName, 'package.json')
      const packageJson = await fs.readJson(packageJsonPath) as PackageJSON

      const issues: string[] = []

      // Check for suspicious scripts that might elevate privileges
      if (packageJson.scripts) {
        const suspiciousScripts = ['preinstall', 'install', 'postinstall', 'preuninstall', 'postuninstall']

        for (const scriptName of suspiciousScripts) {
          const script = packageJson.scripts[scriptName]
          if (script) {
            if (script.includes('sudo')) {
              issues.push(`${scriptName} script requires sudo`)
            }
            if (script.includes('chmod 777') || script.includes('chmod -R 777')) {
              issues.push(`${scriptName} script sets overly permissive file permissions`)
            }
            if (script.includes('curl') || script.includes('wget')) {
              if (script.includes('| sh') || script.includes('| bash')) {
                issues.push(`${scriptName} script downloads and executes remote code`)
              }
            }
          }
        }
      }

      // Move all permission issues to manual review instead of failing
      if (issues.length > 0) {
        this.manualReview.push(`Security: permission/privilege concerns detected - ${issues.join(', ')}`)
        this.passed.push('Security: permission checks flagged for manual review')
      } else {
        this.passed.push('Security: no privilege escalation attempts detected')
      }
    } catch (e) {
      console.log('Could not check permissions:', this.handleError(e))
    }
  }

  private async getAllCodeFiles(dir: string): Promise<string[]> {
    const files: string[] = []

    async function walk(currentDir: string) {
      try {
        const entries = await fs.readdir(currentDir, { withFileTypes: true })

        for (const entry of entries) {
          const fullPath = join(currentDir, entry.name)

          if (entry.isDirectory()) {
            // Skip certain directories
            if (!['node_modules', '.git', 'dist', 'coverage'].includes(entry.name)) {
              await walk(fullPath)
            }
          } else if (entry.isFile()) {
            // Include JS, TS, and JSON files
            if (/\.(?:js|ts|json)$/.test(entry.name) && !entry.name.includes('.min.')) {
              files.push(fullPath)
            }
          }
        }
      } catch {
        // Skip directories we can't read
      }
    }

    await walk(dir)
    return files
  }

  private async saveResults(): Promise<void> {
    const results: TestResults = {
      failed: this.failed,
      passed: this.passed,
      manualReview: this.manualReview,
      version: this.packageVersion,
      detailedFailures: this.detailedFailures,
      httpRequests: this.allHttpRequests,
    }

    try {
      await fs.writeJson(CheckHomebridgePlugin.CONSTANTS.RESULTS_PATH, results)
    } catch (e) {
      // If we can't write to the results path, output to console in debug mode
      if (process.env.DEBUG) {
        console.log('Could not write results file, showing results in console:')
        console.log(JSON.stringify(results, null, 2))
      }
    }
  }

  private displayResults(): void {
    console.log(`\n${'='.repeat(60)}`)

    if (this.failed.length > 0) {
      console.log('\n🔴 The following checks failed:\n')
      for (const failure of this.failed) {
        console.log(`- ${failure}`)
      }
    }

    if (this.passed.length > 0) {
      console.log('\n✅ The following checks passed:\n')
      for (const pass of this.passed) {
        console.log(`- ${pass}`)
      }
    }

    console.log(`\n${'='.repeat(60)}`)
  }

  private async testRuntimeBehavior(): Promise<void> {
    if (!this.configSchema) {
      this.failed.push('Runtime: config schema not available, skipping runtime tests')
      return
    }

    // First, ensure Homebridge is installed
    await this.installHomebridge()

    const scenarios = this.generateTestScenarios()

    for (const scenario of scenarios) {
      const result = await this.runHomebridgeTestScenario(scenario)

      // Collect HTTP requests from this scenario
      if (result && result.httpRequests) {
        this.allHttpRequests.push(...result.httpRequests)
      }

      // Check for suspicious file access
      if (result && result.suspiciousFileAccess && result.suspiciousFileAccess.length > 0) {
        const accessedPaths = result.suspiciousFileAccess.map(a => a.path || a.command).join(', ')
        this.failed.push(`Security: Runtime - suspicious file/command access detected in scenario "${scenario.name}": ${accessedPaths}`)
      }
    }

    // After all initial tests, run network failure test if HTTP requests were detected
    await this.runNetworkFailureTestIfNeeded()
  }

  private async runNetworkFailureTestIfNeeded(): Promise<void> {
    if (this.allHttpRequests.length === 0) {
      console.log('No HTTP requests detected in previous tests - skipping network failure test')
      return
    }

    // Only generate network failure test if we have a full config and detected HTTP activity
    const fullConfig = this.generateFullValidConfig()
    if (!fullConfig) {
      console.log('Cannot generate full config - skipping network failure test')
      return
    }

    console.log(`\nDetected ${this.allHttpRequests.length} HTTP requests in previous tests - running network resilience test`)

    const networkFailureScenario: RuntimeTestScenario = {
      name: 'network resilience',
      config: fullConfig,
      expectStartup: true,
      expectPluginToLoad: true,
      description: 'plugin should handle network failures without crashing',
      mockNetworkFailures: true,
    }

    const result = await this.runHomebridgeTestScenario(networkFailureScenario)

    // Collect HTTP requests from network failure test too (should be the failed attempts)
    if (result && result.httpRequests) {
      this.allHttpRequests.push(...result.httpRequests)
    }
  }

  private async installHomebridge(): Promise<void> {
    try {
      console.log('Installing Homebridge for runtime testing...')

      const installPromise = new Promise<void>((resolve, reject) => {
        const proc = spawn('npm', ['install', 'homebridge@latest'], {
          cwd: this.testPath,
          stdio: 'inherit',
        })

        proc.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error(`Homebridge installation failed with code ${code}`))
          }
        })
      })

      await installPromise
      this.passed.push('Runtime: homebridge installed successfully')
    } catch (e) {
      this.failed.push(`Runtime: failed to install homebridge - ${this.handleError(e)}`)
      throw e
    }
  }

  private generateTestScenarios(): RuntimeTestScenario[] {
    const scenarios: RuntimeTestScenario[] = []
    const seenConfigs = new Set<string>()

    // Helper function to add scenario if config is unique
    const addUniqueScenario = (scenario: RuntimeTestScenario) => {
      const configKey = JSON.stringify(scenario.config, Object.keys(scenario.config || {}).sort())
      if (!seenConfigs.has(configKey)) {
        seenConfigs.add(configKey)
        scenarios.push(scenario)
      }
    }

    // Test 1: No plugin configuration (Homebridge should start but plugin shouldn't load)
    addUniqueScenario({
      name: 'no config',
      config: undefined,
      expectStartup: true, // Homebridge should start, just without the plugin
      expectPluginToLoad: false, // Plugin should NOT be loaded
      description: 'homebridge should start without plugin configuration and plugin should not load',
    })

    // Test 2: Minimal config with just platform property
    if (this.configSchema?.pluginAlias) {
      addUniqueScenario({
        name: 'platform only',
        config: {
          platform: this.configSchema.pluginAlias,
        },
        expectStartup: true,
        expectPluginToLoad: true,
        description: 'plugin should start with just platform property',
      })
    }

    // Test 3: Minimal required configuration
    const minimalConfig = this.generateMinimalRequiredConfig()
    if (minimalConfig) {
      addUniqueScenario({
        name: 'minimal required',
        config: minimalConfig,
        expectStartup: true,
        expectPluginToLoad: true,
        description: 'plugin should start with minimal required configuration',
      })
    }

    // Test 4: Full valid configuration
    const fullConfig = this.generateFullValidConfig()
    if (fullConfig) {
      addUniqueScenario({
        name: 'full config',
        config: fullConfig,
        expectStartup: true,
        expectPluginToLoad: true,
        description: 'plugin should start with comprehensive configuration',
      })
    }

    // Test 5: network resilience test is now run conditionally
    // after detecting HTTP requests in previous tests

    return scenarios
  }

  private generateMinimalRequiredConfig(): any | null {
    if (!this.configSchema?.schema?.properties || !this.configSchema.pluginAlias) {
      return null
    }

    const config: any = {
      platform: this.configSchema.pluginAlias,
    }

    // Add required properties with default values
    const schema = this.configSchema.schema
    const properties = schema.properties || {}

    // Handle both formats: schema.required array and individual property.required=true
    const requiredFromArray = schema.required || []
    const requiredFromProperties: string[] = []

    // Find properties marked with required: true
    for (const [propName, propSchema] of Object.entries(properties)) {
      if (typeof propSchema === 'object' && propSchema && (propSchema as any).required === true) {
        requiredFromProperties.push(propName)
      }
    }

    // Combine both sources of required properties
    const allRequired = [...new Set([...requiredFromArray, ...requiredFromProperties])]

    for (const prop of allRequired) {
      if (prop === 'platform') {
        continue
      } // Already added

      const propSchema = properties[prop]
      if (propSchema) {
        config[prop] = this.getDefaultValueForProperty(propSchema)
      }
    }

    return config
  }

  private getDefaultValueForProperty(propSchema: any): any {
    if (propSchema.default !== undefined) {
      return propSchema.default
    }

    // Handle oneOf (similar to enum) for minimal required config too
    if (propSchema.oneOf && Array.isArray(propSchema.oneOf) && propSchema.oneOf.length > 0) {
      const firstOption = propSchema.oneOf[0]
      if (firstOption.enum && Array.isArray(firstOption.enum) && firstOption.enum.length > 0) {
        return firstOption.enum[0]
      }
      if (firstOption.const !== undefined) {
        return firstOption.const
      }
    }

    switch (propSchema.type) {
      case 'string':
        return propSchema.enum ? propSchema.enum[0] : 'testvalue'
      case 'number':
      case 'integer':
        return propSchema.minimum || 1
      case 'boolean':
        return false
      case 'array':
        return []
      case 'object':
        return {}
      default:
        return null
    }
  }

  private generateFullValidConfig(): any | null {
    if (!this.configSchema?.schema?.properties || !this.configSchema.pluginAlias) {
      return null
    }

    const config: any = {
      platform: this.configSchema.pluginAlias,
    }

    const schema = this.configSchema.schema
    const properties = schema.properties || {}

    // Add ALL properties from schema (not just required ones)
    for (const [propName, propSchema] of Object.entries(properties)) {
      if (propName === 'platform') {
        continue
      } // Already added

      config[propName] = this.getFullValueForProperty(propSchema as any, propName)
    }

    return config
  }

  private getFullValueForProperty(propSchema: any, propName: string): any {
    // Use explicit defaults first
    if (propSchema.default !== undefined) {
      return propSchema.default
    }

    // Use examples if available
    if (propSchema.examples && Array.isArray(propSchema.examples) && propSchema.examples.length > 0) {
      return propSchema.examples[0]
    }

    // Handle oneOf (similar to enum)
    if (propSchema.oneOf && Array.isArray(propSchema.oneOf) && propSchema.oneOf.length > 0) {
      const firstOption = propSchema.oneOf[0]
      if (firstOption.enum && Array.isArray(firstOption.enum) && firstOption.enum.length > 0) {
        return firstOption.enum[0]
      }
      if (firstOption.const !== undefined) {
        return firstOption.const
      }
    }

    // Generate realistic values based on property name and type
    switch (propSchema.type) {
      case 'string': {
        if (propSchema.enum) {
          return propSchema.enum[0]
        }

        // Generate value respecting length constraints
        let baseValue = this.getBaseValueForPropertyName(propName)

        // Adjust for length constraints
        if (propSchema.minLength || propSchema.maxLength) {
          const minLen = propSchema.minLength || 1
          const maxLen = propSchema.maxLength || 1000

          if (baseValue.length < minLen) {
            // Pad the value to meet minimum length
            baseValue = baseValue.padEnd(minLen, '0123456789abcdef')
          } else if (baseValue.length > maxLen) {
            // Truncate to maximum length
            baseValue = baseValue.substring(0, maxLen)
          }
        }

        return baseValue
      }

      case 'number':
      case 'integer':
        if (propName.toLowerCase().includes('port')) {
          return 8080
        }
        if (propName.toLowerCase().includes('timeout')) {
          return 30
        }
        if (propName.toLowerCase().includes('interval') || propName.toLowerCase().includes('poll')) {
          return 60
        }
        if (propName.toLowerCase().includes('temperature')) {
          return 22
        }
        return propSchema.minimum || propSchema.maximum || 1

      case 'boolean':
        // Default to false for debug/verbose options, true for enabled features
        if (propName.toLowerCase().includes('debug') || propName.toLowerCase().includes('verbose')) {
          return false
        }
        return propName.toLowerCase().includes('enable') || propName.toLowerCase().includes('active')

      case 'array':
        // Generate a sample array with one item
        if (propSchema.items) {
          const sampleItem = this.getFullValueForProperty(propSchema.items, 'item')
          return [sampleItem]
        }
        return []

      case 'object':
        // Generate a sample object based on properties
        if (propSchema.properties) {
          const obj: any = {}
          for (const [subPropName, subPropSchema] of Object.entries(propSchema.properties)) {
            obj[subPropName] = this.getFullValueForProperty(subPropSchema as any, subPropName)
          }
          return obj
        }
        return {}

      default:
        return null
    }
  }

  private getBaseValueForPropertyName(propName: string): string {
    // Generate realistic values based on common property names
    if (propName.toLowerCase().includes('username') || propName.toLowerCase().includes('user')) {
      return 'testuser@example.com'
    }
    if (propName.toLowerCase().includes('password') || propName.toLowerCase().includes('pass')) {
      return 'testpassword'
    }
    if (propName.toLowerCase().includes('host') || propName.toLowerCase().includes('server')) {
      return '192.168.1.100'
    }
    if (propName.toLowerCase().includes('email')) {
      return 'test@example.com'
    }
    if (propName.toLowerCase().includes('url') || propName.toLowerCase().includes('endpoint')) {
      return 'https://api.example.com'
    }
    if (propName.toLowerCase().includes('token') || propName.toLowerCase().includes('key')) {
      return 'test-api-key-12345'
    }
    return 'test-value'
  }

  private async runHomebridgeTestScenario(scenario: RuntimeTestScenario): Promise<TestResult | null> {
    console.log(`\nTesting scenario: ${scenario.name}`)
    if (scenario.config) {
      console.log('Plugin configuration:')
      console.log(JSON.stringify(scenario.config, null, 2))
    } else {
      console.log('Plugin configuration: (none - testing Homebridge without plugin)')
    }

    try {
      const result = await this.runRealHomebridgeTest(scenario)

      // Check both startup and plugin loading expectations
      const startupOk = scenario.expectStartup ? result.success : !result.success
      const pluginLoadingOk = scenario.expectPluginToLoad === undefined
        || (scenario.expectPluginToLoad === result.pluginLoaded)

      if (startupOk && pluginLoadingOk) {
        this.passed.push(`Runtime: ${scenario.name} - ${scenario.description}`)
        console.log(`${scenario.name}: PASSED`)
      } else if (scenario.expectStartup && !result.success) {
        const failureMessage = `Runtime: ${scenario.name} - expected startup but failed - ${result.error}`
        this.failed.push(failureMessage)

        // Add detailed failure information
        this.detailedFailures.push({
          message: failureMessage,
          config: scenario.config,
          scenario: scenario.name,
          isRuntimeFailure: true,
          isNetworkResilienceTest: scenario.mockNetworkFailures === true,
        })

        console.log(`${scenario.name}: FAILED - ${result.error}`)
      } else if (!pluginLoadingOk) {
        // Plugin loading expectation not met
        const expectedText = scenario.expectPluginToLoad ? 'should load' : 'should not load'
        const actualText = result.pluginLoaded ? 'did load' : 'did not load'
        const failureMessage = `Runtime: ${scenario.name} - plugin ${expectedText} but ${actualText}`
        this.failed.push(failureMessage)
        console.log(`${scenario.name}: FAILED - Plugin ${expectedText} but ${actualText}`)
      } else {
        this.failed.push(`Runtime: ${scenario.name} - expected failure but Homebridge started`)
        console.log(`${scenario.name}: FAILED - Expected failure but Homebridge started`)
      }

      return result
    } catch (e) {
      this.failed.push(`Runtime: ${scenario.name} - test execution failed - ${this.handleError(e)}`)
      console.log(`${scenario.name}: ERROR - ${this.handleError(e)}`)
      return null
    }
  }

  private async runRealHomebridgeTest(scenario: RuntimeTestScenario): Promise<TestResult> {
    const testId = Date.now()
    const port = CheckHomebridgePlugin.CONSTANTS.HOMEBRIDGE_PORT_BASE + (testId % 1000)
    const storagePath = join(this.testPath, `homebridge-test-${testId}`)

    try {
      // Create storage directory
      await fs.mkdirp(storagePath)

      // Generate Homebridge config
      const config = this.generateHomebridgeConfig(scenario, port)
      await fs.writeJson(join(storagePath, 'config.json'), config, { spaces: 2 })

      // Run Homebridge test
      const result = await this.startHomebridgeProcess(storagePath, scenario)

      // Cleanup
      await fs.remove(storagePath)

      return result
    } catch (e) {
      // Cleanup on error
      if (await fs.pathExists(storagePath)) {
        await fs.remove(storagePath)
      }

      return {
        success: false,
        error: this.handleError(e),
        logs: [],
        duration: 0,
        pluginLoaded: false,
      }
    }
  }

  private generateHomebridgeConfig(scenario: RuntimeTestScenario, port: number): HomebridgeConfig {
    const config: HomebridgeConfig = {
      bridge: {
        name: 'Test Bridge',
        username: 'CC:22:3D:E3:CE:30',
        port,
        pin: '031-45-154',
      },
      accessories: [],
      platforms: [],
    }

    // Add plugin configuration if provided
    if (scenario.config) {
      config.platforms.push(scenario.config)
    }

    return config
  }

  private async startHomebridgeProcess(storagePath: string, scenario: RuntimeTestScenario): Promise<TestResult> {
    const startTime = Date.now()
    const logs: string[] = []
    let homebridgeProcess: ChildProcess | null = null

    return new Promise((resolve) => {
      try {
        // Create HTTP monitoring script
        const monitorScript = this.createHttpMonitoringScript()
        const scriptPath = join(storagePath, 'http-monitor.js')
        require('node:fs').writeFileSync(scriptPath, monitorScript)

        // Start Homebridge process with HTTP monitoring
        homebridgeProcess = spawn('node', ['-r', scriptPath, 'node_modules/.bin/homebridge', '-U', storagePath], {
          cwd: this.testPath,
          stdio: 'pipe',
          env: {
            ...process.env,
            HTTP_MONITOR_SCENARIO: scenario.name,
            HTTP_MONITOR_LOG: join(storagePath, 'http-requests.json'),
            MOCK_NETWORK_FAILURES: scenario.mockNetworkFailures ? 'true' : 'false',
          },
        })

        let resolved = false
        let success = false
        let errorMessage = ''
        let pluginLoaded = false

        // Timeout for the entire test
        const testTimeout = setTimeout(() => {
          if (!resolved) {
            resolved = true
            if (homebridgeProcess) {
              homebridgeProcess.kill('SIGTERM')
            }
            resolve({
              success: false,
              error: 'Test timed out',
              logs,
              duration: Date.now() - startTime,
              httpRequests: [],
              pluginLoaded,
            })
          }
        }, CheckHomebridgePlugin.CONSTANTS.RUNTIME_TEST_TIMEOUT)

        // Track restart attempts and plugin failures
        let restartCount = 0
        let pluginFailure = false

        // Timeout for Homebridge startup
        const startupTimeout = setTimeout(() => {
          if (!resolved && success && !pluginFailure) {
            // Homebridge started successfully without plugin failures
            resolved = true
            clearTimeout(testTimeout)
            if (homebridgeProcess) {
              homebridgeProcess.kill('SIGTERM')
            }

            // Try to read HTTP requests log before resolving
            const httpLogPath = join(storagePath, 'http-requests.json')
            const fileLogPath = join(storagePath, 'http-requests-files.json')
            let capturedRequests: HttpRequest[] = []
            let suspiciousFileAccess: any[] = []
            try {
              if (require('node:fs').existsSync(httpLogPath)) {
                const httpLogContent = require('node:fs').readFileSync(httpLogPath, 'utf8')
                capturedRequests = JSON.parse(httpLogContent)
              }
            } catch (e) {
              // Ignore HTTP log read errors
            }

            try {
              if (require('node:fs').existsSync(fileLogPath)) {
                const fileLogContent = require('node:fs').readFileSync(fileLogPath, 'utf8')
                suspiciousFileAccess = JSON.parse(fileLogContent)
              }
            } catch (e) {
              // Ignore file log read errors
            }

            resolve({
              success: true,
              error: undefined,
              logs,
              duration: Date.now() - startTime,
              httpRequests: capturedRequests,
              pluginLoaded,
              suspiciousFileAccess,
            })
          } else if (!resolved && pluginFailure) {
            // Plugin failure detected
            resolved = true
            clearTimeout(testTimeout)
            if (homebridgeProcess) {
              homebridgeProcess.kill('SIGTERM')
            }
            resolve({
              success: false,
              error: errorMessage || 'Plugin failure detected',
              logs,
              duration: Date.now() - startTime,
              httpRequests: [],
              pluginLoaded,
            })
          }
        }, CheckHomebridgePlugin.CONSTANTS.HOMEBRIDGE_STARTUP_TIMEOUT)

        // Common function to handle Homebridge supervisor events
        const handleHomebridgeOutput = (output: string) => {
          // Look for successful startup indicators
          if (output.includes('Homebridge is running on port')
            || output.includes('Setup Payload:')
            || output.includes('Scan this code with your HomeKit app')) {
            success = true
          }

          // If using HB Supervisor, wait for full startup
          if (output.includes('[HB Supervisor] Started Homebridge')) {
            success = true
          }

          // Detect plugin loading/initialization (be more specific to avoid false positives)
          const pluginAlias = this.configSchema?.pluginAlias

          // Look for actual plugin initialization, not just discovery
          if (pluginAlias && output.includes(`Initializing ${pluginAlias} platform`)) {
            pluginLoaded = true
          }

          // Detect Homebridge crashes and restart loops
          if (output.includes('[HB Supervisor] Restarting Homebridge')) {
            restartCount += 1
            pluginFailure = true
            errorMessage = `Homebridge restart loop detected (restart ${restartCount})`
          }

          // Detect Homebridge process ending (indicates a crash when followed by restart)
          if (output.includes('[HB Supervisor] Homebridge process ended')) {
            const codeMatch = output.match(/Code: (\d+)/)
            if (codeMatch && codeMatch[1] !== '0' && codeMatch[1] !== '143') {
              pluginFailure = true
              errorMessage = `Homebridge crashed with exit code ${codeMatch[1]}`
            }
          }
        }

        // Handle stdout
        homebridgeProcess.stdout?.on('data', (data: Buffer) => {
          const output = data.toString()
          logs.push(`STDOUT: ${output}`)
          handleHomebridgeOutput(output)
        })

        // Handle stderr
        homebridgeProcess.stderr?.on('data', (data: Buffer) => {
          const output = data.toString()
          logs.push(`STDERR: ${output}`)
          handleHomebridgeOutput(output)

          // Look for critical errors that should fail the test
          if (output.includes('TypeError:')
            || output.includes('ReferenceError:')
            || output.includes('Cannot find module')
            || output.includes('SIGKILL')
            || output.includes('SIGTERM')) {
            errorMessage = output.trim()
          }
        })

        // Handle process exit
        homebridgeProcess.on('close', (code: number) => {
          clearTimeout(testTimeout)
          clearTimeout(startupTimeout)

          if (!resolved) {
            resolved = true

            // Try to read HTTP requests log
            const httpLogPath = join(storagePath, 'http-requests.json')
            const fileLogPath = join(storagePath, 'http-requests-files.json')
            let capturedRequests: HttpRequest[] = []
            let suspiciousFileAccess: any[] = []
            try {
              if (require('node:fs').existsSync(httpLogPath)) {
                const httpLogContent = require('node:fs').readFileSync(httpLogPath, 'utf8')
                capturedRequests = JSON.parse(httpLogContent)
              }
            } catch (e) {
              // Ignore HTTP log read errors
            }

            try {
              if (require('node:fs').existsSync(fileLogPath)) {
                const fileLogContent = require('node:fs').readFileSync(fileLogPath, 'utf8')
                suspiciousFileAccess = JSON.parse(fileLogContent)
              }
            } catch (e) {
              // Ignore file log read errors
            }

            // Check for any errors in the logs that suggest plugin failure
            const hasPluginError = logs.some(log =>
              log.includes('Error:')
              && !log.includes('AssertionError [ERR_ASSERTION]: Cannot generate setupURI'),
            )

            if ((code === 0 || success) && !pluginFailure && !hasPluginError) {
              resolve({
                success: true,
                error: undefined,
                logs,
                duration: Date.now() - startTime,
                httpRequests: capturedRequests,
                pluginLoaded,
                suspiciousFileAccess,
              })
            } else {
              const failureReason = pluginFailure
                ? 'Plugin restart loop detected'
                : hasPluginError
                  ? 'Plugin initialization error detected'
                  : `Homebridge exited with code ${code}`

              resolve({
                success: false,
                error: errorMessage || failureReason,
                logs,
                duration: Date.now() - startTime,
                httpRequests: capturedRequests,
                pluginLoaded,
                suspiciousFileAccess,
              })
            }
          }
        })

        homebridgeProcess.on('error', (error: Error) => {
          clearTimeout(testTimeout)
          clearTimeout(startupTimeout)

          if (!resolved) {
            resolved = true
            resolve({
              success: false,
              error: error.message,
              logs,
              duration: Date.now() - startTime,
              pluginLoaded: false,
            })
          }
        })
      } catch (e) {
        resolve({
          success: false,
          error: this.handleError(e),
          logs,
          duration: Date.now() - startTime,
          pluginLoaded: false,
        })
      }
    })
  }

  private createHttpMonitoringScript(): string {
    return `
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const originalHttpRequest = http.request;
const originalHttpsRequest = https.request;
const requests = [];
const logFile = process.env.HTTP_MONITOR_LOG;
const mockNetworkFailures = process.env.MOCK_NETWORK_FAILURES === 'true';

function captureRequest(module, originalRequest) {
  return function(...args) {
    let url, options = {};
    
    // Parse arguments (url can be string, URL object, or options object)
    if (typeof args[0] === 'string') {
      url = args[0];
      if (args[1] && typeof args[1] === 'object') {
        options = args[1];
      }
    } else if (args[0] && typeof args[0] === 'object') {
      options = args[0];
      if (options.hostname || options.host) {
        const protocol = module === 'https' ? 'https:' : 'http:';
        const hostname = options.hostname || options.host;
        const port = options.port ? ':' + options.port : '';
        const path = options.path || '/';
        url = protocol + '//' + hostname + port + path;
      } else {
        url = options.href || 'unknown';
      }
    }

    if (url && !url.includes('localhost') && !url.includes('127.0.0.1')) {
      const request = {
        url: url,
        method: options.method || 'GET',
        timestamp: new Date().toISOString(),
        scenario: process.env.HTTP_MONITOR_SCENARIO || 'unknown'
      };
      
      requests.push(request);
      
      // Write to log file immediately
      try {
        fs.writeFileSync(logFile, JSON.stringify(requests, null, 2));
      } catch (e) {
        // Ignore write errors
      }
      
      // Mock network failures if enabled
      if (mockNetworkFailures) {
        console.log('[HTTP Monitor] Mocking network failure for:', url);
        const mockRequest = {
          on: function(event, callback) {
            if (event === 'error') {
              // Store error callback for later use
              this._errorCallback = callback;
            }
            return this;
          },
          write: function() { return this; },
          end: function() {
            // Simulate network failure after a short delay
            setTimeout(() => {
              const error = new Error('ENOTFOUND: Mock network failure - ' + url);
              error.code = 'ENOTFOUND';
              error.hostname = options.hostname || options.host;
              if (this._errorCallback) {
                this._errorCallback(error);
              }
            }, 100);
            return this;
          },
          setTimeout: function() { return this; },
          setHeader: function() { return this; },
          destroy: function() { return this; },
          abort: function() { return this; }
        };
        return mockRequest;
      }
    }

    return originalRequest.apply(this, args);
  };
}

// Override both HTTP and HTTPS request methods
http.request = captureRequest('http', originalHttpRequest);
https.request = captureRequest('https', originalHttpsRequest);

// Also capture using fetch if available (Node 18+)
if (typeof globalThis.fetch === 'function') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function(url, options = {}) {
    if (typeof url === 'string' && !url.includes('localhost') && !url.includes('127.0.0.1')) {
      const request = {
        url: url,
        method: options.method || 'GET',
        timestamp: new Date().toISOString(),
        scenario: process.env.HTTP_MONITOR_SCENARIO || 'unknown'
      };
      
      requests.push(request);
      
      try {
        fs.writeFileSync(logFile, JSON.stringify(requests, null, 2));
      } catch (e) {
        // Ignore write errors
      }
      
      // Mock global fetch network failure
      if (mockNetworkFailures) {
        console.log('[HTTP Monitor] Mocking global fetch network failure for:', url);
        return Promise.reject(new Error('ENOTFOUND: Mock global fetch network failure - ' + url));
      }
    }
    
    return originalFetch.apply(this, arguments);
  };
}

// Intercept popular HTTP libraries by hooking into require
const Module = require('module');
const originalRequire = Module.prototype.require;

Module.prototype.require = function(...args) {
  const moduleName = args[0];
  const exportedThing = originalRequire.apply(this, args);
  
  // Wrap popular HTTP libraries
  if (moduleName === 'axios') {
    return wrapAxios(exportedThing);
  }
  if (moduleName === 'node-fetch' || moduleName === 'isomorphic-fetch') {
    console.log('[HTTP Monitor] Intercepting ' + moduleName);
    return wrapFetch(exportedThing);
  }
  if (moduleName === 'request' || moduleName === 'request-promise') {
    console.log('[HTTP Monitor] Intercepting ' + moduleName);
    return wrapRequest(exportedThing);
  }
  if (moduleName === 'superagent') {
    console.log('[HTTP Monitor] Intercepting superagent');
    return wrapSuperagent(exportedThing);
  }
  if (moduleName === 'undici') {
    console.log('[HTTP Monitor] Intercepting undici');
    return wrapUndici(exportedThing);
  }
  if (moduleName === 'got') {
    console.log('[HTTP Monitor] Intercepting got');
    return wrapGot(exportedThing);
  }
  
  return exportedThing;
};

function wrapAxios(axios) {
  if (!axios || typeof axios !== 'function') return axios;
  
  // Create a wrapper function that preserves axios functionality
  const wrappedAxios = function(...args) {
    captureAxiosRequest('axios()', ...args);
    return axios.apply(this, args);
  };
  
  // Copy all static properties and methods from the main axios function
  Object.setPrototypeOf(wrappedAxios, axios);
  Object.keys(axios).forEach(key => {
    if (key === 'default') {
      // Special handling for the default property - wrap it too if it's a function
      if (typeof axios[key] === 'function') {
        const wrappedDefault = function(...args) {
          captureAxiosRequest('axios.default()', ...args);
          return axios.default.apply(axios.default, args);
        };
        
        // Copy all properties from the default function
        Object.setPrototypeOf(wrappedDefault, axios.default);
        Object.keys(axios.default).forEach(defaultKey => {
          if (typeof axios.default[defaultKey] === 'function') {
            wrappedDefault[defaultKey] = function(...args) {
              captureAxiosRequest('axios.default.' + defaultKey + '()', ...args);
              return axios.default[defaultKey].apply(axios.default, args);
            };
          } else {
            wrappedDefault[defaultKey] = axios.default[defaultKey];
          }
        });
        
        wrappedAxios[key] = wrappedDefault;
      } else {
        wrappedAxios[key] = axios[key];
      }
    } else if (typeof axios[key] === 'function') {
      wrappedAxios[key] = function(...args) {
        captureAxiosRequest('axios.' + key + '()', ...args);
        return axios[key].apply(axios, args);
      };
    } else {
      wrappedAxios[key] = axios[key];
    }
  });
  
  return wrappedAxios;
}

function captureAxiosRequest(method, ...args) {
  let url, config = {};
  
  if (typeof args[0] === 'string') {
    url = args[0];
    config = args[1] || {};
  } else if (typeof args[0] === 'object' && args[0] && args[0].url) {
    config = args[0];
    url = config.url;
  }
  
  if (!url || url.includes('localhost') || url.includes('127.0.0.1')) {
    return;
  }
  
  const request = {
    url: url,
    method: (config.method || 'GET').toUpperCase(),
    timestamp: new Date().toISOString(),
    scenario: process.env.HTTP_MONITOR_SCENARIO || 'unknown',
    library: 'axios'
  };
  
  requests.push(request);
  
  try {
    fs.writeFileSync(logFile, JSON.stringify(requests, null, 2));
  } catch (e) {
    // Ignore write errors
  }
  
  // Mock axios network failure
  if (mockNetworkFailures) {
    console.log('[HTTP Monitor] Mocking axios network failure for:', url);
    throw new Error('ENOTFOUND: Mock axios network failure - ' + url);
  }
}

function wrapFetch(fetch) {
  if (typeof fetch !== 'function') return fetch;
  
  return function(url, options = {}) {
    if (typeof url === 'string' && !url.includes('localhost') && !url.includes('127.0.0.1')) {
      const request = {
        url: url,
        method: (options.method || 'GET').toUpperCase(),
        timestamp: new Date().toISOString(),
        scenario: process.env.HTTP_MONITOR_SCENARIO || 'unknown',
        library: 'fetch'
      };
      
      requests.push(request);
      
      try {
        fs.writeFileSync(logFile, JSON.stringify(requests, null, 2));
      } catch (e) {
        // Ignore write errors
      }
      
      // Mock fetch network failure
      if (mockNetworkFailures) {
        console.log('[HTTP Monitor] Mocking fetch network failure for:', url);
        return Promise.reject(new Error('ENOTFOUND: Mock fetch network failure - ' + url));
      }
    }
    
    return fetch.apply(this, arguments);
  };
}

function wrapRequest(request) {
  if (typeof request !== 'function') return request;
  
  return function(...args) {
    let url, options = {};
    
    if (typeof args[0] === 'string') {
      url = args[0];
      options = args[1] || {};
    } else if (typeof args[0] === 'object' && args[0]) {
      options = args[0];
      url = options.url || options.uri;
    }
    
    if (url && !url.includes('localhost') && !url.includes('127.0.0.1')) {
      const requestInfo = {
        url: url,
        method: (options.method || 'GET').toUpperCase(),
        timestamp: new Date().toISOString(),
        scenario: process.env.HTTP_MONITOR_SCENARIO || 'unknown',
        library: 'request'
      };
      
      requests.push(requestInfo);
      
      try {
        fs.writeFileSync(logFile, JSON.stringify(requests, null, 2));
      } catch (e) {
        // Ignore write errors
      }
    }
    
    return request.apply(this, arguments);
  };
}

function wrapSuperagent(superagent) {
  if (!superagent || typeof superagent !== 'function') return superagent;
  
  const originalRequest = superagent.Request;
  if (originalRequest && originalRequest.prototype && originalRequest.prototype.end) {
    const originalEnd = originalRequest.prototype.end;
    originalRequest.prototype.end = function(callback) {
      const url = this.url;
      if (url && !url.includes('localhost') && !url.includes('127.0.0.1')) {
        const requestInfo = {
          url: url,
          method: (this.method || 'GET').toUpperCase(),
          timestamp: new Date().toISOString(),
          scenario: process.env.HTTP_MONITOR_SCENARIO || 'unknown',
          library: 'superagent'
        };
        
        requests.push(requestInfo);
        
        try {
          fs.writeFileSync(logFile, JSON.stringify(requests, null, 2));
        } catch (e) {
          // Ignore write errors
        }
      }
      
      return originalEnd.call(this, callback);
    };
  }
  
  return superagent;
}

function wrapUndici(undici) {
  if (!undici || typeof undici !== 'object') return undici;
  
  // Wrap the request method
  if (undici.request) {
    const originalRequest = undici.request;
    undici.request = async function(url, options = {}) {
      const urlStr = typeof url === 'string' ? url : url.toString();
      
      if (!urlStr.includes('localhost') && !urlStr.includes('127.0.0.1')) {
        const requestInfo = {
          url: urlStr,
          method: (options.method || 'GET').toUpperCase(),
          timestamp: new Date().toISOString(),
          scenario: process.env.HTTP_MONITOR_SCENARIO || 'unknown',
          library: 'undici'
        };
        
        requests.push(requestInfo);
        
        try {
          fs.writeFileSync(logFile, JSON.stringify(requests, null, 2));
        } catch (e) {
          // Ignore write errors
        }
      }
      
      return originalRequest.apply(this, arguments);
    };
  }
  
  // Wrap the fetch method if available
  if (undici.fetch) {
    const originalFetch = undici.fetch;
    undici.fetch = function(url, options = {}) {
      const urlStr = typeof url === 'string' ? url : url.toString();
      
      if (!urlStr.includes('localhost') && !urlStr.includes('127.0.0.1')) {
        const requestInfo = {
          url: urlStr,
          method: (options.method || 'GET').toUpperCase(),
          timestamp: new Date().toISOString(),
          scenario: process.env.HTTP_MONITOR_SCENARIO || 'unknown',
          library: 'undici.fetch'
        };
        
        requests.push(requestInfo);
        
        try {
          fs.writeFileSync(logFile, JSON.stringify(requests, null, 2));
        } catch (e) {
          // Ignore write errors
        }
      }
      
      return originalFetch.apply(this, arguments);
    };
  }
  
  // Wrap the Agent class if used
  if (undici.Agent) {
    const OriginalAgent = undici.Agent;
    undici.Agent = class extends OriginalAgent {
      request(...args) {
        const url = args[0];
        const urlStr = typeof url === 'string' ? url : url.toString();
        
        if (!urlStr.includes('localhost') && !urlStr.includes('127.0.0.1')) {
          const requestInfo = {
            url: urlStr,
            method: (args[1]?.method || 'GET').toUpperCase(),
            timestamp: new Date().toISOString(),
            scenario: process.env.HTTP_MONITOR_SCENARIO || 'unknown',
            library: 'undici.Agent'
          };
          
          requests.push(requestInfo);
          
          try {
            fs.writeFileSync(logFile, JSON.stringify(requests, null, 2));
          } catch (e) {
            // Ignore write errors
          }
        }
        
        return super.request(...args);
      }
    };
  }
  
  return undici;
}

function wrapGot(got) {
  if (!got || typeof got !== 'function') return got;
  
  // Create a wrapper function
  const wrappedGot = function(...args) {
    const url = args[0];
    const urlStr = typeof url === 'string' ? url : (url && url.toString ? url.toString() : '');
    
    if (urlStr && !urlStr.includes('localhost') && !urlStr.includes('127.0.0.1')) {
      const options = args[1] || {};
      const requestInfo = {
        url: urlStr,
        method: (options.method || 'GET').toUpperCase(),
        timestamp: new Date().toISOString(),
        scenario: process.env.HTTP_MONITOR_SCENARIO || 'unknown',
        library: 'got'
      };
      
      requests.push(requestInfo);
      
      try {
        fs.writeFileSync(logFile, JSON.stringify(requests, null, 2));
      } catch (e) {
        // Ignore write errors
      }
    }
    
    return got.apply(this, arguments);
  };
  
  // Copy all static properties and methods
  Object.setPrototypeOf(wrappedGot, got);
  Object.keys(got).forEach(key => {
    wrappedGot[key] = got[key];
  });
  
  // Wrap specific HTTP methods
  const methods = ['get', 'post', 'put', 'patch', 'head', 'delete'];
  methods.forEach(method => {
    if (typeof got[method] === 'function') {
      wrappedGot[method] = function(...args) {
        const url = args[0];
        const urlStr = typeof url === 'string' ? url : (url && url.toString ? url.toString() : '');
        
        if (urlStr && !urlStr.includes('localhost') && !urlStr.includes('127.0.0.1')) {
          const requestInfo = {
            url: urlStr,
            method: method.toUpperCase(),
            timestamp: new Date().toISOString(),
            scenario: process.env.HTTP_MONITOR_SCENARIO || 'unknown',
            library: 'got.' + method
          };
          
          requests.push(requestInfo);
          
          try {
            fs.writeFileSync(logFile, JSON.stringify(requests, null, 2));
          } catch (e) {
            // Ignore write errors
          }
        }
        
        return got[method].apply(got, arguments);
      };
    }
  });
  
  return wrappedGot;
}

// Intercept ES module imports - check if _importDynamic is available
if (typeof globalThis._importDynamic === 'function') {
  const originalImportDynamic = globalThis._importDynamic;
  globalThis._importDynamic = async function(modulePath) {
    const module = await originalImportDynamic(modulePath);
    
    // Check if this is a known HTTP library
    if (modulePath === 'axios') {
      console.log('[HTTP Monitor] Intercepting ES module: axios');
      if (module.default) {
        module.default = wrapAxios(module.default);
      }
      return module;
    }
    
    if (modulePath === 'undici') {
      console.log('[HTTP Monitor] Intercepting ES module: undici');
      if (module.default) {
        module.default = wrapUndici(module.default);
      }
      if (module.request) {
        const wrapped = wrapUndici(module);
        return wrapped;
      }
      return module;
    }
    
    if (modulePath === 'got') {
      console.log('[HTTP Monitor] Intercepting ES module: got');
      if (module.default) {
        module.default = wrapGot(module.default);
      }
      return module;
    }
    
    if (modulePath === 'node-fetch' || modulePath === 'isomorphic-fetch') {
      console.log('[HTTP Monitor] Intercepting ES module: ' + modulePath);
      if (module.default) {
        module.default = wrapFetch(module.default);
      }
      return module;
    }
    
    return module;
  };
}

// Also intercept import() calls directly if possible
try {
  const originalDynamicImport = eval('(m) => import(m)');
  if (typeof originalDynamicImport === 'function') {
    const interceptedImport = async function(specifier) {
      const module = await originalDynamicImport(specifier);
      
      // Apply the same wrapping logic
      if (specifier.includes('axios')) {
        console.log('[HTTP Monitor] Intercepting dynamic import: axios');
        if (module.default) module.default = wrapAxios(module.default);
      } else if (specifier.includes('undici')) {
        console.log('[HTTP Monitor] Intercepting dynamic import: undici');
        if (module.default) module.default = wrapUndici(module.default);
        if (module.request) return wrapUndici(module);
      } else if (specifier.includes('got')) {
        console.log('[HTTP Monitor] Intercepting dynamic import: got');
        if (module.default) module.default = wrapGot(module.default);
      } else if (specifier.includes('node-fetch') || specifier.includes('isomorphic-fetch')) {
        console.log('[HTTP Monitor] Intercepting dynamic import: ' + specifier);
        if (module.default) module.default = wrapFetch(module.default);
      }
      
      return module;
    };
    
    // Replace global import
    globalThis.import = interceptedImport;
  }
} catch (e) {
  // Some environments might not allow creating or overriding dynamic import
  // This is expected and not a problem - we'll still catch CommonJS requires
}

// File system access monitoring
const suspiciousFilePatterns = [
  '.ssh/',
  '.aws/',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'private_key',
  'privatekey',
  '.env',
  '/etc/passwd',
  '/etc/shadow',
  'wallet.dat',
  '.bitcoin',
  '.ethereum',
  'cookies.sqlite',
  'Cookies',
  'Login Data',
  '.bash_history',
  '.zsh_history',
  'known_hosts'
];

const fileAccessLog = process.env.HTTP_MONITOR_LOG ? process.env.HTTP_MONITOR_LOG.replace('.json', '-files.json') : null;
const fileAccesses = [];

// Wrap fs module methods to detect suspicious file access
const originalReadFile = fs.readFile;
const originalReadFileSync = fs.readFileSync;
const originalOpen = fs.open;
const originalOpenSync = fs.openSync;
const originalAccess = fs.access;
const originalAccessSync = fs.accessSync;
const originalStat = fs.stat;
const originalStatSync = fs.statSync;

const ignoredFilePaths = [
  'node_modules/@dabh/diagnostics/adapters/process.env.js',
];

function checkSuspiciousPath(path, operation) {
  if (!path || typeof path !== 'string') return;

  const pathStr = path.toString();

  if (ignoredFilePaths.some(ignored => pathStr.includes(ignored))) return;

  for (const pattern of suspiciousFilePatterns) {
    if (pathStr.includes(pattern)) {
      const access = {
        path: pathStr,
        pattern: pattern,
        operation: operation,
        timestamp: new Date().toISOString(),
        scenario: process.env.HTTP_MONITOR_SCENARIO || 'unknown',
        stack: new Error().stack
      };

      fileAccesses.push(access);

      // Write to log file
      if (fileAccessLog) {
        try {
          fs.writeFileSync(fileAccessLog, JSON.stringify(fileAccesses, null, 2));
        } catch (e) {
          // Ignore write errors
        }
      }

      console.log('[File Monitor] Suspicious file access detected:', pathStr);
      break;
    }
  }
}

// Wrap async file operations
fs.readFile = function(path, ...args) {
  checkSuspiciousPath(path, 'readFile');
  return originalReadFile.call(this, path, ...args);
};

fs.readFileSync = function(path, ...args) {
  checkSuspiciousPath(path, 'readFileSync');
  return originalReadFileSync.call(this, path, ...args);
};

fs.open = function(path, ...args) {
  checkSuspiciousPath(path, 'open');
  return originalOpen.call(this, path, ...args);
};

fs.openSync = function(path, ...args) {
  checkSuspiciousPath(path, 'openSync');
  return originalOpenSync.call(this, path, ...args);
};

fs.access = function(path, ...args) {
  checkSuspiciousPath(path, 'access');
  return originalAccess.call(this, path, ...args);
};

fs.accessSync = function(path, ...args) {
  checkSuspiciousPath(path, 'accessSync');
  return originalAccessSync.call(this, path, ...args);
};

fs.stat = function(path, ...args) {
  checkSuspiciousPath(path, 'stat');
  return originalStat.call(this, path, ...args);
};

fs.statSync = function(path, ...args) {
  checkSuspiciousPath(path, 'statSync');
  return originalStatSync.call(this, path, ...args);
};

// Also monitor child_process for suspicious commands
const child_process = require('child_process');
const originalExec = child_process.exec;
const originalExecSync = child_process.execSync;
const originalSpawn = child_process.spawn;

const suspiciousCommands = [
  'cat /etc/passwd',
  'cat ~/.ssh/',
  'find / -name id_rsa',
  'grep -r password',
  'curl.*|.*sh',
  'wget.*|.*bash',
  'sudo'
];

child_process.exec = function(command, ...args) {
  if (typeof command === 'string') {
    for (const pattern of suspiciousCommands) {
      if (new RegExp(pattern, 'i').test(command)) {
        const access = {
          command: command,
          operation: 'exec',
          timestamp: new Date().toISOString(),
          scenario: process.env.HTTP_MONITOR_SCENARIO || 'unknown'
        };

        fileAccesses.push(access);

        if (fileAccessLog) {
          try {
            fs.writeFileSync(fileAccessLog, JSON.stringify(fileAccesses, null, 2));
          } catch (e) {
            // Ignore
          }
        }

        console.log('[Command Monitor] Suspicious command detected:', command);
        break;
      }
    }
  }
  return originalExec.call(this, command, ...args);
};

child_process.execSync = function(command, ...args) {
  if (typeof command === 'string') {
    for (const pattern of suspiciousCommands) {
      if (new RegExp(pattern, 'i').test(command)) {
        console.log('[Command Monitor] Suspicious command detected:', command);
        break;
      }
    }
  }
  return originalExecSync.call(this, command, ...args);
};
`
  }

  private displayHttpRequestSummary(): void {
    if (this.allHttpRequests.length === 0) {
      console.log('\n🌐 HTTP Requests: No external HTTP requests detected')
      return
    }

    console.log('\n🌐 HTTP Requests Summary:')
    console.log('='.repeat(50))

    // Group by URL
    const urlCounts: { [url: string]: { count: number, methods: Set<string>, scenarios: Set<string> } } = {}

    for (const req of this.allHttpRequests) {
      if (!urlCounts[req.url]) {
        urlCounts[req.url] = { count: 0, methods: new Set(), scenarios: new Set() }
      }
      urlCounts[req.url].count += 1
      urlCounts[req.url].methods.add(req.method)
      urlCounts[req.url].scenarios.add(req.scenario)
    }

    // Display each unique URL
    Object.entries(urlCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([url, info]) => {
        const methods = Array.from(info.methods).join(', ')
        const scenarios = Array.from(info.scenarios).join(', ')
        console.log(`📡 ${url}`)
        console.log(`   Methods: ${methods} | Count: ${info.count} | Scenarios: ${scenarios}`)
      })

    console.log(`\n📊 Total: ${this.allHttpRequests.length} requests to ${Object.keys(urlCounts).length} unique URLs`)
  }

  private handleError(e: unknown): string {
    if (e instanceof Error) {
      return e.message
    }
    return String(e)
  }
}

const checkHomebridgePlugin = new CheckHomebridgePlugin()
void checkHomebridgePlugin.start()
