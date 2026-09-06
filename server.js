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

// Configuración de la base de datos (con SSL dinámico para local o producción/Neon)
const dbConfig = {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT,
    ssl: {
        rejectUnauthorized: false // Obligatorio para que Neon y Render permitan la conexión segura
    }
};

// Si el host no es localhost (es decir, apunta a Neon en la nube), activamos SSL
if (process.env.NODE_ENV === 'production' || (process.env.DB_HOST && process.env.DB_HOST !== 'localhost')) {
    dbConfig.ssl = {
        rejectUnauthorized: false
    };
}

const db = new Pool(dbConfig);

// Función automática para crear las tablas si no existen en la base de datos
async function crearTablasSiNoExisten() {
    const queryDonaciones = `
        CREATE TABLE IF NOT EXISTS donaciones (
            id SERIAL PRIMARY KEY,
            tipo_donante VARCHAR(50),
            nombre VARCHAR(150),
            dni VARCHAR(20),
            fecha_nacimiento VARCHAR(20),
            correo VARCHAR(150),
            categoria VARCHAR(100),
            estado VARCHAR(50) DEFAULT 'Pendiente',
            ocultar_nombre VARCHAR(10),
            genero VARCHAR(50),
            telefono VARCHAR(50),
            cantidad INTEGER DEFAULT 0,
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            cuit VARCHAR(20) UNIQUE,
            descripcion TEXT
        );
    `;

    const queryUsuarios = `
        CREATE TABLE IF NOT EXISTS usuarios (
            id SERIAL PRIMARY KEY,
            nombre_usuario VARCHAR(50) UNIQUE NOT NULL,
            dni VARCHAR(20) UNIQUE NOT NULL,
            nombre VARCHAR(150) NOT NULL,
            contrasena VARCHAR(255) NOT NULL,
            rol VARCHAR(20) NOT NULL DEFAULT 'usuario'
        );
    `;

    try {
        await db.query(queryDonaciones);
        await db.query(queryUsuarios);
        console.log('📦 Tablas "donaciones" y "usuarios" verificadas o creadas correctamente.');
    } catch (err) {
        console.error('❌ Error al crear las tablas automáticamente:', err);
    }
}

// 🧹 Función para eliminar automáticamente donaciones pendientes con más de 30 días
async function limpiarDonacionesExpiradas() {
    try {
        const query = `
            DELETE FROM donaciones 
            WHERE estado = 'Pendiente' 
            AND fecha < NOW() - INTERVAL '30 days'
        `;
        const resultado = await db.query(query);
        if (resultado.rowCount > 0) {
            console.log(`🧹 Limpieza automática: Se eliminaron ${resultado.rowCount} donaciones pendientes expiradas (>30 días).`);
        }
    } catch (err) {
        console.error('❌ Error al limpiar donaciones expiradas:', err);
    }
}

db.connect(async (err, client, release) => {
    if (err) {
        return console.error('❌ Error al conectar a PostgreSQL:', err.stack);
    }
    console.log('✨ ¡Conectado exitosamente a la base de datos PostgreSQL!');
    release();

    // Ejecutamos la creación de las tablas al iniciar
    await crearTablasSiNoExisten();
    // Ejecutamos la limpieza inicial al encender
    await limpiarDonacionesExpiradas();
});

let ultimaDonacionCache = null;

// --- RUTA DE LOGIN PARA EL SISTEMA DE ROLES (RBAC) ---
app.post('/api/login', async (req, res) => {
    const { nombre_usuario, contrasena } = req.body;

    try {
        const query = 'SELECT * FROM usuarios WHERE nombre_usuario = $1';
        const resultado = await db.query(query, [nombre_usuario]);

        if (resultado.rows.length === 0) {
            return res.status(401).json({ error: 'El usuario no existe.' });
        }

        const usuario = resultado.rows[0];

        // Validación de contraseña
        if (contrasena !== usuario.contrasena) {
            return res.status(401).json({ error: 'Contraseña incorrecta.' });
        }

        // Devolvemos los datos del usuario y su rol para que el frontend decida a dónde redirigir
        return res.json({
            mensaje: 'Login exitoso',
            nombre: usuario.nombre,
            rol: usuario.rol // 'superadmin', 'admin' o 'usuario'
        });

    } catch (err) {
        console.error('Error en el login:', err);
        return res.status(500).json({ error: 'Error interno en el servidor.' });
    }
});

// --- 2. RUTA POST: RECIBIR Y GUARDAR DONACIÓN ---
app.post('/api/donaciones', async (req, res) => {
    const {
        tipoDonante, nombreCompleto, nombreEmpresa, dni, fechaNacimiento,
        correo, categoria, ocultarNombre, genero, telefono, cantidad, cuit, descripcion
    } = req.body;

    const nombreFinal = (tipoDonante === 'empresa') ? nombreEmpresa : nombreCompleto;
    const dniFinal = (tipoDonante === 'persona') ? dni : null;
    const fechaNacFinal = (tipoDonante === 'persona') ? fechaNacimiento : null;
    const generoFinal = (tipoDonante === 'persona') ? genero : null;
    const cuitFinal = (tipoDonante === 'empresa') ? cuit : null;
    const ocultarFinal = ocultarNombre ? 'si' : 'no';
    const cantidadFinal = parseInt(cantidad) || 0;

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

    const claveEnvioActual = `${correo}-${categoria}-${nombreFinal}`;
    if (ultimaDonacionCache === claveEnvioActual) {
        console.log('⚠️ Petición duplicada bloqueada en el servidor.');
        return res.status(200).json({ mensaje: 'Donación ya procesada anteriormente.', duplicado: true });
    }

    ultimaDonacionCache = claveEnvioActual;
    setTimeout(() => { ultimaDonacionCache = null; }, 2000);

    const sql = `INSERT INTO donaciones (tipo_donante, nombre, dni, fecha_nacimiento, correo, categoria, estado, ocultar_nombre, genero, telefono, cantidad, cuit, descripcion) 
                 VALUES ($1, $2, $3, $4, $5, $6, 'Pendiente', $7, $8, $9, $10, $11, $12) RETURNING id`;

    const valores = [
        tipoDonante,
        nombreFinal,
        dniFinal,
        fechaNacFinal,
        correo,
        categoria,
        ocultarFinal,
        generoFinal,
        telefono,
        cantidadFinal,
        cuitFinal,
        descripcion
    ];

    db.query(sql, valores, (err, result) => {
        if (err) {
            console.error('Error al insertar donación:', err);
            return res.status(500).json({ error: 'Error al guardar la donación.' });
        }
        return res.status(201).json({ mensaje: 'Donación registrada como Pendiente.', id: result.rows[0].id });
    });
});

// --- 3. RUTA GET: OBTENER TODAS LAS DONACIONES (Para el Admin) ---
app.get('/api/donaciones', async (req, res) => {
    await limpiarDonacionesExpiradas();

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
            cantidad,
            descripcion
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