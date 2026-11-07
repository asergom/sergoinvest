# SergoInvest

Seguimiento de una cartera de fondos de inversión con motor fiscal FIFO para el IRPF español: lotes, traspasos sin tributar, plusvalías por ejercicio, TIR y simulador de reembolsos.

**Versión de prueba.** La app no guarda nada: los datos se importan desde un JSON y viven solo en la pestaña del navegador. Este repositorio no contiene ninguna operación ni importe.

## Qué hay aquí

| Archivo | Qué es |
|---|---|
| `index.html`, `app.js` | La app (GitHub Pages) |
| `engine.js` | Motor de cálculo: FIFO, traspasos, TIR, fiscalidad |
| `precios.json` | Valores liquidativos por ISIN (público) |
| `scripts/actualizar-vl.mjs` | Consulta Morningstar y, de respaldo, QueFondos |
| `.github/workflows/vl.yml` | Proceso "Actualizar VL", lanzado desde el botón de la app |

## Puesta en marcha

1. **Settings → Pages**: *Deploy from a branch*, rama `main`, carpeta `/ (root)`.
2. **Settings → Actions → General → Workflow permissions**: *Read and write permissions*.
3. Crea un token en https://github.com/settings/personal-access-tokens/new con acceso solo a este repositorio y permiso **Actions: Read and write**. La app lo pide al pulsar "Actualizar VL" y lo olvida al cerrar la pestaña.

El proceso también se puede lanzar a mano en **Actions → Actualizar VL → Run workflow**.
