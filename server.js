require('dotenv').config(); // Carga las variables de entorno al principio
const express = require('express');
const { Pool } = require('pg'); 
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public'))); 

// Conexión a la base de datos usando variables de entorno
const db = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT,
});

db.connect((err, client, release) => {
    if (err) {
        return console.error('❌ Error al conectar a PostgreSQL:', err.stack);
    }
    console.log('✨ ¡Conectado exitosamente a la base de datos PostgreSQL hospitalguemes!');
    release();
});

let ultimaDonacionCache = null;

// --- RUTA DE SEGURIDAD PARA ACCESO AL PANEL ---
app.post('/api/verificar-acceso', (req, res) => {
    const { clave } = req.body;
    if (clave === process.env.ADMIN_PASSWORD) {
        res.json({ accesoConcedido: true });
    } else {
        res.json({ accesoConcedido: false });
    }
});

// --- 2. RUTA POST: RECIBIR Y GUARDAR DONACIÓN ---
app.post('/api/donaciones', async (req, res) => {
    const { 
        tipoDonante, nombreCompleto, nombreEmpresa, dni, fechaNacimiento, 
        correo, categoria, ocultarNombre, genero, telefono, cantidad 
    } = req.body;

    const nombreFinal = (tipoDonante === 'empresa') ? nombreEmpresa : nombreCompleto;
    const dniFinal = (tipoDonante === 'persona') ? dni : null;
    const fechaNacFinal = (tipoDonante === 'persona') ? fechaNacimiento : null;
    const ocultarFinal = ocultarNombre ? 'si' : 'no'; 
    const generoFinal = (tipoDonante === 'persona') ? genero : null; 
    const cantidadFinal = parseInt(cantidad) || 0; // Aseguramos que sea número

    // 🛠️ VALIDACIÓN: Bloqueo de donación si ya existe una pendiente con ese correo
    try {
        const checkSql = "SELECT id FROM donaciones WHERE correo = $1 AND estado = 'Pendiente' LIMIT 1";
        const checkResult = await db.query(checkSql, [correo]);

        if (checkResult.rows.length > 0) {
            return res.status(400).json({ error: "Ya tienes una donación pendiente en proceso. Por favor, espera a que sea aprobada antes de realizar una nueva." });
        }
    } catch (err) {
        console.error('Error al validar donación pendiente:', err);
        return res.status(500).json({ error: 'Error interno al verificar estado de donaciones.' });
    }

    // Lógica original de anti-duplicidad por caché rápido
    const claveEnvioActual = `${correo}-${categoria}-${nombreFinal}`;
    if (ultimaDonacionCache === claveEnvioActual) {
        console.log('⚠️ Petición duplicada bloqueada en el servidor.');
        return res.status(200).json({ mensaje: 'Donación ya procesada anteriormente.', duplicado: true });
    }

    ultimaDonacionCache = claveEnvioActual;
    setTimeout(() => { ultimaDonacionCache = null; }, 2000);

    // INSERT SQL (Incluye la columna cantidad)
    const sql = `INSERT INTO donaciones (tipo_donante, nombre, dni, fecha_nacimiento, correo, categoria, estado, ocultar_nombre, genero, telefono, cantidad) 
                 VALUES ($1, $2, $3, $4, $5, $6, 'Pendiente', $7, $8, $9, $10) RETURNING id`;
    
    const valores = [tipoDonante, nombreFinal, dniFinal, fechaNacFinal, correo, categoria, ocultarFinal, generoFinal, telefono, cantidadFinal];

    db.query(sql, valores, (err, result) => {
        if (err) {
            console.error('Error al insertar donación:', err);
            return res.status(500).json({ error: 'Error al guardar la donación.' });
        }
        return res.status(201).json({ mensaje: 'Donación registrada como Pendiente.', id: result.rows[0].id });
    });
});

// --- 3. RUTA GET: OBTENER TODAS LAS DONACIONES (Para el Admin) ---
app.get('/api/donaciones', (req, res) => {
    const sql = "SELECT * FROM donaciones ORDER BY id DESC";
    db.query(sql, (err, results) => {
        if (err) {
            console.error('Error al obtener donaciones:', err);
            return res.status(500).json({ error: 'Error al obtener datos.' });
        }
        return res.json(results.rows); 
    });
});

// --- RUTA GET PÚBLICA: OBTENER DONACIONES APROBADAS ---
app.get('/api/donaciones/aprobadas', (req, res) => {
    const sql = `
        SELECT 
            CASE 
                WHEN ocultar_nombre IS NULL THEN nombre
                WHEN LOWER(ocultar_nombre) = 'si' THEN '-' 
                ELSE nombre 
            END AS nombre, 
            categoria, 
            fecha,
            cantidad
        FROM donaciones 
        WHERE estado = 'Aprobado y Destinado' 
        ORDER BY id DESC
    `;
    
    db.query(sql, (err, results) => {
        if (err) {
            console.error('Error al obtener el historial público:', err);
            return res.status(500).json({ error: 'Error al obtener el historial.' });
        }
        return res.json(results.rows); 
    });
});

// --- 4. RUTA PUT: ACTUALIZAR EL ESTADO DE LA DONACIÓN ---
app.put('/api/donaciones/:id/estado', (req, res) => {
    const { id } = req.params;
    const { nuevoEstado } = req.body;

    const statesPermitidos = ['Pendiente', 'Recibido', 'Aprobado y Destinado'];
    if (!statesPermitidos.includes(nuevoEstado)) {
        return res.status(400).json({ error: 'Estado no válido.' });
    }

    const sql = `UPDATE donaciones SET estado = $1 WHERE id = $2`;
    db.query(sql, [nuevoEstado, id], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Error al actualizar estado.' });
        }
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Donación no encontrada.' });
        }
        return res.json({ mensaje: 'Estado actualizado con éxito.', nuevoEstado });
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});