import { newTarget, connect, evaluate } from './.audit-cdp.mjs'

const url = process.argv[2] ?? 'http://127.0.0.1:8443/#/admin'
const seconds = Number(process.argv[3] ?? 15)
const script = process.argv[4] ?? 'null'

const t = await newTarget(url)
const { ws, send, events } = await connect(t.webSocketDebuggerUrl)
await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
await send('Network.enable')

// wait for load
await new Promise((r) => setTimeout(r, 4000))

// count React commits via a MutationObserver on the root's childList+characterData,
// which fires once per committed DOM mutation batch.
await evaluate(send, `(() => {
  const root = document.getElementById('root');
  window.__commits = 0;
  window.__mutations = 0;
  const po = new PerformanceObserver((l) => { window.__longTasks = (window.__longTasks||0); for (const e of l.getEntries()) window.__longTasks += e.duration; });
  try { po.observe({entryTypes:['longtask']}); } catch {}
  let depth = 0, scheduled = false;
  const mo = new MutationObserver(() => { window.__mutations += mo.takeRecords().length; window.__commits++; });
  mo.observe(root, {subtree:true, childList:true, characterData:true});
  window.__mo = mo;
  return true;
})()`)

await new Promise((r) => setTimeout(r, seconds * 1000))

const out = await evaluate(send, `(() => ({
  commits: window.__commits,
  mutations: window.__mutations,
  longTaskMs: window.__longTasks || 0,
  domNodes: document.querySelectorAll('*').length,
  rows: document.querySelectorAll('tbody tr').length,
  scripts: [...document.querySelectorAll('script')].map(s=>s.src),
  perf: performance.getEntriesByType('resource').map(r=>({n:r.name.split('/').pop(), t:Math.round(r.startTime), dur:+r.duration.toFixed(1), size:r.transferSize, enc:r.encodedBodySize}))
}))()`)

const extra = script !== 'null' ? await evaluate(send, script) : null

console.log(JSON.stringify({ url, window: seconds + 's', ...out, extra }, null, 2))
ws.close()
process.exit(0)
