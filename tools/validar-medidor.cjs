// Validación del medidor de consola contra el banco de prueba local (NO es el chat real).
// Requiere: node tools/mock-sse-server.mjs  (puerto 8787) en otra terminal.
// Uso: node tools/validar-medidor.cjs
// Validación única del medidor de consola contra el banco de prueba local (no es el chat real).
(async () => {
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const snippet = readFileSync(process.argv[2] || require('node:path').join(__dirname, 'medidor-chat-consola.js'), 'utf8');
const casos = [
  { nombre: 'fluido, CPU 1x', mode: 'fluido', cpu: 1 },
  
  { nombre: 'pausa 10 s, CPU 1x', mode: 'pausa', cpu: 1 },
];
const browser = await chromium.launch();
for (const c of casos) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errores = [];
  page.on('pageerror', (e) => errores.push(String(e)));
  await page.goto(`http://localhost:8787/?mode=${c.mode}`);
  if (c.cpu > 1) { const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: c.cpu }); }
  await page.evaluate(snippet);                       // equivale a pegarlo en la consola
  await page.evaluate(() => __lecoMedidor.etiquetar('validación'));
  await page.click('#enviar');
  await page.waitForFunction(() => window.__lecoMedidor && __lecoMedidor.resultados.length > 0, null, { timeout: 120000 });
  const r = await page.evaluate(() => __lecoMedidor.resultados[0]);
  console.log(JSON.stringify({ caso: c.nombre, errores, ...r }));
  await page.close();
}
await browser.close();
})();
