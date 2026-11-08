#!/usr/bin/env node
/**
 * Servidor SSE simulado · Fase 1 (diagnóstico) y base de la Fase 6 (regresión).
 * Cero dependencias. Reproduce, de forma controlada, los síntomas del chat:
 *
 *   fluido      Headers correctos, comentario inmediato, 1 token cada `interval` ms.
 *   buffer      Mismo contenido, pero el servidor lo acumula y lo envía todo al final
 *               (simula una plataforma/proxy que no hace flush).
 *   gzip        Comprime la ruta SSE sin flush (zlib acumula ~16 KB → llega de golpe).
 *   rafagas     Grupos de 20 tokens cada 800 ms (texto "a tirones").
 *   pausa       Fluido, pero se detiene 10 s a la mitad (atasco).
 *   corte       Corta el socket a la mitad, sin evento final (conexión caída).
 *   ttft-lento  3 s de silencio total antes del primer byte (sin comentario inicial).
 *
 * Uso:
 *   node tools/mock-sse-server.mjs [--port 8787]
 *   curl -N "http://localhost:8787/sse?mode=fluido"
 *   GET /            → página de chat "ingenua" para validar el arnés de navegador
 *
 * Formato de eventos (estilo OpenAI/Anthropic simplificado):
 *   : ok                         (comentario de apertura)
 *   data: {"delta":"texto"}      (token)
 *   data: [DONE]                 (cierre limpio)
 */
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || Number(process.env.PORT) || 8787;

// Texto FICTICIO de ejemplo (no corresponde a ningún proyecto) con párrafos, lista, tabla y código.
const RESPUESTA = `## Resumen de avance

El **frente norte** presenta un avance físico de 62 % y el sur de 48 %. A continuación el detalle por partida, con las observaciones de terreno y los pendientes que requieren decisión.

- Excavación: terminada en tramos 1 a 4.
- Hormigón: pendiente ensayo de probetas a 28 días.
- Topografía: falta replanteo del eje secundario.

| Partida | Avance | Estado |
|---|---|---|
| Excavación | 100 % | Cerrada |
| Hormigón | 55 % | En curso |
| Topografía | 30 % | Atrasada |

\`\`\`js
const avance = partidas.reduce((s, p) => s + p.peso * p.avance, 0);
console.log(\`Avance ponderado: \${avance.toFixed(1)} %\`);
\`\`\`

Recomiendo priorizar topografía esta semana para no bloquear el hormigonado del tramo 5.`;

/** Trocea en "tokens" de 1–4 caracteres respetando espacios, como hacen los LLM. */
function tokenizar(texto) {
  const partes = texto.match(/\s+|[^\s]{1,4}/g) ?? [];
  return partes;
}
const TOKENS = tokenizar(RESPUESTA);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evento = (delta) => `data: ${JSON.stringify({ delta })}\n\n`;

const HEADERS_OK = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
  Connection: 'keep-alive',
  'Access-Control-Allow-Origin': '*',
};

async function servirSSE(req, res, url) {
  const mode = url.searchParams.get('mode') || 'fluido';
  const interval = Number(url.searchParams.get('interval')) || 40;
  const nTokens = Math.min(Number(url.searchParams.get('tokens')) || TOKENS.length, TOKENS.length);
  const tokens = TOKENS.slice(0, nTokens);
  let cerrado = false;
  req.on('close', () => { cerrado = true; });

  if (mode === 'buffer') {
    // Mismo ritmo de generación, pero nada sale hasta el final.
    res.writeHead(200, { ...HEADERS_OK, 'Content-Type': 'text/event-stream' });
    let acumulado = ': ok\n\n';
    for (const t of tokens) { if (cerrado) return; await sleep(interval); acumulado += evento(t); }
    acumulado += 'data: [DONE]\n\n';
    res.end(acumulado);
    return;
  }

  if (mode === 'gzip') {
    res.writeHead(200, { ...HEADERS_OK, 'Content-Encoding': 'gzip' });
    const gz = zlib.createGzip(); // sin flush explícito → zlib retiene la salida
    gz.pipe(res);
    gz.write(': ok\n\n');
    for (const t of tokens) { if (cerrado) return; await sleep(interval); gz.write(evento(t)); }
    gz.end('data: [DONE]\n\n');
    return;
  }

  if (mode === 'ttft-lento') {
    await sleep(3000);
    if (cerrado) return;
    res.writeHead(200, HEADERS_OK);
  } else {
    res.writeHead(200, HEADERS_OK);
    res.write(': ok\n\n'); // comentario inmediato: el cliente sabe que hay conexión
  }

  const mitad = Math.floor(tokens.length / 2);
  for (let i = 0; i < tokens.length; i++) {
    if (cerrado) return;
    if (mode === 'rafagas') {
      if (i % 20 === 0) await sleep(800);
    } else {
      await sleep(interval);
    }
    if (mode === 'pausa' && i === mitad) await sleep(10_000);
    if (mode === 'corte' && i === mitad) { res.socket?.destroy(); return; }
    res.write(evento(tokens[i]));
  }
  res.end('data: [DONE]\n\n');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/sse') {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
        return res.end();
      }
      if (req.method === 'POST') { for await (const _ of req); } // descartar cuerpo
      return await servirSSE(req, res, url);
    }
    if (url.pathname === '/' || url.pathname === '/chat-ingenuo.html') {
      const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'chat-ingenuo.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    res.writeHead(404).end('no encontrado');
  } catch (err) {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(err));
  }
});

server.listen(PORT, () => {
  console.log(`mock-sse-server escuchando en http://localhost:${PORT}  (${TOKENS.length} tokens de ejemplo)`);
});
