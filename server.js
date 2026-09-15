require('dotenv').config();
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

const dbConfig = {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT,
    ssl: {
        rejectUnauthorized: false
    }
};

if (process.env.NODE_ENV === 'production' || (process.env.DB_HOST && process.env.DB_HOST !== 'localhost')) {
    dbConfig.ssl = {
        rejectUnauthorized: false
    };
}

const db = new Pool(dbConfig);

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
            descripcion TEXT,
            actualizado_por VARCHAR(100),
            fecha_actualizacion TIMESTAMP
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

async function limpiarDonacionesExpiradas() {
    try {
        const query = `
            DELETE FROM donaciones 
            WHERE estado = 'Pendiente' 
            AND fecha < NOW() - INTERVAL '30 days'
        `;
        const resultado = await db.query(query);
        if (resultado.rowCount > 0) {
            console.log(`🧹 Limpieza automática: Se eliminaron ${resultado.rowCount} donaciones pendientes expiradas.`);
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

    await crearTablasSiNoExisten();
    await limpiarDonacionesExpiradas();
});

let ultimaDonacionCache = null;

// --- RUTA DE LOGIN ---
app.post('/api/login', async (req, res) => {
    const { nombre_usuario, contrasena } = req.body;

    try {
        const query = 'SELECT * FROM usuarios WHERE nombre_usuario = $1';
        const resultado = await db.query(query, [nombre_usuario]);

        if (resultado.rows.length === 0) {
            return res.status(401).json({ error: 'El usuario no existe.' });
        }

        const usuario = resultado.rows[0];

        if (contrasena !== usuario.contrasena) {
            return res.status(401).json({ error: 'Contraseña incorrecta.' });
        }

        return res.json({
            mensaje: 'Login exitoso',
            nombre: usuario.nombre,
            rol: usuario.rol
        });

    } catch (err) {
        console.error('Error en el login:', err);
        return res.status(500).json({ error: 'Error interno en el servidor.' });
    }
});

// --- RUTA POST: DONACIONES ---
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
            return res.status(400).json({ error: "Ya tienes una donación pendiente en proceso." });
        }
    } catch (err) {
        console.error('Error al validar donación:', err);
        return res.status(500).json({ error: 'Error interno al verificar estado.' });
    }

    const claveEnvioActual = `${correo}-${categoria}-${nombreFinal}`;
    if (ultimaDonacionCache === claveEnvioActual) {
        return res.status(200).json({ mensaje: 'Donación ya procesada anteriormente.', duplicado: true });
    }

    ultimaDonacionCache = claveEnvioActual;
    setTimeout(() => { ultimaDonacionCache = null; }, 2000);

    const sql = `INSERT INTO donaciones (tipo_donante, nombre, dni, fecha_nacimiento, correo, categoria, estado, ocultar_nombre, genero, telefono, cantidad, cuit, descripcion) 
                 VALUES ($1, $2, $3, $4, $5, $6, 'Pendiente', $7, $8, $9, $10, $11, $12) RETURNING id`;

    const valores = [tipoDonante, nombreFinal, dniFinal, fechaNacFinal, correo, categoria, ocultarFinal, generoFinal, telefono, cantidadFinal, cuitFinal, descripcion];

    db.query(sql, valores, (err, result) => {
        if (err) {
            console.error('Error al insertar donación:', err);
            return res.status(500).json({ error: 'Error al guardar la donación.' });
        }
        return res.status(201).json({ mensaje: 'Donación registrada como Pendiente.', id: result.rows[0].id });
    });
});

// --- RUTA GET: OBTENER DONACIONES ---
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

// --- RUTA GET PÚBLICA: APROBADAS ---
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
            console.error('Error al obtener historial público:', err);
            return res.status(500).json({ error: 'Error al obtener historial.' });
        }
        return res.json(results.rows);
    });
});

// --- RUTA PUT: ESTADO DONACIÓN ---
app.put('/api/donaciones/:id/estado', async (req, res) => {
    const { id } = req.params;
    const { estado, motivoRechazo, actualizado_por } = req.body;
    const nuevoEstado = estado || req.body.nuevoEstado;
    
    const statesPermitidos = ['Pendiente', 'Recibido', 'Aprobado y Destinado', 'Rechazado'];
    if (!statesPermitidos.includes(nuevoEstado)) {
        return res.status(400).json({ error: 'Estado no válido.' });
    }

    try {
        const checkSql = "SELECT estado, descripcion FROM donaciones WHERE id = $1";
        const checkRes = await db.query(checkSql, [id]);

        if (checkRes.rows.length === 0) {
            return res.status(404).json({ error: 'Donación no encontrada.' });
        }

        const estadoActual = checkRes.rows[0].estado || 'Pendiente';

        if (estadoActual === 'Aprobado y Destinado' || estadoActual === 'Rechazado') {
            return res.status(400).json({ error: `Esta donación ya fue cerrada como "${estadoActual}" y no se puede modificar.` });
        }

        if (estadoActual === 'Pendiente' && nuevoEstado !== 'Recibido') {
            return res.status(400).json({ error: 'Una donación Pendiente solo puede pasar al estado "Recibido".' });
        }

        if (estadoActual === 'Recibido' && (nuevoEstado !== 'Aprobado y Destinado' && nuevoEstado !== 'Rechazado')) {
            return res.status(400).json({ error: 'Una donación Recibida solo puede pasar a "Aprobado y Destinado" o "Rechazado".' });
        }

        // Tomamos el nombre completo sin recortar (o por defecto 'Sistema' si viene vacío)
        const responsableFinal = actualizado_por ? String(actualizado_por).trim() : 'Sistema';
        
        // Obtenemos la fecha y hora exacta actual para registrar el momento de la modificación
        const fechaHoraActual = new Date();

        let sql = `UPDATE donaciones SET estado = $1, actualizado_por = $3, fecha_actualizacion = $4 WHERE id = $2`;
        let valores = [nuevoEstado, id, responsableFinal, fechaHoraActual];

        if (nuevoEstado === 'Rechazado') {
            if (!motivoRechazo || motivoRechazo.trim() === '') {
                return res.status(400).json({ error: 'Debe especificar el motivo del rechazo.' });
            }
            const descripcionAnterior = checkRes.rows[0].descripcion || '';
            const descripcionConMotivo = `${descripcionAnterior} | [RECHAZADO: ${motivoRechazo.trim()}]`;
            
            sql = `UPDATE donaciones SET estado = $1, actualizado_por = $3, fecha_actualizacion = $4, descripcion = $5 WHERE id = $2`;
            valores = [nuevoEstado, id, responsableFinal, fechaHoraActual, descripcionConMotivo];
        }

        await db.query(sql, valores);
        return res.json({ mensaje: 'Estado actualizado con éxito.', nuevoEstado, fecha_actualizacion: fechaHoraActual });
    } catch (err) {
        console.error('Error al actualizar estado:', err);
        return res.status(500).json({ error: 'Error al actualizar estado.' });
    }
});

// --- RUTAS DE GESTIÓN DE USUARIOS ---

// GET: Obtener todos los usuarios
app.get('/api/usuarios', async (req, res) => {
    try {
        const sql = "SELECT id, nombre_usuario, dni, nombre, rol FROM usuarios ORDER BY id DESC";
        const resultado = await db.query(sql);
        return res.json(resultado.rows);
    } catch (err) {
        console.error('Error al obtener usuarios:', err);
        return res.status(500).json({ error: 'Error al obtener usuarios.' });
    }
});

// POST: Crear un nuevo usuario
app.post('/api/usuarios', async (req, res) => {
    const { nombre_usuario, nombre, contrasena, rol, dni } = req.body;
    const rolFinal = rol || 'usuario';

    try {
        const check = await db.query("SELECT id FROM usuarios WHERE nombre_usuario = $1 OR dni = $2", [nombre_usuario, dni]);
        if (check.rows.length > 0) {
            return res.status(400).json({ error: 'El nombre de usuario o el DNI ya se encuentran registrados.' });
        }

        const sql = `
            INSERT INTO usuarios (nombre_usuario, dni, nombre, contrasena, rol) 
            VALUES ($1, $2, $3, $4, $5) 
            RETURNING id, nombre_usuario, dni, nombre, rol
        `;
        const valores = [nombre_usuario, dni, nombre, contrasena, rolFinal];
        const resultado = await db.query(sql, valores);

        return res.status(201).json({ 
            mensaje: 'Usuario creado exitosamente', 
            usuario: resultado.rows[0] 
        });
    } catch (err) {
        console.error('Error detallado al crear usuario:', err);
        return res.status(500).json({ error: `Error de BD: ${err.message}` });
    }
});

// DELETE: Eliminar usuario por ID
app.delete('/api/usuarios/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const sql = "DELETE FROM usuarios WHERE id = $1";
        const resultado = await db.query(sql, [id]);

        if (resultado.rowCount === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado.' });
        }

        return res.json({ mensaje: 'Usuario eliminado correctamente.' });
    } catch (err) {
        console.error('Error al eliminar usuario:', err);
        return res.status(500).json({ error: 'Error al eliminar el usuario.' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});