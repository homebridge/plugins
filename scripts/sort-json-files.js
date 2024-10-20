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

const scoped = JSON.parse(fs.readFileSync('scoped-plugins.json', 'utf8'))
const scopedSortedKeys = Object.keys(scoped).sort()
const scopedSorted = scopedSortedKeys.reduce((obj, key) => {
  obj[key] = scoped[key]
  return obj
}, {})

fs.writeFileSync('scoped-plugins.json', `${JSON.stringify(scopedSorted, null, 2)}\n`)

const hasScope = JSON.parse(fs.readFileSync('has-scope-plugins.json', 'utf8'))
const hasScopeSorted = hasScope.sort((a, b) => a.from.localeCompare(b.from))
const hasScopeKeys = hasScopeSorted.map(plugin => plugin.from)
fs.writeFileSync('has-scope-plugins.json', `${JSON.stringify(hasScopeSorted, null, 2)}\n`)

const maintained = JSON.parse(fs.readFileSync('maintained-plugins.json', 'utf8'))
const maintainedPlugins = maintained.sort()
fs.writeFileSync('maintained-plugins.json', `${JSON.stringify(maintainedPlugins, null, 2)}\n`)

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

const fullJson = verifiedSorted
  .concat(verifiedPlusSorted)
  .concat(hiddenSorted)
  .concat(maintainedPlugins)
  .concat(hasScopeKeys)
  .concat(scopedSortedKeys)
  .sort()
  .reduce((obj, key) => {
    obj[key] = {
      hidden: hidden.includes(key),
      icon: (verified.includes(key) || verifiedPlus.includes(key)) && fs.existsSync(`./${icons[key]}`) ? icons[key] : null,
      maintained: maintained.includes(key),
      newScope: hasScopeKeys.includes(key) ? hasScope.find(plugin => plugin.from === key) : false,
      scoped: scopedSortedKeys.includes(key) ? scopedSorted[key] : false,
      verified: verified.includes(key),
      verifiedPlus: verifiedPlus.includes(key),
    }
    return obj
  }, {})

const filteredJson = Object.keys(fullJson).reduce((obj, key) => {
  obj[key] = Object.entries(fullJson[key]).reduce((props, [propKey, propValue]) => {
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

fs.writeFileSync('./assets/plugins.json', `${JSON.stringify(fullJson, null, 2)}\n`)
fs.writeFileSync('./assets/plugins.min.json', JSON.stringify(filteredJson))

const fullArray = Object.values(fullJson)

console.log('\n----------- STATS -----------')
console.log(`- Hidden Total: ${fullArray.filter(plugin => plugin.hidden).length}`)
console.log(`- Maintained Total: ${fullArray.filter(plugin => plugin.maintained).length}`)
console.log(`- Scoped Total: ${fullArray.filter(plugin => plugin.scoped).length}`)
console.log(`- Has New Scope Total: ${fullArray.filter(plugin => plugin.newScope).length}`)
console.log(`- Verified With Icon: ${fullArray.filter(plugin => plugin.verified && plugin.icon).length}`)
console.log(`- Verified Without Icon: ${fullArray.filter(plugin => plugin.verified && !plugin.icon).length}`)
console.log(`- Verified Total: ${fullArray.filter(plugin => plugin.verified).length}`)
console.log(`- Verified Plus Total: ${fullArray.filter(plugin => plugin.verifiedPlus).length}`)
console.log('-----------------------------')
