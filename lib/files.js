const fs = require('fs')
const { CONFIG_PATH, USERNAMES_PATH } = require('./config')

function readUserNames() {
  try {
    return fs.existsSync(USERNAMES_PATH) ? JSON.parse(fs.readFileSync(USERNAMES_PATH, 'utf8')) : {}
  } catch { return {} }
}

function writeUserNames(names) {
  fs.writeFileSync(USERNAMES_PATH, JSON.stringify(names, null, 2))
}

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
}

function writeConfig(data) {
  const serialized = JSON.stringify(data, null, 2)
  const tmpPath = CONFIG_PATH + '.tmp'
  fs.writeFileSync(tmpPath, serialized)
  fs.renameSync(tmpPath, CONFIG_PATH)
}

module.exports = { readUserNames, writeUserNames, readConfig, writeConfig }
