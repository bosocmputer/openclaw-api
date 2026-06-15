const fs = require('fs')
const { USERNAMES_PATH } = require('./config')
const { readOpenclawConfig, writeOpenclawConfigAtomic } = require('./openclaw-config')

function readUserNames() {
  try {
    return fs.existsSync(USERNAMES_PATH) ? JSON.parse(fs.readFileSync(USERNAMES_PATH, 'utf8')) : {}
  } catch { return {} }
}

function writeUserNames(names) {
  fs.writeFileSync(USERNAMES_PATH, JSON.stringify(names, null, 2))
}

function readConfig() {
  return readOpenclawConfig()
}

function writeConfig(data) {
  return writeOpenclawConfigAtomic(data)
}

module.exports = { readUserNames, writeUserNames, readConfig, writeConfig }
