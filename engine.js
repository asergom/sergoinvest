/* ============================================================
   SergoInvest · Motor de cálculo
   Fuente única de verdad: el registro de operaciones (state.ops).
   Lotes, plusvalías, fiscalidad y rentabilidades se recalculan
   siempre desde cero, así que editar o borrar es seguro.
   ============================================================ */
const Motor = (() => {
  const EPS = 1e-6;
  const DIA = 86400000;

  // Escala de la base del ahorro (desde 2025)
  const ESCALA_AHORRO = [
    [6000, 0.19], [50000, 0.21], [200000, 0.23], [300000, 0.27], [Infinity, 0.30]
  ];
  const RETENCION = 0.19;
  const ANIOS_COMPENSACION = 4;

  const r2 = x => Math.round((x + Number.EPSILON) * 100) / 100;
  const t = s => Date.parse(s + 'T00:00:00Z');
  const anio = s => Number(String(s).slice(0, 4));
  const num = x => (x === '' || x == null || !Number.isFinite(Number(x))) ? 0 : Number(x);

  function cuotaEscala(base) {
    if (!(base > 0)) return 0;
    let cuota = 0, desde = 0;
    for (const [hasta, tipo] of ESCALA_AHORRO) {
      if (base <= desde) break;
      cuota += (Math.min(base, hasta) - desde) * tipo;
      desde = hasta;
    }
    return cuota;
  }

  /* ---------- TIR (XIRR) robusta por bisección ----------
     flujos: [{fecha, importe}] con signo del inversor
     (aportación negativa, cobro o valor final positivo). */
  function xirr(flujos) {
    const fl = flujos.filter(f => Math.abs(f.importe) > EPS);
    if (fl.length < 2) return null;
    if (!fl.some(f => f.importe < 0) || !fl.some(f => f.importe > 0)) return null;
    const t0 = Math.min(...fl.map(f => t(f.fecha)));
    const ys = fl.map(f => ({ y: (t(f.fecha) - t0) / (365 * DIA), v: f.importe }));
    const vpn = r => ys.reduce((s, f) => s + f.v / Math.pow(1 + r, f.y), 0);
    let lo = -0.9999, hi = 1;
    let flo = vpn(lo), fhi = vpn(hi);
    while (flo * fhi > 0 && hi < 1e6) { hi *= 4; fhi = vpn(hi); }
    if (flo * fhi > 0) return null;
    for (let i = 0; i < 300; i++) {
      const mid = (lo + hi) / 2, fm = vpn(mid);
      if (Math.abs(fm) < 1e-9 || (hi - lo) < 1e-12) return mid;
      if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  }

  /* Rentabilidad del periodo ponderada por dinero (Dietz modificado),
     sin anualizar. Útil cuando el periodo es menor de un año. */
  function dietz(flujos, fechaFin) {
    const fl = flujos.filter(f => Math.abs(f.importe) > EPS && f.fecha <= fechaFin);
    const aport = fl.filter(f => !f.final);
    if (!aport.length) return null;
    const ini = Math.min(...aport.map(f => t(f.fecha)));
    const T = (t(fechaFin) - ini) / DIA;
    const ganancia = fl.reduce((s, f) => s + f.importe, 0);
    let capital = 0;
    for (const f of aport) {
      const w = T > 0 ? (t(fechaFin) - t(f.fecha)) / DIA / T : 1;
      capital += -f.importe * w;
    }
    return capital > EPS ? ganancia / capital : null;
  }

  function rentabilidad(flujos, fechaFin) {
    const aport = flujos.filter(f => !f.final && Math.abs(f.importe) > EPS);
    if (!aport.length) return { tipo: null, valor: null, dias: 0 };
    const dias = (t(fechaFin) - Math.min(...aport.map(f => t(f.fecha)))) / DIA;
    if (dias >= 365) return { tipo: 'tir', valor: xirr(flujos), dias };
    return { tipo: 'periodo', valor: dietz(flujos, fechaFin), dias };
  }

  /* ---------- Precios ----------
     Serie oficial (prices[fondoId] = [[fecha, vl], ...]) + VL de
     ejecución deducidos de las operaciones. */
  function seriesPrecios(state, prices) {
    const s = {};
    for (const f of state.funds) s[f.id] = new Map();
    const put = (id, fecha, vl, prioridad) => {
      if (!s[id] || !(vl > 0) || !fecha) return;
      const prev = s[id].get(fecha);
      if (!prev || prioridad >= prev.p) s[id].set(fecha, { v: vl, p: prioridad });
    };
    for (const op of state.ops) {
      if (op.tipo === 'suscripcion' && op.participaciones > 0) put(op.fondo, op.fecha, op.vl || (op.importe / op.participaciones), 1);
      if (op.tipo === 'reembolso' && op.participaciones > 0) put(op.fondo, op.fecha, op.vl || (op.importe / op.participaciones), 1);
      if (op.tipo === 'traspaso') {
        if (op.participaciones > 0) put(op.fondo, op.fecha, op.importe / op.participaciones, 1);
        if (op.participacionesDestino > 0) put(op.destino, op.fechaDestino || op.fecha, (op.importeDestino || op.importe) / op.participacionesDestino, 1);
      }
      if (op.tipo === 'lote_inicial' && op.participaciones > 0 && op.costeEntrada > 0) put(op.fondo, op.fecha, op.vlEntrada || (op.costeEntrada / op.participaciones), 0);
    }
    for (const [id, serie] of Object.entries(prices || {})) {
      for (const [fecha, vl] of serie || []) put(id, fecha, Number(vl), 2);
    }
    const out = {};
    for (const [id, m] of Object.entries(s)) {
      out[id] = [...m.entries()].map(([fecha, o]) => [fecha, o.v]).sort((a, b) => a[0] < b[0] ? -1 : 1);
    }
    return out;
  }

  function precioEn(serie, fecha) {
    let res = null;
    for (const [f, v] of serie) { if (f <= fecha) res = [f, v]; else break; }
    return res;
  }

  /* ---------- Orden de proceso ---------- */
  const PRIORIDAD = { lote_inicial: 0, suscripcion: 1, traspaso: 2, reembolso: 3, historico: 4 };
  function ordenar(ops) {
    return ops.map((op, i) => ({ op, i }))
      .sort((a, b) => a.op.fecha < b.op.fecha ? -1 : a.op.fecha > b.op.fecha ? 1
        : (PRIORIDAD[a.op.tipo] - PRIORIDAD[b.op.tipo]) || (a.i - b.i))
      .map(x => x.op);
  }

  /* ---------- Motor principal ---------- */
  function calcular(state, prices, opciones = {}) {
    const funds = state.funds || [];
    const byId = Object.fromEntries(funds.map(f => [f.id, f]));
    const lotes = Object.fromEntries(funds.map(f => [f.id, []]));
    const avisos = [];
    const realizadas = [];        // ganancias/pérdidas por reembolso
    const historicos = [];
    const flujosGlobal = [];
    const flujosFondo = Object.fromEntries(funds.map(f => [f.id, []]));
    const movPart = Object.fromEntries(funds.map(f => [f.id, []]));
    const traspasosDiferidos = [];
    let seq = 0;

    const insertarLote = (fondo, lote) => {
      lote.seq = seq++;
      const arr = lotes[fondo];
      arr.push(lote);
      arr.sort((a, b) => a.fechaFiscal < b.fechaFiscal ? -1 : a.fechaFiscal > b.fechaFiscal ? 1 : a.seq - b.seq);
    };

    const consumir = (fondo, part, op) => {
      const arr = lotes[fondo];
      const disponibles = arr.reduce((s, l) => s + l.participaciones, 0);
      let resto = part;
      if (part > disponibles + 1e-4) {
        avisos.push({ nivel: 'error', opId: op.id, fondo,
          texto: `La operación del ${op.fecha} saca ${fmtP(part)} participaciones de ${nombre(fondo)}, pero solo había ${fmtP(disponibles)}.` });
        resto = disponibles;
      }
      const piezas = [];
      while (resto > EPS && arr.length) {
        const l = arr[0];
        const usa = Math.min(l.participaciones, resto);
        const prop = usa / l.participaciones;
        const pieza = {
          loteId: l.id, fechaFiscal: l.fechaFiscal, fechaEntrada: l.fechaEntrada,
          fechaEstimada: l.fechaEstimada, origen: l.origen,
          participaciones: usa,
          costeFiscal: l.costeFiscal * prop,
          costeEntrada: l.costeEntrada * prop
        };
        piezas.push(pieza);
        l.participaciones -= usa;
        l.costeFiscal -= pieza.costeFiscal;
        l.costeEntrada -= pieza.costeEntrada;
        resto -= usa;
        if (l.participaciones <= EPS) arr.shift();
      }
      return piezas;
    };

    const nombre = id => byId[id]?.nombre || id;
    const fmtP = x => x.toLocaleString('es-ES', { maximumFractionDigits: 6 });

    for (const op of ordenar(state.ops || [])) {
      if (!byId[op.fondo]) { avisos.push({ nivel: 'error', opId: op.id, texto: `Operación del ${op.fecha} sobre un fondo que ya no existe.` }); continue; }
      switch (op.tipo) {
        case 'suscripcion': {
          const imp = num(op.importe), part = num(op.participaciones);
          if (!(part > 0) || !(imp > 0)) { avisos.push({ nivel: 'error', opId: op.id, fondo: op.fondo, texto: `Suscripción del ${op.fecha} sin importe o participaciones.` }); break; }
          insertarLote(op.fondo, {
            id: op.id, opId: op.id, origen: 'suscripcion',
            fechaEntrada: op.fecha, fechaFiscal: op.fecha,
            participaciones: part, participacionesIniciales: part,
            costeFiscal: imp, costeEntrada: imp
          });
          flujosGlobal.push({ fecha: op.fecha, importe: -imp });
          flujosFondo[op.fondo].push({ fecha: op.fecha, importe: -imp });
          movPart[op.fondo].push([op.fecha, part]);
          break;
        }
        case 'lote_inicial': {
          const part = num(op.participaciones), cf = num(op.costeFiscal);
          const ce = num(op.costeEntrada) || cf;
          const ff = op.fechaFiscal || op.fecha;
          const estimada = op.origen === 'traspaso' && !op.fechaFiscalConfirmada;
          insertarLote(op.fondo, {
            id: op.id, opId: op.id, origen: op.origen || 'suscripcion',
            fechaEntrada: op.fecha, fechaFiscal: ff, fechaEstimada: estimada,
            participaciones: part, participacionesIniciales: part,
            costeFiscal: cf, costeEntrada: ce
          });
          // Global: el dinero de bolsillo (coste fiscal) entró en la fecha fiscal.
          flujosGlobal.push({ fecha: ff, importe: -cf, aproximado: estimada });
          // Fondo: entró el valor de mercado traspasado en la fecha de entrada.
          flujosFondo[op.fondo].push({ fecha: op.fecha, importe: -ce });
          movPart[op.fondo].push([op.fecha, part]);
          break;
        }
        case 'reembolso': {
          const part = num(op.participaciones), imp = num(op.importe);
          const piezas = consumir(op.fondo, part, op);
          const costeFiscal = piezas.reduce((s, p) => s + p.costeFiscal, 0);
          const costeEntrada = piezas.reduce((s, p) => s + p.costeEntrada, 0);
          const transmision = imp - num(op.comision);
          const ganancia = transmision - costeFiscal;
          realizadas.push({
            opId: op.id, fondo: op.fondo, fecha: op.fecha, anio: anio(op.fecha),
            participaciones: part, transmision, costeFiscal, costeEntrada, ganancia,
            retencion: op.retencion != null && op.retencion !== '' ? num(op.retencion) : Math.max(0, ganancia) * RETENCION,
            piezas, origen: 'reembolso'
          });
          flujosGlobal.push({ fecha: op.fecha, importe: imp });
          flujosFondo[op.fondo].push({ fecha: op.fecha, importe: imp });
          movPart[op.fondo].push([op.fecha, -part]);
          break;
        }
        case 'traspaso': {
          if (!byId[op.destino] || op.destino === op.fondo) { avisos.push({ nivel: 'error', opId: op.id, fondo: op.fondo, texto: `Traspaso del ${op.fecha} sin fondo destino válido.` }); break; }
          const part = num(op.participaciones), imp = num(op.importe);
          const fd = op.fechaDestino || op.fecha;
          const partD = num(op.participacionesDestino);
          const impD = num(op.importeDestino) || imp;
          const piezas = consumir(op.fondo, part, op);
          const totPart = piezas.reduce((s, p) => s + p.participaciones, 0);
          const costeFiscal = piezas.reduce((s, p) => s + p.costeFiscal, 0);
          if (!(partD > 0)) avisos.push({ nivel: 'error', opId: op.id, fondo: op.destino, texto: `Traspaso del ${op.fecha}: faltan las participaciones recibidas en ${nombre(op.destino)}.` });
          piezas.forEach((p, k) => {
            const prop = totPart > 0 ? p.participaciones / totPart : 0;
            insertarLote(op.destino, {
              id: `${op.id}:${k}`, opId: op.id, origen: 'traspaso', fondoOrigen: op.fondo,
              fechaEntrada: fd, fechaFiscal: p.fechaFiscal, fechaEstimada: p.fechaEstimada,
              participaciones: partD * prop, participacionesIniciales: partD * prop,
              costeFiscal: p.costeFiscal, costeEntrada: impD * prop
            });
          });
          traspasosDiferidos.push({ opId: op.id, fecha: op.fecha, origen: op.fondo, destino: op.destino, valor: imp, costeFiscal, diferida: imp - costeFiscal, lotes: piezas.length });
          flujosFondo[op.fondo].push({ fecha: op.fecha, importe: imp });
          flujosFondo[op.destino].push({ fecha: fd, importe: -impD });
          movPart[op.fondo].push([op.fecha, -part]);
          movPart[op.destino].push([fd, partD]);
          break;
        }
        case 'historico': {
          const h = { opId: op.id, fondo: op.fondo, fecha: op.fecha, anio: anio(op.fecha), resultado: num(op.resultado), descripcion: op.descripcion || '', clase: op.clase || 'pendiente' };
          historicos.push(h);
          if (h.clase === 'reembolso') {
            realizadas.push({ opId: op.id, fondo: op.fondo, fecha: op.fecha, anio: h.anio, participaciones: 0, transmision: null, costeFiscal: null, costeEntrada: null, ganancia: h.resultado, retencion: op.retencion != null && op.retencion !== '' ? num(op.retencion) : Math.max(0, h.resultado) * RETENCION, piezas: [], origen: 'historico' });
          }

          break;
        }
        default:
          avisos.push({ nivel: 'error', opId: op.id, texto: `Tipo de operación desconocido: ${op.tipo}` });
      }
    }

    const pendPorFondo = {};
    historicos.filter(h => h.clase === 'pendiente' && Math.abs(h.resultado) > 0.005).forEach(h => (pendPorFondo[h.fondo] = pendPorFondo[h.fondo] || []).push(h));
    for (const [fid, hs] of Object.entries(pendPorFondo)) {
      avisos.push({ nivel: 'aviso', fondo: fid, texto: `${nombre(fid)}: ${hs.length} resultado(s) histórico(s) sin clasificar (${hs.reduce((s, h) => s + h.resultado, 0).toFixed(2).replace('.', ',')} € en total). Indica en Fiscalidad si cada uno fue un reembolso (tributa) o un traspaso (no tributa).` });
    }

    /* ---------- Valoración ---------- */
    const series = seriesPrecios(state, prices);
    const hoy = opciones.hoy || new Date().toISOString().slice(0, 10);
    const fondos = [];
    let fechaValoracion = '0000-00-00';
    for (const f of funds) {
      const serie = series[f.id] || [];
      const ultimo = serie.length ? serie[serie.length - 1] : null;
      if (ultimo && ultimo[0] > fechaValoracion) fechaValoracion = ultimo[0];
    }
    if (fechaValoracion === '0000-00-00') fechaValoracion = hoy;

    for (const f of funds) {
      const ls = lotes[f.id];
      const serie = series[f.id] || [];
      const ultimo = serie.length ? serie[serie.length - 1] : null;
      const vl = ultimo ? ultimo[1] : 0;
      const fechaVL = ultimo ? ultimo[0] : null;
      const part = ls.reduce((s, l) => s + l.participaciones, 0);
      const costeFiscal = ls.reduce((s, l) => s + l.costeFiscal, 0);
      const costeEntrada = ls.reduce((s, l) => s + l.costeEntrada, 0);
      const valor = part * vl;
      const lotesV = ls.map(l => ({ ...l, valor: l.participaciones * vl, latente: l.participaciones * vl - l.costeFiscal, precioFiscal: l.participaciones > 0 ? l.costeFiscal / l.participaciones : 0 }));
      const flujos = flujosFondo[f.id].slice();
      if (valor > EPS) flujos.push({ fecha: fechaVL || fechaValoracion, importe: valor, final: true });
      const rent = rentabilidad(flujos, fechaVL || fechaValoracion);
      const realizadoFondo = realizadas.filter(r => r.fondo === f.id).reduce((s, r) => s + r.ganancia, 0);
      const diasVL = fechaVL ? (t(hoy) - t(fechaVL)) / DIA : null;
      if (part > EPS && (diasVL == null || diasVL > 7)) {
        avisos.push({ nivel: 'aviso', fondo: f.id, texto: fechaVL ? `El VL de ${f.nombre} es del ${fechaVL} (hace ${Math.round(diasVL)} días).` : `${f.nombre} no tiene VL.` });
      }
      if (lotesV.some(l => l.fechaEstimada)) {
        avisos.push({ nivel: 'info', fondo: f.id, texto: `${f.nombre}: ${lotesV.filter(l => l.fechaEstimada).length} lote(s) recibidos por traspaso con fecha de adquisición original sin confirmar. Se usa la fecha del traspaso para el orden FIFO.` });
      }
      fondos.push({
        id: f.id, fondo: f, vl, fechaVL, participaciones: part,
        costeFiscal, costeEntrada, valor,
        latenteFiscal: valor - costeFiscal,
        latenteFondo: valor - costeEntrada,
        pctFiscal: costeFiscal > EPS ? (valor - costeFiscal) / costeFiscal : null,
        pctFondo: costeEntrada > EPS ? (valor - costeEntrada) / costeEntrada : null,
        precioMedioFiscal: part > EPS ? costeFiscal / part : null,
        precioMedioEntrada: part > EPS ? costeEntrada / part : null,
        costeTER: valor * num(f.ter),
        rent, realizado: realizadoFondo,
        lotes: lotesV, flujos
      });
    }

    const valorTotal = fondos.reduce((s, f) => s + f.valor, 0);
    fondos.forEach(f => f.peso = valorTotal > EPS ? f.valor / valorTotal : 0);
    const flujosG = flujosGlobal.slice();
    if (valorTotal > EPS) flujosG.push({ fecha: fechaValoracion, importe: valorTotal, final: true });
    const rentGlobal = rentabilidad(flujosG, fechaValoracion);
    const aportadoNeto = -flujosGlobal.reduce((s, f) => s + f.importe, 0);

    /* ---------- Fiscalidad por ejercicio ---------- */
    const fiscal = fiscalidad(realizadas, state.settings || {});

    if (historicos.length && !historicos.some(h => h.clase === 'pendiente')) { /* ok */ }

    return {
      fondos, valorTotal, fechaValoracion, hoy,
      costeFiscal: fondos.reduce((s, f) => s + f.costeFiscal, 0),
      costeEntrada: fondos.reduce((s, f) => s + f.costeEntrada, 0),
      latenteFiscal: fondos.reduce((s, f) => s + f.latenteFiscal, 0),
      costeTER: fondos.reduce((s, f) => s + f.costeTER, 0),
      aportadoNeto, rentGlobal, flujosGlobal: flujosG,
      gananciaTotal: valorTotal - aportadoNeto,
      realizadas, historicos, traspasosDiferidos, fiscal, avisos,
      series, movPart
    };
  }

  /* ---------- Fiscalidad ----------
     Integra ganancias y pérdidas de fondos por año, compensa pérdidas
     de los 4 ejercicios anteriores (FIFO por antigüedad) y estima la
     cuota marginal sobre "otros rendimientos del ahorro" del año. */
  function fiscalidad(realizadas, settings) {
    const porAnio = {};
    for (const r of realizadas) {
      const a = porAnio[r.anio] || (porAnio[r.anio] = { anio: r.anio, ganancias: 0, perdidas: 0, retenciones: 0, operaciones: 0 });
      if (r.ganancia >= 0) a.ganancias += r.ganancia; else a.perdidas += -r.ganancia;
      a.retenciones += r.retencion || 0;
      a.operaciones++;
    }
    const previas = (settings.perdidasPrevias || []).map(p => ({ anio: Number(p.anio), restante: num(p.importe) })).filter(p => p.restante > 0);
    const otros = settings.otrosAhorro || {};
    const anios = new Set([...Object.keys(porAnio).map(Number), ...previas.map(p => p.anio)]);
    const anioActual = new Date().getFullYear();
    anios.add(anioActual);
    const lista = [...anios].sort((a, b) => a - b);
    const pendientes = previas.slice().sort((a, b) => a.anio - b.anio);
    const res = [];
    for (const y of lista) {
      const a = porAnio[y] || { anio: y, ganancias: 0, perdidas: 0, retenciones: 0, operaciones: 0 };
      const neto = a.ganancias - a.perdidas;
      let compensado = 0;
      const desglose = [];
      if (neto > 0) {
        let resto = neto;
        for (const p of pendientes) {
          if (p.anio >= y || p.anio < y - ANIOS_COMPENSACION || p.restante <= EPS) continue;
          const usa = Math.min(resto, p.restante);
          p.restante -= usa; resto -= usa; compensado += usa;
          desglose.push({ anio: p.anio, importe: usa });
          if (resto <= EPS) break;
        }
      } else if (neto < -EPS && !previas.some(p => p.anio === y)) {
        pendientes.push({ anio: y, restante: -neto, generada: true });
        pendientes.sort((p, q) => p.anio - q.anio);
      }
      const base = Math.max(0, neto - compensado);
      const otrosY = num(otros[y]);
      const cuota = cuotaEscala(otrosY + base) - cuotaEscala(otrosY);
      res.push({ ...a, neto, compensado, desglose, base, otros: otrosY, cuota, tipoMedio: base > EPS ? cuota / base : null, aDevolverOPagar: cuota - a.retenciones });
    }
    const pendientesVivas = pendientes.filter(p => p.restante > EPS && p.anio >= anioActual - ANIOS_COMPENSACION)
      .map(p => ({ anio: p.anio, restante: p.restante, caduca: p.anio + ANIOS_COMPENSACION }));
    return { anios: res, pendientes: pendientesVivas };
  }

  /* ---------- Simuladores ---------- */
  function simularReembolso(state, prices, { fondo, participaciones, vl, fecha }) {
    const base = calcular(state, prices);
    const op = { id: '__sim', tipo: 'reembolso', fondo, fecha, participaciones, importe: participaciones * vl };
    const sim = calcular({ ...state, ops: [...state.ops, op] }, prices);
    const r = sim.realizadas.find(x => x.opId === '__sim');
    const y = anio(fecha);
    const antes = base.fiscal.anios.find(a => a.anio === y) || { cuota: 0, neto: 0 };
    const despues = sim.fiscal.anios.find(a => a.anio === y) || { cuota: 0, neto: 0 };
    const avisoRecompra = r && r.ganancia < 0 ? recompras(state, fondo, fecha) : [];
    return {
      importe: op.importe, ganancia: r ? r.ganancia : 0, costeFiscal: r ? r.costeFiscal : 0,
      piezas: r ? r.piezas : [], retencion: r ? r.retencion : 0,
      cuotaIncremental: despues.cuota - antes.cuota,
      netoAnioAntes: antes.neto, netoAnioDespues: despues.neto,
      errores: sim.avisos.filter(a => a.opId === '__sim'),
      avisoRecompra
    };
  }

  function simularTraspaso(state, prices, { fondo, participaciones, vl, fecha }) {
    const s = calcular(state, prices);
    const f = s.fondos.find(x => x.id === fondo);
    if (!f) return null;
    let resto = participaciones; const piezas = [];
    for (const l of f.lotes) {
      if (resto <= EPS) break;
      const usa = Math.min(resto, l.participaciones);
      piezas.push({ fechaFiscal: l.fechaFiscal, participaciones: usa, costeFiscal: l.costeFiscal * usa / l.participaciones, fechaEstimada: l.fechaEstimada });
      resto -= usa;
    }
    const costeFiscal = piezas.reduce((a, p) => a + p.costeFiscal, 0);
    const valor = participaciones * vl;
    return { valor, costeFiscal, diferida: valor - costeFiscal, piezas, faltan: resto > 1e-4 ? resto : 0 };
  }

  /* Art. 33.5 g) LIRPF: pérdidas por transmisión de participaciones no
     cotizadas no computan si se adquieren homogéneas en el año anterior
     o posterior. Se avisa, no se aplica automáticamente. */
  function recompras(state, fondo, fecha) {
    const tf = t(fecha);
    return (state.ops || []).filter(o =>
      ((o.tipo === 'suscripcion' && o.fondo === fondo) || (o.tipo === 'traspaso' && o.destino === fondo) || (o.tipo === 'lote_inicial' && o.fondo === fondo))
      && Math.abs(t(o.tipo === 'traspaso' ? (o.fechaDestino || o.fecha) : o.fecha) - tf) <= 366 * DIA
      && o.id !== '__sim'
    ).map(o => o.fecha);
  }

  /* ---------- Evolución histórica ----------
     Valor de mercado y dinero aportado en cada fecha conocida. */
  function evolucion(res, fondoId = null) {
    const ids = fondoId ? [fondoId] : res.fondos.map(f => f.id);
    const fechas = new Set();
    for (const id of ids) {
      for (const [d] of res.movPart[id] || []) fechas.add(d);
      for (const [d] of res.series[id] || []) fechas.add(d);
    }
    const flujos = fondoId ? res.fondos.find(f => f.id === fondoId).flujos : res.flujosGlobal;
    for (const fl of flujos) if (!fl.final) fechas.add(fl.fecha);
    const lista = [...fechas].sort();
    const primera = Math.min(...ids.map(id => (res.movPart[id] || []).length ? t(res.movPart[id][0][0]) : Infinity));
    const out = [];
    for (const d of lista) {
      if (t(d) < primera) continue;
      let valor = 0, completo = true;
      for (const id of ids) {
        const part = (res.movPart[id] || []).filter(m => m[0] <= d).reduce((s, m) => s + m[1], 0);
        if (part <= EPS) continue;
        const p = precioEn(res.series[id] || [], d);
        if (!p) { completo = false; continue; }
        valor += part * p[1];
      }
      const aportado = -flujos.filter(fl => !fl.final && fl.fecha <= d).reduce((s, fl) => s + fl.importe, 0);
      out.push({ fecha: d, valor, aportado, completo });
    }
    return out;
  }

  return { calcular, simularReembolso, simularTraspaso, evolucion, xirr, dietz, cuotaEscala, seriesPrecios, ESCALA_AHORRO, RETENCION, r2 };
})();
if (typeof module !== 'undefined') module.exports = Motor;
