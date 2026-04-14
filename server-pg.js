const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ligas (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      tiene_goleadores INTEGER DEFAULT 0,
      tiene_tarjetas INTEGER DEFAULT 0,
      creada_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jugadores (
      id SERIAL PRIMARY KEY,
      liga_id INTEGER REFERENCES ligas(id),
      nombre TEXT NOT NULL,
      equipo TEXT DEFAULT ''
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS partidos (
      id SERIAL PRIMARY KEY,
      liga_id INTEGER REFERENCES ligas(id),
      fecha INTEGER NOT NULL,
      tv INTEGER NOT NULL,
      jugador1_id INTEGER REFERENCES jugadores(id),
      jugador2_id INTEGER REFERENCES jugadores(id),
      goles1 INTEGER DEFAULT NULL,
      goles2 INTEGER DEFAULT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS goles (
      id SERIAL PRIMARY KEY,
      partido_id INTEGER REFERENCES partidos(id),
      jugador_id INTEGER REFERENCES jugadores(id),
      futbolista TEXT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tarjetas (
      id SERIAL PRIMARY KEY,
      partido_id INTEGER REFERENCES partidos(id),
      jugador_id INTEGER REFERENCES jugadores(id),
      futbolista TEXT NOT NULL,
      tipo TEXT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS suspensiones (
      id SERIAL PRIMARY KEY,
      liga_id INTEGER REFERENCES ligas(id),
      partido_id INTEGER REFERENCES partidos(id),
      jugador_id INTEGER REFERENCES jugadores(id),
      futbolista TEXT NOT NULL,
      UNIQUE(partido_id, jugador_id, futbolista)
    )
  `);
}

function generarFixture(jugadores) {
  const lista = [...jugadores];
  if (lista.length % 2 !== 0) lista.push(null);
  const total = lista.length;
  const fechas = [];
  for (let ronda = 0; ronda < total - 1; ronda++) {
    const partidos = [];
    for (let i = 0; i < total / 2; i++) {
      const j1 = lista[i], j2 = lista[total - 1 - i];
      if (j1 && j2) partidos.push([j1, j2]);
    }
    fechas.push(partidos);
    lista.splice(1, 0, lista.pop());
  }
  return fechas;
}

async function getNextPartido(ligaId, jugadorId, currentFecha) {
  const { rows } = await pool.query(`
    SELECT * FROM partidos
    WHERE liga_id = $1 AND (jugador1_id = $2 OR jugador2_id = $2) AND fecha > $3
    ORDER BY fecha ASC LIMIT 1
  `, [ligaId, jugadorId, currentFecha]);
  return rows[0];
}

async function recalcSuspensiones(ligaId) {
  await pool.query('DELETE FROM suspensiones WHERE liga_id = $1', [ligaId]);
  const { rows: partidos } = await pool.query(
    'SELECT * FROM partidos WHERE liga_id = $1 AND goles1 IS NOT NULL ORDER BY fecha, id',
    [ligaId]
  );
  const amarillasAcum = {};
  for (const partido of partidos) {
    for (const jugadorId of [partido.jugador1_id, partido.jugador2_id]) {
      const { rows: cards } = await pool.query(
        'SELECT * FROM tarjetas WHERE partido_id = $1 AND jugador_id = $2',
        [partido.id, jugadorId]
      );
      for (const card of cards) {
        const key = `${jugadorId}:${card.futbolista.toLowerCase()}`;
        if (card.tipo === 'roja') {
          const next = await getNextPartido(ligaId, jugadorId, partido.fecha);
          if (next) await pool.query(
            'INSERT INTO suspensiones (liga_id, partido_id, jugador_id, futbolista) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
            [ligaId, next.id, jugadorId, card.futbolista]
          );
          amarillasAcum[key] = 0;
        } else if (card.tipo === 'amarilla') {
          amarillasAcum[key] = (amarillasAcum[key] || 0) + 1;
          if (amarillasAcum[key] % 2 === 0) {
            const next = await getNextPartido(ligaId, jugadorId, partido.fecha);
            if (next) await pool.query(
              'INSERT INTO suspensiones (liga_id, partido_id, jugador_id, futbolista) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
              [ligaId, next.id, jugadorId, card.futbolista]
            );
          }
        }
      }
    }
  }
}

// POST /api/ligas
app.post('/api/ligas', async (req, res) => {
  try {
    const { nombre, jugadores, tiene_goleadores, tiene_tarjetas } = req.body;
    if (!nombre || !jugadores || jugadores.length < 2)
      return res.status(400).json({ error: 'Nombre y al menos 2 jugadores requeridos' });

    const { rows: [liga] } = await pool.query(
      'INSERT INTO ligas (nombre, tiene_goleadores, tiene_tarjetas) VALUES ($1,$2,$3) RETURNING *',
      [nombre, tiene_goleadores ? 1 : 0, tiene_tarjetas ? 1 : 0]
    );

    const jugadoresDb = [];
    for (const j of jugadores) {
      const nombre = typeof j === 'string' ? j : j.nombre;
      const equipo = typeof j === 'string' ? '' : (j.equipo || '');
      const { rows: [jug] } = await pool.query(
        'INSERT INTO jugadores (liga_id, nombre, equipo) VALUES ($1,$2,$3) RETURNING *',
        [liga.id, nombre, equipo]
      );
      jugadoresDb.push(jug);
    }

    const fechas = generarFixture(jugadoresDb);
    for (let fi = 0; fi < fechas.length; fi++) {
      for (let pi = 0; pi < fechas[fi].length; pi++) {
        const [j1, j2] = fechas[fi][pi];
        await pool.query(
          'INSERT INTO partidos (liga_id, fecha, tv, jugador1_id, jugador2_id) VALUES ($1,$2,$3,$4,$5)',
          [liga.id, fi + 1, (pi % 2) + 1, j1.id, j2.id]
        );
      }
    }
    res.json({ id: liga.id, nombre: liga.nombre, jugadores: jugadoresDb });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ligas
app.get('/api/ligas', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM ligas ORDER BY creada_en DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ligas/:id
app.get('/api/ligas/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { rows: [liga] } = await pool.query('SELECT * FROM ligas WHERE id = $1', [id]);
    if (!liga) return res.status(404).json({ error: 'Liga no encontrada' });

    const { rows: jugadores } = await pool.query('SELECT * FROM jugadores WHERE liga_id = $1', [id]);
    const { rows: partidos } = await pool.query(`
      SELECT p.*,
        j1.nombre as jugador1_nombre, j1.equipo as jugador1_equipo,
        j2.nombre as jugador2_nombre, j2.equipo as jugador2_equipo
      FROM partidos p
      JOIN jugadores j1 ON p.jugador1_id = j1.id
      JOIN jugadores j2 ON p.jugador2_id = j2.id
      WHERE p.liga_id = $1 ORDER BY p.fecha, p.tv
    `, [id]);

    for (const p of partidos) {
      const { rows: goles } = await pool.query('SELECT * FROM goles WHERE partido_id = $1', [p.id]);
      const { rows: tarjetas } = await pool.query('SELECT * FROM tarjetas WHERE partido_id = $1', [p.id]);
      const { rows: suspensiones } = await pool.query(`
        SELECT s.*, j.nombre as jugador_nombre
        FROM suspensiones s JOIN jugadores j ON s.jugador_id = j.id
        WHERE s.partido_id = $1
      `, [p.id]);
      p.goles_detalle = goles;
      p.tarjetas_detalle = tarjetas;
      p.suspensiones = suspensiones;
    }

    res.json({ ...liga, jugadores, partidos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/ligas/:id
app.delete('/api/ligas/:id', async (req, res) => {
  try {
    const id = req.params.id;
    await pool.query('DELETE FROM suspensiones WHERE liga_id = $1', [id]);
    const { rows: pids } = await pool.query('SELECT id FROM partidos WHERE liga_id = $1', [id]);
    for (const p of pids) {
      await pool.query('DELETE FROM goles WHERE partido_id = $1', [p.id]);
      await pool.query('DELETE FROM tarjetas WHERE partido_id = $1', [p.id]);
    }
    await pool.query('DELETE FROM partidos WHERE liga_id = $1', [id]);
    await pool.query('DELETE FROM jugadores WHERE liga_id = $1', [id]);
    await pool.query('DELETE FROM ligas WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ligas/:id/reiniciar
app.post('/api/ligas/:id/reiniciar', async (req, res) => {
  try {
    const id = req.params.id;
    await pool.query('UPDATE partidos SET goles1 = NULL, goles2 = NULL WHERE liga_id = $1', [id]);
    const { rows: pids } = await pool.query('SELECT id FROM partidos WHERE liga_id = $1', [id]);
    for (const p of pids) {
      await pool.query('DELETE FROM goles WHERE partido_id = $1', [p.id]);
      await pool.query('DELETE FROM tarjetas WHERE partido_id = $1', [p.id]);
    }
    await pool.query('DELETE FROM suspensiones WHERE liga_id = $1', [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/partidos/:id
app.put('/api/partidos/:id', async (req, res) => {
  try {
    const { goles1, goles2, goleadores1, goleadores2, tarjetas1, tarjetas2 } = req.body;
    if (goles1 === undefined || goles2 === undefined)
      return res.status(400).json({ error: 'Goles requeridos' });

    const { rows: [partido] } = await pool.query('SELECT * FROM partidos WHERE id = $1', [req.params.id]);
    if (!partido) return res.status(404).json({ error: 'Partido no encontrado' });

    await pool.query('UPDATE partidos SET goles1 = $1, goles2 = $2 WHERE id = $3', [goles1, goles2, req.params.id]);

    await pool.query('DELETE FROM goles WHERE partido_id = $1', [req.params.id]);
    for (const f of (goleadores1 || [])) {
      if ((f || '').trim()) await pool.query(
        'INSERT INTO goles (partido_id, jugador_id, futbolista) VALUES ($1,$2,$3)',
        [req.params.id, partido.jugador1_id, f.trim()]
      );
    }
    for (const f of (goleadores2 || [])) {
      if ((f || '').trim()) await pool.query(
        'INSERT INTO goles (partido_id, jugador_id, futbolista) VALUES ($1,$2,$3)',
        [req.params.id, partido.jugador2_id, f.trim()]
      );
    }

    await pool.query('DELETE FROM tarjetas WHERE partido_id = $1', [req.params.id]);
    for (const t of (tarjetas1 || [])) {
      if ((t.futbolista || '').trim()) await pool.query(
        'INSERT INTO tarjetas (partido_id, jugador_id, futbolista, tipo) VALUES ($1,$2,$3,$4)',
        [req.params.id, partido.jugador1_id, t.futbolista.trim(), t.tipo]
      );
    }
    for (const t of (tarjetas2 || [])) {
      if ((t.futbolista || '').trim()) await pool.query(
        'INSERT INTO tarjetas (partido_id, jugador_id, futbolista, tipo) VALUES ($1,$2,$3,$4)',
        [req.params.id, partido.jugador2_id, t.futbolista.trim(), t.tipo]
      );
    }

    const { rows: [liga] } = await pool.query('SELECT * FROM ligas WHERE id = $1', [partido.liga_id]);
    if (liga.tiene_tarjetas) await recalcSuspensiones(partido.liga_id);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ligas/:id/tabla
app.get('/api/ligas/:id/tabla', async (req, res) => {
  try {
    const { rows: jugadores } = await pool.query('SELECT * FROM jugadores WHERE liga_id = $1', [req.params.id]);
    const { rows: partidos } = await pool.query(
      'SELECT * FROM partidos WHERE liga_id = $1 AND goles1 IS NOT NULL', [req.params.id]
    );
    const tabla = {};
    jugadores.forEach(j => {
      tabla[j.id] = { id: j.id, nombre: j.nombre, equipo: j.equipo || '', pj:0, pg:0, pe:0, pp:0, gf:0, gc:0, dg:0, pts:0 };
    });
    partidos.forEach(p => {
      const j1 = tabla[p.jugador1_id], j2 = tabla[p.jugador2_id];
      if (!j1 || !j2) return;
      j1.pj++; j2.pj++;
      j1.gf += p.goles1; j1.gc += p.goles2;
      j2.gf += p.goles2; j2.gc += p.goles1;
      j1.dg = j1.gf - j1.gc; j2.dg = j2.gf - j2.gc;
      if (p.goles1 > p.goles2)      { j1.pg++; j1.pts += 3; j2.pp++; }
      else if (p.goles1 < p.goles2) { j2.pg++; j2.pts += 3; j1.pp++; }
      else                           { j1.pe++; j2.pe++; j1.pts++; j2.pts++; }
    });
    res.json(Object.values(tabla).sort((a,b) => b.pts-a.pts || b.dg-a.dg || b.gf-a.gf));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ligas/:id/goleadores
app.get('/api/ligas/:id/goleadores', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT LOWER(g.futbolista) as key, g.futbolista, COUNT(*) as goles
      FROM goles g JOIN partidos p ON g.partido_id = p.id
      WHERE p.liga_id = $1
      GROUP BY LOWER(g.futbolista), g.futbolista
      ORDER BY goles DESC, g.futbolista ASC
    `, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ligas/:id/tarjetas-resumen
app.get('/api/ligas/:id/tarjetas-resumen', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT LOWER(t.futbolista) as key, t.futbolista,
        SUM(CASE WHEN t.tipo='amarilla' THEN 1 ELSE 0 END) as amarillas,
        SUM(CASE WHEN t.tipo='roja'    THEN 1 ELSE 0 END) as rojas
      FROM tarjetas t JOIN partidos p ON t.partido_id = p.id
      WHERE p.liga_id = $1
      GROUP BY LOWER(t.futbolista), t.futbolista
      ORDER BY rojas DESC, amarillas DESC
    `, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => console.log(`Servidor PG corriendo en puerto ${PORT}`)))
  .catch(err => { console.error('Error DB:', err); process.exit(1); });
