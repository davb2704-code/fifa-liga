const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const db = new Database(path.join(__dirname, 'liga.db'));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Init DB
db.exec(`
  CREATE TABLE IF NOT EXISTS ligas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    tiene_goleadores INTEGER DEFAULT 0,
    tiene_tarjetas INTEGER DEFAULT 0,
    creada_en DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS jugadores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    liga_id INTEGER,
    nombre TEXT NOT NULL,
    FOREIGN KEY (liga_id) REFERENCES ligas(id)
  );

  CREATE TABLE IF NOT EXISTS partidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    liga_id INTEGER,
    fecha INTEGER NOT NULL,
    tv INTEGER NOT NULL,
    jugador1_id INTEGER,
    jugador2_id INTEGER,
    goles1 INTEGER DEFAULT NULL,
    goles2 INTEGER DEFAULT NULL,
    FOREIGN KEY (liga_id) REFERENCES ligas(id),
    FOREIGN KEY (jugador1_id) REFERENCES jugadores(id),
    FOREIGN KEY (jugador2_id) REFERENCES jugadores(id)
  );

  CREATE TABLE IF NOT EXISTS goles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partido_id INTEGER NOT NULL,
    jugador_id INTEGER NOT NULL,
    futbolista TEXT NOT NULL,
    FOREIGN KEY (partido_id) REFERENCES partidos(id),
    FOREIGN KEY (jugador_id) REFERENCES jugadores(id)
  );

  CREATE TABLE IF NOT EXISTS tarjetas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partido_id INTEGER NOT NULL,
    jugador_id INTEGER NOT NULL,
    futbolista TEXT NOT NULL,
    tipo TEXT NOT NULL,
    FOREIGN KEY (partido_id) REFERENCES partidos(id),
    FOREIGN KEY (jugador_id) REFERENCES jugadores(id)
  );

  CREATE TABLE IF NOT EXISTS suspensiones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    liga_id INTEGER NOT NULL,
    partido_id INTEGER NOT NULL,
    jugador_id INTEGER NOT NULL,
    futbolista TEXT NOT NULL,
    UNIQUE(partido_id, jugador_id, futbolista),
    FOREIGN KEY (liga_id) REFERENCES ligas(id),
    FOREIGN KEY (partido_id) REFERENCES partidos(id),
    FOREIGN KEY (jugador_id) REFERENCES jugadores(id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS playoff_partidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    liga_id INTEGER NOT NULL,
    ronda TEXT NOT NULL,
    orden INTEGER NOT NULL,
    jugador1_id INTEGER,
    jugador2_id INTEGER,
    goles1 INTEGER DEFAULT NULL,
    goles2 INTEGER DEFAULT NULL,
    FOREIGN KEY (liga_id) REFERENCES ligas(id),
    FOREIGN KEY (jugador1_id) REFERENCES jugadores(id),
    FOREIGN KEY (jugador2_id) REFERENCES jugadores(id)
  );
  CREATE TABLE IF NOT EXISTS playoff_goles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playoff_partido_id INTEGER NOT NULL,
    jugador_id INTEGER NOT NULL,
    futbolista TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS playoff_tarjetas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playoff_partido_id INTEGER NOT NULL,
    jugador_id INTEGER NOT NULL,
    futbolista TEXT NOT NULL,
    tipo TEXT NOT NULL
  );
`);

// Migraciones para ligas existentes
try { db.exec("ALTER TABLE ligas ADD COLUMN tiene_goleadores INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE ligas ADD COLUMN tiene_tarjetas INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE jugadores ADD COLUMN equipo TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE ligas ADD COLUMN num_tvs INTEGER DEFAULT 2"); } catch(e) {}
try { db.exec("ALTER TABLE ligas ADD COLUMN tiene_playoffs INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE ligas ADD COLUMN num_playoff_jugadores INTEGER DEFAULT 4"); } catch(e) {}
try { db.exec("ALTER TABLE ligas ADD COLUMN ida_vuelta INTEGER DEFAULT 0"); } catch(e) {}

// Genera fixture round-robin
function generarFixture(jugadores) {
  const lista = [...jugadores];
  if (lista.length % 2 !== 0) lista.push(null);
  const total = lista.length;
  const fechas = [];
  for (let ronda = 0; ronda < total - 1; ronda++) {
    const partidos = [];
    for (let i = 0; i < total / 2; i++) {
      const j1 = lista[i];
      const j2 = lista[total - 1 - i];
      if (j1 && j2) partidos.push([j1, j2]);
    }
    fechas.push(partidos);
    lista.splice(1, 0, lista.pop());
  }
  return fechas;
}

function getNextPartido(ligaId, jugadorId, currentFecha) {
  return db.prepare(`
    SELECT * FROM partidos
    WHERE liga_id = ? AND (jugador1_id = ? OR jugador2_id = ?) AND fecha > ?
    ORDER BY fecha ASC LIMIT 1
  `).get(ligaId, jugadorId, jugadorId, currentFecha);
}

// Recalcula suspensiones completas para una liga
function recalcSuspensiones(ligaId) {
  db.prepare('DELETE FROM suspensiones WHERE liga_id = ?').run(ligaId);

  const partidos = db.prepare(`
    SELECT * FROM partidos WHERE liga_id = ? AND goles1 IS NOT NULL ORDER BY fecha, id
  `).all(ligaId);

  const amarillasAcum = {}; // key: jugadorId:futbolista_lower

  partidos.forEach(partido => {
    [partido.jugador1_id, partido.jugador2_id].forEach(jugadorId => {
      const cards = db.prepare(
        'SELECT * FROM tarjetas WHERE partido_id = ? AND jugador_id = ?'
      ).all(partido.id, jugadorId);

      cards.forEach(card => {
        const key = `${jugadorId}:${card.futbolista.toLowerCase()}`;
        if (card.tipo === 'roja') {
          const next = getNextPartido(ligaId, jugadorId, partido.fecha);
          if (next) {
            try {
              db.prepare('INSERT OR IGNORE INTO suspensiones (liga_id, partido_id, jugador_id, futbolista) VALUES (?, ?, ?, ?)')
                .run(ligaId, next.id, jugadorId, card.futbolista);
            } catch(e) {}
          }
          amarillasAcum[key] = 0; // roja resetea amarillas
        } else if (card.tipo === 'amarilla') {
          amarillasAcum[key] = (amarillasAcum[key] || 0) + 1;
          if (amarillasAcum[key] % 2 === 0) { // cada 2 amarillas -> suspensión
            const next = getNextPartido(ligaId, jugadorId, partido.fecha);
            if (next) {
              try {
                db.prepare('INSERT OR IGNORE INTO suspensiones (liga_id, partido_id, jugador_id, futbolista) VALUES (?, ?, ?, ?)')
                  .run(ligaId, next.id, jugadorId, card.futbolista);
              } catch(e) {}
            }
          }
        }
      });
    });
  });
}

// ── PLAYOFFS HELPERS ─────────────────────────────────────

function getRondas(n) {
  if (n <= 2) return ['final'];
  if (n <= 4) return ['semi', 'final'];
  return ['cuartos', 'semi', 'final'];
}

// Dado un partido de ronda X, retorna a qué partido de la siguiente ronda va el ganador
function getAvance(ronda, orden, n) {
  if (n <= 2) return null;
  if (n <= 4) {
    if (ronda === 'semi') return { ronda: 'final', orden: 1, pos: orden === 1 ? 1 : 2 };
  }
  if (n <= 8) {
    if (ronda === 'cuartos') {
      const map = { 1: [1,1], 2: [2,1], 3: [2,2], 4: [1,2] };
      const [sfOrden, pos] = map[orden];
      return { ronda: 'semi', orden: sfOrden, pos };
    }
    if (ronda === 'semi') return { ronda: 'final', orden: 1, pos: orden === 1 ? 1 : 2 };
  }
  return null;
}

function avanzarGanador(ligaId, ronda, orden, ganadorId, n) {
  const avance = getAvance(ronda, orden, n);
  if (!avance) return;
  const col = avance.pos === 1 ? 'jugador1_id' : 'jugador2_id';
  db.prepare(`UPDATE playoff_partidos SET ${col} = ? WHERE liga_id = ? AND ronda = ? AND orden = ?`)
    .run(ganadorId, ligaId, avance.ronda, avance.orden);
}

// ── PLAYOFFS ENDPOINTS ────────────────────────────────────

// POST /api/ligas/:id/generar-playoffs
app.post('/api/ligas/:id/generar-playoffs', (req, res) => {
  const id = req.params.id;
  const liga = db.prepare('SELECT * FROM ligas WHERE id = ?').get(id);
  if (!liga) return res.status(404).json({ error: 'Liga no encontrada' });

  // Limpiar playoffs anteriores
  db.prepare('DELETE FROM playoff_partidos WHERE liga_id = ?').run(id);

  // Obtener tabla de posiciones
  const jugadores = db.prepare('SELECT * FROM jugadores WHERE liga_id = ?').all(id);
  const partidos  = db.prepare('SELECT * FROM partidos WHERE liga_id = ? AND goles1 IS NOT NULL').all(id);
  const tabla = {};
  jugadores.forEach(j => { tabla[j.id] = { id: j.id, nombre: j.nombre, pts: 0, dg: 0, gf: 0 }; });
  partidos.forEach(p => {
    const j1 = tabla[p.jugador1_id], j2 = tabla[p.jugador2_id];
    if (!j1 || !j2) return;
    j1.gf += p.goles1; j1.dg += p.goles1 - p.goles2;
    j2.gf += p.goles2; j2.dg += p.goles2 - p.goles1;
    if (p.goles1 > p.goles2) { j1.pts += 3; }
    else if (p.goles1 < p.goles2) { j2.pts += 3; }
    else { j1.pts++; j2.pts++; }
  });
  const seeds = Object.values(tabla)
    .sort((a,b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf)
    .slice(0, liga.num_playoff_jugadores || 4);

  const n = seeds.length;
  const rondas = getRondas(n);
  const ins = db.prepare('INSERT INTO playoff_partidos (liga_id, ronda, orden, jugador1_id, jugador2_id) VALUES (?,?,?,?,?)');

  if (n === 2) {
    ins.run(id, 'final', 1, seeds[0].id, seeds[1].id);
  } else if (n === 4) {
    ins.run(id, 'semi', 1, seeds[0].id, seeds[3].id);
    ins.run(id, 'semi', 2, seeds[1].id, seeds[2].id);
    ins.run(id, 'final', 1, null, null);
  } else if (n === 8) {
    ins.run(id, 'cuartos', 1, seeds[0].id, seeds[7].id);
    ins.run(id, 'cuartos', 2, seeds[1].id, seeds[6].id);
    ins.run(id, 'cuartos', 3, seeds[2].id, seeds[5].id);
    ins.run(id, 'cuartos', 4, seeds[3].id, seeds[4].id);
    ins.run(id, 'semi', 1, null, null);
    ins.run(id, 'semi', 2, null, null);
    ins.run(id, 'final', 1, null, null);
  }

  res.json({ ok: true });
});

// GET /api/ligas/:id/playoffs
app.get('/api/ligas/:id/playoffs', (req, res) => {
  const partidos = db.prepare(`
    SELECT pp.*,
      j1.nombre as jugador1_nombre, j1.equipo as jugador1_equipo,
      j2.nombre as jugador2_nombre, j2.equipo as jugador2_equipo
    FROM playoff_partidos pp
    LEFT JOIN jugadores j1 ON pp.jugador1_id = j1.id
    LEFT JOIN jugadores j2 ON pp.jugador2_id = j2.id
    WHERE pp.liga_id = ? ORDER BY pp.ronda, pp.orden
  `).all(req.params.id);
  partidos.forEach(p => {
    p.goles_detalle = db.prepare('SELECT * FROM playoff_goles WHERE playoff_partido_id = ?').all(p.id);
    p.tarjetas_detalle = db.prepare('SELECT * FROM playoff_tarjetas WHERE playoff_partido_id = ?').all(p.id);
  });
  res.json(partidos);
});

// PUT /api/playoff-partidos/:id
app.put('/api/playoff-partidos/:id', (req, res) => {
  const { goles1, goles2, goleadores1, goleadores2, tarjetas1, tarjetas2 } = req.body;
  if (goles1 === undefined || goles2 === undefined)
    return res.status(400).json({ error: 'Goles requeridos' });

  const pp = db.prepare('SELECT * FROM playoff_partidos WHERE id = ?').get(req.params.id);
  if (!pp) return res.status(404).json({ error: 'Partido no encontrado' });

  db.prepare('UPDATE playoff_partidos SET goles1 = ?, goles2 = ? WHERE id = ?')
    .run(goles1, goles2, req.params.id);

  // Goleadores
  db.prepare('DELETE FROM playoff_goles WHERE playoff_partido_id = ?').run(req.params.id);
  const insGol = db.prepare('INSERT INTO playoff_goles (playoff_partido_id, jugador_id, futbolista) VALUES (?, ?, ?)');
  (goleadores1 || []).forEach(f => { if ((f || '').trim()) insGol.run(req.params.id, pp.jugador1_id, f.trim()); });
  (goleadores2 || []).forEach(f => { if ((f || '').trim()) insGol.run(req.params.id, pp.jugador2_id, f.trim()); });

  // Tarjetas
  db.prepare('DELETE FROM playoff_tarjetas WHERE playoff_partido_id = ?').run(req.params.id);
  const insTar = db.prepare('INSERT INTO playoff_tarjetas (playoff_partido_id, jugador_id, futbolista, tipo) VALUES (?, ?, ?, ?)');
  (tarjetas1 || []).forEach(t => { if ((t.futbolista || '').trim()) insTar.run(req.params.id, pp.jugador1_id, t.futbolista.trim(), t.tipo); });
  (tarjetas2 || []).forEach(t => { if ((t.futbolista || '').trim()) insTar.run(req.params.id, pp.jugador2_id, t.futbolista.trim(), t.tipo); });

  const liga = db.prepare('SELECT * FROM ligas WHERE id = ?').get(pp.liga_id);
  const n = liga.num_playoff_jugadores || 4;
  const ganadorId = goles1 > goles2 ? pp.jugador1_id : pp.jugador2_id;
  avanzarGanador(pp.liga_id, pp.ronda, pp.orden, ganadorId, n);

  res.json({ ok: true });
});

// POST /api/ligas/:id/resetear-playoffs
app.post('/api/ligas/:id/resetear-playoffs', (req, res) => {
  const ppids = db.prepare('SELECT id FROM playoff_partidos WHERE liga_id = ?').all(req.params.id);
  ppids.forEach(p => {
    db.prepare('DELETE FROM playoff_goles WHERE playoff_partido_id = ?').run(p.id);
    db.prepare('DELETE FROM playoff_tarjetas WHERE playoff_partido_id = ?').run(p.id);
  });
  db.prepare('DELETE FROM playoff_partidos WHERE liga_id = ?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/ligas - crear liga
app.post('/api/ligas', (req, res) => {
  const { nombre, jugadores, tiene_goleadores, tiene_tarjetas, num_tvs, tiene_playoffs, num_playoff_jugadores, ida_vuelta } = req.body;
  if (!nombre || !jugadores || jugadores.length < 2) {
    return res.status(400).json({ error: 'Nombre y al menos 2 jugadores requeridos' });
  }

  const liga = db.prepare(
    'INSERT INTO ligas (nombre, tiene_goleadores, tiene_tarjetas, num_tvs, tiene_playoffs, num_playoff_jugadores, ida_vuelta) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(nombre, tiene_goleadores ? 1 : 0, tiene_tarjetas ? 1 : 0, num_tvs || 2, tiene_playoffs ? 1 : 0, num_playoff_jugadores || 4, ida_vuelta ? 1 : 0);
  const ligaId = liga.lastInsertRowid;

  const insertJugador = db.prepare('INSERT INTO jugadores (liga_id, nombre, equipo) VALUES (?, ?, ?)');
  const jugadoresDb = jugadores.map(j => {
    const nombre = typeof j === 'string' ? j : j.nombre;
    const equipo = typeof j === 'string' ? '' : (j.equipo || '');
    const r = insertJugador.run(ligaId, nombre, equipo);
    return { id: r.lastInsertRowid, nombre, equipo };
  });

  const nTvs = num_tvs || 2;
  const fechas = generarFixture(jugadoresDb);
  // Si ida y vuelta: duplicar el fixture con equipos invertidos
  if (ida_vuelta) {
    const vuelta = fechas.map(ronda => ronda.map(([j1, j2]) => [j2, j1]));
    fechas.push(...vuelta);
  }
  const insertPartido = db.prepare(
    'INSERT INTO partidos (liga_id, fecha, tv, jugador1_id, jugador2_id) VALUES (?, ?, ?, ?, ?)'
  );
  fechas.forEach((partidos, fechaIdx) => {
    partidos.forEach((par, idx) => {
      insertPartido.run(ligaId, fechaIdx + 1, (idx % nTvs) + 1, par[0].id, par[1].id);
    });
  });

  res.json({ id: ligaId, nombre, jugadores: jugadoresDb });
});

// GET /api/ligas - listar ligas
app.get('/api/ligas', (req, res) => {
  res.json(db.prepare('SELECT * FROM ligas ORDER BY creada_en DESC').all());
});

// GET /api/ligas/:id - detalle de liga
app.get('/api/ligas/:id', (req, res) => {
  const liga = db.prepare('SELECT * FROM ligas WHERE id = ?').get(req.params.id);
  if (!liga) return res.status(404).json({ error: 'Liga no encontrada' });

  const jugadores = db.prepare('SELECT * FROM jugadores WHERE liga_id = ?').all(req.params.id);
  const partidos = db.prepare(`
    SELECT p.*,
      j1.nombre as jugador1_nombre, j1.equipo as jugador1_equipo,
      j2.nombre as jugador2_nombre, j2.equipo as jugador2_equipo
    FROM partidos p
    JOIN jugadores j1 ON p.jugador1_id = j1.id
    JOIN jugadores j2 ON p.jugador2_id = j2.id
    WHERE p.liga_id = ? ORDER BY p.fecha, p.tv
  `).all(req.params.id);

  partidos.forEach(p => {
    p.goles_detalle = db.prepare(
      'SELECT * FROM goles WHERE partido_id = ?'
    ).all(p.id);
    p.tarjetas_detalle = db.prepare(
      'SELECT * FROM tarjetas WHERE partido_id = ?'
    ).all(p.id);
    p.suspensiones = db.prepare(`
      SELECT s.*, j.nombre as jugador_nombre
      FROM suspensiones s JOIN jugadores j ON s.jugador_id = j.id
      WHERE s.partido_id = ?
    `).all(p.id);
  });

  res.json({ ...liga, jugadores, partidos });
});

// DELETE /api/ligas/:id - eliminar liga
app.delete('/api/ligas/:id', (req, res) => {
  const id = req.params.id;
  if (!db.prepare('SELECT id FROM ligas WHERE id = ?').get(id)) {
    return res.status(404).json({ error: 'Liga no encontrada' });
  }
  const ppids = db.prepare('SELECT id FROM playoff_partidos WHERE liga_id = ?').all(id);
  ppids.forEach(p => {
    db.prepare('DELETE FROM playoff_goles WHERE playoff_partido_id = ?').run(p.id);
    db.prepare('DELETE FROM playoff_tarjetas WHERE playoff_partido_id = ?').run(p.id);
  });
  db.prepare('DELETE FROM playoff_partidos WHERE liga_id = ?').run(id);
  db.prepare('DELETE FROM suspensiones WHERE liga_id = ?').run(id);
  const pids = db.prepare('SELECT id FROM partidos WHERE liga_id = ?').all(id);
  pids.forEach(p => {
    db.prepare('DELETE FROM goles WHERE partido_id = ?').run(p.id);
    db.prepare('DELETE FROM tarjetas WHERE partido_id = ?').run(p.id);
  });
  db.prepare('DELETE FROM partidos WHERE liga_id = ?').run(id);
  db.prepare('DELETE FROM jugadores WHERE liga_id = ?').run(id);
  db.prepare('DELETE FROM ligas WHERE id = ?').run(id);
  res.json({ ok: true });
});

// POST /api/ligas/:id/reiniciar
app.post('/api/ligas/:id/reiniciar', (req, res) => {
  const id = req.params.id;
  if (!db.prepare('SELECT id FROM ligas WHERE id = ?').get(id)) {
    return res.status(404).json({ error: 'Liga no encontrada' });
  }
  db.prepare('UPDATE partidos SET goles1 = NULL, goles2 = NULL WHERE liga_id = ?').run(id);
  const pids = db.prepare('SELECT id FROM partidos WHERE liga_id = ?').all(id);
  pids.forEach(p => {
    db.prepare('DELETE FROM goles WHERE partido_id = ?').run(p.id);
    db.prepare('DELETE FROM tarjetas WHERE partido_id = ?').run(p.id);
  });
  db.prepare('DELETE FROM suspensiones WHERE liga_id = ?').run(id);
  const ppids = db.prepare('SELECT id FROM playoff_partidos WHERE liga_id = ?').all(id);
  ppids.forEach(p => {
    db.prepare('DELETE FROM playoff_goles WHERE playoff_partido_id = ?').run(p.id);
    db.prepare('DELETE FROM playoff_tarjetas WHERE playoff_partido_id = ?').run(p.id);
  });
  db.prepare('DELETE FROM playoff_partidos WHERE liga_id = ?').run(id);
  res.json({ ok: true });
});

// PUT /api/partidos/:id - cargar resultado con goleadores y tarjetas
app.put('/api/partidos/:id', (req, res) => {
  const { goles1, goles2, goleadores1, goleadores2, tarjetas1, tarjetas2 } = req.body;
  if (goles1 === undefined || goles2 === undefined) {
    return res.status(400).json({ error: 'Goles requeridos' });
  }

  const partido = db.prepare('SELECT * FROM partidos WHERE id = ?').get(req.params.id);
  if (!partido) return res.status(404).json({ error: 'Partido no encontrado' });

  db.prepare('UPDATE partidos SET goles1 = ?, goles2 = ? WHERE id = ?')
    .run(goles1, goles2, req.params.id);

  // Goleadores
  db.prepare('DELETE FROM goles WHERE partido_id = ?').run(req.params.id);
  const insGol = db.prepare('INSERT INTO goles (partido_id, jugador_id, futbolista) VALUES (?, ?, ?)');
  (goleadores1 || []).forEach(f => { if ((f || '').trim()) insGol.run(req.params.id, partido.jugador1_id, f.trim()); });
  (goleadores2 || []).forEach(f => { if ((f || '').trim()) insGol.run(req.params.id, partido.jugador2_id, f.trim()); });

  // Tarjetas
  db.prepare('DELETE FROM tarjetas WHERE partido_id = ?').run(req.params.id);
  const insTar = db.prepare('INSERT INTO tarjetas (partido_id, jugador_id, futbolista, tipo) VALUES (?, ?, ?, ?)');
  (tarjetas1 || []).forEach(t => { if ((t.futbolista || '').trim()) insTar.run(req.params.id, partido.jugador1_id, t.futbolista.trim(), t.tipo); });
  (tarjetas2 || []).forEach(t => { if ((t.futbolista || '').trim()) insTar.run(req.params.id, partido.jugador2_id, t.futbolista.trim(), t.tipo); });

  // Recalcular suspensiones
  const liga = db.prepare('SELECT * FROM ligas WHERE id = ?').get(partido.liga_id);
  if (liga.tiene_tarjetas) recalcSuspensiones(partido.liga_id);

  res.json({ ok: true });
});

// GET /api/ligas/:id/tabla
app.get('/api/ligas/:id/tabla', (req, res) => {
  const jugadores = db.prepare('SELECT * FROM jugadores WHERE liga_id = ?').all(req.params.id);
  const partidos = db.prepare(
    'SELECT * FROM partidos WHERE liga_id = ? AND goles1 IS NOT NULL'
  ).all(req.params.id);

  const tabla = {};
  jugadores.forEach(j => {
    tabla[j.id] = { id: j.id, nombre: j.nombre, equipo: j.equipo || '', pj: 0, pg: 0, pe: 0, pp: 0, gf: 0, gc: 0, dg: 0, pts: 0 };
  });
  partidos.forEach(p => {
    const j1 = tabla[p.jugador1_id], j2 = tabla[p.jugador2_id];
    if (!j1 || !j2) return;
    j1.pj++; j2.pj++;
    j1.gf += p.goles1; j1.gc += p.goles2;
    j2.gf += p.goles2; j2.gc += p.goles1;
    j1.dg = j1.gf - j1.gc; j2.dg = j2.gf - j2.gc;
    if (p.goles1 > p.goles2) { j1.pg++; j1.pts += 3; j2.pp++; }
    else if (p.goles1 < p.goles2) { j2.pg++; j2.pts += 3; j1.pp++; }
    else { j1.pe++; j2.pe++; j1.pts++; j2.pts++; }
  });

  res.json(Object.values(tabla).sort((a, b) => b.pts - a.pts || b.dg - a.dg || b.gf - a.gf));
});

// GET /api/ligas/:id/goleadores
app.get('/api/ligas/:id/goleadores', (req, res) => {
  const rows = db.prepare(`
    SELECT LOWER(g.futbolista) as key, g.futbolista, COUNT(*) as goles
    FROM goles g
    JOIN partidos p ON g.partido_id = p.id
    WHERE p.liga_id = ?
    GROUP BY LOWER(g.futbolista)
    ORDER BY goles DESC, g.futbolista ASC
  `).all(req.params.id);
  res.json(rows);
});

// GET /api/ligas/:id/tarjetas-resumen
app.get('/api/ligas/:id/tarjetas-resumen', (req, res) => {
  const rows = db.prepare(`
    SELECT LOWER(t.futbolista) as key, t.futbolista,
      SUM(CASE WHEN t.tipo = 'amarilla' THEN 1 ELSE 0 END) as amarillas,
      SUM(CASE WHEN t.tipo = 'roja'    THEN 1 ELSE 0 END) as rojas
    FROM tarjetas t
    JOIN partidos p ON t.partido_id = p.id
    WHERE p.liga_id = ?
    GROUP BY LOWER(t.futbolista)
    ORDER BY rojas DESC, amarillas DESC, t.futbolista ASC
  `).all(req.params.id);
  res.json(rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
