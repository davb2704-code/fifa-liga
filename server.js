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

// Migraciones para ligas existentes
try { db.exec("ALTER TABLE ligas ADD COLUMN tiene_goleadores INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE ligas ADD COLUMN tiene_tarjetas INTEGER DEFAULT 0"); } catch(e) {}

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

// POST /api/ligas - crear liga
app.post('/api/ligas', (req, res) => {
  const { nombre, jugadores, tiene_goleadores, tiene_tarjetas } = req.body;
  if (!nombre || !jugadores || jugadores.length < 2) {
    return res.status(400).json({ error: 'Nombre y al menos 2 jugadores requeridos' });
  }

  const liga = db.prepare(
    'INSERT INTO ligas (nombre, tiene_goleadores, tiene_tarjetas) VALUES (?, ?, ?)'
  ).run(nombre, tiene_goleadores ? 1 : 0, tiene_tarjetas ? 1 : 0);
  const ligaId = liga.lastInsertRowid;

  const insertJugador = db.prepare('INSERT INTO jugadores (liga_id, nombre) VALUES (?, ?)');
  const jugadoresDb = jugadores.map(n => {
    const r = insertJugador.run(ligaId, n);
    return { id: r.lastInsertRowid, nombre: n };
  });

  const fechas = generarFixture(jugadoresDb);
  const insertPartido = db.prepare(
    'INSERT INTO partidos (liga_id, fecha, tv, jugador1_id, jugador2_id) VALUES (?, ?, ?, ?, ?)'
  );
  fechas.forEach((partidos, fechaIdx) => {
    partidos.forEach((par, idx) => {
      insertPartido.run(ligaId, fechaIdx + 1, (idx % 2) + 1, par[0].id, par[1].id);
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
    SELECT p.*, j1.nombre as jugador1_nombre, j2.nombre as jugador2_nombre
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
    tabla[j.id] = { id: j.id, nombre: j.nombre, pj: 0, pg: 0, pe: 0, pp: 0, gf: 0, gc: 0, dg: 0, pts: 0 };
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
