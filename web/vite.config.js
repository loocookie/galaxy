import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Single source of truth for the share-code version: GENERATOR_VERSION in ../galaxy.py
const galaxyPy = readFileSync(new URL('../galaxy.py', import.meta.url), 'utf8')
const genVersion = Number(galaxyPy.match(/^GENERATOR_VERSION = (\d+)/m)?.[1])
if (!genVersion) throw new Error('GENERATOR_VERSION not found in galaxy.py')
// Difficulty levels per size (code letter -> [label, tiers]), also from galaxy.py
const levelsJson = galaxyPy.match(/^LEVELS_JSON = '''([\s\S]*?)'''/m)?.[1]
if (!levelsJson) throw new Error('LEVELS_JSON not found in galaxy.py')
const levels = JSON.parse(levelsJson)

// base './' so the build also works from a sub-path (e.g. GitHub Pages)
export default defineConfig({
  base: './',
  plugins: [react()],
  define: { __GEN_VERSION__: JSON.stringify(genVersion), __LEVELS__: JSON.stringify(levels) },
})
