import { newTarget, connect, evaluate } from './.audit-cdp.mjs'

const HOOK = `
(() => {
  const commits = { n: 0, byRoot: 0, samples: [] };
  const t0 = performance.now();
  const renderers = new Map();
  let id = 0;
  const hook = {
    renderers,
    supportsFiber: true,
    isDisabled: false,
    inject(renderer) { const i = ++id; renderers.set(i, renderer); return i; },
    onCommitFiberRoot(id_, root) {
      commits.n++;
      commits.byRoot++;
      if (commits.samples.length < 40) {
        // count how many fibers had work
        let changed = 0;
        try {
          const walk = (f) => { if (!f) return; if (f.alternate) changed++; let c = f.child; while (c) { walk(c); c = c.sibling; } };
          walk(root.current.child);
        } catch {}
        commits.samples.push({ t: Math.round(performance.now() - t0), changed });
      }
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberUnmountByRenderer() {},
    checkDCE() {},
    emit() {},
    getFiberRoots() {},
    getCurrentFiber() { return null; },
    scheduleUpdate() {},
    setStrictMode() {},
  };
  Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: hook, configurable: true, writable: true });
  window.__commits = commits;
})();
`

const url = process.argv[2] ?? 'http://127.0.0.1:8443/#/admin'
const seconds = Number(process.argv[3] ?? 25)
const doLogin = process.argv[4] !== 'nolgin'

const t = await newTarget('about:blank')
const { ws, send } = await connect(t.webSocketDebuggerUrl)
await send('Page.enable')
await send('Runtime.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK })
await send('Page.navigate', { url })
await new Promise((r) => setTimeout(r, 3500))

const log = (...a) => console.log('·', ...a)

if (doLogin) {
  const hasForm = await evaluate(send, `!!document.getElementById('admin-username')`)
  if (hasForm) {
    await evaluate(send, `(() => {
      const set = (el, v) => {
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        desc.set.call(el, v);
        el.dispatchEvent(new Event('input', {bubbles:true}));
      };
      set(document.getElementById('admin-username'), 'gary.whitlock');
      set(document.getElementById('admin-password'), 'Ballot-Demo-2026');
      return true;
    })()`)
    await new Promise((r) => setTimeout(r, 300))
    await evaluate(send, `(() => { const f=document.querySelector('form'); f.requestSubmit(); return true })()`)
    log('submitted login')
    await new Promise((r) => setTimeout(r, 4000))
  } else {
    log('no login form; already signed in?', await evaluate(send, `document.body.innerText.slice(0,120)`))
  }
}

const where = await evaluate(send, `({ hash: location.hash, nodes: document.querySelectorAll('*').length, rows: document.querySelectorAll('tbody tr').length, text: document.body.innerText.slice(0,80).replace(/\\n/g,' | ') })`)
log('location', JSON.stringify(where))

await evaluate(send, `(() => { window.__commits.n = 0; window.__commits.samples.length = 0; return true })()`)
await new Promise((r) => setTimeout(r, seconds * 1000))

const out = await evaluate(send, `({
  commits: window.__commits.n,
  perSecond: +(window.__commits.n / ${seconds}).toFixed(2),
  samples: window.__commits.samples.slice(0, 25),
  nodes: document.querySelectorAll('*').length,
  rows: document.querySelectorAll('tbody tr').length,
  navigable: [...document.querySelectorAll('.control-nav-item')].map(b=>b.innerText.trim().split('\\n')[0])
})`)
console.log(JSON.stringify(out, null, 2))
ws.close()
process.exit(0)
