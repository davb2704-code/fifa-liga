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
      num_tvs INTEGER DEFAULT 2,
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS playoff_partidos (
      id SERIAL PRIMARY KEY,
      liga_id INTEGER REFERENCES ligas(id),
      ronda TEXT NOT NULL,
      orden INTEGER NOT NULL,
      jugador1_id INTEGER REFERENCES jugadores(id),
      jugador2_id INTEGER REFERENCES jugadores(id),
      goles1 INTEGER DEFAULT NULL,
      goles2 INTEGER DEFAULT NULL
    )
  `);
  await pool.query(`CREATE TABLE IF NOT EXISTS playoff_goles (
    id SERIAL PRIMARY KEY, playoff_partido_id INTEGER REFERENCES playoff_partidos(id),
    jugador_id INTEGER REFERENCES jugadores(id), futbolista TEXT NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS playoff_tarjetas (
    id SERIAL PRIMARY KEY, playoff_partido_id INTEGER REFERENCES playoff_partidos(id),
    jugador_id INTEGER REFERENCES jugadores(id), futbolista TEXT NOT NULL, tipo TEXT NOT NULL
  )`);
  // Migrations for existing tables
  await pool.query(`ALTER TABLE ligas ADD COLUMN IF NOT EXISTS tiene_goleadores INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE ligas ADD COLUMN IF NOT EXISTS tiene_tarjetas INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE jugadores ADD COLUMN IF NOT EXISTS equipo TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE ligas ADD COLUMN IF NOT EXISTS num_tvs INTEGER DEFAULT 2`);
  await pool.query(`ALTER TABLE ligas ADD COLUMN IF NOT EXISTS tiene_playoffs INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE ligas ADD COLUMN IF NOT EXISTS num_playoff_jugadores INTEGER DEFAULT 4`);
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
    const { nombre, jugadores, tiene_goleadores, tiene_tarjetas, num_tvs, tiene_playoffs, num_playoff_jugadores } = req.body;
    if (!nombre || !jugadores || jugadores.length < 2)
      return res.status(400).json({ error: 'Nombre y al menos 2 jugadores requeridos' });

    const { rows: [liga] } = await pool.query(
      'INSERT INTO ligas (nombre, tiene_goleadores, tiene_tarjetas, num_tvs, tiene_playoffs, num_playoff_jugadores) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [nombre, tiene_goleadores ? 1 : 0, tiene_tarjetas ? 1 : 0, num_tvs || 2, tiene_playoffs ? 1 : 0, num_playoff_jugadores || 4]
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

    const nTvs = num_tvs || 2;
    const fechas = generarFixture(jugadoresDb);
    for (let fi = 0; fi < fechas.length; fi++) {
      for (let pi = 0; pi < fechas[fi].length; pi++) {
        const [j1, j2] = fechas[fi][pi];
        await pool.query(
          'INSERT INTO partidos (liga_id, fecha, tv, jugador1_id, jugador2_id) VALUES ($1,$2,$3,$4,$5)',
          [liga.id, fi + 1, (pi % nTvs) + 1, j1.id, j2.id]
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
    const { rows: ppids } = await pool.query('SELECT id FROM playoff_partidos WHERE liga_id = $1', [id]);
    for (const p of ppids) {
      await pool.query('DELETE FROM playoff_goles WHERE playoff_partido_id = $1', [p.id]);
      await pool.query('DELETE FROM playoff_tarjetas WHERE playoff_partido_id = $1', [p.id]);
    }
    await pool.query('DELETE FROM playoff_partidos WHERE liga_id = $1', [id]);
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
    const { rows: ppids } = await pool.query('SELECT id FROM playoff_partidos WHERE liga_id = $1', [id]);
    for (const p of ppids) {
      await pool.query('DELETE FROM playoff_goles WHERE playoff_partido_id = $1', [p.id]);
      await pool.query('DELETE FROM playoff_tarjetas WHERE playoff_partido_id = $1', [p.id]);
    }
    await pool.query('DELETE FROM playoff_partidos WHERE liga_id = $1', [id]);
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

// ── PLAYOFFS HELPERS ─────────────────────────────────────

function getRondas(n) {
  if (n <= 2) return ['final'];
  if (n <= 4) return ['semi', 'final'];
  return ['cuartos', 'semi', 'final'];
}

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

async function avanzarGanador(ligaId, ronda, orden, ganadorId, n) {
  const avance = getAvance(ronda, orden, n);
  if (!avance) return;
  const col = avance.pos === 1 ? 'jugador1_id' : 'jugador2_id';
  await pool.query(
    `UPDATE playoff_partidos SET ${col} = $1 WHERE liga_id = $2 AND ronda = $3 AND orden = $4`,
    [ganadorId, ligaId, avance.ronda, avance.orden]
  );
}

// POST /api/ligas/:id/generar-playoffs
app.post('/api/ligas/:id/generar-playoffs', async (req, res) => {
  try {
    const id = req.params.id;
    const { rows: [liga] } = await pool.query('SELECT * FROM ligas WHERE id = $1', [id]);
    if (!liga) return res.status(404).json({ error: 'Liga no encontrada' });

    await pool.query('DELETE FROM playoff_partidos WHERE liga_id = $1', [id]);

    const { rows: jugadores } = await pool.query('SELECT * FROM jugadores WHERE liga_id = $1', [id]);
    const { rows: partidos } = await pool.query('SELECT * FROM partidos WHERE liga_id = $1 AND goles1 IS NOT NULL', [id]);

    const tabla = {};
    jugadores.forEach(j => { tabla[j.id] = { id: j.id, pts: 0, dg: 0, gf: 0 }; });
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
    const ins = (ronda, orden, j1, j2) =>
      pool.query('INSERT INTO playoff_partidos (liga_id, ronda, orden, jugador1_id, jugador2_id) VALUES ($1,$2,$3,$4,$5)',
        [id, ronda, orden, j1, j2]);

    if (n === 2) {
      await ins('final', 1, seeds[0].id, seeds[1].id);
    } else if (n === 4) {
      await ins('semi', 1, seeds[0].id, seeds[3].id);
      await ins('semi', 2, seeds[1].id, seeds[2].id);
      await ins('final', 1, null, null);
    } else if (n === 8) {
      await ins('cuartos', 1, seeds[0].id, seeds[7].id);
      await ins('cuartos', 2, seeds[1].id, seeds[6].id);
      await ins('cuartos', 3, seeds[2].id, seeds[5].id);
      await ins('cuartos', 4, seeds[3].id, seeds[4].id);
      await ins('semi', 1, null, null);
      await ins('semi', 2, null, null);
      await ins('final', 1, null, null);
    }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ligas/:id/playoffs
app.get('/api/ligas/:id/playoffs', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT pp.*,
        j1.nombre as jugador1_nombre, j1.equipo as jugador1_equipo,
        j2.nombre as jugador2_nombre, j2.equipo as jugador2_equipo
      FROM playoff_partidos pp
      LEFT JOIN jugadores j1 ON pp.jugador1_id = j1.id
      LEFT JOIN jugadores j2 ON pp.jugador2_id = j2.id
      WHERE pp.liga_id = $1 ORDER BY pp.ronda, pp.orden
    `, [req.params.id]);
    for (const p of rows) {
      const { rows: goles } = await pool.query('SELECT * FROM playoff_goles WHERE playoff_partido_id = $1', [p.id]);
      const { rows: tarjetas } = await pool.query('SELECT * FROM playoff_tarjetas WHERE playoff_partido_id = $1', [p.id]);
      p.goles_detalle = goles;
      p.tarjetas_detalle = tarjetas;
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/playoff-partidos/:id
app.put('/api/playoff-partidos/:id', async (req, res) => {
  try {
    const { goles1, goles2, goleadores1, goleadores2, tarjetas1, tarjetas2 } = req.body;
    if (goles1 === undefined || goles2 === undefined)
      return res.status(400).json({ error: 'Goles requeridos' });

    const { rows: [pp] } = await pool.query('SELECT * FROM playoff_partidos WHERE id = $1', [req.params.id]);
    if (!pp) return res.status(404).json({ error: 'Partido no encontrado' });

    await pool.query('UPDATE playoff_partidos SET goles1 = $1, goles2 = $2 WHERE id = $3', [goles1, goles2, req.params.id]);

    // Goleadores
    await pool.query('DELETE FROM playoff_goles WHERE playoff_partido_id = $1', [req.params.id]);
    for (const f of (goleadores1 || [])) {
      if ((f || '').trim()) await pool.query(
        'INSERT INTO playoff_goles (playoff_partido_id, jugador_id, futbolista) VALUES ($1,$2,$3)',
        [req.params.id, pp.jugador1_id, f.trim()]
      );
    }
    for (const f of (goleadores2 || [])) {
      if ((f || '').trim()) await pool.query(
        'INSERT INTO playoff_goles (playoff_partido_id, jugador_id, futbolista) VALUES ($1,$2,$3)',
        [req.params.id, pp.jugador2_id, f.trim()]
      );
    }

    // Tarjetas
    await pool.query('DELETE FROM playoff_tarjetas WHERE playoff_partido_id = $1', [req.params.id]);
    for (const t of (tarjetas1 || [])) {
      if ((t.futbolista || '').trim()) await pool.query(
        'INSERT INTO playoff_tarjetas (playoff_partido_id, jugador_id, futbolista, tipo) VALUES ($1,$2,$3,$4)',
        [req.params.id, pp.jugador1_id, t.futbolista.trim(), t.tipo]
      );
    }
    for (const t of (tarjetas2 || [])) {
      if ((t.futbolista || '').trim()) await pool.query(
        'INSERT INTO playoff_tarjetas (playoff_partido_id, jugador_id, futbolista, tipo) VALUES ($1,$2,$3,$4)',
        [req.params.id, pp.jugador2_id, t.futbolista.trim(), t.tipo]
      );
    }

    const { rows: [liga] } = await pool.query('SELECT * FROM ligas WHERE id = $1', [pp.liga_id]);
    const n = liga.num_playoff_jugadores || 4;
    const ganadorId = goles1 > goles2 ? pp.jugador1_id : pp.jugador2_id;
    await avanzarGanador(pp.liga_id, pp.ronda, pp.orden, ganadorId, n);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ligas/:id/resetear-playoffs
app.post('/api/ligas/:id/resetear-playoffs', async (req, res) => {
  try {
    const { rows: ppids } = await pool.query('SELECT id FROM playoff_partidos WHERE liga_id = $1', [req.params.id]);
    for (const p of ppids) {
      await pool.query('DELETE FROM playoff_goles WHERE playoff_partido_id = $1', [p.id]);
      await pool.query('DELETE FROM playoff_tarjetas WHERE playoff_partido_id = $1', [p.id]);
    }
    await pool.query('DELETE FROM playoff_partidos WHERE liga_id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => console.log(`Servidor PG corriendo en puerto ${PORT}`)))
  .catch(err => { console.error('Error DB:', err); process.exit(1); });
