const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');               // <-- NUEVO PARA EL PDF
const puppeteer = require('puppeteer'); // <-- NUEVO PARA EL PDF
const ejs = require('ejs');

const { PrismaClient } = require('./prisma/generated/client');
const { verificarRol } = require('./middleware/auth'); // Importamos nuestro guardián

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser()); // Necesario para leer las cookies de sesión

// ==========================================
// RUTAS PÚBLICAS Y DE AUTENTICACIÓN
// ==========================================

app.get('/', (req, res) => {
    res.redirect('/login'); // Redirigir el inicio directo al login
});

app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', async (req, res) => {
    try {
        const { documento, password } = req.body;
        
        // 1. Buscar al usuario
        const usuario = await prisma.usuario.findUnique({ where: { documento } });
        if (!usuario) {
            return res.render('login', { error: 'Documento o contraseña incorrectos' });
        }

        // 2. Verificar contraseña encriptada
        const esValida = await bcrypt.compare(password, usuario.password);
        if (!esValida) {
            return res.render('login', { error: 'Documento o contraseña incorrectos' });
        }

        // 3. Crear el "pase" (Token JWT)
        const token = jwt.sign(
            { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol }, 
            process.env.JWT_SECRET, 
            { expiresIn: '12h' } // La sesión dura 12 horas
        );

       // 4. Guardar en una cookie segura y redirigir según su rol
        res.cookie('jwt', token, { httpOnly: true, maxAge: 12 * 60 * 60 * 1000 });
        
        if (usuario.rol === 'admin') {
            return res.redirect('/admin');
        } else {
            return res.redirect('/panel-conductor'); // ¡AHORA VA A SU PROPIO PANEL!
        }
    } catch (error) {
        console.error(error);
        res.render('login', { error: 'Error interno del servidor' });
    }
});

app.get('/logout', (req, res) => {
    res.clearCookie('jwt');
    res.redirect('/login');
});

// RUTA SECRETA PARA CREAR EL PRIMER ADMINISTRADOR (Úsala una vez y luego bórrala)
app.get('/setup-admin', async (req, res) => {
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash('admin123', salt);
    
    await prisma.usuario.upsert({
        where: { documento: '999999999' },
        update: {},
        create: { nombre: 'Administrador Principal', documento: '999999999', password: hash, rol: 'admin' }
    });
    res.send('✅ Admin creado. Documento: 999999999 | Contraseña: admin123 <br><br> <a href="/login">Ir a Iniciar Sesión</a>');
});


// ==========================================
// RUTAS PROTEGIDAS (Solo pasan si tienen el rol adecuado)
// ==========================================

// PANEL ADMIN (Solo administradores)
app.get('/admin', verificarRol(['admin']), async (req, res) => {
    try {
        const inspecciones = await prisma.inspeccion.findMany({
            where: { eliminado: false }, // <-- FILTRO DE SOFT DELETE
            include: { conductor: true, vehiculo: true },
            orderBy: { fecha_apertura: 'desc' }
        });

        // 1. Lógica para determinar el nuevo estado y extraer ambos kilometrajes
        const inspeccionesProcesadas = inspecciones.map(insp => {
            let estadoBadge = 'Pendiente'; 
            let badgeClass = 'bg-warning text-dark'; // Amarillo

            if (insp.estado === 'Finalizada') {
                const datos = insp.datos_chequeo || {};
                const items = datos.chequeo_items || {};
                
                // Comprobar si hay algún "MALO" o si el conductor escribió alguna descripción de defecto
                const tieneDefectos = Object.values(items).includes('MALO') || 
                                      (datos.descripcion_defecto && datos.descripcion_defecto.trim() !== '');

                if (tieneDefectos) {
                    estadoBadge = 'Con defectos';
                    badgeClass = 'bg-danger text-white'; // Rojo
                } else {
                    estadoBadge = 'Aprobado';
                    badgeClass = 'bg-success text-white'; // Verde
                }
            }

            return {
                ...insp,
                estadoBadge,
                badgeClass,
                km_inicio: insp.kilometraje_salida,
                km_fin: insp.datos_chequeo?.kilometraje_final || '---'
            };
        });

        res.render('admin', { title: 'Panel Administrativo', inspecciones: inspeccionesProcesadas });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al cargar el panel de administración');
    }
});


// ==========================================
// GESTIÓN DE CONDUCTORES (Solo Admin)
// ==========================================

// 1. Ver lista de conductores
app.get('/admin/conductores', verificarRol(['admin']), async (req, res) => {
    try {
        const conductores = await prisma.usuario.findMany({
            where: { rol: 'conductor' },
            orderBy: { nombre: 'asc' }
        });
        res.render('conductores', { title: 'Gestión de Conductores', conductores, error: req.query.error });
    } catch (error) {
        res.status(500).send('Error al cargar la tabla de conductores');
    }
});

// 2. Mostrar formulario de creación
app.get('/admin/conductores/nuevo', verificarRol(['admin']), (req, res) => {
    res.render('crear-conductor', { title: 'Crear Conductor' });
});

// 3. Procesar creación
app.post('/admin/conductores/nuevo', verificarRol(['admin']), async (req, res) => {
    try {
        const { nombre, documento, password } = req.body;
        
        // Verificar que no exista otro con la misma cédula
        const existe = await prisma.usuario.findUnique({ where: { documento } });
        if (existe) {
            return res.render('crear-conductor', { title: 'Crear Conductor', error: 'Ese número de documento ya está registrado.' });
        }

        // Encriptar la contraseña y guardar
        const salt = await bcrypt.genSalt(10);
        const hashPassword = await bcrypt.hash(password, salt);

        await prisma.usuario.create({
            data: { nombre, documento, password: hashPassword, rol: 'conductor' }
        });

        res.send(`
            <div style="text-align: center; padding: 50px; font-family: Arial;">
                <h1 style="color: #27ae60;">¡Conductor Creado Exitosamente!</h1>
                <p>El conductor ya puede iniciar sesión con su documento.</p>
                <br><a href="/admin" style="padding:10px 20px; background:#3498db; color:white; text-decoration:none; border-radius:5px;">Volver al Panel</a>
            </div>
        `);
    } catch (error) {
        console.error(error);
        res.render('crear-conductor', { title: 'Crear Conductor', error: 'Error interno del servidor.' });
    }
});

// 4. Mostrar formulario para Editar
app.get('/admin/conductores/editar/:id', verificarRol(['admin']), async (req, res) => {
    try {
        const conductor = await prisma.usuario.findUnique({ where: { id: parseInt(req.params.id) } });
        if (!conductor) return res.redirect('/admin/conductores');
        res.render('editar-conductor', { title: 'Editar Conductor', conductor });
    } catch (error) {
        res.status(500).send('Error al cargar formulario');
    }
});

// 5. Procesar la Edición
app.post('/admin/conductores/editar/:id', verificarRol(['admin']), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { nombre, documento, password } = req.body;
        
        const dataActualizar = { nombre, documento };
        
        // Si el admin escribió una contraseña nueva, la encriptamos. Si la dejó vacía, no se cambia.
        if (password && password.trim() !== '') {
            const salt = await bcrypt.genSalt(10);
            dataActualizar.password = await bcrypt.hash(password, salt);
        }

        await prisma.usuario.update({ where: { id }, data: dataActualizar });
        res.redirect('/admin/conductores');
    } catch (error) {
        res.redirect('/admin/conductores?error=No+se+pudo+actualizar.+Verifica+que+el+documento+no+esté+duplicado.');
    }
});

// 6. Eliminar conductor
app.post('/admin/conductores/eliminar/:id', verificarRol(['admin']), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await prisma.usuario.delete({ where: { id } });
        res.redirect('/admin/conductores');
    } catch (error) {
        // Bloqueo de seguridad: No borrar si ya firmó inspecciones
        res.redirect('/admin/conductores?error=No+puedes+eliminar+a+este+conductor+porque+ya+tiene+inspecciones+registradas+en+el+historial.');
    }
});

// ==========================================
// RUTAS DE INSPECCIÓN
// ==========================================

// PANEL DEL CONDUCTOR (Su pantalla principal)
app.get('/panel-conductor', verificarRol(['conductor', 'admin']), async (req, res) => {
    try {
        // Buscar si el conductor ya tiene una inspección iniciada (En curso)
        const inspeccionActiva = await prisma.inspeccion.findFirst({
            where: { 
                conductor_id: req.usuario.id,
                estado: 'En curso' 
            },
            orderBy: { fecha_apertura: 'desc' }
        });

        res.render('panel-conductor', {
            usuario: req.usuario,
            inspeccionActiva: inspeccionActiva
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al cargar el panel del conductor');
    }
});

// FORMULARIO DE INSPECCIÓN (Acceden conductores. Admins también por si acaso)
app.get('/inspeccion', verificarRol(['conductor', 'admin']), (req, res) => {
    const fechaHoy = new Date().toISOString().split('T')[0];
    res.render('inspeccion', {
        title: 'Inspección Preoperacional',
        appName: 'Transporte SST',
        appVersion: '1.0.0',
        today: fechaHoy,
        formatoCodigo: 'SST-F-01',
        usuarioActual: req.usuario // Pasamos los datos del conductor a la vista
    });
});

app.post('/inspeccion/inicio', verificarRol(['conductor', 'admin']), async (req, res) => {
    try {
        const { placa, tipo_vehiculo, empresa, nombre_conductor, licencia_conductor, categoria_licencia, vigencia_licencia, modelo, kilometraje_entrada, cc_conductor, firma_conductor_base64, observaciones_generales, descripcion_defecto, ...restoDelFormulario } = req.body;

        let vehiculo = await prisma.vehiculo.findUnique({ where: { placa: placa.toUpperCase() } });
        if (!vehiculo) {
            vehiculo = await prisma.vehiculo.create({ data: { placa: placa.toUpperCase(), tipo: tipo_vehiculo || 'Otro', modelo: modelo || '' } });
        }

        let conductor = await prisma.usuario.findUnique({ where: { documento: cc_conductor } });
        
        // REGLA ESTRICTA: Si el conductor no existe en la BD, bloqueamos el registro
        if (!conductor) {
            return res.status(400).send(`
                <div style="text-align:center; padding:50px; font-family:Arial;">
                    <h1 style="color:#e74c3c;">Conductor no encontrado</h1>
                    <p>El documento <strong>${cc_conductor}</strong> no está registrado. Un administrador debe crear su usuario primero.</p>
                    <a href="/inspeccion" style="padding:10px 20px; background:#3498db; color:white; text-decoration:none; border-radius:5px;">Volver al Formulario</a>
                </div>
            `);
        }

        const nuevaInspeccion = await prisma.inspeccion.create({
            data: {
                estado: 'En curso',
                kilometraje_salida: parseInt(kilometraje_entrada), 
                conductor_id: conductor.id,
                vehiculo_placa: vehiculo.placa,
                datos_chequeo: { empresa, licencia_conductor, categoria_licencia, vigencia_licencia, firma_conductor: firma_conductor_base64, observaciones_generales, descripcion_defecto, chequeo_items: restoDelFormulario }
            }
        });

        const urlDestino = req.usuario.rol === 'admin' ? '/admin' : '/panel-conductor';
        res.send(`<div style="text-align: center; padding: 50px; font-family: Arial;"><h1 style="color: #27ae60;">¡Inspección Registrada!</h1><p>ID: #${nuevaInspeccion.id}</p><br><a href="${urlDestino}" style="padding:10px 20px; background:#3498db; color:white; text-decoration:none; border-radius:5px;">Volver a Mi Panel</a></div>`);    
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al guardar inspección');
    }
});

// ==========================================
// ACCIONES DE INSPECCIÓN (ADMIN)
// ==========================================

// 1. Ver Detalle Completo con Resumen
app.get('/admin/inspeccion/detalle/:id', verificarRol(['admin']), async (req, res) => {
    try {
        const insp = await prisma.inspeccion.findUnique({
            where: { id: parseInt(req.params.id) },
            include: { conductor: true, vehiculo: true }
        });

        if (!insp) return res.redirect('/admin');

        // Calcular resumen de calificación
        let resumen = { buenos: 0, malos: 0, na: 0 };
        const items = insp.datos_chequeo?.chequeo_items || {};
        
        for (const key in items) {
            if (items[key] === 'BUENO') resumen.buenos++;
            if (items[key] === 'MALO') resumen.malos++;
            if (items[key] === 'NA') resumen.na++;
        }

        res.render('detalle-inspeccion', { title: 'Detalle Inspección', insp, resumen });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al cargar detalle');
    }
});

// 2. Mostrar Formulario de Edición
app.get('/admin/inspeccion/editar/:id', verificarRol(['admin']), async (req, res) => {
    try {
        const insp = await prisma.inspeccion.findUnique({
            where: { id: parseInt(req.params.id) },
            // 👇 AQUÍ ESTÁ EL ARREGLO: Agregamos "conductor: true" 👇
            include: { vehiculo: true, conductor: true } 
        });
        if (!insp) return res.redirect('/admin');
        res.render('editar-inspeccion', { title: 'Editar Inspección', insp });
    } catch (error) {
        res.status(500).send('Error al cargar edición');
    }
});

// 3. Procesar Edición Completa
app.post('/admin/inspeccion/editar/:id', verificarRol(['admin']), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const body = req.body;

        const inspActual = await prisma.inspeccion.findUnique({ where: { id } });
        let datos = inspActual.datos_chequeo || {};
        
        // 1. Extraer TODOS los documentos explícitamente para que no se mezclen
        const { 
            empresa, licencia_conductor, categoria_licencia, vigencia_licencia, 
            doc_licencia_transito, fecha_vencimiento_soat, doc_poliza_rcc, 
            doc_poliza_todo_riesgo, doc_tarjeta_operacion, fecha_revision, fecha_cambio_aceite,
            kilometraje_salida, kilometraje_final, observaciones_generales, descripcion_defecto, 
            ...chequeo_items 
        } = body;
        
        // 2. Guardar Información y Documentos en la raíz
        if (empresa !== undefined) datos.empresa = empresa;
        if (licencia_conductor !== undefined) datos.licencia_conductor = licencia_conductor;
        if (categoria_licencia !== undefined) datos.categoria_licencia = categoria_licencia;
        if (vigencia_licencia !== undefined) datos.vigencia_licencia = vigencia_licencia;
        if (doc_licencia_transito !== undefined) datos.doc_licencia_transito = doc_licencia_transito;
        if (fecha_vencimiento_soat !== undefined) datos.fecha_vencimiento_soat = fecha_vencimiento_soat;
        if (doc_poliza_rcc !== undefined) datos.doc_poliza_rcc = doc_poliza_rcc;
        if (doc_poliza_todo_riesgo !== undefined) datos.doc_poliza_todo_riesgo = doc_poliza_todo_riesgo;
        if (doc_tarjeta_operacion !== undefined) datos.doc_tarjeta_operacion = doc_tarjeta_operacion;
        if (fecha_revision !== undefined) datos.fecha_revision = fecha_revision;
        if (fecha_cambio_aceite !== undefined) datos.fecha_cambio_aceite = fecha_cambio_aceite;

        // 3. Actualizar Observaciones y Defectos
        if (observaciones_generales !== undefined) datos.observaciones_generales = observaciones_generales;
        if (descripcion_defecto !== undefined) datos.descripcion_defecto = descripcion_defecto;
        if (kilometraje_final) datos.kilometraje_final = parseFloat(kilometraje_final);
        
        // 4. Guardar SOLO los items de calificación (Buenos/Malos) en la lista
        datos.chequeo_items = { ...datos.chequeo_items, ...chequeo_items };

        await prisma.inspeccion.update({
            where: { id },
            data: { 
                kilometraje_salida: parseInt(kilometraje_salida),
                datos_chequeo: datos
            }
        });

        res.redirect('/admin');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al guardar cambios');
    }
});

// ==========================================
// RUTA PARA EXPORTAR PDF (ADAPTADA A TU NUEVO TEMPLATE Y CON FIRMA)
// ==========================================
app.get('/admin/inspeccion/pdf/:id', verificarRol(['admin']), async (req, res) => {
    let browser = null; 
    try {
        const inspeccionId = parseInt(req.params.id);
        
        // 1. Buscar la inspección
        const insp = await prisma.inspeccion.findUnique({
            where: { id: inspeccionId },
            include: { conductor: true, vehiculo: true }
        });

        if (!insp || insp.eliminado) {
            return res.status(404).send('La inspección no existe o fue eliminada.');
        }

        const datos = insp.datos_chequeo || {};
        const items = datos.chequeo_items || {};

        // 2. Calcular totales
        let total_bueno = 0, total_malo = 0, total_na = 0;
        for (const key in items) {
            if (items[key] === 'BUENO') total_bueno++;
            if (items[key] === 'MALO') total_malo++;
            if (items[key] === 'NA') total_na++;
        }

        // 3. Determinar estado real
        let estadoReal = 'pendiente';
        if (insp.estado === 'Finalizada') {
            if (total_malo > 0 || (datos.descripcion_defecto && datos.descripcion_defecto.trim() !== '')) {
                estadoReal = 'con_defectos';
            } else {
                estadoReal = 'aprobado';
            }
        }

        // 4. TRADUCTOR: Mapear a las variables exactas de tu EJS
        const inspeccionFormateada = {
            id: insp.id,
            placa: insp.vehiculo_placa,
            codigo_inspeccion: insp.id,
            fecha_inspeccion: insp.fecha_apertura,
            hora_inspeccion: new Date(insp.fecha_apertura).toLocaleTimeString('es-ES', {hour: '2-digit', minute:'2-digit'}),
            hora_salida: insp.fecha_cierre ? new Date(insp.fecha_cierre).toLocaleTimeString('es-ES', {hour: '2-digit', minute:'2-digit'}) : '',
            estado: estadoReal,
            nombre_conductor: insp.conductor.nombre,
            cc_conductor: insp.conductor.documento,
            tipo_vehiculo: insp.vehiculo.tipo,
            licencia_conductor: datos.licencia_conductor || items.licencia_conductor,
            categoria_licencia: datos.categoria_licencia || items.categoria_licencia,
            modelo_vehiculo: insp.vehiculo.modelo,
            empresa: datos.empresa || items.empresa,
            vigencia_licencia: datos.vigencia_licencia || items.vigencia_licencia,
            
            // BLINDAJE DE DOCUMENTOS: Busca en la raíz o en los items por si acaso
            doc_licencia_transito: datos.doc_licencia_transito || items.doc_licencia_transito || '',
            fecha_vencimiento_soat: datos.fecha_vencimiento_soat || items.fecha_vencimiento_soat || '',
            fecha_revision: datos.fecha_revision || items.fecha_revision || '',
            doc_poliza_rcc: datos.doc_poliza_rcc || items.doc_poliza_rcc || '',
            doc_poliza_todo_riesgo: datos.doc_poliza_todo_riesgo || items.doc_poliza_todo_riesgo || '',
            doc_tarjeta_operacion: datos.doc_tarjeta_operacion || items.doc_tarjeta_operacion || '',
            fecha_cambio_aceite: datos.fecha_cambio_aceite || items.fecha_cambio_aceite || '',
            
            kilometraje_entrada: insp.kilometraje_salida,
            kilometraje_salida: datos.kilometraje_final,
            distancia_recorrida: datos.kilometraje_final ? (parseFloat(datos.kilometraje_final) - parseFloat(insp.kilometraje_salida)).toFixed(1) : 0,
            total_bueno, 
            total_malo, 
            total_na,
            observaciones_generales: datos.observaciones_generales,
            tiene_defectos: (total_malo > 0 || items.defecto_frontal || items.defecto_trasero || items.defecto_lateral_izq || items.defecto_lateral_der || items.defecto_motor || items.defecto_chasis || datos.descripcion_defecto) ? 1 : 0,
            defecto_frontal: !!items.defecto_frontal,
            defecto_trasero: !!items.defecto_trasero,
            defecto_lateral_izq: !!items.defecto_lateral_izq,
            defecto_lateral_der: !!items.defecto_lateral_der,
            defecto_motor: !!items.defecto_motor,
            defecto_chasis: !!items.defecto_chasis,
            descripcion_defecto: datos.descripcion_defecto,
            
            firma_conductor: datos.firma_conductor, 
            
            nombre_firma_conductor: datos.nombre_firma_conductor || insp.conductor.nombre,
            firma_coordinador: req.usuario.nombre, // Tu nombre como admin que descarga
            cc_coordinador: req.usuario.documento
        };

        // 5. Crear las categorías que pide tu código
        const categorias = {
            niveles: [
                { label: 'Líquido refrigerante', valor: items.nivel_refrigerante, obs: items.obs_nivel_refrigerante },
                { label: 'Líquido de frenos', valor: items.nivel_frenos, obs: items.obs_nivel_frenos },
                { label: 'Aceite motor', valor: items.nivel_aceite, obs: items.obs_nivel_aceite },
                { label: 'Líquido hidráulico', valor: items.nivel_hidraulico, obs: items.obs_nivel_hidraulico },
                { label: 'Agua limpiavidrios', valor: items.nivel_agua, obs: items.obs_nivel_agua }
            ],
            pedales: [
                { label: 'Acelerador', valor: items.pedal_acelerador, obs: items.obs_pedal_acelerador },
                { label: 'Clutch/Embrague', valor: items.pedal_clutch, obs: items.obs_pedal_clutch },
                { label: 'Freno', valor: items.pedal_freno, obs: items.obs_pedal_freno }
            ],
            luces: [
                { label: 'Luces principales', valor: items.luz_principales, obs: items.obs_luz_principales },
                { label: 'Direccionales', valor: items.luz_direccionales, obs: items.obs_luz_direccionales },
                { label: 'Estacionarias', valor: items.luz_estacionarias, obs: items.obs_luz_estacionarias },
                { label: 'Stops/Frenos', valor: items.luz_stops, obs: items.obs_luz_stops },
                { label: 'Testigos tablero', valor: items.luz_testigos, obs: items.obs_luz_testigos },
                { label: 'Luz reversa', valor: items.luz_reversa, obs: items.obs_luz_reversa },
                { label: 'Luces internas', valor: items.luz_internas, obs: items.obs_luz_internas }
            ],
            equipo: [
                { label: 'Extintor (BC - ABC)', valor: items.equipo_extintor, obs: items.obs_equipo_extintor },
                { label: 'Fecha Venc. Extintor', valor: items.equipo_fecha_extintor, obs: items.obs_equipo_fecha_extintor },
                { label: 'Llanta de repuesto', valor: items.equipo_llanta, obs: items.obs_equipo_llanta },
                { label: 'Señales reflectivas', valor: items.equipo_senales, obs: items.obs_equipo_senales },
                { label: 'Caja herramientas', valor: items.equipo_herramientas, obs: items.obs_equipo_herramientas },
                { label: 'Botiquín', valor: items.equipo_botiquin, obs: items.obs_equipo_botiquin },
                { label: 'Kit de Carreteras', valor: items.equipo_carreteras, obs: items.obs_equipo_carreteras },
                { label: 'Kit Ambiental', valor: items.equipo_ambiental, obs: items.obs_equipo_ambiental }
            ],
            varios: [
                { label: 'Llantas', valor: items.varios_llantas, obs: items.obs_varios_llantas },
                { label: 'Batería', valor: items.varios_bateria, obs: items.obs_varios_bateria },
                { label: 'Rines', valor: items.varios_rines, obs: items.obs_varios_rines },
                { label: 'Cinturones', valor: items.varios_cinturones, obs: items.obs_varios_cinturones },
                { label: 'Pito reversa', valor: items.varios_pito_reversa, obs: items.obs_varios_pito_reversa },
                { label: 'Pito', valor: items.varios_pito, obs: items.obs_varios_pito },
                { label: 'Freno emergencia', valor: items.varios_freno_emergencia, obs: items.obs_varios_freno_emergencia },
                { label: 'Espejos', valor: items.varios_espejos, obs: items.obs_varios_espejos },
                { label: 'Carcasa luces', valor: items.varios_carcasa, obs: items.obs_varios_carcasa },
                { label: 'Plumillas', valor: items.varios_plumillas, obs: items.obs_varios_plumillas },
                { label: 'Tapizado', valor: items.varios_tapizado, obs: items.obs_varios_tapizado },
                { label: 'Panorámico', valor: items.varios_panoramico, obs: items.obs_varios_panoramico },
                { label: 'Radiotelefono', valor: items.varios_radiotelefono, obs: items.obs_varios_radiotelefono },
                { label: 'Aire Acondicionado', valor: items.varios_aire, obs: items.obs_varios_aire },
                { label: 'Vidrios Laterales', valor: items.varios_vidrios_laterales, obs: items.obs_varios_vidrios_laterales },
                { label: 'Vidrio Trasero', valor: items.varios_vidrio_trasero, obs: items.obs_varios_vidrio_trasero },
                { label: 'Tercer Stop', valor: items.varios_tercer_stop, obs: items.obs_varios_tercer_stop }
            ]
        };

        // 6. Cargar el Logo (si existe)
        let logoSrc = '';
        try {
            const logoPath = path.join(__dirname, 'public/images/logo.png');
            if (fs.existsSync(logoPath)) {
                const logoBuffer = fs.readFileSync(logoPath);
                logoSrc = `data:image/png;base64,${logoBuffer.toString('base64')}`;
            }
        } catch (logoError) {}

        // 7. Renderizar y generar PDF
        const templatePath = path.join(__dirname, 'views/pdf-template.ejs');
        const html = await ejs.renderFile(templatePath, {
            inspeccion: inspeccionFormateada,
            categorias: categorias, 
            logoSrc: logoSrc, 
            fechaImpresion: new Date().toLocaleString('es-ES'),
            adminSolicitante: req.usuario.nombre,
            formatoCodigo: 'SST-F-01'
        });

        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        
        const pdfBytes = await page.pdf({
            format: 'Letter',
            printBackground: true,
            margin: { top: '10px', right: '10px', bottom: '10px', left: '10px' }
        });

        await browser.close();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Inspeccion_${inspeccionFormateada.placa}_${inspeccionId}.pdf"`);
        res.end(Buffer.from(pdfBytes));

    } catch (error) {
        if (browser) await browser.close(); 
        console.error('🔥 Error crítico al generar PDF:', error);
        res.status(500).send('Ocurrió un error al intentar generar el documento PDF.');
    }
});

// 4. Soft Delete (Eliminar ocultando)
app.post('/admin/inspeccion/eliminar/:id', verificarRol(['admin']), async (req, res) => {
    try {
        await prisma.inspeccion.update({
            where: { id: parseInt(req.params.id) },
            data: { eliminado: true }
        });
        res.redirect('/admin');
    } catch (error) {
        res.status(500).send('Error al eliminar');
    }
});

// CIERRE DE JORNADA (Acceden administradores y conductores)
app.get('/inspeccion/cierre/:id', verificarRol(['conductor', 'admin']), async (req, res) => {
    try {
        const idInspeccion = parseInt(req.params.id);
        const inspeccion = await prisma.inspeccion.findUnique({
            where: { id: idInspeccion },
            include: { vehiculo: true, conductor: true }
        });

        if (!inspeccion) return res.status(404).send('Inspección no encontrada');
        if (inspeccion.estado === 'Finalizada') return res.send('<div style="text-align:center; padding:50px;"><h1>Esta jornada ya fue cerrada</h1><a href="/panel-conductor">Volver</a></div>');

        res.render('cierre', { title: 'Cierre de Jornada', appName: 'Transporte SST', inspeccion });
    } catch (error) {
        res.status(500).send('Error al cargar la inspección');
    }
});

app.post('/inspeccion/cierre/:id', verificarRol(['conductor', 'admin']), async (req, res) => {
    try {
        const idInspeccion = parseInt(req.params.id);
        const { kilometraje_final, novedades } = req.body;
        const inspeccionActual = await prisma.inspeccion.findUnique({ where: { id: idInspeccion } });
        let datosChequeoActualizados = inspeccionActual.datos_chequeo || {};
        datosChequeoActualizados.kilometraje_final = parseFloat(kilometraje_final);

        await prisma.inspeccion.update({
            where: { id: idInspeccion },
            data: { estado: 'Finalizada', fecha_cierre: new Date(), novedades_cierre: novedades || 'Sin novedades', datos_chequeo: datosChequeoActualizados }
        });

        const urlDestino = req.usuario.rol === 'admin' ? '/admin' : '/panel-conductor';
        res.send(`<div style="text-align: center; padding: 50px; font-family: Arial;"><h1 style="color: #27ae60;">¡Jornada Cerrada!</h1><br><a href="${urlDestino}" style="padding:10px 20px; background:#3498db; color:white; text-decoration:none; border-radius:5px;">Volver a Mi Panel</a></div>`);
    } catch (error) {
        res.status(500).send('Error al cerrar la jornada');
    }
});

// Iniciar servidor xd
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});