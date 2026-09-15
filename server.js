require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const nodemailer = require('nodemailer'); // <-- Importamos nodemailer

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public')));

// --- CONFIGURACIÓN DE CORREO (Nodemailer adaptado para Render - Puerto 587) ---
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // false para puerto 587
    auth: {
        user: process.env.EMAIL_USER,     // Lee el correo desde el .env
        pass: process.env.EMAIL_PASSWORD  // Lee la contraseña desde el .env
    },
    tls: {
        rejectUnauthorized: false
    },
    socketTimeout: 60000,
    connectionTimeout: 60000
});

// Función auxiliar para enviar correos
async function enviarCorreo(destinatario, asunto, texto) {
    if (!destinatario) return; // Si no hay correo, no enviamos nada
    try {
        await transporter.sendMail({
            from: `"Hospital Güemes - Donaciones" <${process.env.EMAIL_USER}>`,
            to: destinatario,
            subject: asunto,
            text: texto,
        });
        console.log(`📧 Correo enviado a ${destinatario} - Asunto: "${asunto}"`);
    } catch (error) {
        console.error(`❌ Error al enviar correo a ${destinatario}:`, error);
    }
}

// --- CONFIGURACIÓN DE BASE DE DATOS ---
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

        // --- ENVÍO DE CORREO: NUEVA DONACIÓN ---
        const asuntoNuevo = '¡Gracias por tu intención de donar al Hospital Güemes!';
        const mensajeNuevo = `Hola ${nombreFinal},\n\nHemos registrado tu intención de donar "${cantidadFinal} unidades de ${categoria}".\nTu donación se encuentra en estado PENDIENTE de recepción en el hospital.\n\nPor favor, acércate a nuestras instalaciones para concretar la entrega.\n\n¡Muchas gracias por tu solidaridad!\nEquipo del Hospital Güemes.`;
        enviarCorreo(correo, asuntoNuevo, mensajeNuevo);

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
        const checkSql = "SELECT estado, descripcion, correo, nombre FROM donaciones WHERE id = $1";
        const checkRes = await db.query(checkSql, [id]);

        if (checkRes.rows.length === 0) {
            return res.status(404).json({ error: 'Donación no encontrada.' });
        }

        const donacionDB = checkRes.rows[0];
        const estadoActual = donacionDB.estado || 'Pendiente';
        const correoDonante = donacionDB.correo;
        const nombreDonante = donacionDB.nombre;

        if (estadoActual === 'Aprobado y Destinado' || estadoActual === 'Rechazado') {
            return res.status(400).json({ error: `Esta donación ya fue cerrada como "${estadoActual}" y no se puede modificar.` });
        }

        if (estadoActual === 'Pendiente' && nuevoEstado !== 'Recibido' && nuevoEstado !== 'Rechazado') {
            return res.status(400).json({ error: 'Una donación Pendiente debe pasar al estado "Recibido" o puede ser "Rechazada".' });
        }

        if (estadoActual === 'Recibido' && (nuevoEstado !== 'Aprobado y Destinado' && nuevoEstado !== 'Rechazado')) {
            return res.status(400).json({ error: 'Una donación Recibida solo puede pasar a "Aprobado y Destinado" o "Rechazado".' });
        }

        const responsableFinal = actualizado_por ? String(actualizado_por).trim() : 'Sistema';
        const fechaHoraActual = new Date();

        let sql = `UPDATE donaciones SET estado = $1, actualizado_por = $3, fecha_actualizacion = $4 WHERE id = $2`;
        let valores = [nuevoEstado, id, responsableFinal, fechaHoraActual];

        if (nuevoEstado === 'Rechazado') {
            if (!motivoRechazo || motivoRechazo.trim() === '') {
                return res.status(400).json({ error: 'Debe especificar el motivo del rechazo.' });
            }
            const descripcionAnterior = donacionDB.descripcion || '';
            const descripcionConMotivo = `${descripcionAnterior} | [RECHAZADO: ${motivoRechazo.trim()}]`;
            
            sql = `UPDATE donaciones SET estado = $1, actualizado_por = $3, fecha_actualizacion = $4, descripcion = $5 WHERE id = $2`;
            valores = [nuevoEstado, id, responsableFinal, fechaHoraActual, descripcionConMotivo];
        }

        await db.query(sql, valores);

        // --- ENVÍO DE CORREO: ACTUALIZACIÓN DE ESTADO ---
        let asuntoUpdate = '';
        let mensajeUpdate = '';

        if (nuevoEstado === 'Recibido') {
            asuntoUpdate = 'Hemos recibido tu donación - Hospital Güemes';
            mensajeUpdate = `Hola ${nombreDonante},\n\nTe informamos que hemos RECIBIDO tu donación en nuestras instalaciones. Nuestro personal procederá a clasificarla.\n\n¡Muchas gracias por tu tiempo y solidaridad!`;
        } else if (nuevoEstado === 'Aprobado y Destinado') {
            asuntoUpdate = 'Tu donación ha sido destinada - Hospital Güemes';
            mensajeUpdate = `Hola ${nombreDonante},\n\n¡Excelentes noticias! Tu donación ha sido APROBADA Y DESTINADA con éxito. Gracias a tu aporte, hemos podido ayudar a quienes más lo necesitan.\n\nEl Hospital Güemes y la comunidad te lo agradecen.`;
        } else if (nuevoEstado === 'Rechazado') {
            asuntoUpdate = 'Actualización sobre tu donación - Hospital Güemes';
            mensajeUpdate = `Hola ${nombreDonante},\n\nTe informamos que tu donación ha sido RECHAZADA por el siguiente motivo:\n"${motivoRechazo.trim()}"\n\nAgradecemos de todas formas tu intención de colaborar con el hospital.`;
        }

        enviarCorreo(correoDonante, asuntoUpdate, mensajeUpdate);

        return res.json({ mensaje: 'Estado actualizado con éxito.', nuevoEstado, fecha_actualizacion: fechaHoraActual });
    } catch (err) {
        console.error('Error al actualizar estado:', err);
        return res.status(500).json({ error: 'Error al actualizar estado.' });
    }
});

// --- RUTAS DE GESTIÓN DE USUARIOS ---

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