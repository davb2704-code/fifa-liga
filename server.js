const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const db = new Database('liga.db');

app.use(express.json());
app.use(express.static('public'));

// Init DB
db.exec(`
  CREATE TABLE IF NOT EXISTS ligas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
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
`);

// Genera fixture round-robin
function generarFixture(jugadores) {
  const n = jugadores.length;
  const lista = [...jugadores];
  if (n % 2 !== 0) lista.push(null); // bye si impar
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
    // Rotar (fijo el primero)
    lista.splice(1, 0, lista.pop());
  }
  return fechas;
}

// POST /api/ligas - crear liga
app.post('/api/ligas', (req, res) => {
  const { nombre, jugadores } = req.body;
  if (!nombre || !jugadores || jugadores.length < 2) {
    return res.status(400).json({ error: 'Nombre y al menos 2 jugadores requeridos' });
  }

  const liga = db.prepare('INSERT INTO ligas (nombre) VALUES (?)').run(nombre);
  const ligaId = liga.lastInsertRowid;

  const insertJugador = db.prepare('INSERT INTO jugadores (liga_id, nombre) VALUES (?, ?)');
  const jugadoresDb = jugadores.map(nombre => {
    const r = insertJugador.run(ligaId, nombre);
    return { id: r.lastInsertRowid, nombre };
  });

  // Generar fixture
  const fechas = generarFixture(jugadoresDb);
  const insertPartido = db.prepare(
    'INSERT INTO partidos (liga_id, fecha, tv, jugador1_id, jugador2_id) VALUES (?, ?, ?, ?, ?)'
  );

  fechas.forEach((partidos, fechaIdx) => {
    partidos.forEach((par, idx) => {
      const tv = (idx % 2) + 1; // TV1 o TV2, el resto queda como TV3+
      insertPartido.run(ligaId, fechaIdx + 1, tv, par[0].id, par[1].id);
    });
  });

  res.json({ id: ligaId, nombre, jugadores: jugadoresDb });
});

// GET /api/ligas - listar ligas
app.get('/api/ligas', (req, res) => {
  const ligas = db.prepare('SELECT * FROM ligas ORDER BY creada_en DESC').all();
  res.json(ligas);
});

// GET /api/ligas/:id - detalle de liga
app.get('/api/ligas/:id', (req, res) => {
  const liga = db.prepare('SELECT * FROM ligas WHERE id = ?').get(req.params.id);
  if (!liga) return res.status(404).json({ error: 'Liga no encontrada' });

  const jugadores = db.prepare('SELECT * FROM jugadores WHERE liga_id = ?').all(req.params.id);
  const partidos = db.prepare(`
    SELECT p.*,
      j1.nombre as jugador1_nombre, j2.nombre as jugador2_nombre
    FROM partidos p
    JOIN jugadores j1 ON p.jugador1_id = j1.id
    JOIN jugadores j2 ON p.jugador2_id = j2.id
    WHERE p.liga_id = ?
    ORDER BY p.fecha, p.tv
  `).all(req.params.id);

  res.json({ ...liga, jugadores, partidos });
});

// PUT /api/partidos/:id - cargar resultado
app.put('/api/partidos/:id', (req, res) => {
  const { goles1, goles2 } = req.body;
  if (goles1 === undefined || goles2 === undefined) {
    return res.status(400).json({ error: 'Goles requeridos' });
  }
  db.prepare('UPDATE partidos SET goles1 = ?, goles2 = ? WHERE id = ?')
    .run(goles1, goles2, req.params.id);
  res.json({ ok: true });
});

// GET /api/ligas/:id/tabla - tabla de posiciones
app.get('/api/ligas/:id/tabla', (req, res) => {
  const jugadores = db.prepare('SELECT * FROM jugadores WHERE liga_id = ?').all(req.params.id);
  const partidos = db.prepare(
    'SELECT * FROM partidos WHERE liga_id = ? AND goles1 IS NOT NULL'
  ).all(req.params.id);

  const tabla = {};
  jugadores.forEach(j => {
    tabla[j.id] = {
      id: j.id, nombre: j.nombre,
      pj: 0, pg: 0, pe: 0, pp: 0,
      gf: 0, gc: 0, dg: 0, pts: 0
    };
  });

  partidos.forEach(p => {
    const j1 = tabla[p.jugador1_id];
    const j2 = tabla[p.jugador2_id];
    if (!j1 || !j2) return;

    j1.pj++; j2.pj++;
    j1.gf += p.goles1; j1.gc += p.goles2;
    j2.gf += p.goles2; j2.gc += p.goles1;
    j1.dg = j1.gf - j1.gc;
    j2.dg = j2.gf - j2.gc;

    if (p.goles1 > p.goles2) {
      j1.pg++; j1.pts += 3; j2.pp++;
    } else if (p.goles1 < p.goles2) {
      j2.pg++; j2.pts += 3; j1.pp++;
    } else {
      j1.pe++; j2.pe++; j1.pts++; j2.pts++;
    }
  });

  const resultado = Object.values(tabla).sort((a, b) =>
    b.pts - a.pts || b.dg - a.dg || b.gf - a.gf
  );
  res.json(resultado);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
