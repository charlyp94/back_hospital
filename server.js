require('dotenv').config();
const express = require('express');
const { Sequelize, DataTypes, Op } = require('sequelize');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public')));

// Configuración de la conexión a PostgreSQL con Sequelize (Compatible con Local y Render)
const sequelize = new Sequelize(
    process.env.DB_DATABASE,
    process.env.DB_USER,
    process.env.DB_PASSWORD,
    {
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        dialect: 'postgres',
        logging: false,
        dialectOptions: (process.env.NODE_ENV === 'production' || (process.env.DB_HOST && process.env.DB_HOST !== 'localhost')) ? {
            ssl: {
                require: true,
                rejectUnauthorized: false
            }
        } : {}
    }
);

// --- DEFINICIÓN DE MODELOS ---
const Donacion = sequelize.define('Donacion', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tipo_donante: { type: DataTypes.STRING(50) },
    nombre: { type: DataTypes.STRING(150) },
    dni: { type: DataTypes.STRING(20) },
    fecha_nacimiento: { type: DataTypes.STRING(20) },
    correo: { type: DataTypes.STRING(150) },
    categoria: { type: DataTypes.STRING(100) },
    estado: { type: DataTypes.STRING(50), defaultValue: 'Pendiente' },
    ocultar_nombre: { type: DataTypes.STRING(10) },
    genero: { type: DataTypes.STRING(50) },
    telefono: { type: DataTypes.STRING(50) },
    cantidad: { type: DataTypes.INTEGER, defaultValue: 0 },
    fecha: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    cuit: { type: DataTypes.STRING(20) },
    descripcion: { type: DataTypes.TEXT },
    actualizado_por: { type: DataTypes.STRING(100) },
    fecha_actualizacion: { type: DataTypes.DATE }
}, {
    tableName: 'donaciones',
    timestamps: false
});

const Usuario = sequelize.define('Usuario', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    nombre_usuario: { type: DataTypes.STRING(50), unique: true, allowNull: false },
    dni: { type: DataTypes.STRING(20), unique: true, allowNull: false },
    nombre: { type: DataTypes.STRING(150), allowNull: false },
    contrasena: { type: DataTypes.STRING(255), allowNull: false },
    rol: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'usuario' }
}, {
    tableName: 'usuarios',
    timestamps: false
});

// --- FUNCIÓN DE LIMPIEZA AUTOMÁTICA ---
async function limpiarDonacionesExpiradas() {
    try {
        const treintaDiasAtras = new Date();
        treintaDiasAtras.setDate(treintaDiasAtras.getDate() - 30);
        const resultado = await Donacion.destroy({
            where: {
                estado: 'Pendiente',
                fecha: { [Op.lt]: treintaDiasAtras }
            }
        });
        if (resultado > 0) {
            console.log(`🧹 Limpieza automática: Se eliminaron ${resultado} donaciones pendientes expiradas.`);
        }
    } catch (err) {
        console.error('❌ Error al limpiar donaciones expiradas:', err);
    }
}

// Inicialización de la conexión y sincronización de modelos
sequelize.authenticate()
    .then(async () => {
        console.log('✨ ¡Conectado exitosamente a la base de datos PostgreSQL con Sequelize!');
        await sequelize.sync(); // Crea tablas automáticamente si no existen
        console.log('📦 Modelos y tablas sincronizados correctamente.');
        await limpiarDonacionesExpiradas();
    })
    .catch(err => {
        console.error('❌ Error al conectar a PostgreSQL con Sequelize:', err.stack);
    });

let ultimaDonacionCache = null;

// --- RUTA DE LOGIN ---
app.post('/api/login', async (req, res) => {
    const { nombre_usuario, contrasena } = req.body;

    try {
        const usuario = await Usuario.findOne({ where: { nombre_usuario } });

        if (!usuario) {
            return res.status(401).json({ error: 'El usuario no existe.' });
        }

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
        const pendienteExistente = await Donacion.findOne({ where: { correo, estado: 'Pendiente' } });
        if (pendienteExistente) {
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

    try {
        const nuevaDonacion = await Donacion.create({
            tipo_donante: tipoDonante,
            nombre: nombreFinal,
            dni: dniFinal,
            fecha_nacimiento: fechaNacFinal,
            correo,
            categoria,
            estado: 'Pendiente',
            ocultar_nombre: ocultarFinal,
            genero: generoFinal,
            telefono,
            cantidad: cantidadFinal,
            cuit: cuitFinal,
            descripcion: descripcion
        });

        return res.status(201).json({ mensaje: 'Donación registrada como Pendiente.', id: nuevaDonacion.id });
    } catch (err) {
        console.error('Error al insertar donación:', err);
        return res.status(500).json({ error: 'Error al guardar la donación.' });
    }
});

// --- RUTA GET: OBTENER DONACIONES ---
app.get('/api/donaciones', async (req, res) => {
    await limpiarDonacionesExpiradas();

    try {
        const donaciones = await Donacion.findAll({ order: [['id', 'DESC']] });
        return res.json(donaciones);
    } catch (err) {
        console.error('Error al obtener donaciones:', err);
        return res.status(500).json({ error: 'Error al obtener datos.' });
    }
});

// --- RUTA GET PÚBLICA: APROBADAS ---
app.get('/api/donaciones/aprobadas', async (req, res) => {
    try {
        const donaciones = await Donacion.findAll({
            where: { estado: 'Aprobado y Destinado' },
            order: [['id', 'DESC']]
        });

        const resultadoMapeado = donaciones.map(d => ({
            nombre: (!d.ocultar_nombre || d.ocultar_nombre.toLowerCase() !== 'si') ? d.nombre : '-',
            categoria: d.categoria,
            fecha: d.fecha,
            cantidad: d.cantidad,
            descripcion: d.descripcion
        }));

        return res.json(resultadoMapeado);
    } catch (err) {
        console.error('Error al obtener historial público:', err);
        return res.status(500).json({ error: 'Error al obtener historial.' });
    }
});

// --- RUTA GET: REPORTE DE DONACIONES POR PERIODO ---
app.get('/api/donaciones/reporte', async (req, res) => {
    const { inicio, fin } = req.query;

    if (!inicio || !fin) {
        return res.status(400).json({ success: false, error: 'Debe proporcionar una fecha de inicio y una fecha de fin.' });
    }

    try {
        const fechaInicio = new Date(inicio);
        const fechaFin = new Date(fin);
        fechaFin.setDate(fechaFin.getDate() + 1); // Incluir todo el día final

        const donaciones = await Donacion.findAll({
            where: {
                fecha: {
                    [Op.gte]: fechaInicio,
                    [Op.lte]: fechaFin
                }
            },
            order: [['fecha', 'DESC']]
        });

        return res.json({
            success: true,
            total: donaciones.length,
            donaciones
        });
    } catch (err) {
        console.error('Error al generar el reporte de donaciones:', err);
        return res.status(500).json({ success: false, error: 'Error interno del servidor al generar el reporte.' });
    }
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
        const donacion = await Donacion.findByPk(id);

        if (!donacion) {
            return res.status(404).json({ error: 'Donación no encontrada.' });
        }

        const estadoActual = donacion.estado || 'Pendiente';

        if (estadoActual === 'Aprobado y Destinado' || estadoActual === 'Rechazado') {
            return res.status(400).json({ error: `Esta donación ya fue cerrada como "${estadoActual}" y no se puede modificar.` });
        }

        if (estadoActual === 'Pendiente' && nuevoEstado !== 'Recibido') {
            return res.status(400).json({ error: 'Una donación Pendiente solo puede pasar al estado "Recibido".' });
        }

        if (estadoActual === 'Recibido' && (nuevoEstado !== 'Aprobado y Destinado' && nuevoEstado !== 'Rechazado')) {
            return res.status(400).json({ error: 'Una donación Recibida solo puede pasar a "Aprobado y Destinado" o "Rechazado".' });
        }

        const responsableFinal = actualizado_por ? String(actualizado_por).trim() : 'Sistema';
        const fechaHoraActual = new Date();

        let datosActualizacion = {
            estado: nuevoEstado,
            actualizado_por: responsableFinal,
            fecha_actualizacion: fechaHoraActual
        };

        if (nuevoEstado === 'Rechazado') {
            if (!motivoRechazo || motivoRechazo.trim() === '') {
                return res.status(400).json({ error: 'Debe especificar el motivo del rechazo.' });
            }
            const descripcionAnterior = donacion.descripcion || '';
            datosActualizacion.descripcion = `${descripcionAnterior} | [RECHAZADO: ${motivoRechazo.trim()}]`;
        }

        await donacion.update(datosActualizacion);
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
        const usuarios = await Usuario.findAll({
            attributes: ['id', 'nombre_usuario', 'dni', 'nombre', 'rol'],
            order: [['id', 'DESC']]
        });
        return res.json(usuarios);
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
        const existe = await Usuario.findOne({
            where: {
                [Op.or]: [{ nombre_usuario }, { dni }]
            }
        });

        if (existe) {
            return res.status(400).json({ error: 'El nombre de usuario o el DNI ya se encuentran registrados.' });
        }

        const nuevoUsuario = await Usuario.create({
            nombre_usuario,
            dni,
            nombre,
            contrasena,
            rol: rolFinal
        });

        return res.status(201).json({ 
            mensaje: 'Usuario creado exitosamente', 
            usuario: {
                id: nuevoUsuario.id,
                nombre_usuario: nuevoUsuario.nombre_usuario,
                dni: nuevoUsuario.dni,
                nombre: nuevoUsuario.nombre,
                rol: nuevoUsuario.rol
            }
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
        const eliminado = await Usuario.destroy({ where: { id } });

        if (!eliminado) {
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