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

const RE_ENCODED_AT = /%40/g
const RE_EVAL = /\beval\s*\(/
const RE_FUNCTION_CTOR = /new\s+Function\s*\(/
const RE_DYNAMIC_REQUIRE = /require\s*\([^'"][^)]*\)/
const RE_EXEC_UNSAFE = /child_process\.(?:exec|execSync)\s*\([^'"]/
const RE_SSH_DIR = /\.ssh[/\\]/
const RE_AWS_DIR = /\.aws[/\\]/
const RE_ID_RSA = /id_rsa/
const RE_PRIVATE_KEY = /private[_\-]?key/i
const RE_DOT_ENV = /\.env/
const RE_ETC_PASSWD = /\/etc\/passwd/
const RE_SOURCE_FILE = /\.(?:js|ts|json)$/
const RE_EXIT_CODE = /Code: (\d+)/

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
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  bundledDependencies?: string[] | boolean
  bundleDependencies?: string[] | boolean
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
  diskWrites?: any[]
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
    GRACEFUL_SHUTDOWN_TIMEOUT: 12000, // 12 seconds for a clean exit after SIGTERM
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
  // Platform/accessory names captured by calling the plugin's initializer with
  // a stub Homebridge API. Used to cross-check against `pluginAlias`.
  private registeredNames: string[] = []
  // Dedupe out-of-storage disk write findings across runtime scenarios.
  private readonly diskWritePaths = new Set<string>()
  private homebridgeInstalled = false

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

      let settled = false
      let timer: ReturnType<typeof setTimeout>
      const finish = (fn: () => void): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        fn()
      }

      // Guard against a hung install (registry stall, spawn never closing).
      timer = setTimeout(() => {
        proc.kill('SIGKILL')
        finish(() => {
          this.failed.push('Installation: timed out after 5 minutes')
          reject(new Error('Install timed out'))
        })
      }, 5 * 60 * 1000)

      // Without this, a failure to spawn `npm` (ENOENT) would never settle
      // the promise and the whole run would hang.
      proc.on('error', (err) => {
        finish(() => {
          this.failed.push(`Installation: failed to start npm - ${this.handleError(err)}`)
          reject(err instanceof Error ? err : new Error(String(err)))
        })
      })

      proc.on('close', (code) => {
        finish(() => {
          if (code === 0) {
            this.passed.push('Installation: successfully installed')
            resolve()
          } else {
            this.failed.push(`Installation: failed to install [${code}]`)
            reject(new Error('Failed to install'))
          }
        })
      })
    })
  }

  private async testPackageJson(): Promise<void> {
    try {
      const packageJSON = await this.readPackageJson()

      // Capture the version up front so the results can always report which
      // version was tested, even when other package.json checks fail
      this.packageVersion = packageJSON.version || ''

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
      this.failed.push('Package JSON: `engines.node` property missing')
      return
    }

    try {
      const { body } = await request(CheckHomebridgePlugin.CONSTANTS.URLS.NODE_DIST, {
        headers: {
          'User-Agent': CheckHomebridgePlugin.CONSTANTS.HEADERS.USER_AGENT,
        },
      })
      const versionList = await body.json() as NodeVersion[]

      const latest22 = versionList.find(x => x.version.startsWith('v22'))?.version
      const latest24 = versionList.find(x => x.version.startsWith('v24'))?.version

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
      // `homebridge` is a peer dep and many plugins import runtime values from
      // it at module load. Ensure it's present before importing the entry,
      // otherwise this fails with "Cannot find package 'homebridge'".
      try {
        await this.ensureHomebridgeInstalled()
      } catch (e) {
        console.log('Could not pre-install homebridge before initializer check:', this.handleError(e))
      }

      const mainPath = this.resolveMainModule(packageJSON)
      const pluginModules = await this.loadPluginModule(mainPath, packageJSON.type === 'module')

      const initializer = typeof pluginModules === 'function'
        ? pluginModules
        : (pluginModules && typeof pluginModules.default === 'function' ? pluginModules.default : null)

      if (initializer) {
        this.passed.push('Package JSON: initializer function found')
        this.captureRegisteredNames(initializer)
      } else {
        this.failed.push('Package JSON: no initializer function found')
      }
    } catch (e) {
      this.failed.push(`Package JSON: failed to import plugin as ${this.handleError(e)}`)
    }
  }

  /**
   * Call the plugin initializer with a stub Homebridge API and record the
   * platform/accessory name(s) it registers, so we can later cross-check
   * them against `config.schema.json`'s `pluginAlias`. Best-effort: any
   * failure here is swallowed (we simply skip the consistency check).
   */
  private captureRegisteredNames(initializer: (api: any) => void): void {
    try {
      const names: string[] = []
      function stubTarget(): void { /* Proxy target — never actually invoked */ }
      const passthrough: any = new Proxy(stubTarget, {
        get: () => passthrough,
        apply: () => passthrough,
        construct: () => ({}),
      })
      const record = (...args: any[]): void => {
        for (const arg of args) {
          if (typeof arg === 'string' && arg.trim()) {
            names.push(arg)
          }
        }
      }
      const stubApi: any = {
        version: 2.0,
        serverVersion: '1.99.0',
        hap: {
          Service: passthrough,
          Characteristic: passthrough,
          Categories: passthrough,
          uuid: { generate: (s: string) => `uuid-${s}` },
          HAPStatus: passthrough,
          HapStatusError: passthrough,
        },
        hapLegacyTypes: passthrough,
        platformAccessory: function PlatformAccessory() {
          return new Proxy({ context: {}, services: [] }, { get: () => () => undefined })
        },
        user: {
          storagePath: () => '/tmp',
          configPath: () => '/tmp/config.json',
          persistPath: () => '/tmp',
        },
        on: () => stubApi,
        registerPlatform: (...args: any[]) => record(...args),
        registerAccessory: (...args: any[]) => record(...args),
        publishExternalAccessories: () => undefined,
        registerPlatformAccessories: () => undefined,
        unregisterPlatformAccessories: () => undefined,
        updatePlatformAccessories: () => undefined,
      }

      initializer(stubApi)
      this.registeredNames = [...new Set(names)]
    } catch {
      // Initializer threw with the stub API — skip the consistency check.
      this.registeredNames = []
    }
  }

  private resolveMainModule(packageJSON: PackageJSON): string {
    const main = this.resolveExportsEntry(packageJSON.exports) || packageJSON.main || './index.js'
    return join(this.testPath, 'node_modules', this.packageName, main)
  }

  /**
   * Best-effort resolution of a package `exports` value to a file path.
   * Prefers the '.' entry (as Node does), then the standard condition keys.
   * Recurses because conditions can be nested, e.g.
   * `{ ".": { "import": { "types": "...", "default": "./dist/index.js" } } }`.
   */
  private resolveExportsEntry(entry: PackageJSON['exports']): string | null {
    if (!entry) {
      return null
    }
    if (typeof entry === 'string') {
      return entry
    }
    if (typeof entry !== 'object') {
      return null
    }
    for (const key of ['.', 'import', 'require', 'node', 'default']) {
      if (key in entry) {
        const resolved = this.resolveExportsEntry(entry[key])
        if (resolved) {
          return resolved
        }
      }
    }
    return null
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
      const npmUrl = `${CheckHomebridgePlugin.CONSTANTS.URLS.NPM_REGISTRY}/${encodeURIComponent(this.packageName).replace(RE_ENCODED_AT, '@')}`
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

      // Check for duplicate enum values (causes cascading AJV errors on items/anyOf)
      if (error.includes('should NOT have duplicate items')) {
        this.failed.push(
          'Config Schema JSON: schema is invalid - an `enum` array contains duplicate values. '
          + 'Each value in an `enum` must be unique. Remove the duplicate entries.',
        )
        return
      }

      // Check for 'items should/must be array' or 'items should/must match' errors which often mean invalid properties on array schemas
      if (error.includes('items must be array') || error.includes('items should be array')
        || error.includes('items must match a schema') || error.includes('items should match some schema')) {
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

  private checkForRequiredBooleanMistake(schema: any): boolean {
    if (!schema || typeof schema !== 'object') {
      return false
    }

    // Check if this level has a 'required' property that's a boolean
    if ('required' in schema && typeof schema.required === 'boolean') {
      return true
    }

    // Recursively check properties
    if (schema.properties && typeof schema.properties === 'object') {
      for (const value of Object.values(schema.properties)) {
        if (this.checkForRequiredBooleanMistake(value)) {
          return true
        }
      }
    }

    // Check items for arrays
    if (schema.items) {
      if (Array.isArray(schema.items)) {
        for (const item of schema.items) {
          if (this.checkForRequiredBooleanMistake(item)) {
            return true
          }
        }
      } else if (this.checkForRequiredBooleanMistake(schema.items)) {
        return true
      }
    }

    // Check combinators
    for (const combinator of ['oneOf', 'anyOf', 'allOf']) {
      if (schema[combinator] && Array.isArray(schema[combinator])) {
        for (const branch of schema[combinator]) {
          if (this.checkForRequiredBooleanMistake(branch)) {
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

      // Cross-check the schema alias against the name the plugin actually
      // registers in code. Catches the repo/alias mismatch class of bug
      // where the config UI form never binds to the running platform.
      if (this.registeredNames.length > 0) {
        if (this.registeredNames.includes(configSchema.pluginAlias)) {
          this.passed.push('Config Schema JSON: `pluginAlias` matches the platform/accessory registered in code')
        } else {
          this.failed.push(
            `Config Schema JSON: \`pluginAlias\` ("${configSchema.pluginAlias}") does not match the name registered in code `
            + `(found: ${this.registeredNames.map(n => `"${n}"`).join(', ')}). `
            + 'The `pluginAlias` must equal the platform name passed to `api.registerPlatform()`, or the settings UI will not work.',
          )
        }
      }
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
    // Inspect what the plugin *declares*, not what is present in node_modules:
    // the checker itself installs `homebridge` into the test area, so a
    // folder-presence check would false-positive for every plugin.
    //
    // `homebridge`/`hap-nodejs` must only appear in `devDependencies`. They
    // are disallowed in `dependencies`, `optionalDependencies`,
    // `bundledDependencies`, AND `peerDependencies`/`peerDependenciesMeta` —
    // npm v7+ auto-installs peer dependencies (optional ones included), so a
    // peer dep would still get bundled alongside the plugin even though
    // Homebridge provides it at runtime.
    let packageJSON: PackageJSON
    try {
      packageJSON = await this.readPackageJson()
    } catch (e) {
      this.failed.push(`Dependencies: could not read package.json as ${this.handleError(e)}`)
      return
    }

    const declared = {
      ...(packageJSON.dependencies ?? {}),
      ...(packageJSON.optionalDependencies ?? {}),
      ...(packageJSON.peerDependencies ?? {}),
      ...(packageJSON.peerDependenciesMeta ?? {}),
    }
    const bundled = packageJSON.bundledDependencies ?? packageJSON.bundleDependencies
    const bundledList = Array.isArray(bundled) ? bundled : []

    for (const dep of CheckHomebridgePlugin.CONSTANTS.FORBIDDEN_DEPENDENCIES) {
      if (dep in declared || bundledList.includes(dep)) {
        this.failed.push(`Dependencies: \`${dep}\` must only be in \`devDependencies\` (not \`dependencies\`, \`optionalDependencies\`, \`bundledDependencies\`, or \`peerDependencies\` — npm auto-installs peer deps)`)
      } else {
        this.passed.push(`Dependencies: \`${dep}\` is not declared as a runtime/peer/bundled dependency`)
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
      const errorStr = String(e)
      if (errorStr.includes('npm audit')) {
        try {
          const execError = e as { stdout?: Buffer, output?: Buffer }
          const output = execError.stdout?.toString() || execError.output?.toString() || ''
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
      { pattern: RE_EVAL, message: 'uses eval() which can be a security risk', severity: 'high' },
      { pattern: RE_FUNCTION_CTOR, message: 'uses Function constructor which can be a security risk', severity: 'high' },
      { pattern: RE_DYNAMIC_REQUIRE, message: 'uses dynamic require() which could load arbitrary code', severity: 'medium' },
      { pattern: RE_EXEC_UNSAFE, message: 'uses exec with potentially unsafe input', severity: 'high' },
    ]

    const suspiciousFilePatterns = [
      { pattern: RE_SSH_DIR, message: 'accesses SSH directory', severity: 'critical' },
      { pattern: RE_AWS_DIR, message: 'accesses AWS credentials', severity: 'critical' },
      { pattern: RE_ID_RSA, message: 'accesses SSH keys', severity: 'critical' },
      { pattern: RE_PRIVATE_KEY, message: 'accesses private keys', severity: 'critical' },
      { pattern: RE_DOT_ENV, message: 'accesses environment files', severity: 'high' },
      { pattern: RE_ETC_PASSWD, message: 'accesses system files', severity: 'critical' },
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
            // Skip dependency/VCS/test-artifact dirs, but NOT `dist` — many
            // plugins publish only compiled code there and it is the real
            // surface to scan. Nested `node_modules` is still skipped so we
            // don't scan bundled dependencies.
            if (!['node_modules', '.git', 'coverage'].includes(entry.name)) {
              await walk(fullPath)
            }
          } else if (entry.isFile()) {
            // Include JS, TS, and JSON files
            if (RE_SOURCE_FILE.test(entry.name) && !entry.name.includes('.min.')) {
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

      // Collect writes outside the Homebridge storage directory
      if (result && Array.isArray(result.diskWrites)) {
        for (const w of result.diskWrites) {
          if (w && typeof w.path === 'string') {
            this.diskWritePaths.add(w.path)
          }
        }
      }
    }

    // After all initial tests, run network failure test if HTTP requests were detected
    await this.runNetworkFailureTestIfNeeded()

    // Surface any out-of-storage writes for manual review (criteria: plugins
    // should only write inside the Homebridge storage directory).
    if (this.diskWritePaths.size > 0) {
      const paths = [...this.diskWritePaths].slice(0, 8).join(', ')
      const more = this.diskWritePaths.size > 8 ? ` and ${this.diskWritePaths.size - 8} more` : ''
      this.manualReview.push(
        `Disk Writes: plugin wrote outside the Homebridge storage directory: ${paths}${more}. `
        + 'Plugins should only write to the Homebridge storage path (e.g. via `api.user.storagePath()`).',
      )
    }

    // Shutdown / reload safety (catches missing `api.on('shutdown')`,
    // leaked timers, and sockets that keep a port bound after a restart).
    await this.testShutdownAndReload()
  }

  /**
   * Start Homebridge with a working config, SIGTERM it, and check it exits
   * cleanly; then start it again on the same port to detect a leaked
   * server/socket/timer that keeps the port bound after shutdown.
   */
  private async testShutdownAndReload(): Promise<void> {
    const baseConfig = this.generateFullValidConfig() || this.generateMinimalRequiredConfig()
    if (!baseConfig) {
      return
    }

    const port = CheckHomebridgePlugin.CONSTANTS.HOMEBRIDGE_PORT_BASE + 900
    const storagePath = join(this.testPath, `homebridge-shutdown-${Date.now()}`)

    try {
      await fs.mkdirp(storagePath)
      const hbConfig = this.generateHomebridgeConfig(
        { name: 'shutdown', config: baseConfig, expectStartup: true, description: 'shutdown/reload safety' },
        port,
      )
      await fs.writeJson(join(storagePath, 'config.json'), hbConfig, { spaces: 2 })

      const first = await this.runShutdownInstance(storagePath, false)
      if (!first.started) {
        // Could not start with this config; startup is already covered by the
        // scenario tests, so don't double-penalise here.
        console.log('Shutdown test skipped - Homebridge did not start with generated config')
        return
      }

      if (first.exitedCleanly) {
        this.passed.push(`Runtime: plugin shuts down cleanly within ${CheckHomebridgePlugin.CONSTANTS.GRACEFUL_SHUTDOWN_TIMEOUT / 1000}s of SIGTERM`)
      } else {
        this.manualReview.push(
          `Runtime: Homebridge did not exit within ${CheckHomebridgePlugin.CONSTANTS.GRACEFUL_SHUTDOWN_TIMEOUT / 1000}s of SIGTERM and had to be force-killed. `
          + 'This usually means the plugin leaks a timer, interval, open socket or serial handle and does not register an `api.on(\'shutdown\')` cleanup handler.',
        )
      }

      const second = await this.runShutdownInstance(storagePath, true)
      if (second.portConflict) {
        this.failed.push(
          'Runtime: a port was still in use when Homebridge restarted, indicating the plugin leaks a server/socket/timer on shutdown. '
          + 'Add an `api.on(\'shutdown\')` handler that closes connections and clears timers.',
        )
      } else if (second.started) {
        this.passed.push('Runtime: plugin restarts cleanly without port conflicts')
      }
    } catch (e) {
      console.log('Could not run shutdown/reload test:', this.handleError(e))
    } finally {
      if (await fs.pathExists(storagePath)) {
        await fs.remove(storagePath)
      }
    }
  }

  /**
   * Run a single Homebridge instance for the shutdown/reload test.
   * - When `watchPortConflict` is false: wait until started, SIGTERM it, and
   *   measure whether it exits before GRACEFUL_SHUTDOWN_TIMEOUT.
   * - When true: just start it and watch the logs for an address-in-use
   *   error (a leaked listener from the previous run).
   */
  private runShutdownInstance(
    storagePath: string,
    watchPortConflict: boolean,
  ): Promise<{ started: boolean, exitedCleanly: boolean, portConflict: boolean }> {
    return new Promise((resolve) => {
      const startedPatterns = this.buildPluginLoadedPatterns()
      const portConflictRe = /eaddrinuse|address already in use|port \d+ is already in use/i
      let proc: ChildProcess | null = null
      let resolved = false
      let started = false
      let exitedCleanly = false
      let portConflict = false
      let graceTimer: ReturnType<typeof setTimeout> | undefined
      let overallTimer: ReturnType<typeof setTimeout>
      let startupTimer: ReturnType<typeof setTimeout>

      const done = (): void => {
        if (resolved) {
          return
        }
        resolved = true
        clearTimeout(overallTimer)
        clearTimeout(startupTimer)
        if (graceTimer) {
          clearTimeout(graceTimer)
        }
        if (proc && !proc.killed) {
          proc.kill('SIGKILL')
        }
        resolve({ started, exitedCleanly, portConflict })
      }

      overallTimer = setTimeout(done, CheckHomebridgePlugin.CONSTANTS.RUNTIME_TEST_TIMEOUT)

      // If it never reaches a "started" signal, give up after the normal
      // startup window.
      startupTimer = setTimeout(() => {
        if (!started) {
          done()
        }
      }, CheckHomebridgePlugin.CONSTANTS.HOMEBRIDGE_STARTUP_TIMEOUT)

      const onStarted = (): void => {
        if (started) {
          return
        }
        started = true
        clearTimeout(startupTimer)

        if (watchPortConflict) {
          // It came up fine on the reused port — no leaked listener.
          setTimeout(done, 1500)
          return
        }

        // Ask it to shut down and time how long it takes to exit.
        proc?.kill('SIGTERM')
        graceTimer = setTimeout(() => {
          exitedCleanly = false
          done()
        }, CheckHomebridgePlugin.CONSTANTS.GRACEFUL_SHUTDOWN_TIMEOUT)
      }

      const handle = (output: string): void => {
        if (watchPortConflict && portConflictRe.test(output)) {
          portConflict = true
          done()
          return
        }
        if (output.includes('Homebridge is running on port')
          || output.includes('Setup Payload:')
          || output.includes('Scan this code with your HomeKit app')
          || output.includes('[HB Supervisor] Started Homebridge')
          || startedPatterns.some(re => re.test(output))) {
          onStarted()
        }
      }

      try {
        proc = spawn('node', ['node_modules/.bin/homebridge', '-U', storagePath], {
          cwd: this.testPath,
          stdio: 'pipe',
          env: { ...process.env, HB_STORAGE_PATH: storagePath },
        })

        proc.stdout?.on('data', (d: Buffer) => handle(d.toString()))
        proc.stderr?.on('data', (d: Buffer) => handle(d.toString()))

        proc.on('close', () => {
          if (started && !watchPortConflict && graceTimer) {
            // Exited after our SIGTERM and before the grace timer fired.
            exitedCleanly = true
          }
          done()
        })
        proc.on('error', () => done())
      } catch {
        done()
      }
    })
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

  /**
   * Install `homebridge` into the test area once, idempotently.
   *
   * `homebridge` is a peer dependency, so it isn't pulled in by installing
   * the plugin. It must be present before we import the plugin's entry
   * (plugins legitimately import runtime values from `homebridge`), not just
   * for the later runtime tests — otherwise the initializer import fails with
   * "Cannot find package 'homebridge'" and every downstream check is skipped.
   */
  private async ensureHomebridgeInstalled(): Promise<void> {
    if (this.homebridgeInstalled) {
      return
    }

    if (await fs.pathExists(join(this.testPath, 'node_modules', 'homebridge', 'package.json'))) {
      this.homebridgeInstalled = true
      return
    }

    console.log('Installing Homebridge...')
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('npm', ['install', 'homebridge@latest'], {
        cwd: this.testPath,
        stdio: 'inherit',
      })

      let settled = false
      let timer: ReturnType<typeof setTimeout>
      const finish = (fn: () => void): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        fn()
      }

      timer = setTimeout(() => {
        proc.kill('SIGKILL')
        finish(() => reject(new Error('Homebridge install timed out')))
      }, 5 * 60 * 1000)

      proc.on('error', err => finish(() => reject(err instanceof Error ? err : new Error(String(err)))))
      proc.on('close', (code) => {
        finish(() => {
          if (code === 0) {
            this.homebridgeInstalled = true
            resolve()
          } else {
            reject(new Error(`Homebridge installation failed with code ${code}`))
          }
        })
      })
    })
  }

  private async installHomebridge(): Promise<void> {
    try {
      console.log('Ensuring Homebridge is installed for runtime testing...')
      await this.ensureHomebridgeInstalled()
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
        config[prop] = this.getDefaultValueForProperty(propSchema, prop)
      }
    }

    return config
  }

  private getDefaultValueForProperty(propSchema: any, propName = ''): any {
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
        return this.resolveStringValue(propSchema, this.getBaseValueForPropertyName(propName))
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
        // Respects enum/format/pattern/length so the generated config passes
        // the plugin's own validation instead of hitting its reject path.
        return this.resolveStringValue(propSchema, this.getBaseValueForPropertyName(propName))
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

  /** A valid sample value for a known JSON-Schema `format`, or null. */
  private valueForFormat(format: string): string | null {
    switch (format) {
      case 'email': return 'test@example.com'
      case 'ipv4': return '192.168.1.100'
      case 'ipv6': return '::1'
      case 'hostname': return 'example.com'
      case 'uri':
      case 'url': return 'https://example.com'
      case 'uuid': return '123e4567-e89b-12d3-a456-426614174000'
      case 'date-time': return new Date().toISOString()
      case 'date': return '2024-01-01'
      case 'time': return '12:00:00'
      case 'mac':
      case 'macaddress': return 'AA:BB:CC:DD:EE:FF'
      default: return null
    }
  }

  /**
   * Best-effort generator for a string that satisfies a regex `pattern`.
   * Handles the common subset (anchors, literals, `\d \w \s .`, `[...]`
   * classes, `(...)`/alternation, `{n,m} + * ?` quantifiers). The result is
   * always validated against the real RegExp — if it doesn't match we return
   * null and the caller falls back, so this can never make things worse.
   */
  private generateFromPattern(pattern: string, depth = 0): string | null {
    if (depth > 4) {
      return null
    }
    try {
      const src = pattern.replace(/^\^/, '').replace(/\$$/, '')
      let i = 0
      let out = ''
      const MAX = 64

      const classChar = (cls: string): string => {
        if (cls.includes('\\d') || /0-9/.test(cls)) {
          return '5'
        }
        if (/a-z/i.test(cls) || cls.includes('\\w')) {
          return 'a'
        }
        const literal = cls.replace(/\\./g, '').match(/[^^\-\]]/)
        return literal ? literal[0] : 'a'
      }

      const expand = (atom: string): string => {
        switch (atom) {
          case '\\d': return '5'
          case '\\w': return 'a'
          case '\\s': return ' '
          case '.': return 'a'
          default: return atom.length === 2 && atom[0] === '\\' ? atom[1] : atom
        }
      }

      while (i < src.length && out.length < MAX) {
        let atom = ''
        const c = src[i]

        if (c === '\\') {
          atom = src.slice(i, i + 2)
          i += 2
        } else if (c === '[') {
          const end = src.indexOf(']', i + 1)
          if (end === -1) {
            atom = '['
            i += 1
          } else {
            atom = classChar(src.slice(i + 1, end))
            i = end + 1
          }
        } else if (c === '(') {
          const end = src.indexOf(')', i + 1)
          if (end === -1) {
            i += 1
            continue
          }
          const inner = src.slice(i + 1, end).replace(/^\?:/, '').split('|')[0]
          atom = this.generateFromPattern(inner, depth + 1) ?? inner.replace(/[\\^$.*+?()[\]{}|]/g, '')
          i = end + 1
        } else if (c === '|') {
          break // top-level alternation: first alternative is enough
        } else {
          atom = c
          i += 1
        }

        let count = 1
        const q = src[i]
        if (q === '{') {
          const end = src.indexOf('}', i + 1)
          if (end !== -1) {
            count = Math.max(Number.parseInt(src.slice(i + 1, end).split(',')[0], 10) || 1, 1)
            i = end + 1
          }
        } else if (q === '+') {
          count = 2
          i += 1
        } else if (q === '*') {
          count = 0
          i += 1
        } else if (q === '?') {
          count = 1
          i += 1
        }

        const unit = atom.length > 1 && atom[0] !== '\\' ? atom : expand(atom)
        out += unit.repeat(Math.max(0, Math.min(count, 16)))
      }

      if (out && new RegExp(pattern).test(out)) {
        return out
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * Resolve a string value that respects `enum`, `format`, `pattern` and
   * length constraints, so generated test configs pass the plugin's own
   * validation instead of exercising its "bad config" path.
   */
  private resolveStringValue(propSchema: any, base: string): string {
    if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0) {
      return propSchema.enum[0]
    }

    let value = base

    if (typeof propSchema.format === 'string') {
      const formatted = this.valueForFormat(propSchema.format.toLowerCase())
      if (formatted !== null) {
        value = formatted
      }
    }

    if (typeof propSchema.pattern === 'string' && propSchema.pattern) {
      let matches = true
      try {
        matches = new RegExp(propSchema.pattern).test(value)
      } catch {
        matches = true // unparseable pattern — leave value as-is
      }
      if (!matches) {
        const generated = this.generateFromPattern(propSchema.pattern)
        if (generated !== null) {
          value = generated
        }
      }
    }

    // Only adjust for length when there is no pattern (padding/truncating a
    // pattern-matched value would usually break the pattern).
    if (!propSchema.pattern) {
      if (typeof propSchema.minLength === 'number' && value.length < propSchema.minLength) {
        value = value.padEnd(propSchema.minLength, '0123456789abcdef')
      }
      if (typeof propSchema.maxLength === 'number' && value.length > propSchema.maxLength) {
        value = value.substring(0, propSchema.maxLength)
      }
    }

    return value
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

  /**
   * Build the log signals that mean "this plugin's platform/accessory was
   * actually initialised" — i.e. constructed from config, NOT merely
   * discovered on disk.
   *
   * This must stay init-time only. Discovery/registration lines such as
   * "Loaded plugin: <pkg>" or "Registering platform '<pkg>.<alias>'" are
   * emitted by Homebridge for every installed plugin even when it has no
   * config, so matching those would make the "no config" scenario (which
   * expects the plugin NOT to load) wrongly report it as loaded.
   *
   * `Initializing <alias> platform` is a Homebridge *core* line emitted only
   * when a configured platform is constructed, so it does not depend on
   * plugin-specific log wording and never fires without config.
   */
  private buildPluginLoadedPatterns(): RegExp[] {
    const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const alias = this.configSchema?.pluginAlias ? esc(this.configSchema.pluginAlias) : ''

    if (!alias) {
      return []
    }

    return [
      new RegExp(`Initializing ${alias} (?:platform|accessory)`, 'i'),
      // Homebridge prefixes an *instantiated* platform's own log lines with
      // its name; only appears once the platform is constructed from config.
      new RegExp(`^\\s*\\[${alias}\\]`, 'm'),
    ]
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
      await this.removeTestArea(storagePath)

      return result
    } catch (e) {
      // Cleanup on error
      if (await fs.pathExists(storagePath)) {
        await this.removeTestArea(storagePath)
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

  /**
   * Remove a runtime-test storage directory. A child that outlived the
   * give-up timer in `stopAndThen` can still be writing here during its
   * teardown, so removal is retried, and a directory that still can't be
   * removed is only worth a warning — it must not replace the test result.
   */
  private async removeTestArea(storagePath: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await fs.remove(storagePath)
        return
      } catch (e) {
        if (attempt === 3) {
          console.log(`Warning: could not remove test area ${storagePath} - ${this.handleError(e)}`)
          return
        }
        await new Promise(resolve => setTimeout(resolve, 2000))
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
    const pluginLoadedPatterns = this.buildPluginLoadedPatterns()
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
            HB_STORAGE_PATH: storagePath,
            MOCK_NETWORK_FAILURES: scenario.mockNetworkFailures ? 'true' : 'false',
          },
        })

        let resolved = false
        let success = false
        let errorMessage = ''
        let pluginLoaded = false

        // Stop the child and run `finalize` only once it has exited.
        // Homebridge writes files during its SIGTERM teardown (e.g.
        // accessories/cachedAccessories via the bridge service), and the
        // monitor script flushes its logs at exit — resolving before the
        // process is gone lets the test-area cleanup race those writes
        // (ENOTEMPTY from fs.remove) and read incomplete monitor logs.
        //
        // Waits on 'exit' rather than 'close': 'close' needs the stdio pipes
        // to drain, and a grandchild that inherited them (e.g. a camera
        // plugin's ffmpeg) keeps the pipes open past SIGKILL, which would
        // hang the run. The short delay after 'exit' lets buffered stdio and
        // the monitor's exit-time flush land before logs are read and the
        // test area is removed; the give-up timer bounds pathological cases.
        const stopAndThen = (finalize: () => void): void => {
          const proc = homebridgeProcess
          if (!proc) {
            finalize()
            return
          }
          if (proc.exitCode !== null || proc.signalCode !== null) {
            // Already exited, but buffered stdio may not have drained yet —
            // give it the same grace period as the normal path below
            setTimeout(finalize, 1000)
            return
          }
          let finished = false
          let killTimer: ReturnType<typeof setTimeout>
          let giveUpTimer: ReturnType<typeof setTimeout>
          const finish = (): void => {
            if (finished) {
              return
            }
            finished = true
            clearTimeout(killTimer)
            clearTimeout(giveUpTimer)
            setTimeout(finalize, 1000)
          }
          killTimer = setTimeout(() => proc.kill('SIGKILL'), 10000)
          giveUpTimer = setTimeout(finish, 15000)
          proc.once('exit', finish)
          proc.kill('SIGTERM')
        }

        // Timeout for the entire test
        const testTimeout = setTimeout(() => {
          if (!resolved) {
            resolved = true
            stopAndThen(() => resolve({
              success: false,
              error: 'Test timed out',
              logs,
              duration: Date.now() - startTime,
              httpRequests: [],
              pluginLoaded,
            }))
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
            stopAndThen(() => {
              // Read the monitor logs only after the child has exited, so
              // the exit-time flush is included and the files are complete
              const httpLogPath = join(storagePath, 'http-requests.json')
              const fileLogPath = join(storagePath, 'http-requests-files.json')
              const writesLogPath = join(storagePath, 'http-requests-writes.json')
              let capturedRequests: HttpRequest[] = []
              let suspiciousFileAccess: any[] = []
              let diskWrites: any[] = []
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

              try {
                if (require('node:fs').existsSync(writesLogPath)) {
                  diskWrites = JSON.parse(require('node:fs').readFileSync(writesLogPath, 'utf8'))
                }
              } catch (e) {
                // Ignore disk-write log read errors
              }

              resolve({
                success: true,
                error: undefined,
                logs,
                duration: Date.now() - startTime,
                httpRequests: capturedRequests,
                pluginLoaded,
                suspiciousFileAccess,
                diskWrites,
              })
            })
          } else if (!resolved && pluginFailure) {
            // Plugin failure detected
            resolved = true
            clearTimeout(testTimeout)
            // Capture the failure now: the shutdown we're about to trigger
            // logs lines containing 'SIGTERM', which the output handlers
            // store into errorMessage, overwriting the real error.
            const failureError = errorMessage || 'Plugin failure detected'
            stopAndThen(() => resolve({
              success: false,
              error: failureError,
              logs,
              duration: Date.now() - startTime,
              httpRequests: [],
              pluginLoaded,
            }))
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

          // Detect plugin loading/initialization. Matches both the plugin's
          // own init log and the core Homebridge "Loaded plugin"/"Registering
          // platform" lines, so detection doesn't depend on plugin wording.
          if (!pluginLoaded && pluginLoadedPatterns.some(re => re.test(output))) {
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
            const codeMatch = output.match(RE_EXIT_CODE)
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
            const writesLogPath = join(storagePath, 'http-requests-writes.json')
            let capturedRequests: HttpRequest[] = []
            let suspiciousFileAccess: any[] = []
            let diskWrites: any[] = []
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

            try {
              if (require('node:fs').existsSync(writesLogPath)) {
                diskWrites = JSON.parse(require('node:fs').readFileSync(writesLogPath, 'utf8'))
              }
            } catch (e) {
              // Ignore disk-write log read errors
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
                diskWrites,
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
                diskWrites,
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

const EventEmitter = require('events');

const originalHttpRequest = http.request;
const originalHttpsRequest = https.request;
const originalHttpGet = http.get;
const originalHttpsGet = https.get;
const requests = [];
const logFile = process.env.HTTP_MONITOR_LOG;
const mockNetworkFailures = process.env.MOCK_NETWORK_FAILURES === 'true';

// A stand-in ClientRequest that fails with a network error. Built on
// EventEmitter so clients can use on/once/removeListener/etc. The error is
// emitted on a timer rather than from end(), so it also fires for
// http.get(), which calls end() internally on the real request. If the
// caller has no 'error' listener the emit throws, matching how an
// unhandled request error behaves in real Node.
function createMockFailingRequest(url, options) {
  const req = new EventEmitter();
  const chain = function() { return req; };
  req.write = function() { return true; };
  req.end = chain;
  req.setTimeout = chain;
  req.setHeader = chain;
  req.getHeader = function() { return undefined; };
  req.removeHeader = chain;
  req.setNoDelay = chain;
  req.setSocketKeepAlive = chain;
  req.flushHeaders = chain;
  req.destroy = chain;
  req.abort = chain;
  setTimeout(function() {
    const error = new Error('ENOTFOUND: Mock network failure - ' + url);
    error.code = 'ENOTFOUND';
    error.hostname = options.hostname || options.host;
    req.emit('error', error);
  }, 100);
  return req;
}

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
        return createMockFailingRequest(url, options);
      }
    }

    return originalRequest.apply(this, args);
  };
}

// Override the HTTP and HTTPS request methods. http.get/https.get call the
// module-internal request function, so overriding .request alone does not
// intercept them - they must be wrapped separately.
http.request = captureRequest('http', originalHttpRequest);
https.request = captureRequest('https', originalHttpsRequest);
http.get = captureRequest('http', originalHttpGet);
https.get = captureRequest('https', originalHttpsGet);

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

// Note: native ES module import() calls cannot be intercepted from a
// preloaded (-r) CommonJS script. ESM plugins are still monitored via the
// http/https core hooks above, which all HTTP libraries use underneath.

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
  'curl.*\\\\|.*sh',
  'wget.*\\\\|.*bash',
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

// Disk write monitoring: flag writes whose resolved path is outside the
// Homebridge storage directory (criteria: plugins should only write there).
const os = require('os');
const origWriteFileSync = fs.writeFileSync;
const writesLog = process.env.HTTP_MONITOR_LOG ? process.env.HTTP_MONITOR_LOG.replace('.json', '-writes.json') : null;
const diskWrites = [];
const allowedRoots = [process.env.HB_STORAGE_PATH || '', os.tmpdir(), '/tmp']
  .filter(Boolean)
  .map(function (p) { try { return path.resolve(p); } catch (e) { return p; } });

function recordWrite(target, operation) {
  try {
    if (!target) return;
    const raw = typeof target === 'string' ? target : (target && target.toString ? target.toString() : '');
    if (!raw || raw.indexOf('://') !== -1) return;
    const abs = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
    for (let i = 0; i < allowedRoots.length; i++) {
      if (abs === allowedRoots[i] || abs.indexOf(allowedRoots[i] + path.sep) === 0) return;
    }
    diskWrites.push({
      path: abs,
      operation: operation,
      timestamp: new Date().toISOString(),
      scenario: process.env.HTTP_MONITOR_SCENARIO || 'unknown'
    });
    if (writesLog) {
      try { origWriteFileSync(writesLog, JSON.stringify(diskWrites, null, 2)); } catch (e) {}
    }
    console.log('[Disk Monitor] Write outside storage dir:', abs);
  } catch (e) {}
}

['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'mkdir', 'mkdirSync'].forEach(function (m) {
  if (typeof fs[m] !== 'function') return;
  const orig = fs[m];
  fs[m] = function (p) {
    recordWrite(p, m);
    return orig.apply(this, arguments);
  };
});

try {
  const fsp = require('fs/promises');
  ['writeFile', 'appendFile', 'mkdir'].forEach(function (m) {
    if (typeof fsp[m] !== 'function') return;
    const origp = fsp[m];
    fsp[m] = function (p) {
      recordWrite(p, 'promises.' + m);
      return origp.apply(this, arguments);
    };
  });
} catch (e) {}
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
        const methods = [...info.methods].join(', ')
        const scenarios = [...info.scenarios].join(', ')
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
