const path = require('path')

const HOME = process.env.HOME
const CONFIG_PATH = path.join(HOME, '.openclaw/openclaw.json')
const USERNAMES_PATH = path.join(HOME, '.openclaw/usernames.json')

// openclaw CLI ต้องรันจาก package directory เพราะใช้ relative path หา dist/
const OPENCLAW_PKG = process.env.OPENCLAW_PKG || ''
const execOpts = OPENCLAW_PKG ? { cwd: OPENCLAW_PKG } : {}

module.exports = { HOME, CONFIG_PATH, USERNAMES_PATH, OPENCLAW_PKG, execOpts }
