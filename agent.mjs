/**
 * Penniless Agent watcher (trimmed from Echolonius/echo-earning-agent).
 * Runs on GitHub Actions every 30 min. Read-only: no private keys, no spending.
 *   1. reads USDC balances of YOUR receive-only wallets (Base + Solana) and native SOL
 *   2. scans Superteam agent listings (skipped unless SUPERTEAM_API_KEY secret exists)
 *   3. tracks YOUR open-source PRs (open / merged)
 *   4. writes status.md + appends history.jsonl
 * A payment landing or a PR merging fails the run once, so GitHub emails you.
 */
import { writeFileSync, appendFileSync, readFileSync, unlinkSync } from 'node:fs'

// ---- EDIT THESE THREE LINES (public addresses only, never a private key) ----
const EVM_WALLET = ''      // Base USDC, starts with 0x. Leave '' to skip.
const SOL_WALLET = '2BaLfgxWBqNRwf6MquueXYvUy8Xa1GUpU8g7UfK1yC8K'    // Solana address. Leave '' to skip.
const GITHUB_USER = 'DeeDubs57'  // your GitHub username, for the PR tracker
// -----------------------------------------------------------------------------

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const SOL_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const now = new Date().toISOString()
const T = (ms) => AbortSignal.timeout(ms)

async function baseUsdc() {
  if (!EVM_WALLET) return 'n/a'
  try {
    const r = await fetch('https://mainnet.base.org', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: T(15000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: BASE_USDC, data: '0x70a08231000000000000000000000000' + EVM_WALLET.slice(2).toLowerCase() }, 'latest'] }),
    })
    const j = await r.json()
    if (j.error) return `err:${j.error.message}`
    return Number(BigInt(j.result || '0x0')) / 1e6
  } catch (e) { return `err:${e.message}` }
}

async function solRpc(method, params) {
  const r = await fetch('https://api.mainnet-beta.solana.com', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: T(15000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await r.json()
  if (j.error) throw new Error(j.error.message)
  return j.result
}
async function solUsdc() {
  if (!SOL_WALLET) return 'n/a'
  try {
    const res = await solRpc('getTokenAccountsByOwner', [SOL_WALLET, { mint: SOL_USDC_MINT }, { encoding: 'jsonParsed' }])
    return (res?.value ?? []).reduce((s, a) => s + (Number(a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount) || 0), 0)
  } catch (e) { return `err:${e.message}` }
}
async function solNative() {
  if (!SOL_WALLET) return 'n/a'
  try { return ((await solRpc('getBalance', [SOL_WALLET]))?.value ?? 0) / 1e9 } catch (e) { return `err:${e.message}` }
}

async function superteamLive() {
  const key = process.env.SUPERTEAM_API_KEY
  if (!key) return { skipped: 'no SUPERTEAM_API_KEY secret (optional)' }
  try {
    const r = await fetch('https://superteam.fun/api/agents/listings/live?take=50', { headers: { Authorization: `Bearer ${key}` }, signal: T(15000) })
    if (!r.ok) return { error: `HTTP ${r.status}` }
    const d = await r.json()
    const items = Array.isArray(d) ? d : d.result || []
    const open = items.filter((l) => (l.deadline || '9999') > now)
      .map((l) => ({ slug: l.slug, type: l.type, reward: l.rewardAmount, token: l.token, access: l.agentAccess, deadline: (l.deadline || '').slice(0, 10) }))
      .sort((a, b) => (b.access === 'AGENT_ONLY' ? 1 : 0) - (a.access === 'AGENT_ONLY' ? 1 : 0) || (b.reward || 0) - (a.reward || 0))
    return { total: items.length, open }
  } catch (e) { return { error: e.message } }
}

// Public Superteam listings that accept agents. Backup for the agent feed, which returned [] from
// 2026-09-21. Needs no key. Caches each slug's access level so a listing's details load only once.
let accessCache = {}
try { accessCache = JSON.parse(readFileSync(new URL('./listing-access.json', import.meta.url), 'utf8')) } catch {}
async function superteamPublic() {
  try {
    const r = await fetch('https://superteam.fun/api/listings?take=200&tab=all', { signal: T(20000) })
    if (!r.ok) return { error: `HTTP ${r.status}` }
    const open = (await r.json()).filter((l) => (l.deadline || '') > now)
    for (const l of open.filter((l) => !accessCache[l.slug]).slice(0, 40)) {
      try {
        const d = await (await fetch(`https://superteam.fun/api/listings/details/${l.slug}`, { signal: T(10000) })).json()
        accessCache[l.slug] = { access: d.agentAccess || 'unknown', sponsor: d.sponsor?.name, verified: Boolean(d.sponsor?.isVerified) }
      } catch {}
    }
    writeFileSync(new URL('./listing-access.json', import.meta.url), JSON.stringify(accessCache))
    const agentOk = open.filter((l) => ['AGENT_ALLOWED', 'AGENT_ONLY'].includes(accessCache[l.slug]?.access))
      .map((l) => ({ slug: l.slug, title: (l.title || '').slice(0, 70), type: l.type, reward: l.rewardAmount, token: l.token,
        access: accessCache[l.slug].access, sponsor: accessCache[l.slug].sponsor, deadline: (l.deadline || '').slice(0, 10) }))
    return { scanned: open.length, open: agentOk }
  } catch (e) { return { error: e.message } }
}

// Pay-per-merge bounties, but ONLY from orgs with a verified Algora payout history ("has been awarded").
// Open "💎 Bounty" labels elsewhere are mostly free-work harvesters. Edit this list as evidence changes.
const PROVEN_PAYERS = ['CapSoftware', 'Mudlet', 'rustdesk', 'permitio', 'outerbase', 'tscircuit', 'archestra-ai', 'activepieces', 'qdrant', 'tursodatabase']
async function provenBounties() {
  try {
    const q = encodeURIComponent(`is:issue is:open label:"💎 Bounty" -label:"💰 Rewarded" ${PROVEN_PAYERS.map((o) => `org:${o}`).join(' ')} created:>2026-06-01`)
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'penniless-watcher' }
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
    const r = await fetch(`https://api.github.com/search/issues?q=${q}&per_page=30&sort=created`, { headers, signal: T(15000) })
    if (!r.ok) return { error: `HTTP ${r.status}` }
    const items = (await r.json()).items || []
    return { open: items.map((i) => ({ url: i.html_url, repo: (i.repository_url || '').split('/').slice(-2).join('/'), title: (i.title || '').slice(0, 70),
      comments: i.comments, created: (i.created_at || '').slice(0, 10), reward: (i.labels || []).map((l) => l.name).find((n) => /^\$[\d.,]+k?$/.test(n)) || '?' })) }
  } catch (e) { return { error: e.message } }
}

// Your PRs to repos you don't own (bounty work). Merged = billable, not paid.
async function githubPrs() {
  if (!GITHUB_USER) return { skipped: true }
  try {
    const q = encodeURIComponent(`author:${GITHUB_USER} type:pr -user:${GITHUB_USER}`)
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'penniless-watcher' }
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
    const r = await fetch(`https://api.github.com/search/issues?q=${q}&per_page=50&sort=created`, { headers, signal: T(15000) })
    if (!r.ok) return { error: `HTTP ${r.status}` }
    const d = await r.json()
    const prs = (d.items || []).map((p) => ({
      repo: (p.repository_url || '').split('/').slice(-2).join('/'),
      num: p.number, url: p.html_url, title: (p.title || '').slice(0, 60),
      merged: Boolean(p.pull_request && p.pull_request.merged_at), state: p.state,
    }))
    return { total: prs.length, merged: prs.filter((p) => p.merged).length, prs }
  } catch (e) { return { error: e.message } }
}

const [usdc, solUsdcBal, solNativeBal, superteamFeed, pub, github, proven] = await Promise.all([baseUsdc(), solUsdc(), solNative(), superteamLive(), superteamPublic(), githubPrs(), provenBounties()])
// Merge both sources: agent feed (incl. hidden AGENT_ONLY) + public listings that accept agents.
const merged = new Map()
for (const o of [...(superteamFeed.open || []), ...(pub.open || [])]) if (!merged.has(o.slug)) merged.set(o.slug, o)
const superteam = (superteamFeed.open || pub.open)
  ? { total: (superteamFeed.total || 0) + (pub.scanned || 0), open: [...merged.values()].sort((a, b) => (b.access === 'AGENT_ONLY') - (a.access === 'AGENT_ONLY') || (b.reward || 0) - (a.reward || 0)),
      note: `agent feed: ${superteamFeed.skipped ? 'no key' : superteamFeed.error || (superteamFeed.open || []).length} · public: ${pub.error || (pub.open || []).length}` }
  : { error: `agent feed: ${superteamFeed.skipped || superteamFeed.error} · public: ${pub.error}` }

// Compare against the LAST GOOD value of each field, not the last line. If an RPC call failed last
// run, a payment that landed meanwhile would otherwise never alert.
let history = []
try { history = readFileSync(new URL('./history.jsonl', import.meta.url), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch {}
const lastGood = (get) => { for (let i = history.length - 1; i >= 0; i--) { const v = get(history[i]); if (typeof v === 'number') return v } return undefined }
const prevBase = lastGood((h) => h.baseUsdc), prevSol = lastGood((h) => h.solUsdc), prevSolNative = lastGood((h) => h.solNative), prevMerged = lastGood((h) => h.github?.merged)
const diff = (a, b) => (typeof a === 'number' && typeof b === 'number') ? +(a - b).toFixed(9) : 0
const delta = diff(usdc, prevBase)
const solDelta = diff(solUsdcBal, prevSol)
const solNativeDelta = diff(solNativeBal, prevSolNative)
const newMerge = typeof prevMerged === 'number' && typeof github.merged === 'number' && github.merged > prevMerged
const paid = delta > 0 || solDelta > 0 || solNativeDelta > 0

let seen = []
try { seen = JSON.parse(readFileSync(new URL('./seen-listings.json', import.meta.url), 'utf8')) } catch {}
const open = superteam.open || []
const fresh = open.filter((o) => !seen.includes(o.slug))
// New bounties from proven payers. The first scan only records them, so it sends no alert.
const provenOpen = proven.open || []
const firstProvenScan = !seen.some((x) => String(x).startsWith('http'))
const freshProven = firstProvenScan ? [] : provenOpen.filter((b) => !seen.includes(b.url))
writeFileSync(new URL('./seen-listings.json', import.meta.url), JSON.stringify([...new Set([...seen, ...open.map((o) => o.slug), ...provenOpen.map((b) => b.url), ...(firstProvenScan ? ['http:init'] : [])])]))

const snapshot = { ts: now, baseUsdc: usdc, solUsdc: solUsdcBal, solNative: solNativeBal, delta, solDelta, solNativeDelta,
  github: { total: github.total, merged: github.merged, error: github.error }, superteam: { total: superteam.total, open: open.length, skipped: superteam.skipped, error: superteam.error }, newListings: fresh.map((o) => o.slug) }
// Append history only when something changed, so the file stays small (the author's grew to 1,185 lines).
const strip = (s) => JSON.stringify({ ...s, ts: undefined })
if (!history.length || strip(history[history.length - 1]) !== strip(snapshot)) {
  appendFileSync(new URL('./history.jsonl', import.meta.url), JSON.stringify(snapshot) + '\n')
}

const flag = (d, unit) => d > 0 ? ` · **+${d} ${unit} received since last run**` : ''
const md = `# Penniless Agent status

_Last run: ${now} (UTC), on GitHub Actions._

## Wallets (VERIFIED money, read from the public blockchain)
- Base USDC \`${EVM_WALLET || 'not set'}\`: **${usdc}**${flag(delta, 'USDC')}
- Solana USDC \`${SOL_WALLET || 'not set'}\`: **${solUsdcBal}**${flag(solDelta, 'USDC')}
- Solana native SOL: **${solNativeBal}**${flag(solNativeDelta, 'SOL')}

## Your PRs to other repos (merged = eligible, not paid)
${github.skipped ? '_not set_' : github.error ? `_err: ${github.error}_` : github.prs.length
  ? `${github.merged}/${github.total} merged${newMerge ? ' · **A PR JUST MERGED: send the invoice / claim now**' : ''}\n` + github.prs.map((p) => `- ${p.merged ? 'MERGED' : p.state === 'closed' ? 'closed' : 'open'} · [${p.repo}#${p.num}](${p.url}) ${p.title}`).join('\n')
  : '_no PRs yet_'}

## Open bounties from orgs with a verified payout history
${proven.error ? `_err: ${proven.error}_` : proven.open.length
  ? proven.open.map((b) => `- [${b.repo}: ${b.title}](${b.url}) · ${b.reward} · ${b.comments} comments · opened ${b.created}`).join('\n')
  : '_none open right now_'}

## Open Superteam agent listings (AGENT_ONLY first)
${superteam.skipped ? `_scan skipped: ${superteam.skipped}_` : superteam.error ? `_scan error: ${superteam.error}_`
  : `_${superteam.note}_\n` + (open.length ? open.map((o) => `- ${o.access === 'AGENT_ONLY' ? '**AGENT_ONLY**' : 'agent-allowed'} · [${o.title || o.slug}](https://superteam.fun/earn/listing/${o.slug}) · ${o.sponsor || ''} · ${o.type} · ${o.reward} ${o.token || ''} · deadline ${o.deadline}`).join('\n') : '_none open right now_')}
${fresh.length ? `\n## New since last run\n${fresh.map((o) => `- \`${o.slug}\` · ${o.reward} ${o.token || ''}`).join('\n')}\n` : ''}
---
_Rewritten by \`agent.mjs\` every run. History in \`history.jsonl\`._
`
writeFileSync(new URL('./status.md', import.meta.url), md)

const NOTIFY = new URL('./NOTIFY.txt', import.meta.url)
if (paid || newMerge || freshProven.length || fresh.length) {
  writeFileSync(NOTIFY, (paid ? `PAYMENT RECEIVED (${now}) Base USDC ${usdc}, Solana USDC ${solUsdcBal}, SOL ${solNativeBal}`
    : newMerge ? `PR MERGED (${now}): check status.md and send the invoice/claim`
    : `NEW WORK (${now}): ${[...freshProven.map((b) => `${b.repo} ${b.reward} ${b.url}`), ...fresh.map((o) => `Superteam ${o.reward} ${o.slug}`)].join(' | ')}. Run the payment check before any work.`) + '\n')
} else { try { unlinkSync(NOTIFY) } catch {} }

console.log('status:', JSON.stringify(snapshot))
