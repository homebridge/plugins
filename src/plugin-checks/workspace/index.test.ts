import process from 'node:process'

import { beforeEach, describe, expect, it } from 'vitest'

import { CheckHomebridgePlugin } from './index.ts'

describe('validateBugsUrl', () => {
  let checker: any

  beforeEach(() => {
    process.env.HOMEBRIDGE_PLUGIN_NAME = 'homebridge-example'
    checker = new CheckHomebridgePlugin()
  })

  it('reads the GitHub owner and repo from a GitHub bugs url', () => {
    checker.validateBugsUrl({
      bugs: { url: 'https://github.com/owner/homebridge-example/issues' },
    })

    expect(checker.gitHubAuthor).toBe('owner')
    expect(checker.gitHubRepo).toBe('homebridge-example')
    expect(checker.failed).toEqual([])
  })

  it('fails when the bugs url is not on GitHub, instead of skipping the GitHub checks', () => {
    // homebridge/plugins#1341 passed every check with its source on a self-hosted GitLab
    checker.validateBugsUrl({
      bugs: { url: 'https://gitlab.example.com/owner/homebridge-example/issues' },
    })

    expect(checker.gitHubAuthor).toBe('')
    expect(checker.gitHubRepo).toBe('')
    expect(checker.failed).toHaveLength(1)
    expect(checker.failed[0]).toMatch(/^GitHub Repo: the source code must be on a public GitHub repository/)
    expect(checker.failed[0]).toContain('https://gitlab.example.com/owner/homebridge-example/issues')
  })

  it('does not add a GitHub failure when the bugs url is missing, as that already fails', () => {
    checker.validateBugsUrl({})

    expect(checker.failed).toEqual(['Package JSON: `bugs.url` missing'])
  })
})
