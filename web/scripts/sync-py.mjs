// Copy the Python generator (../galaxy.py) into public/py so the Pyodide worker can load it.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '../../galaxy.py')
const dstDir = resolve(here, '../public/py')
mkdirSync(dstDir, { recursive: true })
copyFileSync(src, resolve(dstDir, 'galaxy.py'))
console.log('synced galaxy.py -> public/py/galaxy.py')
