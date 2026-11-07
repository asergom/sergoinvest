// Consulta el valor liquidativo de cada ISIN y actualiza precios.json.
// Fuente principal: API pública de Morningstar. Respaldo: QueFondos (VDOS).
import { readFile, writeFile } from 'node:fs/promises';

const ARCHIVO = process.env.PRECIOS_PATH || 'precios.json';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const hoy = () => new Date().toISOString().slice(0, 10);
const espera = ms => new Promise(r => setTimeout(r, ms));

export async function conTimeout(url, opts = {}, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal, headers: { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9', ...(opts.headers || {}) } }); }
  finally { clearTimeout(t); }
}

export async function morningstar(isin, f = conTimeout) {
  const url = 'https://lt.morningstar.com/api/rest.svc/klr5zyak8x/security/screener?page=1&pageSize=10&outputType=json&version=1'
    + '&languageId=es-ES&currencyId=EUR&securityDataPoints=SecId%7CLegalName%7CIsin%7CClosePrice%7CClosePriceDate%7CPriceCurrency'
    + '&term=' + encodeURIComponent(isin);
  const r = await f(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('Morningstar HTTP ' + r.status);
  const j = await r.json();
  const filas = j.rows || [];
  const fila = filas.find(x => x.Isin === isin) || (filas.length === 1 ? filas[0] : null);
  if (!fila) throw new Error('Morningstar no encuentra el ISIN');
  const vl = Number(fila.ClosePrice);
  const fecha = String(fila.ClosePriceDate || '').slice(0, 10);
  if (!(vl > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error('Morningstar sin VL');
  return { vl, fecha, nombre: fila.LegalName || '', fuente: 'Morningstar' };
}

export function parseQueFondos(html) {
  const txt = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const mv = txt.match(/Valor liquidativo:\s*([\d.]+,\d+)\s*EUR/i);
  const mf = txt.match(/[ÚU]ltima valoraci[óo]n.*?Fecha:\s*(\d{2})\/(\d{2})\/(\d{4})/i);
  const mn = html.match(/<h2[^>]*>\s*([^<]+?)\s*<\/h2>/i);
  if (!mv || !mf) throw new Error('QueFondos sin VL');
  return { vl: Number(mv[1].replace(/\./g, '').replace(',', '.')), fecha: `${mf[3]}-${mf[2]}-${mf[1]}`, nombre: mn ? mn[1] : '', fuente: 'QueFondos' };
}

export async function quefondos(isin, f = conTimeout) {
  const r = await f('https://www.quefondos.com/es/fondos/ficha/index.html?isin=' + encodeURIComponent(isin));
  if (!r.ok) throw new Error('QueFondos HTTP ' + r.status);
  return parseQueFondos(await r.text());
}

// Comprueba que el VL nuevo sea razonable frente al último guardado.
export function validar(nuevo, serie) {
  if (!(nuevo.vl > 0)) return 'VL no válido';
  if (nuevo.fecha > hoy()) return `Fecha futura (${nuevo.fecha})`;
  const ultimo = serie.length ? serie[serie.length - 1] : null;
  if (!ultimo) return null;
  if (nuevo.fecha < ultimo[0]) return `Más antiguo que el guardado (${nuevo.fecha} < ${ultimo[0]})`;
  const dias = (Date.parse(nuevo.fecha) - Date.parse(ultimo[0])) / 864e5;
  const [lo, hi] = dias > 30 ? [0.6, 1.6] : [0.85, 1.15];
  const ratio = nuevo.vl / ultimo[1];
  if (ratio < lo || ratio > hi) return `Variación sospechosa: ${ultimo[1]} → ${nuevo.vl} (${((ratio - 1) * 100).toFixed(1)} %)`;
  return null;
}

export function anadir(serie, fecha, vl) {
  const s = serie.filter(p => p[0] !== fecha);
  s.push([fecha, vl]);
  return s.sort((a, b) => a[0] < b[0] ? -1 : 1);
}

export async function consultar(isin, fuentes = [morningstar, quefondos]) {
  const errores = [];
  const ok = [];
  for (const fn of fuentes) {
    for (let intento = 0; intento < 2; intento++) {
      try { ok.push(await fn(isin)); break; }
      catch (e) { errores.push(`${fn.name}: ${e.message}`); if (intento === 0) await espera(1500); }
    }
    // Si la fuente principal da un VL de los últimos 4 días, no hace falta seguir.
    if (ok.length && (Date.parse(hoy()) - Date.parse(ok[0].fecha)) / 864e5 <= 4) break;
  }
  if (!ok.length) return { error: errores.join(' · ') };
  ok.sort((a, b) => a.fecha < b.fecha ? 1 : -1); // el más reciente
  return { ...ok[0], errores };
}

export async function ejecutar({ isins, fuentes } = {}) {
  let datos = { actualizado: null, fondos: {}, resultados: [] };
  try { datos = { ...datos, ...JSON.parse(await readFile(ARCHIVO, 'utf8')) }; } catch { /* primera vez */ }
  const lista = (isins && isins.length ? isins : Object.keys(datos.fondos))
    .map(s => s.trim().toUpperCase()).filter(Boolean);
  const invalidos = lista.filter(i => !ISIN_RE.test(i));
  const validos = [...new Set(lista.filter(i => ISIN_RE.test(i)))];
  const resultados = invalidos.map(isin => ({ isin, ok: false, motivo: 'ISIN con formato no válido' }));
  for (const isin of validos) {
    const f = datos.fondos[isin] || { nombre: '', serie: [] };
    const r = await consultar(isin, fuentes);
    if (r.error) { resultados.push({ isin, ok: false, motivo: r.error }); datos.fondos[isin] = f; continue; }
    const motivo = validar(r, f.serie);
    if (motivo) { resultados.push({ isin, ok: false, vl: r.vl, fecha: r.fecha, fuente: r.fuente, motivo }); datos.fondos[isin] = f; continue; }
    f.serie = anadir(f.serie, r.fecha, r.vl);
    if (r.nombre) f.nombre = r.nombre;
    f.fuente = r.fuente;
    datos.fondos[isin] = f;
    resultados.push({ isin, ok: true, vl: r.vl, fecha: r.fecha, fuente: r.fuente });
    await espera(800);
  }
  datos.actualizado = new Date().toISOString();
  datos.resultados = resultados;
  await writeFile(ARCHIVO, JSON.stringify(datos, null, 1) + '\n');
  for (const r of resultados) console.log(r.ok ? `OK    ${r.isin} ${r.fecha} ${r.vl} (${r.fuente})` : `FALLO ${r.isin} ${r.motivo}`);
  return datos;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const isins = (process.env.ISINS || '').split(',').filter(s => s.trim());
  ejecutar({ isins }).then(d => {
    const fallos = d.resultados.filter(r => !r.ok).length;
    console.log(`${d.resultados.length - fallos} actualizados, ${fallos} sin actualizar`);
  }).catch(e => { console.error(e); process.exit(1); });
}
