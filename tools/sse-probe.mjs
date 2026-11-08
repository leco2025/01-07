#!/usr/bin/env node
/**
 * Sonda SSE · Fase 1. Envuelve `curl -N` y mide CUÁNDO llega cada trozo.
 * Responde la pregunta clave del diagnóstico: ¿trozos espaciados o todo al final?
 *
 * Usa curl (respeta HTTPS_PROXY y certificados del sistema) y envía
 * Accept-Encoding como un navegador (--compressed) para reproducir gzip/br en la ruta.
 *
 * Uso:
 *   node tools/sse-probe.mjs --url URL [--method POST] [--body '{"..."}']
 *        [--header 'Authorization: Bearer xxx'] [--stall-ms 8000] [--timeout 120] [--json]
 *
 * No guarda contenido de mensajes: solo tiempos, tamaños y headers relevantes.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const o = { method: 'GET', headers: [], stallMs: 8000, timeout: 120, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--url') o.url = next();
    else if (a === '--method') o.method = next().toUpperCase();
    else if (a === '--body') o.body = next();
    else if (a === '--header' || a === '-H') o.headers.push(next());
    else if (a === '--stall-ms') o.stallMs = Number(next());
    else if (a === '--timeout') o.timeout = Number(next());
    else if (a === '--json') o.json = true;
    else if (a === '--label') o.label = next();
  }
  if (!o.url) { console.error('Falta --url'); process.exit(2); }
  return o;
}

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const r1 = (n) => (n == null ? null : Math.round(n));

export async function probe(opts) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sse-probe-'));
  const hdrFile = path.join(dir, 'headers.txt');
  const MARK = '\n__SSE_PROBE__';
  const curlArgs = [
    '-N', '-sS', '--no-buffer', '--compressed',
    '-D', hdrFile,
    '-X', opts.method,
    '--max-time', String(opts.timeout),
    '-H', 'Accept: text/event-stream',
    '-w', `${MARK} %{http_code} %{time_connect} %{time_starttransfer} %{time_total}\n`,
  ];
  for (const h of opts.headers) curlArgs.push('-H', h);
  if (opts.body != null) curlArgs.push('-H', 'Content-Type: application/json', '--data-raw', opts.body);
  curlArgs.push(opts.url);

  const t0 = performance.now();
  const chunks = []; // { t, bytes, text }
  const child = spawn('curl', curlArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stdout.on('data', (buf) => chunks.push({ t: performance.now() - t0, bytes: buf.length, text: buf.toString('utf8') }));
  child.stderr.on('data', (b) => { stderr += b; });
  const exitCode = await new Promise((r) => child.on('close', r));
  const tEnd = performance.now() - t0;

  // Separar la línea de métricas de curl (va al final de stdout).
  let full = chunks.map((c) => c.text).join('');
  let curlStats = null;
  const mi = full.lastIndexOf(MARK);
  if (mi >= 0) {
    const [code, tc, tst, tt] = full.slice(mi + MARK.length).trim().split(/\s+/);
    curlStats = { http: Number(code), connectMs: Number(tc) * 1000, firstByteMs: Number(tst) * 1000, totalMs: Number(tt) * 1000 };
    // quitar el marcador del último trozo para no contarlo como datos
    let resto = full.length - mi;
    for (let k = chunks.length - 1; k >= 0 && resto > 0; k--) {
      const quitar = Math.min(resto, chunks[k].text.length);
      chunks[k].text = chunks[k].text.slice(0, chunks[k].text.length - quitar);
      chunks[k].bytes = Buffer.byteLength(chunks[k].text);
      resto -= quitar;
    }
    full = full.slice(0, mi);
  }

  let headersRaw = '';
  try { headersRaw = readFileSync(hdrFile, 'utf8'); } catch {}
  rmSync(dir, { recursive: true, force: true });
  // Si hubo redirecciones o 100-continue, quedarse con el último bloque de headers.
  const bloques = headersRaw.split(/\r?\n\r?\n/).filter((b) => b.trim());
  const ultimo = bloques[bloques.length - 1] || '';
  const headers = {};
  for (const line of ultimo.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }

  // Recorrer eventos SSE con el tiempo del trozo en que se completaron.
  let pend = '';
  const eventos = []; // { t, tipo: 'comentario'|'token'|'done'|'error'|'otro' }
  for (const c of chunks) {
    if (!c.text) continue;
    pend += c.text.replace(/\r\n/g, '\n');
    let idx;
    while ((idx = pend.indexOf('\n\n')) >= 0) {
      const raw = pend.slice(0, idx);
      pend = pend.slice(idx + 2);
      const lineas = raw.split('\n');
      const data = lineas.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      const ev = (lineas.find((l) => l.startsWith('event:')) || '').slice(6).trim();
      let tipo = 'otro';
      if (lineas.every((l) => l.startsWith(':'))) tipo = 'comentario';
      else if (ev === 'error') tipo = 'error';
      else if (data === '[DONE]' || ev === 'done' || ev === 'message_stop' || /"type"\s*:\s*"message_stop"/.test(data)) tipo = 'done';
      else if (data) tipo = 'token';
      eventos.push({ t: c.t, tipo });
    }
  }

  const tokens = eventos.filter((e) => e.tipo === 'token');
  const dataChunks = chunks.filter((c) => c.bytes > 0);
  const firstChunk = dataChunks[0]?.t ?? null;
  const firstToken = tokens[0]?.t ?? null;
  const lastToken = tokens[tokens.length - 1]?.t ?? null;

  // Intervalos entre llegadas de trozos que traen tokens (agrupados por instante de llegada).
  const llegadas = [...new Set(tokens.map((e) => e.t))].sort((a, b) => a - b);
  const intervalos = llegadas.slice(1).map((t, i) => t - llegadas[i]);
  const gaps = dataChunks.slice(1).map((c, i) => c.t - dataChunks[i].t);
  if (firstChunk != null) gaps.unshift(firstChunk);
  const maxGap = gaps.length ? Math.max(...gaps) : null;

  // Concentración: % de tokens que llegan en el 10 % final del tramo de streaming.
  let concentracionFinal = null;
  if (tokens.length > 5 && firstToken != null && lastToken != null) {
    const ventana = Math.max(lastToken - (firstChunk ?? 0), 1);
    const umbral = lastToken - 0.1 * ventana;
    concentracionFinal = tokens.filter((e) => e.t >= umbral).length / tokens.length;
  }
  const tokensPorLlegada = llegadas.length ? tokens.length / llegadas.length : null;

  const done = eventos.some((e) => e.tipo === 'done');
  const errorEv = eventos.some((e) => e.tipo === 'error');

  // Chequeo de headers recomendados para SSE.
  const ct = headers['content-type'] || '';
  const cc = headers['cache-control'] || '';
  const chequeos = {
    contentType: /text\/event-stream/i.test(ct),
    charset: /charset=utf-8/i.test(ct),
    noCache: /no-cache/i.test(cc),
    noTransform: /no-transform/i.test(cc),
    xAccelBufferingNo: (headers['x-accel-buffering'] || '').toLowerCase() === 'no',
    sinCompresion: !headers['content-encoding'] || headers['content-encoding'] === 'identity',
  };

  // Veredicto (en orden de gravedad).
  const hallazgos = [];
  if (exitCode !== 0 || (!done && !errorEv)) hallazgos.push('CORTE: el stream terminó sin evento final ([DONE]/done)');
  if (errorEv) hallazgos.push('ERROR: el servidor envió event: error');
  if (concentracionFinal != null && concentracionFinal >= 0.8) hallazgos.push(`BUFFER: ${Math.round(concentracionFinal * 100)} % de los tokens llegó en el 10 % final → llega todo de golpe`);
  if (maxGap != null && maxGap >= opts.stallMs) hallazgos.push(`ATASCO: ${r1(maxGap)} ms sin datos (umbral ${opts.stallMs} ms)`);
  else if (tokensPorLlegada != null && tokensPorLlegada >= 5 && (concentracionFinal ?? 0) < 0.8) hallazgos.push(`RÁFAGAS: ${tokensPorLlegada.toFixed(1)} tokens por llegada, p95 intervalo ${r1(pct(intervalos, 95))} ms → texto a tirones`);
  if (firstChunk != null && firstToken != null && firstToken - firstChunk < 5 && (firstChunk ?? 0) > 1000) hallazgos.push('SIN LATIDO INICIAL: el primer byte es el primer token (no hay comentario/heartbeat al abrir)');
  if (!chequeos.sinCompresion) hallazgos.push(`COMPRESIÓN en la ruta: content-encoding=${headers['content-encoding']}`);
  const veredicto = hallazgos.length ? hallazgos[0].split(':')[0] : 'FLUIDO';

  return {
    label: opts.label || opts.url,
    exitCode,
    curlError: stderr.trim() || null,
    http: curlStats?.http ?? null,
    tiemposMs: {
      conexion: r1(curlStats?.connectMs),
      primerByte: r1(firstChunk),
      primerToken: r1(firstToken),
      ultimoToken: r1(lastToken),
      total: r1(tEnd),
    },
    trozos: dataChunks.length,
    eventos: { tokens: tokens.length, comentarios: eventos.filter((e) => e.tipo === 'comentario').length, done, error: errorEv },
    intervaloEntreLlegadasMs: { p50: r1(pct(intervalos, 50)), p95: r1(pct(intervalos, 95)), max: r1(intervalos.length ? Math.max(...intervalos) : null) },
    maxSilencioMs: r1(maxGap),
    tokensPorLlegada: tokensPorLlegada == null ? null : Number(tokensPorLlegada.toFixed(2)),
    concentracionFinal: concentracionFinal == null ? null : Number(concentracionFinal.toFixed(2)),
    headers: {
      'content-type': headers['content-type'] ?? null,
      'cache-control': headers['cache-control'] ?? null,
      'content-encoding': headers['content-encoding'] ?? null,
      'x-accel-buffering': headers['x-accel-buffering'] ?? null,
      'transfer-encoding': headers['transfer-encoding'] ?? null,
      server: headers['server'] ?? null,
    },
    chequeosHeaders: chequeos,
    veredicto,
    hallazgos,
  };
}

function imprimir(r) {
  const ok = (b) => (b ? 'OK ' : 'NO ');
  console.log(`\n▶ ${r.label}`);
  console.log(`  HTTP ${r.http}  · veredicto: ${r.veredicto}`);
  console.log(`  primer byte ${r.tiemposMs.primerByte} ms · primer token ${r.tiemposMs.primerToken} ms · último token ${r.tiemposMs.ultimoToken} ms · total ${r.tiemposMs.total} ms`);
  console.log(`  trozos ${r.trozos} · tokens ${r.eventos.tokens} · tokens/llegada ${r.tokensPorLlegada} · intervalo p50/p95/max ${r.intervaloEntreLlegadasMs.p50}/${r.intervaloEntreLlegadasMs.p95}/${r.intervaloEntreLlegadasMs.max} ms · silencio máx ${r.maxSilencioMs} ms · concentración final ${r.concentracionFinal}`);
  const c = r.chequeosHeaders;
  console.log(`  headers: ${ok(c.contentType)}event-stream ${ok(c.charset)}utf-8 ${ok(c.noCache)}no-cache ${ok(c.noTransform)}no-transform ${ok(c.xAccelBufferingNo)}X-Accel-Buffering ${ok(c.sinCompresion)}sin-compresión`);
  for (const h of r.hallazgos) console.log(`  · ${h}`);
  if (r.curlError) console.log(`  curl: ${r.curlError}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  const r = await probe(opts);
  if (opts.json) console.log(JSON.stringify(r, null, 2));
  else imprimir(r);
}
