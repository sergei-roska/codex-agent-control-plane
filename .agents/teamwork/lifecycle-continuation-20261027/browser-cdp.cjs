const fs = require('node:fs');
(async () => {
  const [endpoint, url, output, widthArg, heightArg] = process.argv.slice(2);
  const pages = await (await fetch(endpoint + '/json/list')).json();
  const target = pages.find(page => page.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  const exceptions = [];
  socket.addEventListener('message', event => {
    const packet = JSON.parse(event.data);
    if (packet.method === 'Runtime.exceptionThrown') exceptions.push(packet.params.exceptionDetails.text);
    if (!packet.id) return;
    const task = pending.get(packet.id);
    if (!task) return;
    pending.delete(packet.id);
    packet.error ? task.reject(new Error(packet.error.message)) : task.resolve(packet.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  try {
    await call('Page.enable'); await call('Runtime.enable');
    const width = Number(widthArg), height = Number(heightArg);
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
    await call('Page.navigate', { url });
    let evidence;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 150));
      const result = await call('Runtime.evaluate', { expression: "document.getElementById('visual-evidence')?.textContent", returnByValue: true });
      if (result.result.value) { evidence = JSON.parse(result.result.value); break; }
    }
    if (!evidence) throw new Error('Missing rendered browser evidence');
    evidence.exceptions = exceptions;
    const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(output + '.png', Buffer.from(screenshot.data, 'base64'));
    fs.writeFileSync(output + '.json', JSON.stringify(evidence, null, 2) + '\n');
    process.stdout.write(JSON.stringify(evidence) + '\n');
  } finally { socket.close(); }
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
