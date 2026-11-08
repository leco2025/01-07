# Herramientas de medición de chat · LECO

Ninguna de estas herramientas modifica el chat real ni envía datos a terceros. Sin dependencias nuevas.

| Archivo | Para qué | Estado |
|---|---|---|
| `medidor-chat-consola.js` | Medir en tu navegador cualquier chat web (ChatGPT / LECO AGENTE, Claude…): primeros 20 caracteres, velocidad, pausas, frames lentos, bloqueos, DOM y memoria. Solo lectura | Validado 2026-11-08 (v1) |
| `sse-probe.mjs` | `curl -N` con tiempos por trozo para un endpoint SSE **propio**: detecta FLUIDO, BUFFER, RÁFAGAS, ATASCO, CORTE, compresión y headers | Calibrado 2026-11-08 |
| `mock-sse-server.mjs` | Servidor **simulado** (no es el backend del chat) con 7 modos de falla, para calibrar instrumentos y pruebas de regresión | Funciona |
| `fixtures/chat-ingenuo.html` | Página de prueba con antipatrones conocidos, servida por el simulador | Funciona |
| `validar-medidor.cjs` | Reproduce la validación del medidor contra el simulador | Funciona |

```bash
node tools/mock-sse-server.mjs
```

```bash
node tools/sse-probe.mjs --url "http://localhost:8787/sse?mode=buffer"
```

```bash
node tools/validar-medidor.cjs
```

El informe de diagnóstico se entregó por separado (contiene datos internos y este repositorio es público).
