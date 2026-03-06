import fs from 'node:fs'

const verified = JSON.parse(fs.readFileSync('verified-plugins.json', 'utf8'))
const verifiedSorted = verified.sort()
fs.writeFileSync('verified-plugins.json', `${JSON.stringify(verifiedSorted, null, 2)}\n`)

const verifiedPlus = JSON.parse(fs.readFileSync('verified-plus-plugins.json', 'utf8'))
const verifiedPlusSorted = verifiedPlus.sort()
fs.writeFileSync('verified-plus-plugins.json', `${JSON.stringify(verifiedPlusSorted, null, 2)}\n`)

const hidden = JSON.parse(fs.readFileSync('hidden-plugins.json', 'utf8'))
const hiddenSorted = hidden.sort()
fs.writeFileSync('hidden-plugins.json', `${JSON.stringify(hiddenSorted, null, 2)}\n`)

const authors = JSON.parse(fs.readFileSync('plugin-authors.json', 'utf8'))
const authorsSortedKeys = Object.keys(authors).sort()
const authorsSorted = authorsSortedKeys.reduce((obj, key) => {
  obj[key] = authors[key]
  return obj
}, {})

fs.writeFileSync('plugin-authors.json', `${JSON.stringify(authorsSorted, null, 2)}\n`)

const names = JSON.parse(fs.readFileSync('plugin-names.json', 'utf8'))
const namesSortedKeys = Object.keys(names).sort()
const namesSorted = namesSortedKeys.reduce((obj, key) => {
  obj[key] = names[key]
  return obj
}, {})

fs.writeFileSync('plugin-names.json', `${JSON.stringify(namesSorted, null, 2)}\n`)

const changelogs = JSON.parse(fs.readFileSync('plugin-changelogs.json', 'utf8'))
const changelogsSortedKeys = Object.keys(changelogs).sort()
const changelogsSorted = changelogsSortedKeys.reduce((obj, key) => {
  obj[key] = changelogs[key]
  return obj
}, {})

fs.writeFileSync('plugin-changelogs.json', `${JSON.stringify(changelogsSorted, null, 2)}\n`)

const hasScope = JSON.parse(fs.readFileSync('has-scope-plugins.json', 'utf8'))
const hasScopeSorted = hasScope.sort((a, b) => a.from.localeCompare(b.from))
const hasScopeKeys = hasScopeSorted.map(plugin => plugin.from)
fs.writeFileSync('has-scope-plugins.json', `${JSON.stringify(hasScopeSorted, null, 2)}\n`)

const unmaintained = JSON.parse(fs.readFileSync('unmaintained-plugins.json', 'utf8'))
const unmaintainedPlugins = unmaintained.sort()
fs.writeFileSync('unmaintained-plugins.json', `${JSON.stringify(unmaintainedPlugins, null, 2)}\n`)

const icons = JSON.parse(fs.readFileSync('plugin-icons.json', 'utf8'))

fs.writeFileSync('plugin-icons.json', `${JSON.stringify(Object.keys(icons)
  .filter((key) => {
    const iconFile = icons[key]
    if (!verified.includes(key)) {
      console.log(` - Ignoring icon for ${key} because it is not in the verified list`)
      return false
    }
    if (!fs.existsSync(`./${iconFile}`)) {
      console.log(` - Ignoring icon for ${key} because the icon file does not exist`)
      return false
    }
    return true
  })
  .sort()
  .reduce((obj, key) => {
    obj[key] = icons[key]
    return obj
  }, {}), null, 2)}\n`)

const fullJson = [
  ...verifiedSorted,
  ...verifiedPlusSorted,
  ...hiddenSorted,
  ...unmaintainedPlugins,
  ...hasScopeKeys,
  ...authorsSortedKeys,
  ...namesSortedKeys,
  ...changelogsSortedKeys,
]
  .sort()
  .reduce((obj, key) => {
    obj[key] = {
      name: namesSortedKeys.includes(key) ? namesSorted[key] : null,
      hidden: hidden.includes(key),
      icon: (verified.includes(key) || verifiedPlus.includes(key)) && fs.existsSync(`./${icons[key]}`) ? icons[key] : null,
      unmaintained: unmaintained.includes(key),
      newScope: hasScopeKeys.includes(key) ? hasScope.find(plugin => plugin.from === key) : false,
      scoped: (key.startsWith('@homebridge-plugins/') && authorsSortedKeys.includes(key)) ? authorsSorted[key] : false,
      author: authorsSortedKeys.includes(key) ? authorsSorted[key] : null,
      changelog: changelogsSortedKeys.includes(key) ? changelogsSorted[key] : null,
      verified: verified.includes(key),
      verifiedPlus: verifiedPlus.includes(key),
    }
    return obj
  }, {})

const filteredJson = Object.keys(fullJson).reduce((obj, key) => {
  obj[key] = Object.entries(fullJson[key]).reduce((props, [propKey, propValue]) => {
    if (['author', 'name', 'changelog'].includes(propKey)) {
      return props
    }
    if (propValue === true) {
      props[propKey] = 1
    } else if (typeof propValue === 'string') {
      props[propKey] = propValue
        .replace('icons/', '')
        .replace('.png', '')
    } else if (propValue && typeof propValue === 'object') {
      props[propKey] = propValue
    }
    return props
  }, {})
  return obj
}, {})

const shortenedKeys = {
  name: 'n',
  hidden: 'h',
  icon: 'i',
  unmaintained: 'u',
  newScope: 's',
  author: 'a',
  changelog: 'c',
  verified: 'v',
  verifiedPlus: 'p',
}

const filteredJsonV2 = Object.keys(fullJson).reduce((obj, key) => {
  obj[key] = Object.entries(fullJson[key]).reduce((props, [propKey, propValue]) => {
    if (propKey === 'scoped') {
      return props
    }
    const shortKey = shortenedKeys[propKey] || propKey
    if (propValue === true) {
      props[shortKey] = 1
    } else if (typeof propValue === 'string') {
      if (propKey === 'icon') {
        props[shortKey] = propValue
          .replace('icons/', '')
          .replace('.png', '')
      } else {
        props[shortKey] = propValue
      }
    } else if (propValue && typeof propValue === 'object') {
      props[shortKey] = propValue
    }
    return props
  }, {})
  return obj
}, {})

fs.writeFileSync('./assets/plugins.json', `${JSON.stringify(fullJson, null, 2)}\n`)
fs.writeFileSync('./assets/plugins.min.json', JSON.stringify(filteredJson))
fs.writeFileSync('./assets/plugins-v2.min.json', JSON.stringify(filteredJsonV2))

const fullArray = Object.values(fullJson)

console.log('\n----------- STATS -----------')
console.log(`- Hidden Total: ${fullArray.filter(plugin => plugin.hidden).length}`)
console.log(`- Unmaintained Total: ${fullArray.filter(plugin => plugin.unmaintained).length}`)
console.log(`- Scoped Total: ${fullArray.filter(plugin => plugin.scoped).length}`)
console.log(`- Has New Scope Total: ${fullArray.filter(plugin => plugin.newScope).length}`)
console.log(`- Verified With Icon: ${fullArray.filter(plugin => plugin.verified && plugin.icon).length}`)
console.log(`- Verified Without Icon: ${fullArray.filter(plugin => plugin.verified && !plugin.icon).length}`)
console.log(`- Verified Total: ${fullArray.filter(plugin => plugin.verified).length}`)
console.log(`- Verified Plus Total: ${fullArray.filter(plugin => plugin.verifiedPlus).length}`)
console.log('-----------------------------')
