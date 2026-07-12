import fs from 'node:fs'

/**
 * Sort a JSON file containing an array of strings, write it back, and return the sorted array.
 */
function sortArrayFile(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const sorted = data.sort()
  fs.writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`)
  return sorted
}

/**
 * Return a copy of an object with its keys sorted alphabetically.
 */
function sortObjectKeys(obj) {
  return Object.keys(obj)
    .sort()
    .reduce((acc, key) => {
      acc[key] = obj[key]
      return acc
    }, {})
}

/**
 * Sort a JSON file containing an object by its keys, write it back, and return the sorted object.
 */
function sortObjectFile(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const sorted = sortObjectKeys(data)
  fs.writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`)
  return sorted
}

const verified = sortArrayFile('verified-plugins.json')
const verifiedPlus = sortArrayFile('verified-plus-plugins.json')
const hidden = sortArrayFile('hidden-plugins.json')
const unmaintained = sortArrayFile('unmaintained-plugins.json')

const authorsSorted = sortObjectFile('plugin-authors.json')
const namesSorted = sortObjectFile('plugin-names.json')
const changelogsSorted = sortObjectFile('plugin-changelogs.json')

const hasScope = JSON.parse(fs.readFileSync('has-scope-plugins.json', 'utf8'))
const hasScopeSorted = hasScope.sort((a, b) => a.from.localeCompare(b.from))
const hasScopeKeys = hasScopeSorted.map(plugin => plugin.from)
fs.writeFileSync('has-scope-plugins.json', `${JSON.stringify(hasScopeSorted, null, 2)}\n`)

// A plugin's icon is only shown when the plugin is verified (or verified-plus),
// so drop icon entries for plugins on neither list, and entries whose icon
// file is missing from the repo.
const icons = JSON.parse(fs.readFileSync('plugin-icons.json', 'utf8'))

fs.writeFileSync('plugin-icons.json', `${JSON.stringify(Object.keys(icons)
  .filter((key) => {
    const iconFile = icons[key]
    if (!verified.includes(key) && !verifiedPlus.includes(key)) {
      console.log(` - Ignoring icon for ${key} because it is not in the verified or verified-plus lists`)
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

const authorsSortedKeys = Object.keys(authorsSorted)
const namesSortedKeys = Object.keys(namesSorted)
const changelogsSortedKeys = Object.keys(changelogsSorted)

const fullJson = [
  ...verified,
  ...verifiedPlus,
  ...hidden,
  ...unmaintained,
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
      newScope: hasScopeKeys.includes(key) ? hasScopeSorted.find(plugin => plugin.from === key) : false,
      scoped: (key.startsWith('@homebridge-plugins/') && authorsSortedKeys.includes(key)) ? authorsSorted[key] : false,
      author: authorsSortedKeys.includes(key) ? authorsSorted[key] : null,
      changelog: changelogsSortedKeys.includes(key) ? changelogsSorted[key] : null,
      verified: verified.includes(key),
      verifiedPlus: verifiedPlus.includes(key),
    }
    return obj
  }, {})

const iconToShortName = icon => icon.replace('icons/', '').replace('.png', '')

const filteredJson = Object.keys(fullJson).reduce((obj, key) => {
  obj[key] = Object.entries(fullJson[key]).reduce((props, [propKey, propValue]) => {
    if (['author', 'name', 'changelog'].includes(propKey)) {
      return props
    }
    if (propValue === true) {
      props[propKey] = 1
    } else if (typeof propValue === 'string') {
      props[propKey] = propKey === 'icon' ? iconToShortName(propValue) : propValue
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
      props[shortKey] = propKey === 'icon' ? iconToShortName(propValue) : propValue
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
