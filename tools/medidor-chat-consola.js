/* Medidor de fluidez de chat · LECO · v1 (2026-11-08)
 *
 * QUÉ HACE: mide, en TU navegador, cómo se ve llegar una respuesta en cualquier chat web
 * (ChatGPT / LECO AGENTE, Claude, u otro): primer texto visible, velocidad, pausas,
 * bloqueos del hilo principal, tamaño del DOM y memoria de la pestaña.
 *
 * QUÉ NO HACE (solo lectura): no envía datos a ningún servidor, no lee cookies ni
 * almacenamiento, no guarda ni muestra el contenido de los mensajes (solo cuenta caracteres),
 * no cambia la página. Se borra al recargar o cerrar la pestaña.
 *
 * USO (≈5 min):
 *  1. Abrir el chat en una pestaña NUEVA (no usar la pestaña de un trabajo activo).
 *  2. F12 → pestaña "Consola". Chrome pide escribir  allow pasting  la primera vez.
 *  3. Pegar este archivo completo y Enter. Debe aparecer "Medidor LECO listo".
 *  4. (Opcional) __lecoMedidor.etiquetar('conversación larga')
 *  5. Enviar un mensaje normal. Al terminar (12 s sin texto nuevo) se imprime una tabla.
 *  6. Repetir en una conversación NUEVA con el mismo mensaje: __lecoMedidor.etiquetar('conversación nueva')
 *  7. __lecoMedidor.resumen()  → tabla comparativa.  copy(JSON.stringify(__lecoMedidor.resultados))
 *     copia los números (sin contenido de mensajes) para compartirlos.
 *  Mantener la pestaña visible durante la medición (si se oculta, el navegador pausa los frames).
 */
(() => {
  if (window.__lecoMedidor) window.__lecoMedidor.detener();
  // IDLE_MS > ATASCO_MS: una pausa de 8–12 s queda dentro de la medición y se marca ATASCO.
  const IDLE_MS = 12000, FRAME_MS = 20, UMBRAL_CHARS = 20, ATASCO_MS = 8000, MAX_ESPERA_MS = 120000;
  const EDITOR = '#prompt-textarea, textarea, [contenteditable="true"], input:not([type]), input[type="text"]';
  const resultados = [];
  let etiqueta = 'sin etiqueta', run = null, rafId = 0, timer = 0, guard = 0, ultimaFila = null, ultimoFin = 0;

  const now = () => performance.now();
  const largo = (n) => (n && n.textContent ? n.textContent.length : 0);

  function iniciar(enviado) {
    if (run) cerrar();
    run = { t0: now(), enviado: (enviado || '').trim().slice(0, 40), eco: false, net: 0, eventos: [], frames: [], loaf: [], oculta: document.hidden };
    const loop = (ts) => { if (!run) return; run.frames.push(ts); rafId = requestAnimationFrame(loop); };
    rafId = requestAnimationFrame(loop);
    clearTimeout(guard); guard = setTimeout(() => run && cerrar('sin respuesta visible en 120 s'), MAX_ESPERA_MS);
  }

  const mo = new MutationObserver((recs) => {
    if (!run) {
      // Texto que llega después de cerrar (sin nuevo envío): la respuesta se reanudó tras > IDLE_MS.
      if (ultimaFila && !ultimaFila._reanudo && now() - ultimoFin < MAX_ESPERA_MS && recs.some((r) => r.type === 'characterData' || r.addedNodes.length)) {
        ultimaFila._reanudo = true;
        ultimaFila.estado = `ATASCO: el texto se reanudó tras ≥ ${IDLE_MS / 1000} s de silencio`;
        console.warn('Medidor LECO:', ultimaFila.estado);
      }
      return;
    }
    let d = 0;
    for (const r of recs) {
      if (r.type === 'characterData') { d += (r.target.data?.length ?? 0) - (r.oldValue?.length ?? 0); continue; }
      for (const n of r.addedNodes) {
        // No contar el eco del propio mensaje enviado.
        if (!run.eco && run.enviado && (n.textContent || '').includes(run.enviado)) { run.eco = true; continue; }
        d += largo(n);
      }
      for (const n of r.removedNodes) d -= largo(n);
    }
    if (!d) return;
    run.net += d;
    if (d > 0) {
      run.eventos.push([now(), run.net]);
      clearTimeout(timer); timer = setTimeout(() => cerrar(), IDLE_MS);
    }
  });
  mo.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });

  let po = null;
  try {
    po = new PerformanceObserver((l) => { if (run) for (const e of l.getEntries()) if (e.startTime >= run.t0) run.loaf.push([e.duration, e.blockingDuration || 0]); });
    po.observe({ type: 'long-animation-frame', buffered: false });
  } catch { po = null; }

  const onVis = () => { if (run && document.hidden) run.oculta = true; };
  document.addEventListener('visibilitychange', onVis);

  // Momento de envío: Enter en el editor o clic en un botón "Enviar/Send".
  const editorTexto = () => {
    const ed = document.querySelector(EDITOR);
    return ed ? (ed.value ?? ed.innerText ?? '') : '';
  };
  const onKey = (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    if (!e.target.closest || !e.target.closest(EDITOR)) return;
    iniciar(editorTexto());
  };
  const onClick = (e) => {
    const b = e.target.closest && e.target.closest('button');
    if (!b) return;
    const id = `${b.getAttribute('aria-label') || ''} ${b.getAttribute('data-testid') || ''} ${b.title || ''} ${b.id || ''}`;
    if (/send|enviar/i.test(id)) iniciar(editorTexto());
  };
  addEventListener('keydown', onKey, true);
  addEventListener('click', onClick, true);

  const r1 = (x, d = 1) => (x == null || !isFinite(x) ? null : Number(x.toFixed(d)));

  function cerrar(motivo) {
    if (!run) return;
    const r = run; run = null;
    cancelAnimationFrame(rafId); clearTimeout(timer); clearTimeout(guard);
    const ev = r.eventos;
    const iPrimer = ev.findIndex(([, n]) => n >= UMBRAL_CHARS);
    const primer = iPrimer >= 0 ? ev[iPrimer][0] : ev[0]?.[0];
    const ultimo = ev[ev.length - 1]?.[0];
    let pausaMax = 0;
    for (let i = Math.max(1, iPrimer + 1); i < ev.length; i++) pausaMax = Math.max(pausaMax, ev[i][0] - ev[i - 1][0]);
    const fin = ultimo ?? now();
    const fr = r.frames.filter((t) => t >= (primer ?? r.t0) && t <= fin);
    const deltas = fr.slice(1).map((t, i) => t - fr[i]);
    const lentos = deltas.filter((x) => x > FRAME_MS).length;
    const dur = primer != null && ultimo != null ? (ultimo - primer) / 1000 : null;
    const fila = {
      etiqueta,
      'primeros 20 caracteres (s)': r1(primer != null ? (primer - r.t0) / 1000 : null, 2),
      'duración (s)': r1(dur, 1),
      'caracteres': r.net,
      'caracteres/s': r1(dur ? r.net / dur : null, 0),
      'pausa máx (s)': r1(pausaMax / 1000, 2),
      'frames >20 ms (%)': r1(deltas.length ? (100 * lentos) / deltas.length : null, 1),
      'frame máx (ms)': r1(deltas.length ? Math.max(...deltas) : null, 0),
      'bloqueos >50 ms (n)': po ? r.loaf.length : 'no soportado',
      'bloqueo máx (ms)': po ? r1(r.loaf.length ? Math.max(...r.loaf.map((x) => x[0])) : 0, 0) : null,
      'nodos DOM': document.getElementsByTagName('*').length,
      'memoria JS (MB)': performance.memory ? r1(performance.memory.usedJSHeapSize / 1048576, 0) : null,
      'estado': motivo || (pausaMax > ATASCO_MS ? 'ATASCO (> 8 s sin texto)' : r.oculta ? 'pestaña oculta: frames no válidos' : 'ok'),
      'eco excluido': r.eco,
    };
    resultados.push(fila); ultimaFila = fila; ultimoFin = now();
    console.log('%cMedidor LECO · respuesta medida', 'font-weight:bold');
    console.table([fila]);
  }

  window.__lecoMedidor = {
    resultados,
    etiquetar(nombre) { etiqueta = String(nombre); console.log('Etiqueta:', etiqueta); },
    resumen() { console.table(resultados); return resultados; },
    detener() {
      if (run) cerrar('detenido');
      mo.disconnect(); po && po.disconnect();
      removeEventListener('keydown', onKey, true); removeEventListener('click', onClick, true);
      document.removeEventListener('visibilitychange', onVis);
      delete window.__lecoMedidor; console.log('Medidor LECO detenido.');
    },
  };
  console.log('%cMedidor LECO listo: envía un mensaje. Comandos: __lecoMedidor.etiquetar(".."), .resumen(), .detener()', 'color:#0a7');
})();
