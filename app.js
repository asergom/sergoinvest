/* ============================================================
   SergoInvest · Interfaz
   ============================================================ */
const LS_KEY = 'sergoinvest_v2';
const S = { state: null, prices: {}, mode: 'cargando', db: null, downloads: null, res: null, view: 'resumen', fondoSel: null, filtro: { fondo: '', tipo: '' }, loaded: false };
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hoyISO = () => new Date().toISOString().slice(0, 10);
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ---------- Formato ---------- */
const fE = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' });
const eur = x => x == null || !Number.isFinite(x) ? '—' : fE.format(x);
const eurS = x => x == null || !Number.isFinite(x) ? '—' : (x > 0.004 ? '+' : '') + fE.format(x);
const pct = (x, d = 2) => x == null || !Number.isFinite(x) ? '—' : (x > 0.00005 ? '+' : '') + (x * 100).toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }) + ' %';
const fp = x => x == null || !Number.isFinite(x) ? '—' : x.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 6, useGrouping: 'always' });
const fvl = x => x == null || !Number.isFinite(x) ? '—' : x.toLocaleString('es-ES', { minimumFractionDigits: 4, maximumFractionDigits: 6, useGrouping: 'always' }) + ' €';
const fd = s => s ? s.split('-').reverse().join('/') : '—';
const cls = x => x > 0.004 ? 'pos' : x < -0.004 ? 'neg' : '';
const parseNum = v => {
  if (v == null) return NaN;
  let s = String(v).trim().replace(/\s|€/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return Number(s);
};
const TIPOS = { suscripcion: 'Suscripción', reembolso: 'Reembolso', traspaso: 'Traspaso', lote_inicial: 'Lote inicial', historico: 'Resultado histórico' };
const nombreFondo = id => S.state?.funds.find(f => f.id === id)?.nombre || '—';

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 2600);
}

/* ---------- Configuración del repositorio ---------- */
const CFG = { repo: 'asergom/sergoinvest', workflow: 'vl.yml', rama: 'main', precios: 'precios.json' };

/* ---------- Datos en memoria (esta versión no guarda nada) ---------- */
function normalizar(d) {
  const s = JSON.parse(JSON.stringify(d || {}));
  s.schema = 1; s.funds = Array.isArray(s.funds) ? s.funds : []; s.ops = Array.isArray(s.ops) ? s.ops : [];
  s.settings = s.settings || {}; s.settings.perdidasPrevias = s.settings.perdidasPrevias || []; s.settings.otrosAhorro = s.settings.otrosAhorro || {};
  delete s.precios;
  return s;
}
function persistir(msg) { if (S.state) S.state.actualizado = new Date().toISOString(); S.sucio = true; recalcular(); render(); if (msg) toast(msg); }
function persistirPrecio(id, msg = 'VL anotado') { S.sucio = true; recalcular(); render(); toast(msg); }
window.addEventListener('beforeunload', e => { if (S.sucio) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- VL publicados en el repositorio ---------- */
S.remoto = { fondos: {}, actualizado: null, resultados: [] };
S.token = null; S.vl = { estado: 'reposo', texto: '' };
async function leerPreciosRemotos() {
  const urls = [
    { u: `https://api.github.com/repos/${CFG.repo}/contents/${CFG.precios}?ref=${CFG.rama}&t=${Date.now()}`, h: { Accept: 'application/vnd.github.raw+json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) } },
    { u: `${CFG.precios}?t=${Date.now()}`, h: {} }
  ];
  for (const { u, h } of urls) {
    try {
      const r = await fetch(u, { headers: h, cache: 'no-store' });
      if (!r.ok) continue;
      const d = await r.json();
      if (d && d.fondos) { S.remoto = d; recalcular(); render(); return true; }
    } catch (e) { /* siguiente */ }
  }
  return false;
}
function preciosCombinados() {
  const out = {};
  for (const f of (S.state?.funds || [])) {
    const m = new Map();
    for (const [d, v] of (S.prices[f.id] || [])) m.set(d, Number(v));
    const rem = S.remoto.fondos?.[String(f.isin || '').toUpperCase()];
    for (const [d, v] of (rem?.serie || [])) m.set(d, Number(v));
    out[f.id] = [...m.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
  }
  return out;
}

const gh = (path, opts = {}) => fetch('https://api.github.com/repos/' + CFG.repo + path, {
  ...opts, headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + S.token, 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) }
});
function estadoVL(estado, texto) { S.vl = { estado, texto }; render(); const box = $('#vlEstado'); if (box) box.innerHTML = htmlEstadoVL(); }
async function actualizarVL() {
  if (!S.token) return formToken();
  const isins = [...new Set((S.state?.funds || []).map(f => String(f.isin || '').toUpperCase()).filter(Boolean))];
  if (!isins.length) return toast('Añade o importa fondos primero');
  const inicio = new Date(Date.now() - 5000).toISOString();
  estadoVL('lanzando', 'Pidiendo a GitHub que consulte los VL…');
  let r;
  try { r = await gh(`/actions/workflows/${CFG.workflow}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: CFG.rama, inputs: { isins: isins.join(',') } }) }); }
  catch (e) { return estadoVL('error', 'No se pudo conectar con GitHub. Revisa tu conexión.'); }
  if (r.status === 401) { S.token = null; return estadoVL('error', 'GitHub rechaza el token: está mal copiado o ha caducado. Vuelve a introducirlo.'); }
  if (r.status === 403 || r.status === 404) return estadoVL('error', `GitHub no deja lanzar el proceso (${r.status}). Revisa que el token tenga acceso al repositorio ${CFG.repo} con permiso "Actions: Read and write".`);
  if (!r.ok) return estadoVL('error', `GitHub respondió ${r.status} al lanzar el proceso.`);
  estadoVL('esperando', 'Consultando Morningstar desde GitHub. Suele tardar entre 30 segundos y 2 minutos…');
  const limite = Date.now() + 5 * 60000;
  let run = null;
  while (Date.now() < limite) {
    await new Promise(res => setTimeout(res, 5000));
    try {
      const q = await gh(`/actions/workflows/${CFG.workflow}/runs?event=workflow_dispatch&per_page=5&created=${encodeURIComponent('>=' + inicio.slice(0, 19) + 'Z')}`);
      if (!q.ok) continue;
      const j = await q.json();
      run = (j.workflow_runs || [])[0] || null;
      if (run && run.status === 'completed') break;
    } catch (e) { /* reintenta */ }
  }
  if (!run || run.status !== 'completed') return estadoVL('error', 'El proceso sigue en marcha o no ha arrancado. Pulsa "Recargar VL" en un par de minutos.');
  if (run.conclusion !== 'success') return estadoVL('error', `El proceso terminó con error (${run.conclusion}). Puedes ver el detalle en GitHub, pestaña Actions.`);
  await leerPreciosRemotos();
  const res = S.remoto.resultados || [];
  const ok = res.filter(x => x.ok).length;
  estadoVL(ok === res.length ? 'ok' : 'parcial', `${ok} de ${res.length} fondos actualizados.`);
}
function htmlEstadoVL() {
  const res = S.remoto.resultados || [];
  const cab = S.vl.texto ? `<p class="small ${S.vl.estado === 'error' ? 'err' : ''}">${esc(S.vl.texto)}</p>` : '';
  const nom = isin => (S.state?.funds || []).find(f => String(f.isin).toUpperCase() === isin)?.nombre || S.remoto.fondos?.[isin]?.nombre || isin;
  const tabla = res.length ? `<div class="tbl-wrap"><table><thead><tr><th>Fondo</th><th class="r">VL</th><th class="r">Fecha</th><th>Fuente</th><th>Estado</th></tr></thead><tbody>${res.map(x => `<tr><td><div class="fname">${esc(nom(x.isin))}</div><div class="isin">${esc(x.isin)}</div></td><td class="r num">${x.vl ? fvl(x.vl) : '—'}</td><td class="r num">${fd(x.fecha)}</td><td class="small">${esc(x.fuente || '—')}</td><td>${x.ok ? '<span class="pill accent">Actualizado</span>' : `<span class="pill warn">Sin actualizar</span><div class="small muted">${esc(x.motivo || '')}</div>`}</td></tr>`).join('')}</tbody></table></div>` : '';
  return `${cab}${S.remoto.actualizado ? `<p class="small muted">Última consulta: ${new Date(S.remoto.actualizado).toLocaleString('es-ES')}</p>` : ''}${tabla}`;
}
function formToken() {
  abrir(`${cabecera('Conectar con GitHub')}
  <p class="small">Para lanzar la consulta de VL, la app necesita un token de GitHub con permiso solo sobre el repositorio <b>${CFG.repo}</b>. Se guarda solo mientras esta pestaña esté abierta.</p>
  <ol class="small" style="margin:0;padding-left:18px;display:grid;gap:4px">
    <li>Abre <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a>.</li>
    <li>En <b>Repository access</b> elige <b>Only select repositories</b> y marca <b>sergoinvest</b>.</li>
    <li>En <b>Permissions → Repository permissions</b> pon <b>Actions: Read and write</b>.</li>
    <li>Pulsa <b>Generate token</b> y pégalo aquí.</li>
  </ol>
  <form class="f" id="tokenForm" novalidate>
    <label class="fld"><span>Token</span><input id="tokenIn" type="password" autocomplete="off" placeholder="github_pat_…" required></label>
    <p class="err" id="tErr" hidden></p>
    <div class="row" style="justify-content:flex-end"><button class="btn" type="button" data-act="cerrar">Cancelar</button><button class="btn primary" type="submit">Conectar y actualizar</button></div>
  </form>`);
}

async function arrancar() {
  route();
  S.mode = 'memoria'; S.loaded = true;
  recalcular(); render();
  await leerPreciosRemotos();
}

function recalcular() {
  S.res = S.state ? Motor.calcular(S.state, preciosCombinados()) : null;
  if (S.state && (!S.fondoSel || !S.state.funds.some(f => f.id === S.fondoSel))) S.fondoSel = S.state.funds[0]?.id || null;
}

/* ---------- Navegación ---------- */
const VISTAS = ['resumen', 'fondo', 'operaciones', 'fiscal', 'datos'];
function route() {
  const h = (location.hash || '').slice(1);
  S.view = VISTAS.includes(h) ? h : 'resumen';
  document.querySelectorAll('#tabs a').forEach(a => { if (a.dataset.v === S.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
}
window.addEventListener('hashchange', () => { route(); render(); window.scrollTo(0, 0); });
function ir(v, fondo) { if (fondo) S.fondoSel = fondo; if (location.hash.slice(1) === v) { route(); render(); } else location.hash = v; }

/* ---------- Render ---------- */
function render() {
  const st = $('#estado');
  const m = {
    cargando: ['', 'Cargando…'], conectando: ['', 'Conectando…'], lento: ['warn', 'Sin respuesta del almacenamiento'],
    memoria: [S.sucio ? 'warn' : 'ok', S.sucio ? 'Cambios sin exportar' : 'Sin guardar: datos solo en esta pestaña']
  }[S.mode] || ['', ''];
  st.innerHTML = `<span class="dot ${m[0]}"></span><span>${m[1]}</span>`;
  const app = $('#app');
  if (!S.loaded) return;
  if (!S.state || !S.state.funds.length) { app.innerHTML = vistaVacia(); return; }
  const v = { resumen: vistaResumen, fondo: vistaFondo, operaciones: vistaOperaciones, fiscal: vistaFiscal, datos: vistaDatos }[S.view];
  app.innerHTML = v(S.res);
}

function vistaVacia() {
  return `<section class="panel empty">
    <h2>Tu cartera está vacía</h2>
    <p class="muted" style="max-width:56ch">Esta versión de prueba no guarda nada. Importa tu copia JSON para ver tus fondos, lotes FIFO, plusvalías y rentabilidad. Al cerrar la pestaña los datos desaparecen; exporta antes si has hecho cambios.</p>
    <div class="row" style="justify-content:center">
      <button class="btn primary" data-act="nuevo-fondo">Añadir fondo</button>
      <button class="btn" data-act="importar">Importar JSON</button>
    </div>
  </section>`;
}

/* ---------- Gráfico SVG ---------- */
function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))); const n = raw / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
function grafico(puntos) {
  const pts = puntos.filter(p => p.completo || p.valor > 0);
  if (pts.length < 2) return `<p class="small muted">Todavía hay pocos valores liquidativos guardados para dibujar la evolución. La gráfica se completa sola con cada actualización de VL.</p>`;
  const W = 820, H = 250, ml = 70, mr = 14, mt = 10, mb = 28;
  const xs = pts.map(p => Date.parse(p.fecha));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const vals = pts.flatMap(p => [p.valor, p.aportado]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1) { hi += 1; lo -= 1; }
  const step = niceStep((hi - lo) / 4);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const X = x => ml + (x1 === x0 ? 0 : (x - x0) / (x1 - x0)) * (W - ml - mr);
  const Y = y => mt + (1 - (y - lo) / (hi - lo)) * (H - mt - mb);
  const linea = pts.map((p, i) => `${i ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(p.valor).toFixed(1)}`).join('');
  const area = `${linea}L${X(x1).toFixed(1)},${Y(lo).toFixed(1)}L${X(x0).toFixed(1)},${Y(lo).toFixed(1)}Z`;
  let esc2 = '';
  pts.forEach((p, i) => { const x = X(xs[i]).toFixed(1), y = Y(p.aportado).toFixed(1); esc2 += i ? `H${x}V${y}` : `M${x},${y}`; });
  let grid = '';
  for (let v = lo; v <= hi + step / 2; v += step) {
    const y = Y(v).toFixed(1);
    grid += `<line x1="${ml}" x2="${W - mr}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"/><text x="${ml - 8}" y="${+y + 4}" text-anchor="end">${(v / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} k€</text>`;
  }
  const nx = Math.min(5, pts.length);
  let xl = '';
  for (let k = 0; k < nx; k++) {
    const tt = x0 + (x1 - x0) * k / (nx - 1 || 1);
    const d = new Date(tt);
    const lab = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCFullYear()).slice(2)}`;
    xl += `<text x="${X(tt).toFixed(1)}" y="${H - 8}" text-anchor="${k === 0 ? 'start' : k === nx - 1 ? 'end' : 'middle'}">${lab}</text>`;
  }
  const last = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución del valor de mercado frente al dinero aportado">
    ${grid}
    <path d="${area}" fill="var(--chart-area)" stroke="none"/>
    <path d="${esc2}" fill="none" stroke="var(--faint)" stroke-width="1.5" stroke-dasharray="4 4"/>
    <path d="${linea}" fill="none" stroke="var(--accent)" stroke-width="2"/>
    <circle cx="${X(x1).toFixed(1)}" cy="${Y(last.valor).toFixed(1)}" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>
    ${xl}
  </svg>`;
}
function bloqueGrafico(puntos, titulo) {
  return `<section class="panel chart">
    <div class="panel-head"><h2>${titulo}</h2><div class="legend"><span><i></i>Valor de mercado</span><span><i class="dash"></i>Dinero aportado</span></div></div>
    ${grafico(puntos)}
    <p class="note">Cada punto usa el último VL conocido de cada fondo en esa fecha: VL publicados y precios de ejecución de tus operaciones.</p>
  </section>`;
}

/* ---------- Avisos ---------- */
function listaAvisos(avisos, limite = 6) {
  if (!avisos.length) return '';
  const orden = { error: 0, aviso: 1, info: 2 };
  const a = avisos.slice().sort((x, y) => orden[x.nivel] - orden[y.nivel]);
  const lab = { error: ['neg', 'Error'], aviso: ['warn', 'Revisar'], info: ['info', 'Info'] };
  const li = x => `<li class="${x.nivel}"><span class="pill ${lab[x.nivel][0]}">${lab[x.nivel][1]}</span><span>${esc(x.texto)}</span></li>`;
  const vis = a.slice(0, limite), rest = a.slice(limite);
  return `<section class="panel">
    <div class="panel-head"><h2>Avisos</h2><span class="small muted">${a.filter(x => x.nivel === 'error').length} errores · ${a.filter(x => x.nivel === 'aviso').length} a revisar · ${a.filter(x => x.nivel === 'info').length} informativos</span></div>
    <ul class="avisos">${vis.map(li).join('')}</ul>
    ${rest.length ? `<details><summary class="small muted">Ver ${rest.length} más</summary><ul class="avisos" style="margin-top:6px">${rest.map(li).join('')}</ul></details>` : ''}
  </section>`;
}

function rentTxt(r) {
  if (!r || r.valor == null) return { lab: 'Rentabilidad', val: '—', sub: 'Sin datos suficientes' };
  return r.tipo === 'tir'
    ? { lab: 'TIR anualizada', val: pct(r.valor), sub: `Ponderada por dinero · ${Math.round(r.dias / 30.4)} meses` }
    : { lab: 'Rentabilidad del periodo', val: pct(r.valor), sub: `Menos de un año (${Math.round(r.dias)} días): sin anualizar` };
}

/* ---------- Vista: Resumen ---------- */
function vistaResumen(R) {
  const y = new Date().getFullYear();
  const fy = R.fiscal.anios.find(a => a.anio === y) || { neto: 0, cuota: 0 };
  const rg = rentTxt(R.rentGlobal);
  const aprox = R.flujosGlobal.some(f => f.aproximado);
  const filas = R.fondos.slice().sort((a, b) => b.valor - a.valor).map(f => `
    <tr class="click" data-act="ver-fondo" data-id="${f.id}">
      <td><div class="fname">${esc(f.fondo.nombre)}</div><div class="isin">${esc(f.fondo.isin)}${f.fondo.plataforma ? ' · ' + esc(f.fondo.plataforma) : ''}</div></td>
      <td><span class="pill">${esc(f.fondo.tipologia || '—')}</span></td>
      <td class="r num">${fp(f.participaciones)}</td>
      <td class="r"><div class="num">${fvl(f.vl)}</div><div class="small muted">${fd(f.fechaVL)}</div></td>
      <td class="r num">${eur(f.valor)}</td>
      <td class="r num">${eur(f.costeFiscal)}</td>
      <td class="r"><div class="num ${cls(f.latenteFiscal)}">${eurS(f.latenteFiscal)}</div><div class="small num ${cls(f.latenteFiscal)}">${pct(f.pctFiscal)}</div></td>
      <td class="r"><div class="num ${cls(f.latenteFondo)}">${eurS(f.latenteFondo)}</div><div class="small num ${cls(f.latenteFondo)}">${pct(f.pctFondo)}</div></td>
      <td class="r"><div class="num ${cls(f.rent.valor)}">${pct(f.rent.valor)}</div><div class="small muted">${f.rent.tipo === 'tir' ? 'TIR anual' : f.rent.tipo ? 'periodo' : ''}</div></td>
      <td class="r num">${(f.peso * 100).toLocaleString('es-ES', { maximumFractionDigits: 1 })} %</td>
    </tr>`).join('');
  const porTipo = {};
  R.fondos.forEach(f => porTipo[f.fondo.tipologia || 'Sin tipología'] = (porTipo[f.fondo.tipologia || 'Sin tipología'] || 0) + f.valor);
  const tipos = Object.entries(porTipo).sort((a, b) => b[1] - a[1]);
  return `
  <div class="kpis">
    <div class="kpi"><span class="lab">Valor de mercado</span><span class="val">${eur(R.valorTotal)}</span><span class="sub">VL a ${fd(R.fechaValoracion)}</span></div>
    <div class="kpi"><span class="lab">Coste fiscal vivo</span><span class="val">${eur(R.costeFiscal)}</span><span class="sub">Dinero de bolsillo invertido</span></div>
    <div class="kpi"><span class="lab">Plusvalía latente fiscal</span><span class="val ${cls(R.latenteFiscal)}">${eurS(R.latenteFiscal)}</span><span class="sub">${pct(R.costeFiscal ? R.latenteFiscal / R.costeFiscal : null)} · tributaría solo si reembolsas</span></div>
    <div class="kpi"><span class="lab">${rg.lab}</span><span class="val ${cls(R.rentGlobal.valor)}">${rg.val}</span><span class="sub">${rg.sub}${aprox ? ' · aproximada' : ''}</span></div>
    <div class="kpi"><span class="lab">Realizado en ${y}</span><span class="val ${cls(fy.neto)}">${eurS(fy.neto)}</span><span class="sub">IRPF estimado: ${eur(fy.cuota)}</span></div>
    <div class="kpi"><span class="lab">Gastos corrientes</span><span class="val">${eur(R.costeTER)}</span><span class="sub">al año · ${pct(R.valorTotal ? R.costeTER / R.valorTotal : null).replace('+', '')} medio · ya descontados del VL</span></div>
  </div>
  ${listaAvisos(R.avisos)}
  <div class="grid2">
    ${bloqueGrafico(Motor.evolucion(R), 'Evolución de la cartera')}
    <section class="panel"><h2>Distribución</h2><div class="bars">${tipos.map(([t, v]) => `
      <div class="bar-row"><div class="row"><span>${esc(t)}</span><span class="num">${eur(v)} · ${(v / R.valorTotal * 100).toLocaleString('es-ES', { maximumFractionDigits: 1 })} %</span></div><div class="bar"><span style="width:${(v / R.valorTotal * 100).toFixed(2)}%"></span></div></div>`).join('')}
    </div></section>
  </div>
  <section class="panel">
    <div class="panel-head"><h2>Posiciones</h2><div class="row"><button class="btn" data-act="ir-vl">Actualizar VL</button><button class="btn primary" data-act="nueva-op" data-tipo="suscripcion">Suscripción</button><button class="btn" data-act="nueva-op" data-tipo="traspaso">Traspaso</button><button class="btn" data-act="nueva-op" data-tipo="reembolso">Reembolso</button></div></div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Fondo</th><th>Tipología</th><th class="r">Participaciones</th><th class="r">VL</th><th class="r">Valor</th><th class="r">Coste fiscal</th><th class="r">Latente fiscal</th><th class="r">Latente del fondo</th><th class="r">Rentabilidad</th><th class="r">Peso</th></tr></thead>
      <tbody>${filas}</tbody>
      <tfoot><tr><td colspan="4">Total</td><td class="r num">${eur(R.valorTotal)}</td><td class="r num">${eur(R.costeFiscal)}</td><td class="r num ${cls(R.latenteFiscal)}">${eurS(R.latenteFiscal)}</td><td class="r num">${eurS(R.valorTotal - R.costeEntrada)}</td><td class="r num">${rg.val}</td><td class="r num">100 %</td></tr></tfoot>
    </table></div>
    <p class="note"><b>Latente fiscal</b>: valor actual menos tu dinero de bolsillo (lo que declararías al reembolsar). <b>Latente del fondo</b>: valor actual menos lo que valía al entrar en este fondo, incluida la plusvalía traída en traspasos; mide cómo lo ha hecho este fondo.</p>
  </section>`;
}

/* ---------- Vista: Fondo ---------- */
function vistaFondo(R) {
  const f = R.fondos.find(x => x.id === S.fondoSel) || R.fondos[0];
  const rg = rentTxt(f.rent);
  const opsById = Object.fromEntries(S.state.ops.map(o => [o.id, o]));
  const lotes = f.lotes.map((l, i) => {
    const op = opsById[l.opId];
    const editable = op && op.tipo === 'lote_inicial' && op.origen === 'traspaso';
    return `<tr>
      <td class="num muted">${i + 1}</td>
      <td class="num">${fd(l.fechaEntrada)}</td>
      <td><span class="num">${fd(l.fechaFiscal)}</span> ${l.fechaEstimada ? '<span class="pill warn">sin confirmar</span>' : ''}${editable ? ` <button class="btn link" data-act="fecha-fiscal" data-id="${op.id}">${l.fechaEstimada ? 'Indicar fecha original' : 'Cambiar'}</button>` : ''}</td>
      <td><span class="pill ${l.origen === 'traspaso' ? 'info' : 'accent'}">${l.origen === 'traspaso' ? 'Traspaso' + (l.fondoOrigen ? ' desde ' + esc(nombreFondo(l.fondoOrigen).slice(0, 18)) : '') : 'Suscripción'}</span></td>
      <td class="r num">${fp(l.participaciones)}</td>
      <td class="r num">${eur(l.costeFiscal)}</td>
      <td class="r num">${fvl(l.precioFiscal)}</td>
      <td class="r num">${eur(l.costeEntrada)}</td>
      <td class="r num">${eur(l.valor)}</td>
      <td class="r num ${cls(l.latente)}">${eurS(l.latente)}</td>
    </tr>`;
  }).join('');
  const reals = R.realizadas.filter(r => r.fondo === f.id);
  const ops = S.state.ops.filter(o => o.fondo === f.id || o.destino === f.id);
  return `
  <section class="panel">
    <div class="panel-head">
      <label class="fld" style="flex:1 1 320px"><span>Fondo</span>
        <select id="selFondo">${R.fondos.map(x => `<option value="${x.id}" ${x.id === f.id ? 'selected' : ''}>${esc(x.fondo.nombre)}</option>`).join('')}</select>
      </label>
      <div class="row"><button class="btn primary" data-act="nueva-op" data-tipo="suscripcion" data-fondo="${f.id}">Suscribir</button><button class="btn" data-act="nueva-op" data-tipo="traspaso" data-fondo="${f.id}">Traspasar</button><button class="btn" data-act="nueva-op" data-tipo="reembolso" data-fondo="${f.id}">Reembolsar</button></div>
    </div>
    <p class="small muted">${esc(f.fondo.isin)} · ${esc(f.fondo.tipologia || 'Sin tipología')}${f.fondo.plataforma ? ' · ' + esc(f.fondo.plataforma) : ''} · Gastos corrientes ${pct(f.fondo.ter)}</p>
  </section>
  <div class="kpis">
    <div class="kpi"><span class="lab">Valor de mercado</span><span class="val">${eur(f.valor)}</span><span class="sub">${fp(f.participaciones)} part. × ${fvl(f.vl)} (${fd(f.fechaVL)})</span></div>
    <div class="kpi"><span class="lab">Coste fiscal</span><span class="val">${eur(f.costeFiscal)}</span><span class="sub">Precio medio fiscal ${fvl(f.precioMedioFiscal)}</span></div>
    <div class="kpi"><span class="lab">Latente fiscal</span><span class="val ${cls(f.latenteFiscal)}">${eurS(f.latenteFiscal)}</span><span class="sub">${pct(f.pctFiscal)} sobre tu bolsillo</span></div>
    <div class="kpi"><span class="lab">Latente del fondo</span><span class="val ${cls(f.latenteFondo)}">${eurS(f.latenteFondo)}</span><span class="sub">${pct(f.pctFondo)} sobre coste de entrada ${eur(f.costeEntrada)}</span></div>
    <div class="kpi"><span class="lab">${rg.lab}</span><span class="val ${cls(f.rent.valor)}">${rg.val}</span><span class="sub">${rg.sub}</span></div>
    <div class="kpi"><span class="lab">Realizado histórico</span><span class="val ${cls(f.realizado)}">${eurS(f.realizado)}</span><span class="sub">Reembolsos ya tributados</span></div>
  </div>
  <section class="panel">
    <div class="panel-head"><h2>Lotes vivos en orden FIFO</h2><span class="small muted">El primero de la lista es el primero que saldrá en un reembolso o traspaso</span></div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>#</th><th>Entrada en el fondo</th><th>Fecha fiscal de compra</th><th>Origen</th><th class="r">Participaciones</th><th class="r">Coste fiscal</th><th class="r">Precio fiscal</th><th class="r">Coste de entrada</th><th class="r">Valor</th><th class="r">Latente fiscal</th></tr></thead>
      <tbody>${lotes || '<tr><td colspan="10" class="muted">Sin participaciones vivas.</td></tr>'}</tbody>
      ${f.lotes.length ? `<tfoot><tr><td colspan="4">Total</td><td class="r num">${fp(f.participaciones)}</td><td class="r num">${eur(f.costeFiscal)}</td><td class="r num">${fvl(f.precioMedioFiscal)}</td><td class="r num">${eur(f.costeEntrada)}</td><td class="r num">${eur(f.valor)}</td><td class="r num ${cls(f.latenteFiscal)}">${eurS(f.latenteFiscal)}</td></tr></tfoot>` : ''}
    </table></div>
    <p class="note"><b>Precio fiscal</b> es coste fiscal ÷ participaciones (lo que MyInvestor llama precio medio por participación). En lotes traspasados no es el VL al que entraron: ese está en el coste de entrada.</p>
  </section>
  ${bloqueGrafico(Motor.evolucion(R, f.id), 'Evolución del fondo')}
  ${reals.length ? `<section class="panel"><h2>Plusvalías y minusvalías realizadas</h2><div class="tbl-wrap"><table>
    <thead><tr><th>Fecha</th><th>Origen</th><th class="r">Participaciones</th><th class="r">Valor de transmisión</th><th class="r">Coste fiscal</th><th class="r">Resultado</th><th class="r">Retención</th></tr></thead>
    <tbody>${reals.map(r => `<tr><td class="num">${fd(r.fecha)}</td><td>${r.origen === 'historico' ? 'Histórico importado' : 'Reembolso'}</td><td class="r num">${r.participaciones ? fp(r.participaciones) : '—'}</td><td class="r num">${eur(r.transmision)}</td><td class="r num">${eur(r.costeFiscal)}</td><td class="r num ${cls(r.ganancia)}">${eurS(r.ganancia)}</td><td class="r num">${eur(r.retencion)}</td></tr>`).join('')}</tbody>
  </table></div></section>` : ''}
  <section class="panel"><div class="panel-head"><h2>Operaciones del fondo</h2></div>${tablaOps(ops)}</section>`;
}

/* ---------- Vista: Operaciones ---------- */
function detalleOp(o) {
  switch (o.tipo) {
    case 'suscripcion': return `VL ${fvl(o.vl || o.importe / o.participaciones)}`;
    case 'reembolso': { const r = S.res.realizadas.find(x => x.opId === o.id); return r ? `Resultado <span class="num ${cls(r.ganancia)}">${eurS(r.ganancia)}</span>` : ''; }
    case 'traspaso': return `→ ${esc(nombreFondo(o.destino))} · ${fp(o.participacionesDestino)} part. el ${fd(o.fechaDestino || o.fecha)}`;
    case 'lote_inicial': return `${o.origen === 'traspaso' ? 'Recibido por traspaso' : 'Suscripción'} · coste fiscal ${eur(o.costeFiscal)}${o.origen === 'traspaso' ? ' · entrada ' + eur(o.costeEntrada) : ''}`;
    case 'historico': return `${esc(o.descripcion || '')} · <span class="pill ${o.clase === 'pendiente' ? 'warn' : ''}">${o.clase === 'pendiente' ? 'sin clasificar' : o.clase}</span>`;
  }
  return '';
}
function tablaOps(ops) {
  if (!ops.length) return '<p class="muted">No hay operaciones.</p>';
  const err = new Set(S.res.avisos.filter(a => a.nivel === 'error' && a.opId).map(a => a.opId));
  const filas = ops.slice().sort((a, b) => a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0).map(o => `
    <tr>
      <td class="num">${fd(o.fecha)}</td>
      <td><span class="pill ${o.tipo === 'reembolso' ? 'warn' : o.tipo === 'traspaso' ? 'info' : 'accent'}">${TIPOS[o.tipo] || o.tipo}</span>${err.has(o.id) ? ' <span class="pill neg">revisar</span>' : ''}</td>
      <td>${esc(nombreFondo(o.fondo))}</td>
      <td class="r num">${o.participaciones ? fp(o.participaciones) : '—'}</td>
      <td class="r num">${o.tipo === 'lote_inicial' ? eur(o.costeEntrada || o.costeFiscal) : o.tipo === 'historico' ? eurS(o.resultado) : eur(o.importe)}</td>
      <td class="small">${detalleOp(o)}</td>
      <td class="r"><div class="row" style="justify-content:flex-end;flex-wrap:nowrap"><button class="btn sm" data-act="editar-op" data-id="${o.id}">Editar</button><button class="btn sm danger" data-act="borrar-op" data-id="${o.id}">Borrar</button></div></td>
    </tr>`).join('');
  return `<div class="tbl-wrap"><table><thead><tr><th>Fecha</th><th>Tipo</th><th>Fondo</th><th class="r">Participaciones</th><th class="r">Importe</th><th>Detalle</th><th></th></tr></thead><tbody>${filas}</tbody></table></div>`;
}
function vistaOperaciones(R) {
  const fl = S.filtro;
  const ops = S.state.ops.filter(o => (!fl.fondo || o.fondo === fl.fondo || o.destino === fl.fondo) && (!fl.tipo || o.tipo === fl.tipo));
  return `<section class="panel">
    <div class="panel-head"><h2>Registro de operaciones</h2><div class="row">${Object.entries(TIPOS).slice(0, 3).map(([k, v]) => `<button class="btn ${k === 'suscripcion' ? 'primary' : ''}" data-act="nueva-op" data-tipo="${k}">${v}</button>`).join('')}<button class="btn" data-act="nueva-op" data-tipo="lote_inicial">Otro…</button></div></div>
    <div class="fields">
      <label class="fld"><span>Fondo</span><select id="filFondo"><option value="">Todos</option>${S.state.funds.map(f => `<option value="${f.id}" ${fl.fondo === f.id ? 'selected' : ''}>${esc(f.nombre)}</option>`).join('')}</select></label>
      <label class="fld"><span>Tipo</span><select id="filTipo"><option value="">Todos</option>${Object.entries(TIPOS).map(([k, v]) => `<option value="${k}" ${fl.tipo === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    </div>
    ${tablaOps(ops)}
    <p class="note">Todo se recalcula desde este registro. Puedes editar o borrar cualquier operación: los lotes, traspasos posteriores y plusvalías se rehacen solos.</p>
  </section>`;
}

/* ---------- Vista: Fiscalidad ---------- */
function vistaFiscal(R) {
  const y = new Date().getFullYear();
  const set = S.state.settings;
  const filas = R.fiscal.anios.slice().reverse().map(a => `<tr>
    <td class="num">${a.anio}</td><td class="r num pos">${eur(a.ganancias)}</td><td class="r num neg">${a.perdidas ? '−' + eur(a.perdidas) : eur(0)}</td>
    <td class="r num ${cls(a.neto)}">${eurS(a.neto)}</td><td class="r num">${a.compensado ? '−' + eur(a.compensado) : '—'}</td>
    <td class="r num">${eur(a.base)}</td><td class="r num">${eur(a.cuota)}</td><td class="r num">${a.tipoMedio != null ? pct(a.tipoMedio).replace('+', '') : '—'}</td><td class="r num">${eur(a.retenciones)}</td>
  </tr>`).join('');
  const hist = R.historicos.filter(h => Math.abs(h.resultado) > 0.005);
  return `
  <section class="panel">
    <div class="panel-head"><h2>Ganancias y pérdidas por ejercicio</h2><span class="small muted">Solo fondos registrados aquí</span></div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Año</th><th class="r">Ganancias</th><th class="r">Pérdidas</th><th class="r">Saldo</th><th class="r">Compensado</th><th class="r">Base</th><th class="r">Cuota estimada</th><th class="r">Tipo medio</th><th class="r">Retenido</th></tr></thead>
      <tbody>${filas}</tbody>
    </table></div>
    <p class="note">Escala de la base del ahorro: 19 % hasta 6.000 €, 21 % hasta 50.000 €, 23 % hasta 200.000 €, 27 % hasta 300.000 € y 30 % a partir de ahí. Las pérdidas netas de un año se compensan con ganancias de los 4 siguientes. No se incluye la compensación cruzada del 25 % con intereses o dividendos. Es una estimación: la declaración la hace Hacienda con todos tus rendimientos.</p>
  </section>
  <div class="grid2">
    <section class="panel">
      <h2>Simulador de reembolso</h2>
      <form class="f" id="simForm" onsubmit="return false">
        <div class="fields">
          <label class="fld"><span>Fondo</span><select id="simFondo">${R.fondos.filter(f => f.participaciones > 0).map(f => `<option value="${f.id}">${esc(f.fondo.nombre)}</option>`).join('')}</select></label>
          <label class="fld"><span>Importe a retirar (€)</span><input id="simImp" class="numi" inputmode="decimal" placeholder="o deja vacío para todo"></label>
          <label class="fld"><span>VL estimado</span><input id="simVL" class="numi" inputmode="decimal"></label>
          <label class="fld"><span>Fecha</span><input id="simFecha" type="date" value="${hoyISO()}"></label>
        </div>
      </form>
      <div id="simRes"></div>
    </section>
    <section class="panel">
      <h2>Ajustes fiscales ${y}</h2>
      <label class="fld"><span>Otros rendimientos del ahorro en ${y} (€)</span><input id="otrosAhorro" class="numi" inputmode="decimal" value="${set.otrosAhorro[y] ?? ''}" placeholder="intereses, dividendos, otras ganancias"><span class="hint">Sirve para calcular el tramo marginal real de tus reembolsos.</span></label>
      <div><h3 style="margin-bottom:6px">Pérdidas pendientes de años anteriores</h3>
        ${set.perdidasPrevias.length ? `<ul class="avisos">${set.perdidasPrevias.map((p, i) => `<li><span class="num">${p.anio}</span><span class="num" style="flex:1">${eur(Number(p.importe))}</span><button class="btn sm danger" data-act="quitar-perdida" data-i="${i}">Quitar</button></li>`).join('')}</ul>` : '<p class="small muted">Ninguna registrada. Añade las que figuren en tu última declaración.</p>'}
        <div class="row" style="margin-top:8px"><input id="ppAnio" type="number" min="2015" max="${y}" placeholder="Año" style="width:90px"><input id="ppImp" class="numi" inputmode="decimal" placeholder="Importe €" style="width:130px"><button class="btn sm" data-act="anadir-perdida">Añadir</button></div>
      </div>
      ${R.fiscal.pendientes.length ? `<div><h3 style="margin-bottom:6px">Saldo negativo por compensar</h3><dl class="kv">${R.fiscal.pendientes.map(p => `<dt>De ${p.anio} (caduca en ${p.caduca})</dt><dd class="num">${eur(p.restante)}</dd>`).join('')}</dl></div>` : ''}
    </section>
  </div>
  ${hist.length ? `<section class="panel">
    <div class="panel-head"><h2>Resultados históricos importados</h2><span class="small muted">Clasifícalos para que cuenten bien</span></div>
    <div class="tbl-wrap"><table><thead><tr><th>Fecha</th><th>Fondo</th><th>Descripción</th><th class="r">Resultado</th><th>Clasificación</th></tr></thead><tbody>
    ${hist.map(h => `<tr><td class="num">${fd(h.fecha)}</td><td>${esc(nombreFondo(h.fondo))}</td><td class="small">${esc(h.descripcion)}</td><td class="r num ${cls(h.resultado)}">${eurS(h.resultado)}</td>
      <td><div class="seg" style="display:inline-flex">${['pendiente', 'reembolso', 'traspaso'].map(c => `<button data-act="clasificar" data-id="${h.opId}" data-c="${c}" aria-pressed="${h.clase === c}">${c === 'pendiente' ? 'Sin clasificar' : c === 'reembolso' ? 'Reembolso' : 'Traspaso'}</button>`).join('')}</div></td></tr>`).join('')}
    </tbody></table></div>
    <p class="note">Un <b>reembolso</b> tributa en el año en que se hizo. Un <b>traspaso</b> no tributa: su plusvalía ya va dentro del coste fiscal del fondo destino, así que contarla aquí sería duplicarla.</p>
  </section>` : ''}`;
}
function actualizarSim() {
  const box = $('#simRes'); if (!box) return;
  const id = $('#simFondo').value; const f = S.res.fondos.find(x => x.id === id); if (!f) { box.innerHTML = ''; return; }
  const vlIn = $('#simVL'); if (!vlIn.value) vlIn.value = String(f.vl).replace('.', ',');
  const vl = parseNum(vlIn.value) || f.vl;
  const imp = parseNum($('#simImp').value);
  const part = Number.isFinite(imp) && imp > 0 ? Math.min(imp / vl, f.participaciones) : f.participaciones;
  const s = Motor.simularReembolso(S.state, preciosCombinados(), { fondo: id, participaciones: part, vl, fecha: $('#simFecha').value || hoyISO() });
  box.innerHTML = `<div class="sim">
    <div class="row"><span>Participaciones que salen (FIFO)</span><span class="num">${fp(part)} de ${fp(f.participaciones)}</span></div>
    <div class="row"><span>Importe bruto</span><span class="num">${eur(s.importe)}</span></div>
    <div class="row"><span>Coste fiscal consumido</span><span class="num">${eur(s.costeFiscal)} · ${s.piezas.length} lote(s)</span></div>
    <div class="row"><b>Plusvalía o minusvalía</b><b class="num ${cls(s.ganancia)}">${eurS(s.ganancia)}</b></div>
    <div class="row"><span>Retención en el reembolso (19 %)</span><span class="num">${eur(s.retencion)}</span></div>
    <div class="row"><span>IRPF adicional estimado del año</span><span class="num">${eur(s.cuotaIncremental)}</span></div>
    <div class="row"><span>Neto aproximado tras impuestos</span><span class="num">${eur(s.importe - s.cuotaIncremental)}</span></div>
    ${s.piezas.some(p => p.fechaEstimada) ? '<p class="small" style="color:var(--warn)">Algún lote consumido tiene la fecha de compra original sin confirmar: el orden FIFO real podría ser otro.</p>' : ''}
    ${s.avisoRecompra.length ? `<p class="small" style="color:var(--warn)">Hay compras de este fondo a menos de un año (${s.avisoRecompra.map(fd).join(', ')}). Por el art. 33.5 LIRPF la pérdida podría no computarse hasta vender esas participaciones. Consúltalo antes de operar.</p>` : ''}
  </div>`;
}

/* ---------- Vista: Datos ---------- */
function vistaDatos(R) {
  return `
  <section class="panel">
    <div class="panel-head"><h2>Fondos y valor liquidativo</h2><button class="btn primary" data-act="nuevo-fondo">Añadir fondo</button></div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Fondo</th><th>Tipología</th><th>Plataforma</th><th class="r">Gastos corr.</th><th class="r">Último VL</th><th class="r">Fecha</th><th class="r">VL conocidos</th><th></th></tr></thead>
      <tbody>${R.fondos.map(f => `<tr>
        <td><div class="fname">${esc(f.fondo.nombre)}</div><div class="isin">${esc(f.fondo.isin)}</div></td>
        <td>${esc(f.fondo.tipologia || '—')}</td><td>${esc(f.fondo.plataforma || '—')}</td>
        <td class="r num">${pct(f.fondo.ter).replace('+', '')}</td>
        <td class="r num">${fvl(f.vl)}</td>
        <td class="r num">${fd(f.fechaVL)}</td>
        <td class="r num">${(preciosCombinados()[f.id] || []).length}</td>
        <td class="r"><div class="row" style="justify-content:flex-end;flex-wrap:nowrap"><button class="btn sm primary" data-act="nuevo-vl" data-id="${f.id}">Anotar VL</button><button class="btn sm" data-act="editar-fondo" data-id="${f.id}">Editar</button></div></td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="note">Cada VL publicado por el proceso de GitHub o anotado a mano añade un punto a la gráfica. También se usan los VL de ejecución de tus propias operaciones.</p>
  </section>
  <section class="panel">
    <div class="panel-head"><h2>Actualizar valores liquidativos</h2><div class="row"><button class="btn primary" data-act="actualizar-vl" ${['lanzando','esperando'].includes(S.vl.estado) ? 'disabled' : ''}>${['lanzando','esperando'].includes(S.vl.estado) ? 'Actualizando…' : 'Actualizar VL'}</button><button class="btn" data-act="recargar-vl">Recargar VL</button></div></div>
    <p class="note">Lanza en GitHub un proceso que consulta Morningstar (con QueFondos de respaldo) y publica los VL en el archivo precios.json del repositorio. Un VL solo se acepta si es más reciente que el guardado y no varía de forma sospechosa.</p>
    <div id="vlEstado">${htmlEstadoVL()}</div>
  </section>
  <div class="grid2">
    <section class="panel">
      <h2>Copia de seguridad</h2>
      <p class="small muted">Fondos, operaciones, ajustes fiscales y VL anotados a mano. Esta versión no guarda nada: exporta antes de cerrar si has hecho cambios.</p>
      <div class="row"><button class="btn primary" data-act="exportar">Descargar JSON</button><button class="btn" data-act="copiar-json">Copiar JSON</button><button class="btn" data-act="importar">Importar…</button></div>
    </section>
    <section class="panel">
      <h2>Privacidad</h2>
      <p class="small">Tus operaciones e importes solo existen en esta pestaña del navegador. No se envían a GitHub ni a ningún otro sitio. Lo único público del repositorio es el código y precios.json, que contiene los ISIN y sus VL.</p>
      <p class="small muted">${S.state.ops.length} operaciones · ${S.state.funds.length} fondos</p>
    </section>
  </div>`;
}

/* ---------- Diálogos ---------- */
const dlg = () => $('#dlg');
function abrir(html) { $('#dlgBody').innerHTML = html; if (!dlg().open) dlg().showModal(); }
function cerrar() { if (dlg().open) dlg().close(); }
const cabecera = t => `<div class="dlg-head"><h2>${t}</h2><button class="btn sm" data-act="cerrar" type="button">Cerrar</button></div>`;
const optFondos = (sel, soloConPart = false) => S.res.fondos.filter(f => !soloConPart || f.participaciones > 0 || f.id === sel).map(f => `<option value="${f.id}" ${f.id === sel ? 'selected' : ''}>${esc(f.fondo.nombre)}</option>`).join('');
const nv = v => v == null || v === '' ? '' : String(v).replace('.', ',');

function formOp(tipo, op = null, fondoPre = null) {
  const o = op || {};
  const fondo = o.fondo || fondoPre || S.fondoSel;
  const fecha = o.fecha || hoyISO();
  const nuevo = !op;
  const seg = nuevo ? `<div class="seg" role="group" aria-label="Tipo de operación">${['suscripcion', 'traspaso', 'reembolso'].map(k => `<button type="button" data-act="cambiar-tipo" data-tipo="${k}" aria-pressed="${k === tipo}">${TIPOS[k]}</button>`).join('')}</div>` : '';
  let campos = '';
  if (tipo === 'suscripcion') campos = `
    <label class="fld"><span>Fondo</span><select name="fondo">${optFondos(fondo)}</select></label>
    <label class="fld"><span>Fecha de la operación</span><input name="fecha" type="date" value="${fecha}" required></label>
    <label class="fld"><span>Importe pagado (€)</span><input name="importe" class="numi" inputmode="decimal" value="${nv(o.importe)}" required><span class="hint">Incluye comisión si la hubo</span></label>
    <label class="fld"><span>Participaciones recibidas</span><input name="participaciones" class="numi" inputmode="decimal" value="${nv(o.participaciones)}"><span class="hint">Las del extracto</span></label>
    <label class="fld"><span>VL de ejecución</span><input name="vl" class="numi" inputmode="decimal" value="${nv(o.vl)}"><span class="hint">Si no tienes las participaciones, se calculan con el VL</span></label>`;
  if (tipo === 'reembolso') campos = `
    <label class="fld"><span>Fondo</span><select name="fondo">${optFondos(fondo, true)}</select></label>
    <label class="fld"><span>Fecha de la operación</span><input name="fecha" type="date" value="${fecha}" required></label>
    <label class="fld"><span>Participaciones reembolsadas</span><input name="participaciones" class="numi" inputmode="decimal" value="${nv(o.participaciones)}" required><button class="btn link" type="button" data-act="todas" style="justify-self:start">Todas las disponibles</button></label>
    <label class="fld"><span>Importe bruto recibido (€)</span><input name="importe" class="numi" inputmode="decimal" value="${nv(o.importe)}" required><span class="hint">Antes de la retención</span></label>
    <label class="fld"><span>Retención practicada (€)</span><input name="retencion" class="numi" inputmode="decimal" value="${nv(o.retencion)}" placeholder="19 % de la ganancia"></label>
    <label class="fld"><span>Comisión de reembolso (€)</span><input name="comision" class="numi" inputmode="decimal" value="${nv(o.comision)}" placeholder="0"></label>`;
  if (tipo === 'traspaso') campos = `
    <label class="fld"><span>Fondo origen</span><select name="fondo">${optFondos(fondo, true)}</select></label>
    <label class="fld"><span>Fecha de salida</span><input name="fecha" type="date" value="${fecha}" required></label>
    <label class="fld"><span>Participaciones que salen</span><input name="participaciones" class="numi" inputmode="decimal" value="${nv(o.participaciones)}" required><button class="btn link" type="button" data-act="todas" style="justify-self:start">Todas las disponibles</button></label>
    <label class="fld"><span>Valor de salida (€)</span><input name="importe" class="numi" inputmode="decimal" value="${nv(o.importe)}" required><span class="hint">Participaciones × VL de salida</span></label>
    <label class="fld"><span>Fondo destino</span><select name="destino">${S.res.fondos.map(f => `<option value="${f.id}" ${f.id === o.destino ? 'selected' : ''}>${esc(f.fondo.nombre)}</option>`).join('')}</select></label>
    <label class="fld"><span>Fecha de entrada en destino</span><input name="fechaDestino" type="date" value="${o.fechaDestino || fecha}"></label>
    <label class="fld"><span>Participaciones recibidas en destino</span><input name="participacionesDestino" class="numi" inputmode="decimal" value="${nv(o.participacionesDestino)}" required><span class="hint">Las del extracto del fondo destino</span></label>
    <label class="fld"><span>Importe recibido en destino (€)</span><input name="importeDestino" class="numi" inputmode="decimal" value="${nv(o.importeDestino)}" placeholder="igual al valor de salida"></label>`;
  if (tipo === 'lote_inicial') campos = `
    <label class="fld"><span>Fondo</span><select name="fondo">${optFondos(fondo)}</select></label>
    <label class="fld"><span>Origen</span><select name="origen"><option value="traspaso" ${o.origen !== 'suscripcion' ? 'selected' : ''}>Recibido por traspaso</option><option value="suscripcion" ${o.origen === 'suscripcion' ? 'selected' : ''}>Suscripción</option></select></label>
    <label class="fld"><span>Fecha de entrada en el fondo</span><input name="fecha" type="date" value="${fecha}" required></label>
    <label class="fld"><span>Fecha fiscal de compra original</span><input name="fechaFiscal" type="date" value="${o.fechaFiscal || fecha}"><span class="hint">La del lote original antes del traspaso</span></label>
    <label class="fld"><span>Participaciones</span><input name="participaciones" class="numi" inputmode="decimal" value="${nv(o.participaciones)}" required></label>
    <label class="fld"><span>Coste fiscal (€)</span><input name="costeFiscal" class="numi" inputmode="decimal" value="${nv(o.costeFiscal)}" required><span class="hint">Inversión realizada que muestra tu plataforma</span></label>
    <label class="fld"><span>Coste de entrada (€)</span><input name="costeEntrada" class="numi" inputmode="decimal" value="${nv(o.costeEntrada)}"><span class="hint">Valor de mercado al entrar</span></label>`;
  if (tipo === 'historico') campos = `
    <label class="fld"><span>Fondo</span><select name="fondo">${optFondos(fondo)}</select></label>
    <label class="fld"><span>Fecha</span><input name="fecha" type="date" value="${fecha}" required></label>
    <label class="fld"><span>Resultado (€)</span><input name="resultado" class="numi" inputmode="decimal" value="${nv(o.resultado)}" required></label>
    <label class="fld"><span>Clasificación</span><select name="clase">${['pendiente', 'reembolso', 'traspaso'].map(c => `<option value="${c}" ${o.clase === c ? 'selected' : ''}>${c === 'pendiente' ? 'Sin clasificar' : c === 'reembolso' ? 'Reembolso (tributa)' : 'Traspaso (no tributa)'}</option>`).join('')}</select></label>
    <label class="fld" style="grid-column:1/-1"><span>Descripción</span><input name="descripcion" value="${esc(o.descripcion || '')}"></label>`;
  const otros = nuevo ? `<p class="small muted">¿Otro tipo? <button class="btn link" type="button" data-act="cambiar-tipo" data-tipo="lote_inicial">Lote inicial con coste fiscal</button> · <button class="btn link" type="button" data-act="cambiar-tipo" data-tipo="historico">Resultado histórico</button></p>` : '';
  abrir(`${cabecera(nuevo ? 'Nueva operación' : 'Editar ' + TIPOS[tipo].toLowerCase())}
    ${seg}
    <form class="f" id="opForm" data-tipo="${tipo}" data-id="${o.id || ''}" novalidate>
      <div class="fields">${campos}</div>
      <div id="opPrev"></div>
      <p class="err" id="opErr" hidden></p>
      ${otros}
      <div class="row" style="justify-content:flex-end"><button class="btn" type="button" data-act="cerrar">Cancelar</button><button class="btn primary" type="submit">${nuevo ? 'Registrar operación' : 'Guardar cambios'}</button></div>
    </form>`);
  previsualizarOp();
}

function leerOp() {
  const form = $('#opForm'); const fdat = new FormData(form); const tipo = form.dataset.tipo;
  const o = { id: form.dataset.id || uid('op'), tipo };
  for (const [k, v] of fdat.entries()) o[k] = v;
  const numKeys = ['importe', 'participaciones', 'vl', 'retencion', 'comision', 'participacionesDestino', 'importeDestino', 'costeFiscal', 'costeEntrada', 'resultado'];
  for (const k of numKeys) if (k in o) { if (o[k] === '') delete o[k]; else o[k] = parseNum(o[k]); }
  if (tipo === 'suscripcion' && !(o.participaciones > 0) && o.importe > 0 && o.vl > 0) o.participaciones = Number((o.importe / o.vl).toFixed(6));
  if (tipo === 'suscripcion' && o.participaciones > 0 && o.importe > 0 && !(o.vl > 0)) o.vl = o.importe / o.participaciones;
  if (tipo === 'lote_inicial') {
    const prev = S.state.ops.find(x => x.id === o.id);
    o.fechaFiscalConfirmada = o.origen === 'traspaso' ? (o.fechaFiscal !== o.fecha || !!prev?.fechaFiscalConfirmada) : true;
    if (!(o.costeEntrada > 0)) o.costeEntrada = o.costeFiscal;
  }
  if (tipo === 'traspaso' && !o.fechaDestino) o.fechaDestino = o.fecha;
  return o;
}
function validarOp(o) {
  const req = { suscripcion: ['importe', 'participaciones'], reembolso: ['participaciones', 'importe'], traspaso: ['participaciones', 'importe', 'participacionesDestino'], lote_inicial: ['participaciones', 'costeFiscal'], historico: ['resultado'] }[o.tipo];
  const nombres = { importe: 'el importe', participaciones: 'las participaciones', participacionesDestino: 'las participaciones recibidas', costeFiscal: 'el coste fiscal', resultado: 'el resultado' };
  for (const k of req) { if (!Number.isFinite(o[k]) || (k !== 'resultado' && !(o[k] > 0))) return `Falta ${nombres[k]} (número mayor que 0).`; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.fecha || '')) return 'Indica la fecha.';
  if (o.tipo === 'traspaso' && o.destino === o.fondo) return 'El fondo destino tiene que ser distinto del origen.';
  return null;
}
function previsualizarOp() {
  const box = $('#opPrev'); if (!box) return;
  const o = leerOp(); const form = $('#opForm');
  const sinEsta = { ...S.state, ops: S.state.ops.filter(x => x.id !== form.dataset.id) };
  let html = '';
  if (o.tipo === 'suscripcion' && o.importe > 0 && o.participaciones > 0) html = `<div class="sim"><div class="row"><span>VL implícito</span><span class="num">${fvl(o.importe / o.participaciones)}</span></div><div class="row"><span>Participaciones</span><span class="num">${fp(o.participaciones)}</span></div></div>`;
  if (o.tipo === 'reembolso' && o.participaciones > 0 && o.importe > 0) {
    const s = Motor.simularReembolso(sinEsta, preciosCombinados(), { fondo: o.fondo, participaciones: o.participaciones, vl: o.importe / o.participaciones, fecha: o.fecha });
    html = `<div class="sim">
      <div class="row"><span>Coste fiscal FIFO consumido</span><span class="num">${eur(s.costeFiscal)} · ${s.piezas.length} lote(s)</span></div>
      <div class="row"><b>Plusvalía o minusvalía</b><b class="num ${cls(s.ganancia)}">${eurS(s.ganancia)}</b></div>
      <div class="row"><span>Retención esperada (19 %)</span><span class="num">${eur(s.retencion)}</span></div>
      <div class="row"><span>IRPF adicional estimado en ${o.fecha.slice(0, 4)}</span><span class="num">${eur(s.cuotaIncremental)}</span></div>
      ${s.errores.map(e => `<p class="err">${esc(e.texto)}</p>`).join('')}
      ${s.avisoRecompra.length ? `<p class="small" style="color:var(--warn)">Hay compras de este fondo a menos de un año: la pérdida podría no computarse todavía (art. 33.5 LIRPF).</p>` : ''}
    </div>`;
  }
  if (o.tipo === 'traspaso' && o.participaciones > 0 && o.importe > 0) {
    const s = Motor.simularTraspaso(sinEsta, preciosCombinados(), { fondo: o.fondo, participaciones: o.participaciones, vl: o.importe / o.participaciones, fecha: o.fecha });
    if (s) html = `<div class="sim">
      <div class="row"><span>Lotes que pasan al destino</span><span class="num">${s.piezas.length}, cada uno con su fecha y coste fiscal</span></div>
      <div class="row"><span>Coste fiscal que viaja</span><span class="num">${eur(s.costeFiscal)}</span></div>
      <div class="row"><b>Plusvalía diferida (no tributa)</b><b class="num ${cls(s.diferida)}">${eurS(s.diferida)}</b></div>
      ${o.participacionesDestino > 0 ? `<div class="row"><span>VL de entrada en destino</span><span class="num">${fvl((o.importeDestino || o.importe) / o.participacionesDestino)}</span></div>` : ''}
      ${s.faltan ? `<p class="err">Faltan ${fp(s.faltan)} participaciones en el fondo origen en esa fecha.</p>` : ''}
    </div>`;
  }
  box.innerHTML = html;
}

function formFondo(f = null) {
  const x = f || {};
  abrir(`${cabecera(f ? 'Editar fondo' : 'Añadir fondo')}
  <form class="f" id="fondoForm" data-id="${x.id || ''}" novalidate>
    <div class="fields">
      <label class="fld" style="grid-column:1/-1"><span>Nombre</span><input name="nombre" value="${esc(x.nombre || '')}" required></label>
      <label class="fld"><span>ISIN</span><input name="isin" value="${esc(x.isin || '')}" maxlength="12" style="text-transform:uppercase" required></label>
      <label class="fld"><span>Tipología</span><input name="tipologia" list="tipologias" value="${esc(x.tipologia || '')}"><datalist id="tipologias"><option value="Gestión Activa"><option value="Gestión Pasiva"><option value="Monetario"><option value="Renta Fija"><option value="Mixto"></datalist></label>
      <label class="fld"><span>Gastos corrientes (%)</span><input name="ter" class="numi" inputmode="decimal" value="${x.ter != null ? nv((x.ter * 100).toFixed(2)) : ''}"></label>
      <label class="fld"><span>Plataforma</span><input name="plataforma" value="${esc(x.plataforma || '')}" placeholder="MyInvestor, gestora…"></label>
      ${f ? '' : `<label class="fld"><span>VL inicial</span><input name="vl" class="numi" inputmode="decimal"></label><label class="fld"><span>Fecha del VL</span><input name="fechaVL" type="date" value="${hoyISO()}"></label>`}
    </div>
    <p class="err" id="fErr" hidden></p>
    <div class="row" style="justify-content:space-between">
      ${f ? `<button class="btn danger" type="button" data-act="borrar-fondo" data-id="${f.id}">Borrar fondo</button>` : '<span></span>'}
      <div class="row"><button class="btn" type="button" data-act="cerrar">Cancelar</button><button class="btn primary" type="submit">Guardar</button></div>
    </div>
  </form>`);
}
function formVL(id) {
  const f = S.res.fondos.find(x => x.id === id);
  const serie = (S.prices[id] || []).slice(-8).reverse();
  abrir(`${cabecera('Anotar VL')}
  <p class="small muted">${esc(f.fondo.nombre)} · ${esc(f.fondo.isin)}</p>
  <form class="f" id="vlForm" data-id="${id}" novalidate>
    <div class="fields">
      <label class="fld"><span>Fecha</span><input name="fecha" type="date" value="${hoyISO()}" required></label>
      <label class="fld"><span>Valor liquidativo (€)</span><input name="vl" class="numi" inputmode="decimal" required></label>
    </div>
    <p class="err" id="vErr" hidden></p>
    <div class="row" style="justify-content:flex-end"><button class="btn" type="button" data-act="cerrar">Cancelar</button><button class="btn primary" type="submit">Guardar VL</button></div>
  </form>
  ${serie.length ? `<div><h3 style="margin-bottom:6px">Últimos VL guardados</h3><dl class="kv">${serie.map(([d, v]) => `<dt class="num">${fd(d)}</dt><dd class="num">${fvl(v)} <button class="btn link" data-act="borrar-vl" data-id="${id}" data-f="${d}">Quitar</button></dd>`).join('')}</dl></div>` : ''}`);
}
function formFechaFiscal(opId) {
  const o = S.state.ops.find(x => x.id === opId);
  abrir(`${cabecera('Fecha de compra original')}
  <p class="small">Lote de ${esc(nombreFondo(o.fondo))} recibido por traspaso el ${fd(o.fecha)}: ${fp(o.participaciones)} participaciones con coste fiscal ${eur(o.costeFiscal)}.</p>
  <p class="note">Hacienda considera que estas participaciones se compraron cuando compraste las del fondo de origen. Esa fecha decide el orden FIFO en futuros reembolsos. La encontrarás en la pestaña "Pasados" del fondo de origen o en tu informe fiscal.</p>
  <form class="f" id="ffForm" data-id="${opId}" novalidate>
    <label class="fld"><span>Fecha de compra original</span><input name="fechaFiscal" type="date" value="${o.fechaFiscal || o.fecha}" required></label>
    <div class="row" style="justify-content:flex-end"><button class="btn" type="button" data-act="cerrar">Cancelar</button><button class="btn primary" type="submit">Confirmar fecha</button></div>
  </form>`);
}
function confirmar(titulo, texto, accion, etiqueta = 'Borrar') {
  confirmar.fn = accion;
  abrir(`${cabecera(titulo)}<p>${texto}</p><div class="row" style="justify-content:flex-end"><button class="btn" data-act="cerrar">Cancelar</button><button class="btn danger" data-act="confirmar-si">${etiqueta}</button></div>`);
}
function formImportar() {
  abrir(`${cabecera('Importar datos')}
  <p class="small">Acepta una copia JSON de esta app o el export JSON de la versión de prueba. <b>Sustituye</b> todos los datos actuales.</p>
  <label class="fld"><span>Archivo JSON</span><input type="file" id="impFile" accept=".json,application/json"></label>
  <label class="fld"><span>O pega el contenido</span><textarea id="impTxt" placeholder='{"funds": [...], "ops": [...]}'></textarea></label>
  <p class="err" id="impErr" hidden></p>
  <div class="row" style="justify-content:flex-end"><button class="btn" data-act="cerrar">Cancelar</button><button class="btn primary" data-act="importar-si">Importar y sustituir</button></div>`);
}

/* ---------- Importación ---------- */
function migrarAntiguo(arr) {
  const funds = [], ops = [], precios = {}; let n = 0; const id = () => 'op' + String(++n).padStart(3, '0');
  for (const f of arr) {
    funds.push({ id: f.id, isin: f.isin, nombre: f.nombre, tipologia: f.tipologia, ter: f.ter, plataforma: '' });
    if (f.vlActual) precios[f.id] = [[f.fechaVL || hoyISO(), Number(f.vlActual)]];
    for (const a of f.aportaciones || []) {
      if (String(a.tipo || '').includes('TRASPASO')) ops.push({ id: id(), tipo: 'lote_inicial', origen: 'traspaso', fondo: f.id, fecha: a.fecha, fechaFiscal: a.fecha, fechaFiscalConfirmada: false, participaciones: a.participaciones, costeFiscal: a.importe, costeEntrada: a.importeEntrada ?? a.importe });
      else ops.push({ id: id(), tipo: 'suscripcion', fondo: f.id, fecha: a.fecha, importe: a.importe, participaciones: a.participaciones, vl: a.vl });
    }
    for (const h of f.lotesHistoricos || []) ops.push({ id: id(), tipo: 'historico', fondo: f.id, fecha: h.fecha, resultado: h.resultado || 0, descripcion: h.tipo || '', clase: h.resultado ? 'pendiente' : 'traspaso' });
  }
  return { estado: { schema: 1, funds, ops, settings: { perdidasPrevias: [], otrosAhorro: {} } }, precios };
}
function interpretar(txt) {
  const d = JSON.parse(txt);
  if (Array.isArray(d) && d[0] && 'aportaciones' in d[0]) return migrarAntiguo(d);
  if (d && Array.isArray(d.funds) && Array.isArray(d.ops)) return { estado: normalizar(d), precios: d.precios || {} };
  throw new Error('El archivo no tiene el formato esperado (fondos y operaciones).');
}
async function aplicarImport(imp) {
  S.state = normalizar(imp.estado); delete S.state.precios;
  S.prices = imp.precios || {};
  recalcular(); render(); S.sucio = false; toast('Datos importados');
}
function exportJSON() {
  return JSON.stringify({ ...S.state, precios: S.prices, exportado: new Date().toISOString() }, null, 2);
}

/* ---------- Eventos ---------- */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act, id = b.dataset.id;
  if (a === 'ver-fondo') return ir('fondo', id);
  if (a === 'cerrar') return cerrar();
  if (a === 'nueva-op') { if (!S.res) return; return formOp(b.dataset.tipo, null, b.dataset.fondo); }
  if (a === 'cambiar-tipo') { const f = $('#opForm'); const fondo = f?.querySelector('[name=fondo]')?.value; return formOp(b.dataset.tipo, null, fondo); }
  if (a === 'editar-op') { const o = S.state.ops.find(x => x.id === id); return formOp(o.tipo, o); }
  if (a === 'borrar-op') {
    const o = S.state.ops.find(x => x.id === id);
    return confirmar('Borrar operación', `${TIPOS[o.tipo]} del ${fd(o.fecha)} en ${esc(nombreFondo(o.fondo))}. Los lotes y plusvalías posteriores se recalcularán.`, () => { S.state.ops = S.state.ops.filter(x => x.id !== id); persistir('Operación borrada'); });
  }
  if (a === 'confirmar-si') { const fn = confirmar.fn; confirmar.fn = null; cerrar(); return fn && fn(); }
  if (a === 'todas') {
    const f = $('#opForm'); const fondo = f.querySelector('[name=fondo]').value; const fecha = f.querySelector('[name=fecha]').value;
    const sin = { ...S.state, ops: S.state.ops.filter(x => x.id !== f.dataset.id && x.fecha <= fecha) };
    const r = Motor.calcular(sin, preciosCombinados()).fondos.find(x => x.id === fondo);
    f.querySelector('[name=participaciones]').value = nv(Number(r.participaciones.toFixed(6)));
    const imp = f.querySelector('[name=importe]'); if (!imp.value && r.vl) imp.value = nv((r.participaciones * r.vl).toFixed(2));
    return previsualizarOp();
  }
  if (a === 'ir-vl') { ir('datos'); return actualizarVL(); }
  if (a === 'actualizar-vl') return actualizarVL();
  if (a === 'recargar-vl') { const ok = await leerPreciosRemotos(); return toast(ok ? 'VL recargados desde el repositorio' : 'No se pudo leer precios.json'); }
  if (a === 'nuevo-fondo') return formFondo();
  if (a === 'editar-fondo') return formFondo(S.state.funds.find(f => f.id === id));
  if (a === 'borrar-fondo') {
    const n = S.state.ops.filter(o => o.fondo === id || o.destino === id).length;
    if (n) { const el = $('#fErr'); el.textContent = `No se puede borrar: tiene ${n} operaciones. Bórralas antes.`; el.hidden = false; return; }
    return confirmar('Borrar fondo', `Se borrará ${esc(nombreFondo(id))} y su serie de VL.`, () => { S.state.funds = S.state.funds.filter(f => f.id !== id); delete S.prices[id]; persistir('Fondo borrado'); });
  }
  if (a === 'nuevo-vl') return formVL(id);
  if (a === 'borrar-vl') { S.prices[id] = (S.prices[id] || []).filter(r => r[0] !== b.dataset.f); persistirPrecio(id, 'VL quitado'); return formVL(id); }
  if (a === 'fecha-fiscal') return formFechaFiscal(id);
  if (a === 'clasificar') { const o = S.state.ops.find(x => x.id === id); o.clase = b.dataset.c; return persistir('Clasificación guardada'); }
  if (a === 'anadir-perdida') {
    const y = Number($('#ppAnio').value), imp = parseNum($('#ppImp').value);
    if (!(y > 2000) || !(imp > 0)) return toast('Indica año e importe de la pérdida');
    S.state.settings.perdidasPrevias.push({ anio: y, importe: imp }); return persistir();
  }
  if (a === 'quitar-perdida') { S.state.settings.perdidasPrevias.splice(Number(b.dataset.i), 1); return persistir(); }
  if (a === 'importar') return formImportar();
  if (a === 'importar-si') {
    const err = $('#impErr'); err.hidden = true;
    try {
      let txt = $('#impTxt').value.trim();
      const file = $('#impFile').files[0];
      if (!txt && file) txt = await file.text();
      if (!txt) throw new Error('Elige un archivo o pega el contenido.');
      const imp = interpretar(txt);
      cerrar(); await aplicarImport(imp);
    } catch (ex) { err.textContent = ex.message || 'No se pudo leer el JSON.'; err.hidden = false; }
    return;
  }
  if (a === 'exportar') {
    const url = URL.createObjectURL(new Blob([exportJSON()], { type: 'application/json' }));
    const a2 = document.createElement('a'); a2.href = url; a2.download = `SergoInvest_${hoyISO()}.json`;
    document.body.appendChild(a2); a2.click(); a2.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    S.sucio = false; render(); return;
  }
  if (a === 'copiar-json') {
    const txt = exportJSON();
    try { await navigator.clipboard.writeText(txt); toast('Copia copiada al portapapeles'); }
    catch { abrir(`${cabecera('Copia de seguridad')}<p class="small muted">Selecciona todo y copia.</p><textarea readonly style="min-height:300px">${esc(txt)}</textarea>`); $('#dlgBody textarea').select(); }
  }
});

document.addEventListener('submit', e => {
  const form = e.target; e.preventDefault();
  if (form.id === 'opForm') {
    const o = leerOp(); const err = validarOp(o); const el = $('#opErr');
    if (err) { el.textContent = err; el.hidden = false; return; }
    const i = S.state.ops.findIndex(x => x.id === o.id);
    if (i >= 0) S.state.ops[i] = { ...S.state.ops[i], ...o }; else S.state.ops.push(o);
    cerrar(); persistir(i >= 0 ? 'Operación actualizada' : 'Operación registrada');
  }
  if (form.id === 'fondoForm') {
    const d = Object.fromEntries(new FormData(form).entries()); const el = $('#fErr');
    if (!d.nombre.trim() || !/^[A-Za-z]{2}[A-Za-z0-9]{10}$/.test(d.isin.trim())) { el.textContent = 'Indica nombre e ISIN válido (12 caracteres).'; el.hidden = false; return; }
    const ter = parseNum(d.ter);
    const datos = { nombre: d.nombre.trim(), isin: d.isin.trim().toUpperCase(), tipologia: d.tipologia.trim(), ter: Number.isFinite(ter) ? ter / 100 : 0, plataforma: d.plataforma.trim() };
    if (form.dataset.id) Object.assign(S.state.funds.find(f => f.id === form.dataset.id), datos);
    else {
      if (!S.state) S.state = normalizar({});
      const nid = uid('f'); S.state.funds.push({ id: nid, ...datos }); S.fondoSel = nid;
      const vl = parseNum(d.vl);
      if (vl > 0) S.prices[nid] = [[d.fechaVL || hoyISO(), vl]];
    }
    cerrar(); persistir('Fondo guardado');
  }
  if (form.id === 'vlForm') {
    const d = Object.fromEntries(new FormData(form).entries()); const vl = parseNum(d.vl); const id = form.dataset.id;
    if (!(vl > 0) || !d.fecha) { const el = $('#vErr'); el.textContent = 'Indica fecha y un VL mayor que 0.'; el.hidden = false; return; }
    const serie = (S.prices[id] || []).filter(r => r[0] !== d.fecha); serie.push([d.fecha, vl]); serie.sort((a, b) => a[0] < b[0] ? -1 : 1);
    S.prices[id] = serie; cerrar(); persistirPrecio(id);
  }
  if (form.id === 'tokenForm') {
    const t = $('#tokenIn').value.trim();
    if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(t)) { const el = $('#tErr'); el.textContent = 'Eso no parece un token de GitHub (empieza por github_pat_).'; el.hidden = false; return; }
    S.token = t; cerrar(); if (S.view !== 'datos') location.hash = 'datos'; actualizarVL(); return;
  }
  if (form.id === 'ffForm') {
    const o = S.state.ops.find(x => x.id === form.dataset.id);
    o.fechaFiscal = new FormData(form).get('fechaFiscal'); o.fechaFiscalConfirmada = true;
    cerrar(); persistir('Fecha confirmada');
  }
});

document.addEventListener('input', e => {
  if (e.target.closest('#opForm')) previsualizarOp();
  if (e.target.closest('#simForm')) actualizarSim();
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.closest('#opForm')) previsualizarOp();
  if (t.id === 'selFondo') { S.fondoSel = t.value; render(); }
  if (t.id === 'filFondo') { S.filtro.fondo = t.value; render(); }
  if (t.id === 'filTipo') { S.filtro.tipo = t.value; render(); }
  if (t.id === 'simFondo') { $('#simVL').value = ''; actualizarSim(); }
  if (t.closest('#simForm')) actualizarSim();
  if (t.id === 'otrosAhorro') { const y = new Date().getFullYear(); const v = parseNum(t.value); if (Number.isFinite(v)) S.state.settings.otrosAhorro[y] = v; else delete S.state.settings.otrosAhorro[y]; persistir(); }
});
const _render = render;
render = function () { _render(); if (S.view === 'fiscal' && S.res) actualizarSim(); };

arrancar();
