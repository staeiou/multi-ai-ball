#!/usr/bin/env node
// Syncs Auditomatic Lite's maintained provider configs into vendor/providers.
// The configs are the source of truth for base URLs, auth, extraction paths,
// parameter rules, and structured-output support; this app interprets them
// and never re-declares them. Run after upstream config changes:
//
//   npm run sync:providers
//
// Only group.json + endpoints/*.json are copied — environmental cost data and
// pricing seeds are not used here (pricing comes from live endpoints).

import { cpSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..')
const source = resolve(appRoot, '..', 'alfresh', 'src', 'config', 'providers')
const target = join(appRoot, 'vendor', 'providers')

if (!statSync(source, { throwIfNoEntry: false })) {
  console.error(`Provider config source not found: ${source}`)
  process.exit(1)
}

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

let copied = 0
for (const group of readdirSync(source)) {
  const groupDir = join(source, group)
  if (!statSync(groupDir).isDirectory()) continue
  const groupOut = join(target, group)
  mkdirSync(groupOut, { recursive: true })

  for (const file of ['group.json']) {
    const from = join(groupDir, file)
    if (statSync(from, { throwIfNoEntry: false })) {
      cpSync(from, join(groupOut, file))
      copied++
    }
  }

  const endpointsDir = join(groupDir, 'endpoints')
  if (statSync(endpointsDir, { throwIfNoEntry: false })) {
    const endpointsOut = join(groupOut, 'endpoints')
    mkdirSync(endpointsOut, { recursive: true })
    for (const file of readdirSync(endpointsDir)) {
      if (!file.endsWith('.json')) continue
      cpSync(join(endpointsDir, file), join(endpointsOut, file))
      copied++
    }
  }
}

console.log(`Synced ${copied} provider config files into ${target}`)
