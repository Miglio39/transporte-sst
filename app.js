const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');               // <-- PARA EL PDF
const puppeteer = require('puppeteer'); // <-- PARA EL PDF
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

// RUTA SECRETA PARA CREAR LOS ADMINISTRADORES REALES
app.get('/setup-admin', async (req, res) => {
    const salt = await bcrypt.genSalt(10);
    // Encriptamos la nueva contraseña segura (es la misma para ambos)
    const hash = await bcrypt.hash('Omega2026*', salt);
    
    // Crear a Yeison
    await prisma.usuario.upsert({
        where: { documento: '1122141007' },
        // Si el usuario ya existe, le actualizamos la contraseña por si acaso
        update: { password: hash }, 
        create: { nombre: 'Yeison Uriel Vargas Vesga', documento: '1122141007', password: hash, rol: 'admin' }
    });

    // Crear a Maria Fernanda
    await prisma.usuario.upsert({
        where: { documento: '1123087694' },
        // Si el usuario ya existe, le actualizamos la contraseña por si acaso
        update: { password: hash },
        create: { nombre: 'Maria Fernanda Ladino Vega', documento: '1123087694', password: hash, rol: 'admin' }
    });

    res.send(`
        <div style="text-align: center; padding: 50px; font-family: Arial;">
            <h1 style="color: #27ae60;">✅ Cuentas de Administrador Configuradas</h1>
            <p><strong>Yeison:</strong> Doc: 1122141007</p>
            <p><strong>Maria F:</strong> Doc: 1123087694</p>
            <p><small>La contraseña para ambos ha sido establecida como secreta.</small></p>
            <br>
            <a href="/login" style="padding:10px 20px; background:#3498db; color:white; text-decoration:none; border-radius:5px;">Ir a Iniciar Sesión</a>
        </div>
    `);
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
        
        // 1. Extraer TODOS los documentos y la FIRMA DEL ADMIN
        const { 
            empresa, licencia_conductor, categoria_licencia, vigencia_licencia, 
            doc_licencia_transito, fecha_vencimiento_soat, doc_poliza_rcc, 
            doc_poliza_todo_riesgo, doc_tarjeta_operacion, fecha_revision, fecha_cambio_aceite,
            kilometraje_salida, kilometraje_final, observaciones_generales, descripcion_defecto, 
            firma_coordinador_base64, // <-- NUEVO: Atrapamos la firma del admin
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

        // Si el administrador dibujó su firma, la guardamos junto con su nombre
        if (firma_coordinador_base64) {
            datos.firma_coordinador_img = firma_coordinador_base64;
            datos.nombre_coordinador = req.usuario.nombre;
            datos.cc_coordinador = req.usuario.documento;
        }

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
// RUTA PARA EXPORTAR PDF
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
            firma_coordinador_img: datos.firma_coordinador_img || null,
            firma_coordinador: datos.nombre_coordinador || req.usuario.nombre, 
            cc_coordinador: datos.cc_coordinador || req.usuario.documento
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
            headless: true, // Mantenlo en true
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
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

// ==========================================
// NUEVA RUTA: REPORTE MAESTRO CONSOLIDADO
// ==========================================
app.get('/admin/inspeccion/reporte-maestro', verificarRol(['admin']), async (req, res) => {
    let browser = null;
    try {
        const { fechaInicio, fechaFin, placa } = req.query;
        if (!fechaInicio || !fechaFin) return res.status(400).send("Debe seleccionar las fechas.");

        // 1. Configurar los límites de tiempo (Desde las 00:00 hasta las 23:59)
        const startDate = new Date(fechaInicio + 'T00:00:00');
        const endDate = new Date(fechaFin + 'T23:59:59');

        // 2. Construir la consulta a la Base de Datos
        let whereClause = { 
            eliminado: false,
            fecha_apertura: { gte: startDate, lte: endDate }
        };
        if (placa && placa !== 'TODAS') {
            whereClause.vehiculo_placa = placa;
        }

        const inspecciones = await prisma.inspeccion.findMany({
            where: whereClause,
            include: { conductor: true, vehiculo: true },
            orderBy: { fecha_apertura: 'asc' } // Orden cronológico
        });

        if(inspecciones.length === 0) {
            return res.send('<h2 style="text-align:center; margin-top:50px; font-family:sans-serif;">No hay registros en estas fechas.</h2>');
        }

        // 3. Procesar los datos matemáticamente
        let total = inspecciones.length;
        let aprobadas = 0;
        let conDefectos = 0;
        let tablaEjecutiva = [];
        let inspeccionesConDefectos = [];

        inspecciones.forEach(insp => {
            const datos = insp.datos_chequeo || {};
            const items = datos.chequeo_items || {};
            
            // Buscar si hay items malos
            let fallasExtraidas = [];
            for (const key in items) {
                if (items[key] === 'MALO' && !key.startsWith('obs_')) {
                    fallasExtraidas.push({
                        nombre: key.replace(/^[a-z]+_/, '').replace(/_/g, ' ').toUpperCase(),
                        obs: items['obs_' + key] || 'Sin observación'
                    });
                }
            }
            
            let tieneFallas = fallasExtraidas.length > 0 || (datos.descripcion_defecto && datos.descripcion_defecto.trim() !== '');
            let estadoLegible = 'En Curso';

            if (insp.estado === 'Finalizada') {
                if (tieneFallas) {
                    conDefectos++;
                    estadoLegible = 'CON DEFECTOS';
                    // Guardamos la inspección completa para las hojas de detalles posteriores
                    inspeccionesConDefectos.push({
                        id: insp.id,
                        fecha: new Date(insp.fecha_apertura).toLocaleDateString('es-CO'),
                        placa: insp.vehiculo_placa,
                        conductor: insp.conductor.nombre,
                        descripcion_defecto: datos.descripcion_defecto,
                        fallas: fallasExtraidas
                    });
                } else {
                    aprobadas++;
                    estadoLegible = 'APROBADO';
                }
            }

            // Agregamos a la tabla de la Primera Hoja (Todas van aquí)
            tablaEjecutiva.push({
                ticket: insp.id,
                fecha: new Date(insp.fecha_apertura).toLocaleDateString('es-CO'),
                placa: insp.vehiculo_placa,
                conductor: insp.conductor.nombre,
                km_salida: insp.kilometraje_salida,
                km_llegada: datos.kilometraje_final || '-',
                estado: estadoLegible
            });
        });

        // 4. Cargar el Logo (si existe) para inyectarlo en el PDF Maestro
        let logoSrc = '';
        try {
            const logoPath = path.join(__dirname, 'public/images/logo.png');
            if (fs.existsSync(logoPath)) {
                const logoBuffer = fs.readFileSync(logoPath);
                logoSrc = `data:image/png;base64,${logoBuffer.toString('base64')}`;
            }
        } catch (logoError) {
            console.warn('No se pudo cargar el logo para el PDF maestro:', logoError.message);
        }

        // 5. Renderizar el nuevo EJS y pasarlo a PDF
        const templatePath = path.join(__dirname, 'views/pdf-maestro.ejs');
        const html = await ejs.renderFile(templatePath, {
            fechaInicio, fechaFin, placaSeleccionada: placa,
            total, aprobadas, conDefectos, 
            tablaEjecutiva, inspeccionesConDefectos,
            logoSrc: logoSrc, 
            fechaImpresion: new Date().toLocaleString('es-CO')
        });

        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        
        const pdfBytes = await page.pdf({
            format: 'Letter',
            printBackground: true,
            margin: { top: '15px', right: '15px', bottom: '15px', left: '15px' }
        });

        await browser.close();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Auditoria_OmegaGroup_${fechaInicio}_al_${fechaFin}.pdf"`);
        res.end(Buffer.from(pdfBytes));

    } catch (error) {
        if (browser) await browser.close(); 
        console.error('🔥 Error crítico Reporte Maestro:', error);
        res.status(500).send('Error generando el Reporte Maestro: ' + error.message);
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

// ==============================================================
// RUTA TEMPORAL PARA SEMBRAR DATOS FICTICIOS (100% REALISTA)
// ==============================================================
app.get('/generar-prueba', verificarRol(['admin']), async (req, res) => {
    try {
        const flota = [
            { placa: 'OMG-001', doc: '10000001', nombre: 'Carlos Ruiz', tipo: 'Camión' },
            { placa: 'OME-002', doc: '10000002', nombre: 'Luis Martínez', tipo: 'Camión' },
            { placa: 'MGA-003', doc: '10000003', nombre: 'Andrés Gómez', tipo: 'Automóvil' },
            { placa: 'SST-004', doc: '10000004', nombre: 'Jorge Silva', tipo: 'Camioneta' },
            { placa: 'TRP-005', doc: '10000005', nombre: 'Miguel Rojas', tipo: 'Bus' },
            { placa: 'LOG-006', doc: '10000006', nombre: 'David Ramírez', tipo: 'Camión' },
            { placa: 'FLT-007', doc: '10000007', nombre: 'Pedro Castro', tipo: 'Volqueta' },
            { placa: 'VHC-008', doc: '10000008', nombre: 'José Vargas', tipo: 'Camioneta' },
            { placa: 'MVD-009', doc: '10000009', nombre: 'Héctor Ospina', tipo: 'Automóvil' },
            { placa: 'RUT-010', doc: '10000010', nombre: 'Diego León', tipo: 'Bus' }
        ];

        // Lista de absolutamente todos los campos del chequeo
        const todosLosItems = [
            'nivel_refrigerante', 'nivel_frenos', 'nivel_aceite', 'nivel_hidraulico', 'nivel_agua',
            'pedal_acelerador', 'pedal_clutch', 'pedal_freno',
            'luz_principales', 'luz_direccionales', 'luz_estacionarias', 'luz_stops', 'luz_testigos', 'luz_reversa', 'luz_internas',
            'equipo_extintor', 'equipo_fecha_extintor', 'equipo_llanta', 'equipo_senales', 'equipo_herramientas', 'equipo_botiquin', 'equipo_carreteras', 'equipo_ambiental',
            'varios_llantas', 'varios_bateria', 'varios_rines', 'varios_cinturones', 'varios_pito_reversa', 'varios_pito', 'varios_freno_emergencia', 'varios_espejos', 'varios_carcasa', 'varios_plumillas', 'varios_tapizado', 'varios_panoramico', 'varios_radiotelefono', 'varios_aire', 'varios_vidrios_laterales', 'varios_vidrio_trasero', 'varios_tercer_stop'
        ];

        const fallasPosibles = ['nivel_aceite', 'luz_principales', 'luz_stops', 'varios_llantas', 'pedal_freno', 'equipo_extintor', 'varios_pito', 'varios_espejos', 'equipo_botiquin'];
        
        const salt = await bcrypt.genSalt(10);
        const pwdGenerica = await bcrypt.hash('123456', salt); 

        // Crear/Actualizar conductores y vehículos
        for (let vehiculo of flota) {
            const conductorDB = await prisma.usuario.upsert({
                where: { documento: vehiculo.doc },
                update: {},
                create: { nombre: vehiculo.nombre, documento: vehiculo.doc, password: pwdGenerica, rol: 'conductor' }
            });
            vehiculo.conductor_id = conductorDB.id;

            await prisma.vehiculo.upsert({
                where: { placa: vehiculo.placa },
                update: {},
                create: { placa: vehiculo.placa, tipo: vehiculo.tipo, modelo: '2023' }
            });
        }

        // LIMPIEZA TOTAL: Borramos para no duplicar ni generar basura
        await prisma.inspeccion.deleteMany(); 

        let creadas = 0;
        const hoy = new Date();

        // Generador de fechas aleatorias
        const randomDate = (baseDate, offsetDays) => {
            let d = new Date(baseDate);
            d.setDate(d.getDate() + offsetDays);
            return d.toISOString().split('T')[0];
        };

        for (let i = 0; i < 30; i++) {
            const fechaSimulada = new Date(hoy);
            fechaSimulada.setDate(fechaSimulada.getDate() - i); 

            for (let vehiculo of flota) {
                const esFalla = Math.random() < 0.15; // 15% de los reportes tendrán daños
                let chequeo_items = {};
                let descripcion = "";

                // 1. LLENAR TODOS LOS ÍTEMS COMO "BUENO" Y PONERLES OBSERVACIÓN
                for(let item of todosLosItems) {
                    chequeo_items[item] = 'BUENO';
                    chequeo_items['obs_' + item] = 'Inspeccionado, funcionando en óptimas condiciones.';
                }

                // 2. SI EL CARRO FALLA, CAMBIAR DE 1 A 3 ÍTEMS A "MALO"
                if (esFalla) {
                    let numFallas = Math.floor(Math.random() * 3) + 1;
                    for(let j=0; j<numFallas; j++) {
                        let fallaAlAzar = fallasPosibles[Math.floor(Math.random() * fallasPosibles.length)];
                        chequeo_items[fallaAlAzar] = 'MALO';
                        chequeo_items['obs_' + fallaAlAzar] = '❌ Presenta desgaste o mal funcionamiento, requiere revisión técnica.';
                    }
                    descripcion = "Se identificaron componentes en mal estado durante la inspección visual. Solicito mantenimiento preventivo.";
                }

                // 3. GENERAR TODAS LAS FECHAS DE LOS DOCUMENTOS
                const diasSoat = (vehiculo.placa === 'OMG-001') ? -5 : Math.floor(Math.random() * 300) + 10; 
                const diasTecno = (vehiculo.placa === 'OME-002') ? 15 : Math.floor(Math.random() * 300) + 10;
                
                const vigenciaLicencia = randomDate(hoy, 365 + Math.floor(Math.random() * 500));
                const polizaRcc = randomDate(hoy, Math.floor(Math.random() * 300) + 20);
                const polizaRiesgo = randomDate(hoy, Math.floor(Math.random() * 300) + 20);
                const tarjetaOp = randomDate(hoy, Math.floor(Math.random() * 200) + 15);
                const cambioAceite = randomDate(hoy, -Math.floor(Math.random() * 60)); // Fecha en el pasado

                const kmSalida = Math.floor(Math.random() * 50000) + 10000 + ((30 - i) * 150); 

                // INYECTAR EN BD CON TODOS LOS CAMPOS LLENOS AL 100%
                await prisma.inspeccion.create({
                    data: {
                        vehiculo_placa: vehiculo.placa,
                        conductor_id: vehiculo.conductor_id,
                        fecha_apertura: fechaSimulada,
                        fecha_cierre: fechaSimulada,
                        estado: 'Finalizada',
                        kilometraje_salida: kmSalida,
                        datos_chequeo: {
                            // Campos de cabecera
                            empresa: "OmegaGroup SAS",
                            licencia_conductor: vehiculo.doc,
                            categoria_licencia: vehiculo.tipo === 'Automóvil' ? 'B1' : 'C2',
                            vigencia_licencia: vigenciaLicencia,
                            modelo: '2023',
                            // Documentos y Fechas
                            doc_licencia_transito: Math.floor(Math.random() * 90000000) + 10000000 + "",
                            fecha_vencimiento_soat: randomDate(hoy, diasSoat),
                            fecha_revision: randomDate(hoy, diasTecno),
                            doc_poliza_rcc: polizaRcc,
                            doc_poliza_todo_riesgo: polizaRiesgo,
                            doc_tarjeta_operacion: tarjetaOp,
                            fecha_cambio_aceite: cambioAceite,
                            // Chequeo
                            chequeo_items: chequeo_items,
                            descripcion_defecto: descripcion,
                            observaciones_generales: "El vehículo se encuentra limpio y con todos los documentos portados en cabina.",
                            kilometraje_final: kmSalida + Math.floor(Math.random() * 150) + 20
                        }
                    }
                });
                creadas++;
            }
        }
        res.send(`
            <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
                <h1 style="color: #10b981;">✅ ¡Simulación 100% Realista Exitosa!</h1>
                <h2>Se inyectaron ${creadas} inspecciones con todos los campos diligenciados y calificados.</h2>
                <a href="/admin" style="display: inline-block; background: #0f172a; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-top: 20px;">Ir al Panel de Estadísticas</a>
            </div>
        `);
    } catch (error) {
        res.send('❌ Hubo un error de base de datos: ' + error.message);
    }
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});