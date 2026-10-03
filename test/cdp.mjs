// Minimale DevTools-protocolclient voor de browsertests, zonder dependencies
// (ingebouwde WebSocket van Node 22). Start een headless Chromium op CHROME.

import { spawn } from 'node:child_process';

export const wacht = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startBrowser(chromePad, poort = 9333) {
  if (!chromePad) {
    console.error('Zet CHROME op het pad van een (headless) Chromium.');
    process.exit(2);
  }
  const proces = spawn(chromePad, ['--no-sandbox', '--headless', '--hide-scrollbars', `--remote-debugging-port=${poort}`, 'about:blank'], { stdio: 'ignore' });
  let wsUrl;
  for (let i = 0; i < 50 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${poort}/json/version`)).json()).webSocketDebuggerUrl; } catch { await wacht(100); }
  }
  if (!wsUrl) throw new Error('browser start niet');
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  let volgnr = 0;
  const wachtend = new Map();
  const fouten = [];
  const luisteraars = new Map();
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && wachtend.has(d.id)) { wachtend.get(d.id)(d); wachtend.delete(d.id); return; }
    for (const fn of luisteraars.get(d.method) || []) fn(d.params);
    if (d.method === 'Runtime.exceptionThrown') fouten.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') fouten.push(d.params.args.map((a) => a.value).join(' '));
  });
  const stuur = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++volgnr;
    wachtend.set(id, (d) => (d.error ? rej(new Error(method + ': ' + d.error.message)) : res(d.result)));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

  const { targetId } = await stuur('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await stuur('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => stuur(m, p, sessionId);
  await s('Page.enable');
  await s('Runtime.enable');

  return {
    s,
    fouten,
    /** Evalueert een expressie in de pagina en geeft de waarde terug. */
    async evalueer(expressie) {
      const { result, exceptionDetails } = await s('Runtime.evaluate', { expression: expressie, returnByValue: true, awaitPromise: true });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
      return result.value;
    },
    async viewport(w, h, mobiel) {
      await s('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: mobiel });
    },
    async open(url, ms = 900) {
      await s('Page.navigate', { url });
      await wacht(ms);
    },
    async toets(key, code = key, keyCode = 0) {
      for (const type of ['keyDown', 'keyUp']) await s('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode });
    },
    /** Roept fn aan bij elk protocol-event met deze naam (bijv. Fetch.requestPaused). */
    opEvent(methode, fn) {
      luisteraars.set(methode, [...(luisteraars.get(methode) || []), fn]);
    },
    stop() { ws.close(); proces.kill(); },
  };
}
