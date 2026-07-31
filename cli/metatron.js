#!/usr/bin/env node
// metatron — Metatron (dbbranch) panel CLI.
//
// Amac: AI ajan (veya insan) "su dalda calis" dediginde Postgres dalini
// otomatik secmek. `metatron use feat/x` panelden dalin baglanti dizesini
// alir (yoksa dal ACAR) ve repo kokundeki `.env.local`'e DATABASE_URL olarak
// yazar. Bundan sonra `drizzle-kit generate/migrate`, `npm run migrate` vb.
// her komut o dalin veritabanina gider.
//
// Sifre panelde saklanmaz: mevcut dal icin "credentials" ucu sifreyi
// DONDURUP yeni dize verir (eski dize gecersizlesir).
//
// Komutlar:
//   metatron login --url <panel> --token <dbb_...>   kimligi kaydet (~/.config/metatron)
//   metatron list [--project <slug>]                 dallari listele
//   metatron use <dal> [--project] [--no-create]     dala gec + .env.local yaz
//   metatron create <dal> [--project]                dal ac (baglanti dizesini bas)
//   metatron destroy <dal> [--project]               dali kaldir
//   metatron hook install|uninstall                  git post-checkout kancasi
//
// Ortam degiskenleri (CI): METATRON_URL, METATRON_TOKEN config'i ezer.

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONFIG_PATH = join(homedir(), '.config', 'metatron', 'config.json')
const HOOK_MARK = '# metatron-post-checkout'

// ── yardimcilar ──────────────────────────────────────────────────────

function die(msg, code = 1) {
  console.error(`metatron: ${msg}`)
  process.exit(code)
}

function parseArgs(argv) {
  const args = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { flags[k] = next; i++ }
      else flags[k] = true
    } else args.push(a)
  }
  return { args, flags }
}

function loadConfig() {
  const cfg = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {}
  // Ortam degiskenleri config'i ezer (CI'da dosya gerekmez).
  return {
    url: process.env.METATRON_URL ?? cfg.url,
    token: process.env.METATRON_TOKEN ?? cfg.token,
    defaultProject: process.env.METATRON_PROJECT ?? cfg.defaultProject,
  }
}

async function api(cfg, method, path, body) {
  const r = await fetch(`${cfg.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) die(`${method} ${path} -> ${r.status}: ${j.error ?? r.statusText}`)
  return j
}

function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return null }
}

function repoRoot() {
  return git('rev-parse', '--show-toplevel') ?? process.cwd()
}

// git remote origin'den owner/repo cikar (https ve ssh bicimi).
function remoteOwnerRepo() {
  const url = git('remote', 'get-url', 'origin')
  if (!url) return null
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/)
  return m ? { owner: m[1], repo: m[2] } : null
}

// Proje secimi: --project > git remote'a bagli repo > tek proje > config varsayilani.
async function resolveProject(cfg, flags) {
  const { projects } = await api(cfg, 'GET', '/api/projects')
  if (flags.project) {
    const p = projects.find((x) => x.slug === flags.project || x.name === flags.project)
    if (!p) die(`proje bulunamadi: ${flags.project} (var olanlar: ${projects.map((x) => x.slug).join(', ')})`)
    return p
  }
  const remote = remoteOwnerRepo()
  if (remote) {
    const { repos } = await api(cfg, 'GET', '/api/repos')
    const link = repos.find((r) => r.owner === remote.owner && r.repo === remote.repo)
    if (link) {
      const p = projects.find((x) => x.id === link.projectId)
      if (p) return p
    }
  }
  if (cfg.defaultProject) {
    const p = projects.find((x) => x.slug === cfg.defaultProject)
    if (p) return p
  }
  if (projects.length === 1) return projects[0]
  die(`proje secilemedi — --project ver (var olanlar: ${projects.map((x) => x.slug).join(', ') || 'YOK'})`)
}

// Dal adi panelde gitRef veya slug olarak durabilir.
function findBranch(branches, name) {
  return branches.find((b) => b.gitRef === name)
    ?? branches.find((b) => b.slug === name)
    ?? null
}

// Baglanti dizesi secimi: PgBouncer (tek adres, TLS) > SSH tunelli lokal > ic ag.
function pickConnection(j) {
  if (j.pgbouncerConnectionString) return { url: j.pgbouncerConnectionString, via: 'pgbouncer' }
  if (j.localConnectionString) return { url: j.localConnectionString, via: 'ssh-tunnel', tunnel: j.sshTunnel }
  if (j.connectionString) return { url: j.connectionString, via: 'internal' }
  return null
}

// .env.local'deki diger satirlari koruyarak DATABASE_URL'i gunceller.
function writeEnvLocal(dir, key, value) {
  const path = join(dir, '.env.local')
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []
  const seen = new Set()
  const out = lines
    .filter((l) => l.trim() !== '' )
    .map((l) => {
      const k = l.split('=')[0]
      if (k === key || k === 'METATRON_BRANCH') {
        if (seen.has(k)) return null
        seen.add(k)
        return k === key ? `${key}=${value}` : l // METATRON_BRANCH asagida yenilenir
      }
      return l
    })
    .filter((l) => l !== null && !l.startsWith('METATRON_BRANCH='))
  if (!seen.has(key)) out.push(`${key}=${value}`)
  writeFileSync(path, out.join('\n') + '\n', { mode: 0o600 })
  return path
}

function setMetaBranch(dir, slug) {
  const path = join(dir, '.env.local')
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => !l.startsWith('METATRON_BRANCH='))
  lines.push(`METATRON_BRANCH=${slug}`)
  writeFileSync(path, lines.filter((l, i) => l !== '' || i < lines.length - 1).join('\n'), { mode: 0o600 })
}

// .env.local gizli icerir — repo'ya commitlenmemeli.
function ensureGitignored(root) {
  const path = join(root, '.gitignore')
  const body = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (!body.split('\n').some((l) => l.trim() === '.env.local')) {
    writeFileSync(path, body + (body.endsWith('\n') || body === '' ? '' : '\n') + '.env.local\n')
  }
}

// ── komutlar ─────────────────────────────────────────────────────────

async function cmdLogin(flags) {
  if (!flags.url || !flags.token) die('kullanim: metatron login --url <panel> --token <dbb_...>')
  const cfg = { url: flags.url.replace(/\/$/, ''), token: flags.token }
  await api(cfg, 'GET', '/api/projects') // token gercekten calisiyor mu
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify({ url: cfg.url, token: cfg.token }, null, 2) + '\n', { mode: 0o600 })
  console.log(`kaydedildi: ${CONFIG_PATH}`)
}

async function cmdList(cfg, flags) {
  const p = await resolveProject(cfg, flags)
  const { branches } = await api(cfg, 'GET', `/api/branches?projectId=${p.id}`)
  if (branches.length === 0) { console.log('(dal yok)'); return }
  for (const b of branches) {
    console.log(`${b.status.padEnd(12)} ${b.slug.padEnd(40)} ${b.gitRef ?? ''}`)
  }
}

async function cmdUse(cfg, flags, name) {
  const quiet = !!flags.quiet
  const p = await resolveProject(cfg, flags)
  const { branches } = await api(cfg, 'GET', `/api/branches?projectId=${p.id}`)
  let b = findBranch(branches, name)

  let conn
  if (b) {
    // Mevcut dal: sifre saklanmadigi icin yeni dize = sifre dondurme.
    const j = await api(cfg, 'POST', `/api/branches/${encodeURIComponent(b.slug)}/credentials`)
    conn = pickConnection(j)
    if (!conn) die(`dal ${b.slug} icin baglanti dizesi kurulamadi`)
  } else {
    if (flags['no-create']) die(`dal yok: ${name} (--no-create verildi)`)
    if (!quiet) console.error(`dal yok, aciliyor: ${name}`)
    const j = await api(cfg, 'POST', '/api/branches', { projectId: p.id, name })
    b = { slug: j.slug }
    conn = pickConnection(j)
    if (!conn) die(`dal acildi (${j.slug}) ama baglanti dizesi donmedi`)
  }

  const root = repoRoot()
  const envPath = writeEnvLocal(root, 'DATABASE_URL', conn.url)
  setMetaBranch(root, b.slug)
  ensureGitignored(root)

  if (conn.via === 'ssh-tunnel' && conn.tunnel && !quiet) {
    console.error(`not: bu adrese ulasmak icin once tunel: ${conn.tunnel}`)
  }
  if (!quiet) console.error(`${b.slug} -> ${envPath} (${conn.via})`)
  // eval $(metatron use ...) deseni icin stdout'a export satiri:
  console.log(`export DATABASE_URL='${conn.url}'`)
}

async function cmdDestroy(cfg, flags, name) {
  const p = await resolveProject(cfg, flags)
  const { branches } = await api(cfg, 'GET', `/api/branches?projectId=${p.id}`)
  const b = findBranch(branches, name)
  if (!b) die(`dal yok: ${name}`)
  await api(cfg, 'POST', `/api/branches/${encodeURIComponent(b.slug)}/destroy`)
  console.log(`kaldirildi: ${b.slug}`)
}

function cmdHook(sub) {
  const root = git('rev-parse', '--show-toplevel')
  if (!root) die('git reposu icinde degilsiniz')
  const hookPath = join(root, '.git', 'hooks', 'post-checkout')
  if (sub === 'install') {
    const body = `#!/bin/sh
${HOOK_MARK}
# Dal degisiminde (arg3=1) DB dalini arka planda .env.local'e yaz.
# Panel ulasilamazsa checkout'u BLOKE ETME — yalnizca uyar.
if [ "$3" = "1" ]; then
  br="$(git rev-parse --abbrev-ref HEAD)"
  ( metatron use --quiet "$br" 2>>.git/metatron-hook.log \
      || echo "metatron: '$br' icin DB dali ayarlanamadi (bkz .git/metatron-hook.log)" ) &
fi
`
    writeFileSync(hookPath, body, { mode: 0o755 })
    console.log(`kuruldu: ${hookPath}`)
    console.log('bundan boyle `git checkout <dal>` DB dalini da ayarlar.')
  } else if (sub === 'uninstall') {
    if (existsSync(hookPath) && readFileSync(hookPath, 'utf8').includes(HOOK_MARK)) {
      writeFileSync(hookPath, '')
      console.log('kaldirildi (bosaltildi): ' + hookPath)
    } else {
      console.log('metatron kancasi bulunamadi — dokunulmadi.')
    }
  } else {
    die('kullanim: metatron hook install|uninstall')
  }
}

// ── giris ────────────────────────────────────────────────────────────

const { args, flags } = parseArgs(process.argv.slice(2))
const cmd = args[0]

try {
  if (cmd === 'login') {
    await cmdLogin(flags)
  } else if (cmd === 'hook') {
    cmdHook(args[1])
  } else if (cmd === 'list') {
    await cmdList(requireConfig(), flags)
  } else if (cmd === 'use') {
    if (!args[1]) die('kullanim: metatron use <dal> [--project <slug>] [--no-create] [--quiet]')
    await cmdUse(requireConfig(), flags, args[1])
  } else if (cmd === 'create') {
    if (!args[1]) die('kullanim: metatron create <dal>')
    // create = use --no-create'in tersi; ac ve baglan.
    await cmdUse(requireConfig(), flags, args[1])
  } else if (cmd === 'destroy') {
    if (!args[1]) die('kullanim: metatron destroy <dal>')
    await cmdDestroy(requireConfig(), flags, args[1])
  } else {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
      .filter((l) => l.startsWith('//')).slice(0, 24).map((l) => l.slice(3)).join('\n'))
    process.exit(cmd ? 1 : 0)
  }
} catch (e) {
  if (e?.cause?.code === 'ECONNREFUSED') die(`panele ulasilamiyor: ${loadConfig().url}`)
  die(e?.message ?? String(e))
}

function requireConfig() {
  const cfg = loadConfig()
  if (!cfg.url || !cfg.token) die('once: metatron login --url <panel> --token <dbb_...>')
  return cfg
}
