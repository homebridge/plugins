<p align="center">
  <a href="https://github.com/homebridge/homebridge"><img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-color-round-stylized.png" height="140"></a>
</p>

<span align="center">

# Plugins

</span>

Information and resources for Homebridge plugins.

Create [an issue](https://github.com/homebridge/plugins/issues/new/choose) to:

- request verification for your plugin
- request an icon for your verified plugin
- request a transfer into the Homebridge organization (you can choose whether to continue maintaining the plugin)
- request to maintain an unmaintained plugin listed [here](https://github.com/homebridge/plugins/wiki/Unmaintained-Plugins#available-plugins)

More info on these topics can be found below.

## Plugin Verification

The **Verified By Homebridge** program allows plugin developers to get their plugins reviewed and endorsed by the Homebridge project team.

<details>
  <summary>View/Hide Information</summary>

### Benefits

- Have your plugin reviewed by the Homebridge team.
- Increase the visibility of your plugin.
- Increase the level of trust end users place in your plugin.
- The **Verified** shield icon will turn green next to your plugin in the [Homebridge UI](https://github.com/oznu/homebridge-config-ui-x).
- The [**Donate**](https://github.com/oznu/homebridge-config-ui-x/wiki/Developers:-Donation-Links) heart icon will turn pink and enable on your plugin tile in the Homebridge UI.
- Your plugin is bumped to the top of the search results in the Homebridge UI.
- You can optionally upload an icon for your plugin which will be displayed in the Homebridge UI.

### Requirements

The Homebridge project team will check that your plugin meets the following criteria:

- **General**
  - The plugin must be of type [dynamic platform](https://developers.homebridge.io/#/#dynamic-platform-template).
  - The plugin must not offer the same nor less functionality than that of any existing **verified** plugin.
- **Repo**
  - The plugin must be published to NPM and the source code available on a GitHub repository, with issues enabled.
  - A GitHub release should be created for every new version of your plugin, with release notes.
- **Environment**
  - The plugin must run on all [supported LTS versions of Node.js](https://github.com/homebridge/homebridge/wiki/How-To-Update-Node.js), at the time of writing this is Node v18 and v20.
  - The plugin must successfully install and not start unless it is configured.
  - The plugin must not execute post-install scripts that modify the users' system in any way.
  - The plugin must not require the user to run Homebridge in a TTY or with non-standard startup parameters, even for initial configuration.
- **Codebase**
  - The plugin must implement the [Homebridge Plugin Settings GUI](https://developers.homebridge.io/#/config-schema).
  - The plugin must not contain any analytics or calls that enable you to track the user.
  - If the plugin needs to write files to disk (cache, keys, etc.), it must store them inside the Homebridge storage directory.
  - The plugin must not throw unhandled exceptions, the plugin must catch and log its own errors.

These verification requirements were last updated on 2023-12-08. Existing verified plugins will have met the requirements at the time of verification, and not necessarily the current requirements.

### How To Request Verification

If you would like your plugin verified, please open an [issue](https://github.com/homebridge/plugins/issues/new/choose) on this repository and fill in the template. The Homebridge project team will then review your plugin and provide constructive feedback if required.

If you feel that your plugin should replace the verification status of an existing plugin, let us know and this will be dealt with on an individual basis.

If you need assistance meeting the verification requirements, please reach out on the [Homebridge Discord](https://discord.gg/A7nCjbz).

### Post Verification

Once your plugin has been verified you will remain in full control of the GitHub repository and npm package. Your plugin will appear on the 'Verified By Homebridge' plugin list and the '**Verified**' badge will appear next to your plugin when the next update to the [Homebridge UI](https://github.com/oznu/homebridge-config-ui-x) is published.

You may optionally add one of the **Verified By Homebridge** badges to your plugin's README:

[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

```
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
```

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

```
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
```

If you decide you no longer wish to maintain your plugin, please reach out to the Homebridge team on the [Homebridge Discord](https://discord.gg/6GUFCb). We can assist in finding a new owner, or take over the repository until a new maintainer can be found.

### Un-verification

Your plugin may be subject to another review or be removed from the verification list when deemed necessary by the Homebridge team - this could be (but not limited to) the following scenarios:

- We notice an increased amount of issues arising from your plugin, which results in a suboptimal experience for the user, for example, a Homebridge crash loop.
- Your plugin has been unmaintained for some time, and a fork or new plugin offering improved functionality is created.

We will generally do our best to contact existing developers of plugins before removing verification status. However, we may **immediately** remove verification status in the following (but not limited to) the following scenarios:

- We notice any sort of user analysis tracking in a verified plugin
- A new plugin requests verification which replaces the functionality of any existing plugin, and we notice that the existing plugin has not been maintained for an extended period of time (and we deem it likely that any contact attempt with the developer would be unsuccessful).

</details>

## Transfer to the Homebridge Plugins Organization

See the [Unmaintained Plugins](https://github.com/homebridge/plugins/wiki/Unmaintained-Plugins) wiki page for more information about transferring an unmaintained plugin to the Homebridge project.

## Maintain a Plugin

See the [Unmaintained Plugins](https://github.com/homebridge/plugins/wiki/Unmaintained-Plugins) wiki page for more information about maintaining an unmaintained plugin, and a current list of plugins that need a new maintainer.

## Verified Plugin Bundles

The purpose of this is to help make the plugin installation process faster and more reliable for verified plugins.

<details>
  <summary>View/Hide Information</summary>

### Why This Is Needed

Homebridge plugins are published and distributed to the NPM registry and installed using the `npm` cli tool.

While `npm` works for the most part, later versions have become increasingly resource hungry and prone to failure on low powered devices with limited RAM and slow disk I/O (such as a Raspberry Pi).

When using `npm` to install a plugin, it has to individually fetch the metadata, and download, verify and extract the tarball for every dependency a plugin has. This can result in hundreds of HTTP requests every time a plugin is installed or updated. An error during any of these operations will often result in the plugin failing to install or update.

This project pre-bundles verified plugins, making them available to download, with all their dependencies, in a single tarball. Additionally, a SHA256 sum of the tarball is available so the integrity of the bundle can be verified after being downloaded to the user's system.

A plugin installed via a bundle from this repo can be downloaded and installed in seconds, compared the minutes it might take for some plugins on the same hardware.

### How The Bundle Generation Process Works

Every 24 hours, a job is executed using GitHub Actions to check for updates made to any [verified Homebridge plugins](https://homebridge.io/w/Verified-Plugins).

Plugins that require updates are then:

1. Installed using `npm` in a clean work directory, post install scripts are disabled;
2. then a `.tar.gz` bundle is created for the plugin, including all it's dependencies;
3. then a `.sha256` checksum file is generated for the bundle;
4. finally the resulting tarball and checksum file are uploaded to [this repo](https://github.com/homebridge/plugins/releases/tag/v1.0.0).

The two most recent versions of a plugin are retained in [this repo](https://github.com/homebridge/plugins/releases/tag/v1.0.0), older versions are purged automatically.

### How Plugins Are Installed Via Bundles

Bundles are only used on certain systems:

- Debian-based Linux ([via apt package](https://github.com/homebridge/homebridge-apt-pkg)): requires apt package update (=>1.0.27)
- Docker: requires image update (=>2022-07-07)
- Synology DSM 7: requires package update via DSM Package Center (=>3.0.7)

When a user requests a plugin to be installed or updated via the Homebridge UI the following workflow is executed:

1. Check if running on a compatible system
2. Check the plugin is verified
3. Check if a download bundle is available for the requested version
4. Download the `.sha256` checksum for the bundle
5. Download the `.tar.gz` tarball
6. Check the integrity of the tarball against the checksum
7. Create a backup of the existing plugin installation (if already installed)
8. Extract the tarball
9. Run `npm rebuild` in the plugin's root directory to have any post install scripts executed locally
10. Update the local `package.json` with the plugin and it's version

If the extraction, or `npm rebuild` steps fail, the old version of the plugin will be restored.

If at any step, the process fails, the Homebridge UI will fall back to using `npm` to complete the installation.

### Download Statistics

This project may impact the download stats for plugins provided by the NPM registry.

As such download stats are available via the [download-statistics.json](https://github.com/homebridge/plugins/releases/download/v1.0.0/download-statistics.json) file. This file contains the total downloads from this repo for each verified plugin, as well as the download count for each version (including old versions that have been purged).

The `download-statistics.json` file is updated every 24 hours.

If you are accessing the file programmatically, you will need add a `nonce` query string to the URL to prevent it being redirected to an older (deleted) version of the file. E.g. `/download-statistics.json?nonce=1657193776`.

### FAQ

#### How do I get my plugin included?

All verified Homebridge plugins are automatically included.

#### What happens if a user attempts to install the latest version of my plugin before the bundle is created?

The plugin will be installed directly from the NPM registry instead.

#### How do I exclude my plugin from being bundled by this project?

Create a pull request adding your plugin's name to the `pluginFilter: string[]` array in the [src/plugin-tarballs/index.ts](./src/plugin-tarballs/index.ts) file.

</details>

## Community

The [#plugin-development](https://discord.gg/A7nCjbz) channel in the official Homebridge Discord server is where Homebridge plugin developers can get tips and advice from other developers and the Homebridge project team.

<span align="center">

[![Homebridge Discord](https://discordapp.com/api/guilds/432663330281226270/widget.png?style=banner2)](https://discord.gg/kqNCe2D)

</span>

## Credits

- Thanks to [@hjdhjd](https://github.com/hjdhjd) for the _for-the-badge_ style badge!

## License

Copyright (C) 2022-2024 oznu

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the [GNU General Public License](./LICENSE) for more details.
