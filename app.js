/**
 * ============================================================================
 * 1. CONFIGURACIÓN INICIAL Y DEPENDENCIAS
 * ============================================================================
 */
const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');               
const puppeteer = require('puppeteer'); 
const nodemailer = require('nodemailer');
const ejs = require('ejs');

const { PrismaClient } = require('./prisma/generated/client');
const { verificarRol } = require('./middleware/auth');

dotenv.config();

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Límite de 50MB para carga de fotos pesadas de auditoría y firmas
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());

// Función auxiliar para evitar que peticiones a servidores GPS externos cuelguen la página
async function fetchConTimeout(url, options = {}, timeoutMs = 7000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timer);
        return response;
    } catch (error) {
        clearTimeout(timer);
        throw error;
    }
}

/**
 * ============================================================================
 * 2. RUTAS PÚBLICAS Y DE AUTENTICACIÓN (BLINDADAS PARA APP MÓVIL)
 * ============================================================================
 */
app.get('/', (req, res) => {
    res.redirect('/login');
});

app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', async (req, res) => {
    try {
        const { documento, password } = req.body;
        
        const usuario = await prisma.usuario.findUnique({ where: { documento } });
        if (!usuario) {
            return res.render('login', { error: 'Documento o contraseña incorrectos' });
        }

        const esValida = await bcrypt.compare(password, usuario.password);
        if (!esValida) {
            return res.render('login', { error: 'Documento o contraseña incorrectos' });
        }

        // Token firmado por 180 días (6 meses)
        const token = jwt.sign(
            { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol }, 
            process.env.JWT_SECRET || 'llave_de_respaldo_omega_2026', 
            { expiresIn: '180d' }
        );

        const tiempo6Meses = 180 * 24 * 60 * 60 * 1000;
        
        // 🚨 CONFIGURACIÓN CRÍTICA PARA QUE LA PWA (APP MÓVIL) NO CIERRE LA SESIÓN 🚨
        res.cookie('jwt', token, { 
            httpOnly: true, 
            secure: true,      // OBLIGATORIO para móviles con PWA instalada
            path: '/',         // OBLIGATORIO para que el sistema no lo borre al salir
            sameSite: 'lax',
            maxAge: tiempo6Meses,
            expires: new Date(Date.now() + tiempo6Meses)
        });
        
        if (usuario.rol === 'admin') {
            return res.redirect('/admin');
        } else {
            return res.redirect('/panel-conductor');
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

// Ruta para inicializar el sistema
app.get('/setup-admin', async (req, res) => {
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash('Omega2026*', salt);
    
    await prisma.usuario.upsert({
        where: { documento: '1122141007' },
        update: { password: hash }, 
        create: { nombre: 'Yeison Uriel Vargas Vesga', documento: '1122141007', password: hash, rol: 'admin' }
    });

    await prisma.usuario.upsert({
        where: { documento: '1123087694' },
        update: { password: hash },
        create: { nombre: 'Maria Fernanda Ladino Vega', documento: '1123087694', password: hash, rol: 'admin' }
    });

    res.send(`
        <div style="text-align: center; padding: 50px; font-family: Arial;">
            <h1 style="color: #27ae60;">✅ Cuentas de Administrador Configuradas</h1>
            <p><strong>Yeison:</strong> Doc: 1122141007</p>
            <p><strong>Maria F:</strong> Doc: 1123087694</p>
            <br><a href="/login" style="padding:10px 20px; background:#3498db; color:white; text-decoration:none; border-radius:5px;">Ir a Iniciar Sesión</a>
        </div>
    `);
});

/**
 * ============================================================================
 * 3. MÓDULO ADMINISTRATIVO (PANEL Y CONDUCTORES)
 * ============================================================================
 */
app.get('/admin', verificarRol(['admin']), async (req, res) => {
    try {
        const inspecciones = await prisma.inspeccion.findMany({
            where: { eliminado: false }, 
            include: { conductor: true, vehiculo: true },
            orderBy: { fecha_apertura: 'desc' }
        });

        const inspeccionesProcesadas = inspecciones.map(insp => {
            let estadoBadge = 'Pendiente'; 
            let badgeClass = 'bg-warning text-dark'; 

            if (insp.estado === 'Finalizada') {
                const datos = insp.datos_chequeo || {};
                const items = datos.chequeo_items || {};
                
                const tieneDefectos = Object.values(items).includes('MALO') || 
                                      (datos.descripcion_defecto && datos.descripcion_defecto.trim() !== '');

                if (tieneDefectos) {
                    estadoBadge = 'Con defectos';
                    badgeClass = 'bg-danger text-white'; 
                } else {
                    estadoBadge = 'Aprobado';
                    badgeClass = 'bg-success text-white'; 
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

app.get('/admin/conductores', verificarRol(['admin']), async (req, res) => {
    try {
        const conductores = await prisma.usuario.findMany({
            where: { rol: 'conductor' },
            orderBy: { nombre: 'asc' }
        });
        res.render('conductores', { title: 'Gestión de Conductores', conductores, error: req.query.error });
    } catch (error) {
        res.status(500).send('Error al cargar conductores');
    }
});

app.get('/admin/conductores/nuevo', verificarRol(['admin']), (req, res) => {
    res.render('crear-conductor', { title: 'Crear Conductor' });
});

app.post('/admin/conductores/nuevo', verificarRol(['admin']), async (req, res) => {
    try {
        const { nombre, documento, password } = req.body;
        const existe = await prisma.usuario.findUnique({ where: { documento } });
        if (existe) {
            return res.render('crear-conductor', { title: 'Crear Conductor', error: 'Ese número de documento ya está registrado.' });
        }
        const salt = await bcrypt.genSalt(10);
        const hashPassword = await bcrypt.hash(password, salt);

        await prisma.usuario.create({
            data: { nombre, documento, password: hashPassword, rol: 'conductor' }
        });
        res.redirect('/admin/conductores');
    } catch (error) {
        res.render('crear-conductor', { title: 'Crear Conductor', error: 'Error interno.' });
    }
});

app.get('/admin/conductores/editar/:id', verificarRol(['admin']), async (req, res) => {
    try {
        const conductor = await prisma.usuario.findUnique({ where: { id: parseInt(req.params.id) } });
        if (!conductor) return res.redirect('/admin/conductores');
        res.render('editar-conductor', { title: 'Editar Conductor', conductor });
    } catch (error) {
        res.status(500).send('Error al cargar formulario');
    }
});

app.post('/admin/conductores/editar/:id', verificarRol(['admin']), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { nombre, documento, password } = req.body;
        const dataActualizar = { nombre, documento };
        
        if (password && password.trim() !== '') {
            const salt = await bcrypt.genSalt(10);
            dataActualizar.password = await bcrypt.hash(password, salt);
        }

        await prisma.usuario.update({ where: { id }, data: dataActualizar });
        res.redirect('/admin/conductores');
    } catch (error) {
        res.redirect('/admin/conductores?error=Error+al+actualizar');
    }
});

app.post('/admin/conductores/eliminar/:id', verificarRol(['admin']), async (req, res) => {
    try {
        await prisma.usuario.delete({ where: { id: parseInt(req.params.id) } });
        res.redirect('/admin/conductores');
    } catch (error) {
        res.redirect('/admin/conductores?error=No+puedes+eliminar+a+este+conductor.');
    }
});


/**
 * ============================================================================
 * 4. MÓDULO CONDUCTOR: PANEL E INSPECCIÓN
 * ============================================================================
 */
app.get('/panel-conductor', verificarRol(['conductor', 'admin']), async (req, res) => {
    try {
        const inspeccionActiva = await prisma.inspeccion.findFirst({
            where: { conductor_id: req.usuario.id, estado: 'En curso' },
            orderBy: { fecha_apertura: 'desc' }
        });

        res.render('panel-conductor', { usuario: req.usuario, inspeccionActiva });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error al cargar panel del conductor');
    }
});

app.get('/inspeccion', verificarRol(['conductor', 'admin']), (req, res) => {
    const fechaHoy = new Date().toISOString().split('T')[0];
    res.render('inspeccion', {
        title: 'Inspección Preoperacional',
        appName: 'Transporte SST',
        appVersion: '1.0.0',
        today: fechaHoy,
        formatoCodigo: 'SST-F-01',
        usuarioActual: req.usuario 
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
        
        if (!conductor) {
            return res.status(400).send(`<div style="text-align:center; padding:50px; font-family:Arial;"><h1 style="color:#e74c3c;">Conductor no encontrado</h1></div>`);
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

app.get('/inspeccion/cierre/:id', verificarRol(['conductor', 'admin']), async (req, res) => {
    try {
        const idInspeccion = parseInt(req.params.id);
        const inspeccion = await prisma.inspeccion.findUnique({
            where: { id: idInspeccion },
            include: { vehiculo: true, conductor: true }
        });

        if (!inspeccion) return res.status(404).send('Inspección no encontrada');
        if (inspeccion.estado === 'Finalizada') return res.redirect('/panel-conductor');

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


/**
 * ============================================================================
 * 5. MÓDULO ADMINISTRATIVO: DETALLES, FIRMA MASIVA Y EDICIÓN
 * ============================================================================
 */
app.get('/admin/inspeccion/detalle/:id', verificarRol(['admin']), async (req, res) => {
    try {
        const insp = await prisma.inspeccion.findUnique({
            where: { id: parseInt(req.params.id) },
            include: { conductor: true, vehiculo: true }
        });
        if (!insp) return res.redirect('/admin');

        let resumen = { buenos: 0, malos: 0, na: 0 };
        const items = insp.datos_chequeo?.chequeo_items || {};
        for (const key in items) {
            if (items[key] === 'BUENO') resumen.buenos++;
            if (items[key] === 'MALO') resumen.malos++;
            if (items[key] === 'NA') resumen.na++;
        }
        res.render('detalle-inspeccion', { title: 'Detalle Inspección', insp, resumen });
    } catch (error) {
        res.status(500).send('Error al cargar detalle');
    }
});

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

app.post('/admin/inspeccion/editar/:id', verificarRol(['admin']), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const inspActual = await prisma.inspeccion.findUnique({ where: { id } });
        let datos = inspActual.datos_chequeo || {};
        
        const { 
            empresa, licencia_conductor, categoria_licencia, vigencia_licencia, 
            doc_licencia_transito, fecha_vencimiento_soat, doc_poliza_rcc, 
            doc_poliza_todo_riesgo, doc_tarjeta_operacion, fecha_revision, fecha_cambio_aceite,
            kilometraje_salida, kilometraje_final, observaciones_generales, descripcion_defecto, 
            firma_coordinador_base64, ...chequeo_items 
        } = req.body;
        
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
        if (observaciones_generales !== undefined) datos.observaciones_generales = observaciones_generales;
        if (descripcion_defecto !== undefined) datos.descripcion_defecto = descripcion_defecto;
        if (kilometraje_final) datos.kilometraje_final = parseFloat(kilometraje_final);
        
        datos.chequeo_items = { ...datos.chequeo_items, ...chequeo_items };

        if (firma_coordinador_base64) {
            datos.firma_coordinador_img = firma_coordinador_base64;
            datos.nombre_coordinador = req.usuario.nombre;
            datos.cc_coordinador = req.usuario.documento;
        }

        await prisma.inspeccion.update({
            where: { id },
            data: { kilometraje_salida: parseInt(kilometraje_salida), datos_chequeo: datos }
        });

        res.redirect('/admin');
    } catch (error) {
        res.status(500).send('Error al guardar cambios');
    }
});

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

// FIRMA MASIVA DE INSPECCIONES
app.post('/admin/inspeccion/firma-masiva', verificarRol(['admin']), async (req, res) => {
    try {
        const { ids, firma_base64 } = req.body;
        
        if (!ids || ids.length === 0 || !firma_base64) {
            return res.status(400).json({ success: false, message: 'Faltan datos o no hay inspecciones seleccionadas.' });
        }

        const adminNombre = req.usuario.nombre;
        const adminDoc = req.usuario.documento;

        for (const id of ids) {
            const insp = await prisma.inspeccion.findUnique({ where: { id: parseInt(id) } });
            
            if (insp) {
                let datos = insp.datos_chequeo || {};
                datos.firma_coordinador_img = firma_base64;
                datos.nombre_coordinador = adminNombre;
                datos.cc_coordinador = adminDoc;

                await prisma.inspeccion.update({
                    where: { id: parseInt(id) },
                    data: { datos_chequeo: datos }
                });
            }
        }

        res.json({ success: true, message: `${ids.length} inspecciones firmadas exitosamente.` });
    } catch (error) {
        console.error('Error en firma masiva:', error);
        res.status(500).json({ success: false, message: 'Error interno al firmar.' });
    }
});


/**
 * ============================================================================
 * 6. MÓDULO EXPORTACIÓN PDF (INDIVIDUAL, MAESTRO Y DESCARGA MASIVA)
 * ============================================================================
 */
app.get('/admin/inspeccion/reporte-maestro', verificarRol(['admin']), async (req, res) => {
    let browser = null;
    try {
        const { fechaInicio, fechaFin, placa } = req.query;
        if (!fechaInicio || !fechaFin) return res.status(400).send("Debe seleccionar fechas.");

        const startDate = new Date(fechaInicio + 'T00:00:00');
        const endDate = new Date(fechaFin + 'T23:59:59');

        let whereClause = { eliminado: false, fecha_apertura: { gte: startDate, lte: endDate } };
        if (placa && placa !== 'TODAS') whereClause.vehiculo_placa = placa;

        const inspecciones = await prisma.inspeccion.findMany({
            where: whereClause,
            include: { conductor: true, vehiculo: true },
            orderBy: { fecha_apertura: 'asc' } 
        });

        if(inspecciones.length === 0) return res.send('<h2>No hay registros en estas fechas.</h2>');

        let total = inspecciones.length;
        let aprobadas = 0, conDefectos = 0;
        let tablaEjecutiva = [], inspeccionesConDefectos = [];

        inspecciones.forEach(insp => {
            const datos = insp.datos_chequeo || {};
            const items = datos.chequeo_items || {};
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
                    inspeccionesConDefectos.push({
                        id: insp.id, fecha: new Date(insp.fecha_apertura).toLocaleDateString('es-CO'),
                        placa: insp.vehiculo_placa, conductor: insp.conductor.nombre,
                        descripcion_defecto: datos.descripcion_defecto, fallas: fallasExtraidas
                    });
                } else {
                    aprobadas++; estadoLegible = 'APROBADO';
                }
            }

            tablaEjecutiva.push({
                ticket: insp.id, fecha: new Date(insp.fecha_apertura).toLocaleDateString('es-CO'),
                placa: insp.vehiculo_placa, conductor: insp.conductor.nombre,
                km_salida: insp.kilometraje_salida, km_llegada: datos.kilometraje_final || '-',
                estado: estadoLegible
            });
        });

        let logoSrc = '';
        try {
            const logoPath = path.join(__dirname, 'public/images/logo.png');
            if (fs.existsSync(logoPath)) logoSrc = `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`;
        } catch (e) {}

        const templatePath = path.join(__dirname, 'views/pdf-maestro.ejs');
        const html = await ejs.renderFile(templatePath, {
            fechaInicio, fechaFin, placaSeleccionada: placa, total, aprobadas, conDefectos, 
            tablaEjecutiva, inspeccionesConDefectos, logoSrc, fechaImpresion: new Date().toLocaleString('es-CO')
        });

        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdfBytes = await page.pdf({ format: 'Letter', printBackground: true, margin: { top: '15px', bottom: '15px', right: '15px', left: '15px' }});
        await browser.close();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Resumen_Ejecutivo_${fechaInicio}_al_${fechaFin}.pdf"`);
        res.end(Buffer.from(pdfBytes));

    } catch (error) {
        if (browser) await browser.close(); 
        console.error('Error Reporte Maestro:', error);
        res.status(500).send('Error generando el Reporte Maestro.');
    }
});

// DESCARGA MASIVA (LIBRO DETALLADO)
app.get('/admin/inspeccion/descarga-masiva', verificarRol(['admin']), async (req, res) => {
    let browser = null;
    try {
        const { fechaInicio, fechaFin, placa } = req.query;
        if (!fechaInicio || !fechaFin) return res.status(400).send("Debe seleccionar fechas.");

        const startDate = new Date(fechaInicio + 'T00:00:00');
        const endDate = new Date(fechaFin + 'T23:59:59');

        let whereClause = { eliminado: false, fecha_apertura: { gte: startDate, lte: endDate } };
        if (placa && placa !== 'TODAS') whereClause.vehiculo_placa = placa;

        const inspecciones = await prisma.inspeccion.findMany({
            where: whereClause,
            include: { conductor: true, vehiculo: true },
            orderBy: { fecha_apertura: 'asc' } 
        });

        if(inspecciones.length === 0) return res.send('<h2 style="text-align:center; padding:50px;">No hay registros en este rango de fechas para descargar.</h2>');

        let logoSrc = '';
        try {
            const logoPath = path.join(__dirname, 'public/images/logo.png');
            if (fs.existsSync(logoPath)) logoSrc = `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`;
        } catch (e) {}

        const templatePath = path.join(__dirname, 'views/pdf-template.ejs');
        let htmlCompilado = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>.page-break { page-break-after: always; }</style></head><body>`;

        for (let i = 0; i < inspecciones.length; i++) {
            const insp = inspecciones[i];
            const datos = insp.datos_chequeo || {};
            const items = datos.chequeo_items || {};

            let total_bueno = 0, total_malo = 0, total_na = 0;
            for (const key in items) {
                if (items[key] === 'BUENO') total_bueno++;
                if (items[key] === 'MALO') total_malo++;
                if (items[key] === 'NA') total_na++;
            }

            let estadoReal = 'pendiente';
            if (insp.estado === 'Finalizada') {
                if (total_malo > 0 || (datos.descripcion_defecto && datos.descripcion_defecto.trim() !== '')) estadoReal = 'con_defectos';
                else estadoReal = 'aprobado';
            }

            const inspeccionFormateada = {
                id: insp.id, placa: insp.vehiculo_placa, codigo_inspeccion: insp.id,
                fecha_inspeccion: insp.fecha_apertura,
                hora_inspeccion: new Date(insp.fecha_apertura).toLocaleTimeString('es-ES', {hour: '2-digit', minute:'2-digit'}),
                hora_salida: insp.fecha_cierre ? new Date(insp.fecha_cierre).toLocaleTimeString('es-ES', {hour: '2-digit', minute:'2-digit'}) : '',
                estado: estadoReal, nombre_conductor: insp.conductor.nombre, cc_conductor: insp.conductor.documento,
                tipo_vehiculo: insp.vehiculo.tipo, licencia_conductor: datos.licencia_conductor || items.licencia_conductor,
                categoria_licencia: datos.categoria_licencia || items.categoria_licencia,
                modelo_vehiculo: insp.vehiculo.modelo, empresa: datos.empresa || items.empresa,
                vigencia_licencia: datos.vigencia_licencia || items.vigencia_licencia,
                doc_licencia_transito: datos.doc_licencia_transito || items.doc_licencia_transito || '',
                fecha_vencimiento_soat: datos.fecha_vencimiento_soat || items.fecha_vencimiento_soat || '',
                fecha_revision: datos.fecha_revision || items.fecha_revision || '',
                doc_poliza_rcc: datos.doc_poliza_rcc || items.doc_poliza_rcc || '',
                doc_poliza_todo_riesgo: datos.doc_poliza_todo_riesgo || items.doc_poliza_todo_riesgo || '',
                doc_tarjeta_operacion: datos.doc_tarjeta_operacion || items.doc_tarjeta_operacion || '',
                fecha_cambio_aceite: datos.fecha_cambio_aceite || items.fecha_cambio_aceite || '',
                kilometraje_entrada: insp.kilometraje_salida, kilometraje_salida: datos.kilometraje_final,
                distancia_recorrida: datos.kilometraje_final ? (parseFloat(datos.kilometraje_final) - parseFloat(insp.kilometraje_salida)).toFixed(1) : 0,
                total_bueno, total_malo, total_na, observaciones_generales: datos.observaciones_generales,
                tiene_defectos: (total_malo > 0 || items.defecto_frontal || items.defecto_trasero || items.defecto_lateral_izq || items.defecto_lateral_der || items.defecto_motor || items.defecto_chasis || datos.descripcion_defecto) ? 1 : 0,
                defecto_frontal: !!items.defecto_frontal, defecto_trasero: !!items.defecto_trasero,
                defecto_lateral_izq: !!items.defecto_lateral_izq, defecto_lateral_der: !!items.defecto_lateral_der,
                defecto_motor: !!items.defecto_motor, defecto_chasis: !!items.defecto_chasis,
                descripcion_defecto: datos.descripcion_defecto, firma_conductor: datos.firma_conductor, 
                nombre_firma_conductor: datos.nombre_firma_conductor || insp.conductor.nombre,
                firma_coordinador_img: datos.firma_coordinador_img || null,
                firma_coordinador: datos.nombre_coordinador || req.usuario?.nombre, 
                cc_coordinador: datos.cc_coordinador || req.usuario?.documento
            };

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
                    { label: 'Extintor', valor: items.equipo_extintor, obs: items.obs_equipo_extintor },
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
                    { label: 'Espejos', valor: items.varios_espejos, obs: items.obs_varios_espejos }
                ]
            };

            const htmlUnico = await ejs.renderFile(templatePath, {
                inspeccion: inspeccionFormateada,
                categorias: categorias, 
                logoSrc: logoSrc, 
                fechaImpresion: new Date().toLocaleString('es-ES'),
                adminSolicitante: req.usuario.nombre,
                formatoCodigo: 'SST-F-01'
            });

            htmlCompilado += `<div class="page-break">${htmlUnico}</div>`;
        }
        
        htmlCompilado += `</body></html>`;

        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(htmlCompilado, { waitUntil: 'networkidle0' });
        
        const pdfBytes = await page.pdf({ format: 'Letter', printBackground: true, margin: { top: '10px', right: '10px', bottom: '10px', left: '10px' }});
        await browser.close();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Libro_Detallado_${fechaInicio}_al_${fechaFin}.pdf"`);
        res.end(Buffer.from(pdfBytes));

    } catch (error) {
        if (browser) await browser.close(); 
        console.error('Error generando Descarga Masiva:', error);
        res.status(500).send('Error al generar el Libro Detallado PDF.');
    }
});

// PDF Individual
app.get('/admin/inspeccion/pdf/:id', verificarRol(['admin']), async (req, res) => {
    let browser = null; 
    try {
        const inspeccionId = parseInt(req.params.id);
        const insp = await prisma.inspeccion.findUnique({
            where: { id: inspeccionId },
            include: { conductor: true, vehiculo: true }
        });

        if (!insp || insp.eliminado) return res.status(404).send('La inspección no existe.');

        const datos = insp.datos_chequeo || {};
        const items = datos.chequeo_items || {};

        let total_bueno = 0, total_malo = 0, total_na = 0;
        for (const key in items) {
            if (items[key] === 'BUENO') total_bueno++;
            if (items[key] === 'MALO') total_malo++;
            if (items[key] === 'NA') total_na++;
        }

        let estadoReal = 'pendiente';
        if (insp.estado === 'Finalizada') {
            if (total_malo > 0 || (datos.descripcion_defecto && datos.descripcion_defecto.trim() !== '')) estadoReal = 'con_defectos';
            else estadoReal = 'aprobado';
        }

        const inspeccionFormateada = {
            id: insp.id, placa: insp.vehiculo_placa, codigo_inspeccion: insp.id,
            fecha_inspeccion: insp.fecha_apertura,
            hora_inspeccion: new Date(insp.fecha_apertura).toLocaleTimeString('es-ES', {hour: '2-digit', minute:'2-digit'}),
            hora_salida: insp.fecha_cierre ? new Date(insp.fecha_cierre).toLocaleTimeString('es-ES', {hour: '2-digit', minute:'2-digit'}) : '',
            estado: estadoReal, nombre_conductor: insp.conductor.nombre, cc_conductor: insp.conductor.documento,
            tipo_vehiculo: insp.vehiculo.tipo, licencia_conductor: datos.licencia_conductor || items.licencia_conductor,
            categoria_licencia: datos.categoria_licencia || items.categoria_licencia,
            modelo_vehiculo: insp.vehiculo.modelo, empresa: datos.empresa || items.empresa,
            vigencia_licencia: datos.vigencia_licencia || items.vigencia_licencia,
            doc_licencia_transito: datos.doc_licencia_transito || items.doc_licencia_transito || '',
            fecha_vencimiento_soat: datos.fecha_vencimiento_soat || items.fecha_vencimiento_soat || '',
            fecha_revision: datos.fecha_revision || items.fecha_revision || '',
            doc_poliza_rcc: datos.doc_poliza_rcc || items.doc_poliza_rcc || '',
            doc_poliza_todo_riesgo: datos.doc_poliza_todo_riesgo || items.doc_poliza_todo_riesgo || '',
            doc_tarjeta_operacion: datos.doc_tarjeta_operacion || items.doc_tarjeta_operacion || '',
            fecha_cambio_aceite: datos.fecha_cambio_aceite || items.fecha_cambio_aceite || '',
            kilometraje_entrada: insp.kilometraje_salida, kilometraje_salida: datos.kilometraje_final,
            distancia_recorrida: datos.kilometraje_final ? (parseFloat(datos.kilometraje_final) - parseFloat(insp.kilometraje_salida)).toFixed(1) : 0,
            total_bueno, total_malo, total_na, observaciones_generales: datos.observaciones_generales,
            tiene_defectos: (total_malo > 0 || items.defecto_frontal || items.defecto_trasero || items.defecto_lateral_izq || items.defecto_lateral_der || items.defecto_motor || items.defecto_chasis || datos.descripcion_defecto) ? 1 : 0,
            defecto_frontal: !!items.defecto_frontal, defecto_trasero: !!items.defecto_trasero,
            defecto_lateral_izq: !!items.defecto_lateral_izq, defecto_lateral_der: !!items.defecto_lateral_der,
            defecto_motor: !!items.defecto_motor, defecto_chasis: !!items.defecto_chasis,
            descripcion_defecto: datos.descripcion_defecto, firma_conductor: datos.firma_conductor, 
            nombre_firma_conductor: datos.nombre_firma_conductor || insp.conductor.nombre,
            firma_coordinador_img: datos.firma_coordinador_img || null,
            firma_coordinador: datos.nombre_coordinador || req.usuario.nombre, 
            cc_coordinador: datos.cc_coordinador || req.usuario.documento
        };

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
                { label: 'Extintor', valor: items.equipo_extintor, obs: items.obs_equipo_extintor },
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
                { label: 'Espejos', valor: items.varios_espejos, obs: items.obs_varios_espejos }
            ]
        };

        let logoSrc = '';
        try {
            const logoPath = path.join(__dirname, 'public/images/logo.png');
            if (fs.existsSync(logoPath)) logoSrc = `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`;
        } catch (e) {}

        const templatePath = path.join(__dirname, 'views/pdf-template.ejs');
        const html = await ejs.renderFile(templatePath, {
            inspeccion: inspeccionFormateada,
            categorias: categorias, 
            logoSrc: logoSrc, 
            fechaImpresion: new Date().toLocaleString('es-ES'),
            adminSolicitante: req.usuario.nombre,
            formatoCodigo: 'SST-F-01'
        });

        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        
        const pdfBytes = await page.pdf({ format: 'Letter', printBackground: true, margin: { top: '10px', right: '10px', bottom: '10px', left: '10px' }});
        await browser.close();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Inspeccion_${inspeccionFormateada.placa}_${inspeccionId}.pdf"`);
        res.end(Buffer.from(pdfBytes));

    } catch (error) {
        if (browser) await browser.close(); 
        console.error('Error generando PDF:', error);
        res.status(500).send('Error al generar PDF.');
    }
});

/**
 * ============================================================================
 * 7. MÓDULO AUDITORÍA DE PATIO (CARRO 360, EQUIPOS, PDF, CORREO)
 * ============================================================================
 */
app.get('/admin/patio/nuevo', verificarRol(['admin']), async (req, res) => {
    try {
        const vehiculos = await prisma.vehiculo.findMany({ orderBy: { placa: 'asc' } });
        res.render('patio-nuevo', { 
            title: 'Control de Patio 360', 
            vehiculos,
            usuario: req.usuario || req.user || { nombre: 'Admin' }
        });
    } catch (error) {
        res.status(500).send('Error al cargar módulo de patio.');
    }
});

app.post('/admin/patio/guardar', verificarRol(['admin']), async (req, res) => {
    let browser = null;
    try {
        const { placa, tipo_movimiento, evidenciasJSON, firmaBase64 } = req.body;
        const adminId = req.usuario ? req.usuario.id : (req.user ? req.user.id : 1); 
        const evidenciasObj = JSON.parse(evidenciasJSON);

        const nuevoRegistro = await prisma.inspeccionPatio.create({
            data: {
                vehiculo_placa: placa || 'SIN-PLACA',
                admin_id: adminId,
                tipo_movimiento: tipo_movimiento,
                evidencias: evidenciasObj, 
                firma_admin: firmaBase64,
                correo_enviado: false
            },
            include: { admin: true } 
        });

        const templatePath = path.join(__dirname, 'views/pdf-patio.ejs');
        const html = await ejs.renderFile(templatePath, {
            registro: nuevoRegistro,
            evidencias: evidenciasObj,
            datos: evidenciasObj, 
            inspeccion: nuevoRegistro,
            fechaImpresion: new Date().toLocaleString('es-CO')
        });

        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        
        const pdfBytes = await page.pdf({ format: 'Letter', printBackground: true, margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' } });
        await browser.close();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Auditoria_Patio_${placa}_${tipo_movimiento}.pdf"`);
        res.end(Buffer.from(pdfBytes));
    } catch (error) {
        if (browser) await browser.close();
        console.error('Error al procesar auditoría:', error);
        res.status(500).send('Error al generar el registro de patio: ' + error.message);
    }
});

app.get('/admin/patio/historial', verificarRol(['admin']), async (req, res) => {
    try {
        const inspecciones = await prisma.inspeccionPatio.findMany({
            orderBy: { fecha_registro: 'desc' },
            include: { admin: true } 
        });
        res.render('historial-patio', { title: 'Historial de Patio', inspecciones });
    } catch (error) {
        res.status(500).send('Error al cargar historial.');
    }
});

app.get('/admin/patio/pdf/:id', verificarRol(['admin']), async (req, res) => {
    try {
        const inspeccion = await prisma.inspeccionPatio.findUnique({
            where: { id: parseInt(req.params.id) },
            include: { admin: true }
        });
        
        if (!inspeccion) return res.status(404).send('Inspección no encontrada');
        
        const datos = typeof inspeccion.evidencias === 'string' ? JSON.parse(inspeccion.evidencias) : inspeccion.evidencias;

        res.render('pdf-patio', { title: `Inspección ${inspeccion.vehiculo_placa}`, inspeccion: inspeccion, registro: inspeccion, datos: datos, evidencias: datos, fechaImpresion: new Date().toLocaleString('es-CO') });
    } catch (error) {
        res.status(500).send('Error generando el documento.');
    }
});

/**
 * ============================================================================
 * 8. ENVÍO DE CORREO DIRECTO (CONFIGURADO CON TUS CREDENCIALES)
 * ============================================================================
 */
app.post('/admin/patio/enviar-correo/:id', verificarRol(['admin']), async (req, res) => {
    let browser = null;
    try {
        const id = parseInt(req.params.id);
        const correoCliente = req.body.correo;
        
        const inspeccion = await prisma.inspeccionPatio.findUnique({
            where: { id: id },
            include: { admin: true }
        });

        if (!inspeccion) return res.status(404).send('Inspección no encontrada');

        const datos = typeof inspeccion.evidencias === 'string' 
            ? JSON.parse(inspeccion.evidencias) 
            : inspeccion.evidencias;

        const templatePath = path.join(__dirname, 'views/pdf-patio.ejs');
        const html = await ejs.renderFile(templatePath, {
            registro: inspeccion,
            evidencias: datos,
            datos: datos, 
            inspeccion: inspeccion,
            fechaImpresion: new Date().toLocaleString('es-CO')
        });

        browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' }); 
        const pdfBuffer = await page.pdf({ format: 'Letter', printBackground: true, margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' } });
        await browser.close();

        const transporter = nodemailer.createTransport({
            service: 'gmail', 
            auth: {
                user: 'operaciones.omegagroupsas@gmail.com', 
                pass: 'Rosalbamoreno27.'      
            }
        });

        const protocolo = req.protocol; 
        const host = req.get('host'); 
        const urlPdf = `${protocolo}://${host}/admin/patio/pdf/${id}`;

        const mailOptions = {
            from: '"OmegaGroup SST" <operaciones.omegagroupsas@gmail.com>',
            to: correoCliente,
            subject: `Reporte de Auditoría de Patio (Ticket #${id}) - OmegaGroup`,
            html: `
                <div style="font-family: Arial, sans-serif; color: #334155; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                    <div style="background-color: #0f172a; padding: 20px; text-align: center; border-bottom: 4px solid #e50914;">
                        <h2 style="color: white; margin: 0; letter-spacing: 1px;">OMEGAGROUP | Operaciones</h2>
                    </div>
                    <div style="padding: 30px;">
                        <h3 style="color: #0f172a; margin-top: 0;">Reporte Oficial de Auditoría</h3>
                        <p>Cordial saludo,</p>
                        <p>Se ha generado un nuevo registro de inspección de patio en nuestra plataforma de seguridad.</p>
                        <p>Puede visualizar, imprimir y descargar el documento PDF ingresando al siguiente enlace seguro:</p>
                        
                        <div style="text-align: center; margin: 35px 0;">
                            <a href="${urlPdf}" style="background-color: #e50914; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block; letter-spacing: 0.5px;">📄 Abrir Reporte PDF</a>
                        </div>
                        
                        <p style="font-size: 13px; color: #64748b;">Si el botón no funciona, copie y pegue esta dirección en su navegador web:</p>
                        <p style="font-size: 13px; word-break: break-all; background: #f8fafc; padding: 10px; border-radius: 4px; border: 1px solid #e2e8f0;">
                            <a href="${urlPdf}" style="color: #3b82f6; text-decoration: none;">${urlPdf}</a>
                        </p>
                        
                        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 25px 0;">
                        <p style="font-size: 11px; color: #94a3b8; text-align: center; margin: 0;">
                            Se ha adjuntado una copia física a este correo como respaldo. <br>
                            &copy; ${new Date().getFullYear()} OmegaGroup SAS.
                        </p>
                    </div>
                </div>
            `,
            attachments: [{
                filename: `Inspeccion_Patio_${id}.pdf`,
                content: pdfBuffer,
                contentType: 'application/pdf'
            }]
        };

        await transporter.sendMail(mailOptions);
        res.send(`<script>alert('¡Reporte enviado con éxito al correo: ${correoCliente}!'); window.location.href='/admin/patio/historial';</script>`);
    } catch (error) {
        if (browser) await browser.close();
        console.error('Error enviando correo:', error);
        res.status(500).send('Hubo un error al enviar el correo. Verifique la consola del servidor para más detalles.');
    }
});

/**
 * ============================================================================
 * 9. MÓDULO SATELITAL GPS: MOTOR HÍBRIDO (TRACCAR + PLASPY POR PLACA) Y MANUAL
 * ============================================================================
 */

// 9.A SERVIDORES TRACCAR
const TRACCAR_SERVERS = [
    {
        url: 'https://api.globalmonitorgps.com',
        token: 'RzBFAiEAtDXlCJ0WnZ_XAG5xqrA-8SeIlkWsmTFdsaTUk_-DCC8CIGxpnyl_suINh63nvf4xWosnaqanlFCfSfyujnp17SxjeyJpIjo5MTM3MzU3NTY1NzM5MDM1ODAzLCJ1IjoxLCJlIjoiMjAzMC0xMi0zMVQwNTowMDowMC4wMDArMDA6MDAifQ'
    },
    {
        url: 'https://api.labtesting.online',
        token: 'RzBFAiAOdolEs_8-rZav4COv-6DlDWRMRq96aEk4iUyAKGq-YgIhAIEWQPdMm8LyWRalOReQ-jFY_o1VY6CfTjyT7oe0j81JeyJpIjoxMzYyMjE2MzEyOTQ0ODU3MTYxLCJ1IjoxLCJlIjoiMjAzMC0xMi0zMVQwNTowMDowMC4wMDArMDA6MDAifQ'
    }
];

// 9.B CUENTAS Y APIS DE PLASPY (GENERAL + API ENLAZADA A UNA SOLA PLACA)
// Aquí puedes agregar todas las APIs independientes por placa que necesites:
const APIS_PLASPY = [
    {
        // 1. Cuenta General de Plaspy
        user: 'oscarf07@hotmail.com',
        apiKey: '9aspvD6qw+S5Ba3o12S0BEkI04R8HlZBgcW5qPMDcVQ=',
        placaExclusiva: null // null = carga todos los vehículos de esta cuenta
    },
    {
        // 2. API exclusiva enlazada a una sola placa
        user: 'oscarf07@hotmail.com', // <-- Si este vehículo usa otro usuario/correo en Plaspy, cámbialo aquí
        apiKey: '9GOpyysGrwWq8/qatFJ02bQoMRC6UyVv4/di0mzKZKs=',
        placaExclusiva: 'PON_AQUI_LA_PLACA' // <-- Escribe aquí la placa exacta (ej: 'BNT03H') para enlazarla directo
    }
];

function limpiarPlaca(str) {
    return (str || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Garantiza formato exacto HH:mm (24h) en hora de Colombia (UTC-5) para <input type="time">
function formatearHora24Colombia(fechaInput) {
    if (!fechaInput) return '';
    if (typeof fechaInput === 'string' && /^\d{1,2}:\d{2}/.test(fechaInput.trim())) {
        const partes = fechaInput.trim().split(':');
        return `${partes[0].padStart(2, '0')}:${partes[1].slice(0, 2)}`;
    }
    const d = new Date(fechaInput);
    if (isNaN(d.getTime())) return '';
    const colTime = new Date(d.getTime() - (5 * 3600000));
    const hh = String(colTime.getUTCHours()).padStart(2, '0');
    const mm = String(colTime.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

function formatearHora12Colombia(fechaInput) {
    const h24 = formatearHora24Colombia(fechaInput);
    if (!h24) return '--:--';
    let [hh, mm] = h24.split(':').map(Number);
    const ampm = hh >= 12 ? 'p. m.' : 'a. m.';
    hh = hh % 12 || 12;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} ${ampm}`;
}

function obtenerFechaColombiaYYYYMMDD(fechaInput) {
    const d = new Date(fechaInput);
    const colTime = new Date(d.getTime() - (5 * 3600000));
    return colTime.toISOString().split('T')[0];
}

async function obtenerDispositivosTraccar() {
    for (const srv of TRACCAR_SERVERS) {
        try {
            const res = await fetchConTimeout(`${srv.url}/api/devices`, {
                headers: { 'Authorization': `Bearer ${srv.token}`, 'Accept': 'application/json' }
            }, 6000);
            if (res.ok) {
                const devices = await res.json();
                if (Array.isArray(devices) && devices.length > 0) {
                    return { devices, serverUrl: srv.url, token: srv.token };
                }
            }
        } catch (e) {
            console.log(`Aviso conexión ${srv.url}:`, e.message);
        }
    }
    return { devices: [], serverUrl: TRACCAR_SERVERS[0].url, token: TRACCAR_SERVERS[0].token };
}

// Conecta todas las APIs configuradas en APIS_PLASPY y enlaza la placa exclusiva automáticamente
async function obtenerDispositivosPlaspy() {
    let dispositivos = [];
    let errores = [];

    await Promise.all(APIS_PLASPY.map(async (cuenta) => {
        if (!cuenta.user || !cuenta.apiKey) return;
        try {
            const authRes = await fetchConTimeout('https://api.plaspy.com/api/Auth/Token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ userName: cuenta.user.trim(), apiKey: cuenta.apiKey.trim() })
            }, 6000);

            const authData = await authRes.json();
            const token = authData.token || authData.Token || authData.access_token;

            if (!token) {
                errores.push(`Plaspy (${cuenta.user}): ${authData.error || authData.message || 'Sin token'}`);
                return;
            }

            const devRes = await fetchConTimeout('https://api.plaspy.com/api/devices', {
                headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
            }, 6000);

            if (devRes.ok) {
                const devData = await devRes.json();
                const lista = Array.isArray(devData) ? devData : (devData.data || devData.devices || devData.Devices || []);
                const placaForzada = (cuenta.placaExclusiva && cuenta.placaExclusiva !== 'PON_AQUI_LA_PLACA')
                    ? cuenta.placaExclusiva.toUpperCase().trim()
                    : null;

                lista.forEach(d => {
                    const realId = d.id || d.Id;
                    const realName = (d.name || d.Name || '').toUpperCase().trim();

                    // Si esta API es para una sola placa, filtramos o forzamos el enlace con esa placa
                    if (placaForzada) {
                        if (lista.length === 1 || limpiarPlaca(realName).includes(limpiarPlaca(placaForzada))) {
                            dispositivos.push({
                                id: `PLASPY:${realId}`,
                                rawId: realId,
                                name: placaForzada,
                                token: token,
                                plataforma: 'PLASPY'
                            });
                        }
                    } else {
                        dispositivos.push({
                            id: `PLASPY:${realId}`,
                            rawId: realId,
                            name: realName,
                            token: token,
                            plataforma: 'PLASPY'
                        });
                    }
                });
            }
        } catch (err) {
            errores.push(`Plaspy (${cuenta.user}): ${err.message}`);
        }
    }));

    return { devices: dispositivos, errores };
}

// Extrae un día desde Plaspy y devuelve la misma estructura que Traccar
async function extraerDiaCompletoPlaspy(token, rawDeviceId, fechaYYYYMMDD) {
    try {
        const locRes = await fetchConTimeout(`https://api.plaspy.com/api/devices/${encodeURIComponent(rawDeviceId)}/locations`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                from: `${fechaYYYYMMDD}T00:00:00`,
                to: `${fechaYYYYMMDD}T23:59:59`
            })
        }, 8000);

        if (!locRes.ok) return null;
        const locData = await locRes.json();
        const puntos = Array.isArray(locData) ? locData : (locData.data || locData.locations || []);
        if (puntos.length === 0) return null;

        const enMovimiento = puntos.filter(p => (p.speed || p.Speed || 0) > 0);
        if (enMovimiento.length === 0) return null;

        const extraerDateColombia = (dtRaw) => {
            if (!dtRaw) return null;
            const match = dtRaw.toString().match(/(\d{2}:\d{2})/);
            if (match) return new Date(`${fechaYYYYMMDD}T${match[1]}:00-05:00`);
            return new Date(dtRaw);
        };

        const pInicio = extraerDateColombia(enMovimiento[0].dateTime || enMovimiento[0].DateTime || enMovimiento[0].date);
        const pFin = extraerDateColombia(enMovimiento[enMovimiento.length - 1].dateTime || enMovimiento[enMovimiento.length - 1].DateTime || enMovimiento[enMovimiento.length - 1].date);

        if (!pInicio) return null;

        // Distancia por odómetro (milleage) o por suma de distance
        const odoIni = puntos[0].milleage || puntos[0].mileage || 0;
        const odoFin = puntos[puntos.length - 1].milleage || puntos[puntos.length - 1].mileage || 0;
        let distanciaMetros = 0;
        if (odoFin > odoIni) {
            distanciaMetros = (odoFin - odoIni) * 1000;
        } else {
            const sumaDist = puntos.reduce((acc, p) => acc + (p.distance || p.Distance || 0), 0);
            distanciaMetros = sumaDist > 1000 ? sumaDist : sumaDist * 1000;
        }

        const velocidades = enMovimiento.map(p => p.speed || p.Speed || 0);
        const velMaxima = Math.max(...velocidades);
        const velPromedio = velocidades.reduce((a, b) => a + b, 0) / velocidades.length;
        const duracionMs = pFin > pInicio ? (pFin.getTime() - pInicio.getTime()) : 0;

        return {
            inicio: pInicio,
            fin: pFin || pInicio,
            distancia: distanciaMetros,
            duracion: duracionMs,
            totalViajes: enMovimiento.length,
            velMaxima,
            velPromedio
        };
    } catch (e) {
        return null;
    }
}

// Función Híbrida: Extrae un día de Traccar combinando /api/reports/trips y /api/positions (BD cruda)
async function extraerDiaCompletoTraccar(serverUrl, token, deviceId, fechaYYYYMMDD) {
    const fromStr = encodeURIComponent(new Date(`${fechaYYYYMMDD}T00:00:00-05:00`).toISOString());
    const toStr = encodeURIComponent(new Date(`${fechaYYYYMMDD}T23:59:59-05:00`).toISOString());
    const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };

    let inicioDate = null;
    let finDate = null;
    let distanciaMetros = 0;
    let duracionMs = 0;
    let totalEventos = 0;

    // 1. Intentar primero con /api/reports/trips
    try {
        const tripsRes = await fetchConTimeout(
            `${serverUrl}/api/reports/trips?deviceId=${deviceId}&from=${fromStr}&to=${toStr}`,
            { headers },
            7000
        );
        if (tripsRes.ok) {
            const trips = await tripsRes.json();
            if (Array.isArray(trips) && trips.length > 0) {
                inicioDate = new Date(trips[0].startTime);
                finDate = new Date(trips[trips.length - 1].endTime);
                distanciaMetros = trips.reduce((acc, t) => acc + (t.distance || 0), 0);
                duracionMs = trips.reduce((acc, t) => acc + (t.duration || 0), 0);
                totalEventos = trips.length;
            }
        }
    } catch (e) {}

    // 2. Si no hubo trips, o si el trip fue de 0 km / misma hora de inicio y fin, consultar BD cruda (/api/positions)
    const mismoMinuto = inicioDate && finDate && formatearHora24Colombia(inicioDate) === formatearHora24Colombia(finDate);
    if (!inicioDate || mismoMinuto || distanciaMetros < 50) {
        try {
            const posRes = await fetchConTimeout(
                `${serverUrl}/api/positions?deviceId=${deviceId}&from=${fromStr}&to=${toStr}`,
                { headers },
                8000
            );
            if (posRes.ok) {
                const positions = await posRes.json();
                if (Array.isArray(positions) && positions.length > 0) {
                    const activos = positions.filter(p =>
                        (p.speed && p.speed > 0) ||
                        p.attributes?.ignition === true ||
                        p.attributes?.motion === true
                    );
                    const listaUsar = activos.length > 0 ? activos : positions;

                    const pInicio = new Date(listaUsar[0].fixTime || listaUsar[0].deviceTime || listaUsar[0].serverTime);
                    const pFin = new Date(listaUsar[listaUsar.length - 1].fixTime || listaUsar[listaUsar.length - 1].deviceTime || listaUsar[listaUsar.length - 1].serverTime);

                    if (!inicioDate || pInicio < inicioDate) inicioDate = pInicio;
                    if (!finDate || pFin > finDate) finDate = pFin;

                    const distOdo = (positions[positions.length - 1].attributes?.totalDistance || 0) - (positions[0].attributes?.totalDistance || 0);
                    if (distOdo > distanciaMetros) distanciaMetros = distOdo;

                    if (finDate > inicioDate) {
                        duracionMs = Math.max(duracionMs, finDate.getTime() - inicioDate.getTime());
                    }
                    totalEventos = Math.max(totalEventos, listaUsar.length);
                }
            }
        } catch (e) {}
    }

    if (!inicioDate) return null;

    return {
        inicio: inicioDate,
        fin: finDate || inicioDate,
        distancia: distanciaMetros,
        duracion: duracionMs,
        totalViajes: totalEventos
    };
}

// 9.1 DASHBOARD PRINCIPAL DE AUDITORÍA GPS
app.get('/admin/auditoria-horas', verificarRol(['admin']), async (req, res) => {
    try {
        const mesActual = req.query.mes || new Date().toISOString().slice(0, 7); 
        const placaSeleccionada = req.query.placa || 'TODOS';
        
        const vehiculosDB = await prisma.vehiculo.findMany({ orderBy: { placa: 'asc' } });
        const conductoresDB = await prisma.usuario.findMany({ where: { rol: 'conductor' }, orderBy: { nombre: 'asc' } });

        // Obtener dispositivos tanto de Traccar como de las APIs de Plaspy en paralelo
        const [traccarConn, plaspyConn] = await Promise.all([
            obtenerDispositivosTraccar(),
            obtenerDispositivosPlaspy()
        ]);

        const traccarDevices = traccarConn.devices;
        const serverUrl = traccarConn.serverUrl;
        const token = traccarConn.token;
        const plaspyDevices = plaspyConn.devices;

        // Lista combinada para que el selector de las filas reconozca tanto Traccar como Plaspy sin cambiar el .ejs
        const dispositivosCombinados = [
            ...traccarDevices,
            ...plaspyDevices
        ];

        // Unificar placas de BD + Traccar + Plaspy
        const mapaPlacas = new Map();
        vehiculosDB.forEach(v => mapaPlacas.set(limpiarPlaca(v.placa), v.placa.toUpperCase()));
        dispositivosCombinados.forEach(d => {
            const limpia = limpiarPlaca(d.name);
            if (limpia && !mapaPlacas.has(limpia)) {
                mapaPlacas.set(limpia, d.name.toUpperCase());
            }
        });
        const listaPlacasUnificada = Array.from(mapaPlacas.values()).sort().map(p => ({ placa: p }));

        // Si entra por primera vez desde el menú sin parámetros, carga la interfaz rápido
        if (!req.query.placa && !req.query.mes) {
            return res.render('auditoria-horas', {
                title: 'Dashboard Auditoría GPS',
                registros: [],
                mesActual,
                placaSeleccionada,
                vehiculos: listaPlacasUnificada,
                conductores: conductoresDB,
                traccarDevices: dispositivosCombinados,
                usuario: req.usuario
            });
        }

        // Fechas exactas en Zona Horaria Colombia (-05:00)
        const [yearStr, monthStr] = mesActual.split('-');
        const year = parseInt(yearStr);
        const month = parseInt(monthStr) - 1;
        const ultimoDiaNum = new Date(year, month + 1, 0).getDate();

        const startDateISO = new Date(`${mesActual}-01T00:00:00-05:00`);
        const endDateISO = new Date(`${mesActual}-${String(ultimoDiaNum).padStart(2, '0')}T23:59:59-05:00`);
        const ahora = new Date();
        const toDateConsulta = endDateISO > ahora ? ahora : endDateISO;

        // 1. Obtener inspecciones de la Base de Datos
        const inspecciones = await prisma.inspeccion.findMany({
            where: { eliminado: false, fecha_apertura: { gte: startDateISO, lte: endDateISO } },
            include: { conductor: true },
            orderBy: { fecha_apertura: 'desc' }
        });

        let inspData = {};
        inspecciones.forEach(insp => {
            const clavePlaca = limpiarPlaca(insp.vehiculo_placa);
            if (placaSeleccionada !== 'TODOS' && clavePlaca !== limpiarPlaca(placaSeleccionada)) return;

            const dateStr = obtenerFechaColombiaYYYYMMDD(insp.fecha_apertura);
            if (!inspData[clavePlaca]) inspData[clavePlaca] = { nombreOriginal: insp.vehiculo_placa.toUpperCase(), dias: {} };
            const existente = inspData[clavePlaca].dias[dateStr];
            if (!existente || (!existente.datos_chequeo?.inicio_gps && insp.datos_chequeo?.inicio_gps) || new Date(insp.fecha_apertura) < new Date(existente.fecha_apertura)) {
                inspData[clavePlaca].dias[dateStr] = insp;
            }
        });

        // 2. Consultar viajes en Traccar (dividido en bloques semanales para no truncar datos)
        let traccarDays = {};
        if (traccarDevices.length > 0) {
            let devicesToQuery = [];
            if (placaSeleccionada !== 'TODOS') {
                const placaLimpia = limpiarPlaca(placaSeleccionada);
                devicesToQuery = traccarDevices.filter(d =>
                    limpiarPlaca(d.name) === placaLimpia ||
                    limpiarPlaca(d.uniqueId) === placaLimpia ||
                    limpiarPlaca(d.name).includes(placaLimpia)
                );
            } else {
                devicesToQuery = traccarDevices.slice(0, 8);
            }

            if (devicesToQuery.length > 0) {
                const deviceIdsParam = devicesToQuery.map(d => `deviceId=${d.id}`).join('&');

                const rangosSemanales = [
                    { d1: 1, d2: 8 },
                    { d1: 9, d2: 16 },
                    { d1: 17, d2: 24 },
                    { d1: 25, d2: ultimoDiaNum }
                ];

                await Promise.all(rangosSemanales.map(async (rango) => {
                    const fInicio = new Date(`${mesActual}-${String(rango.d1).padStart(2, '0')}T00:00:00-05:00`);
                    const fFin = new Date(`${mesActual}-${String(rango.d2).padStart(2, '0')}T23:59:59-05:00`);
                    if (fInicio > toDateConsulta) return;
                    const fFinReal = fFin > toDateConsulta ? toDateConsulta : fFin;

                    const url = `${serverUrl}/api/reports/trips?${deviceIdsParam}&from=${encodeURIComponent(fInicio.toISOString())}&to=${encodeURIComponent(fFinReal.toISOString())}`;
                    try {
                        const resTrips = await fetchConTimeout(url, {
                            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
                        }, 8000);
                        if (resTrips.ok) {
                            const trips = await resTrips.json();
                            trips.forEach(trip => {
                                const dev = traccarDevices.find(d => d.id === trip.deviceId);
                                const placaNombre = dev ? dev.name.toUpperCase() : placaSeleccionada.toUpperCase();
                                const clavePlaca = limpiarPlaca(placaNombre);

                                const tStart = new Date(trip.startTime);
                                const tEnd = new Date(trip.endTime);
                                const dateStr = obtenerFechaColombiaYYYYMMDD(tStart);

                                if (!traccarDays[clavePlaca]) traccarDays[clavePlaca] = { nombreOriginal: placaNombre, dias: {} };

                                if (!traccarDays[clavePlaca].dias[dateStr]) {
                                    traccarDays[clavePlaca].dias[dateStr] = {
                                        inicio: tStart,
                                        fin: tEnd,
                                        distancia: trip.distance || 0,
                                        duracion: trip.duration || 0,
                                        deviceId: dev ? dev.id : ''
                                    };
                                } else {
                                    if (tStart < traccarDays[clavePlaca].dias[dateStr].inicio) traccarDays[clavePlaca].dias[dateStr].inicio = tStart;
                                    if (tEnd > traccarDays[clavePlaca].dias[dateStr].fin) traccarDays[clavePlaca].dias[dateStr].fin = tEnd;
                                    traccarDays[clavePlaca].dias[dateStr].distancia += (trip.distance || 0);
                                    traccarDays[clavePlaca].dias[dateStr].duracion += (trip.duration || 0);
                                }
                            });
                        }
                    } catch (e) {}
                }));

                // 3. RESCATE DESDE BD CRUDA (/api/positions) DE TRACCAR
                if (placaSeleccionada !== 'TODOS' && devicesToQuery[0]) {
                    const devPrincipal = devicesToQuery[0];
                    const clavePlaca = limpiarPlaca(placaSeleccionada);
                    const diasConInspeccion = Object.keys(inspData[clavePlaca]?.dias || {});

                    const diasFaltantes = diasConInspeccion.filter(dateStr => {
                        const regTr = traccarDays[clavePlaca]?.dias?.[dateStr];
                        if (!regTr) return true;
                        return formatearHora24Colombia(regTr.inicio) === formatearHora24Colombia(regTr.fin);
                    });

                    await Promise.all(diasFaltantes.map(async (dateStr) => {
                        const datosRescate = await extraerDiaCompletoTraccar(serverUrl, token, devPrincipal.id, dateStr);
                        if (datosRescate) {
                            if (!traccarDays[clavePlaca]) traccarDays[clavePlaca] = { nombreOriginal: devPrincipal.name.toUpperCase(), dias: {} };
                            traccarDays[clavePlaca].dias[dateStr] = {
                                ...datosRescate,
                                deviceId: devPrincipal.id
                            };
                        }
                    }));
                }
            }
        }

        // 3.B CONSULTA AUTOMÁTICA PARA PLACAS ENLAZADAS A PLASPY (INCLUYENDO LA NUEVA API POR PLACA)
        if (placaSeleccionada !== 'TODOS' && plaspyDevices.length > 0) {
            const clavePlaca = limpiarPlaca(placaSeleccionada);
            const devPlaspy = plaspyDevices.find(d =>
                limpiarPlaca(d.name) === clavePlaca ||
                limpiarPlaca(d.name).includes(clavePlaca)
            );

            if (devPlaspy) {
                const diasConInspeccion = Object.keys(inspData[clavePlaca]?.dias || {});
                await Promise.all(diasConInspeccion.map(async (dateStr) => {
                    if (traccarDays[clavePlaca]?.dias?.[dateStr]) return;
                    const datosPlaspy = await extraerDiaCompletoPlaspy(devPlaspy.token, devPlaspy.rawId, dateStr);
                    if (datosPlaspy) {
                        if (!traccarDays[clavePlaca]) traccarDays[clavePlaca] = { nombreOriginal: devPlaspy.name.toUpperCase(), dias: {} };
                        traccarDays[clavePlaca].dias[dateStr] = {
                            ...datosPlaspy,
                            deviceId: devPlaspy.id
                        };
                    }
                }));
            }
        }

        // 4. Cruzar datos (Base de Datos + Traccar + Plaspy + Registros Manuales)
        let auditoria = [];
        const clavesPlacas = new Set([...Object.keys(traccarDays), ...Object.keys(inspData)]);

        clavesPlacas.forEach(clavePlaca => {
            const infoTraccar = traccarDays[clavePlaca]?.dias || {};
            const infoApp = inspData[clavePlaca]?.dias || {};
            const placaMostrar = inspData[clavePlaca]?.nombreOriginal || traccarDays[clavePlaca]?.nombreOriginal || clavePlaca;

            const todosLosDias = new Set([...Object.keys(infoTraccar), ...Object.keys(infoApp)]);
            const diasOrdenados = Array.from(todosLosDias).sort((a, b) => b.localeCompare(a));

            diasOrdenados.forEach(dateStr => {
                const trData = infoTraccar[dateStr];
                const inData = infoApp[dateStr];
                const datosJSON = inData?.datos_chequeo || {};
                const sinAppManual = datosJSON.sin_app === true;

                // Horas App en formato militar exacto HH:mm
                let inicioApp24 = '';
                let finApp24 = '';
                if (inData && !sinAppManual) {
                    inicioApp24 = datosJSON.inicio_app_manual
                        ? formatearHora24Colombia(datosJSON.inicio_app_manual)
                        : formatearHora24Colombia(inData.fecha_apertura);

                    if (datosJSON.fin_app_manual) {
                        finApp24 = formatearHora24Colombia(datosJSON.fin_app_manual);
                    } else if (inData.fecha_cierre) {
                        finApp24 = formatearHora24Colombia(inData.fecha_cierre);
                    }
                }

                // Horas GPS en formato militar exacto HH:mm
                let inicioGPS24 = datosJSON.inicio_gps ? formatearHora24Colombia(datosJSON.inicio_gps) : '';
                let finGPS24 = datosJSON.fin_gps ? formatearHora24Colombia(datosJSON.fin_gps) : '';

                if (!inicioGPS24 && trData) {
                    inicioGPS24 = formatearHora24Colombia(trData.inicio);
                }
                if (!finGPS24 && trData) {
                    finGPS24 = formatearHora24Colombia(trData.fin);
                }

                // Distancia y Horas de Motor
                let distKm = (datosJSON.distancia_gps !== undefined && datosJSON.distancia_gps !== '')
                    ? parseFloat(datosJSON.distancia_gps).toFixed(2)
                    : (trData ? (trData.distancia / 1000).toFixed(2) : '0.00');

                let horasMotorStr = datosJSON.horas_motor_gps || '0h 0m';
                if (inicioGPS24 && finGPS24) {
                    const [h1, m1] = inicioGPS24.split(':').map(Number);
                    const [h2, m2] = finGPS24.split(':').map(Number);
                    const diffM = (h2 * 60 + m2) - (h1 * 60 + m1);
                    if (diffM > 0) {
                        horasMotorStr = `${Math.floor(diffM / 60)}h ${diffM % 60}m`;
                    } else if (trData && trData.duracion) {
                        const mins = Math.floor(trData.duracion / 60000);
                        horasMotorStr = `${Math.floor(mins / 60)}h ${mins % 60}m`;
                    }
                }

                // Clasificación de Estados (Semáforo)
                let diffMinutos = '-';
                let estadoNumero = 5;
                let estadoTexto = 'INSPECCIÓN SIN GPS';

                if (inicioGPS24 && inicioApp24) {
                    const [hApp, mApp] = inicioApp24.split(':').map(Number);
                    const [hGps, mGps] = inicioGPS24.split(':').map(Number);
                    let diff = Math.abs((hGps * 60 + mGps) - (hApp * 60 + mApp));
                    diffMinutos = Math.round(diff);

                    if (diff > 30) {
                        estadoNumero = 3;
                        estadoTexto = 'CRÍTICO';
                    } else if (diff >= 20) {
                        estadoNumero = 2;
                        estadoTexto = 'REVISAR';
                    } else {
                        estadoNumero = 1;
                        estadoTexto = 'ÓPTIMO';
                    }
                } else if (inicioGPS24 && !inicioApp24) {
                    estadoNumero = 4;
                    estadoTexto = 'MOVIMIENTO SIN APP';
                    diffMinutos = 'Fuga Detectada';
                } else if (!inicioGPS24 && inicioApp24) {
                    estadoNumero = 5;
                    estadoTexto = 'INSPECCIÓN SIN GPS';
                    diffMinutos = 'Sin GPS';
                } else {
                    estadoNumero = 5;
                    estadoTexto = 'REGISTRO MANUAL';
                    diffMinutos = 'Pendiente Horas';
                }

                auditoria.push({
                    id: inData ? inData.id : 'nuevo',
                    fecha: dateStr,
                    placa: placaMostrar,
                    conductor: inData ? (datosJSON.conductor_manual || inData.conductor.nombre) : 'N/A (Sin App)',
                    inicioApp: inicioApp24,
                    finApp: finApp24,
                    inicioGPS: inicioGPS24,
                    finGPS: finGPS24,
                    distancia: distKm,
                    horasMotor: horasMotorStr,
                    diffMinutos,
                    estadoNumero,
                    estadoTexto,
                    traccarDeviceId: datosJSON.traccar_device_id || (trData ? trData.deviceId : '')
                });
            });
        });

        auditoria.sort((a, b) => b.fecha.localeCompare(a.fecha));

        res.render('auditoria-horas', {
            title: 'Dashboard Auditoría GPS',
            registros: auditoria,
            mesActual,
            placaSeleccionada,
            vehiculos: listaPlacasUnificada,
            conductores: conductoresDB,
            traccarDevices: dispositivosCombinados,
            usuario: req.usuario
        });

    } catch (error) {
        console.error("Error en módulo estadístico:", error);
        res.status(500).send('Error generando análisis: ' + error.message);
    }
});

// 9.2 CREAR UN REGISTRO MANUAL (PARA VEHÍCULOS SIN GPS NI INSPECCIÓN)
app.post('/admin/auditoria-horas/crear-manual', verificarRol(['admin']), async (req, res) => {
    try {
        const { placa_select, placa_nueva, conductor_id, conductor_manual, fecha, inicio_app, fin_app, inicio_gps, fin_gps, distancia_gps } = req.body;
        const placaFinal = (placa_nueva && placa_nueva.trim() !== '' ? placa_nueva : placa_select).toUpperCase().trim();

        if (!placaFinal || !fecha) {
            return res.status(400).json({ success: false, error: 'La placa y la fecha son obligatorias.' });
        }

        await prisma.vehiculo.upsert({
            where: { placa: placaFinal },
            update: {},
            create: { placa: placaFinal, tipo: 'Otro', modelo: '2025' }
        });

        let idConductorFinal = conductor_id ? parseInt(conductor_id) : req.usuario.id;

        const horaApertura = inicio_app && inicio_app.trim() !== '' ? inicio_app : (inicio_gps || '06:00');
        const fechaAperturaObj = new Date(`${fecha}T${horaApertura}:00-05:00`);
        const fechaCierreObj = fin_app && fin_app.trim() !== '' ? new Date(`${fecha}T${fin_app}:00-05:00`) : fechaAperturaObj;

        await prisma.inspeccion.create({
            data: {
                vehiculo_placa: placaFinal,
                conductor_id: idConductorFinal,
                fecha_apertura: fechaAperturaObj,
                fecha_cierre: fechaCierreObj,
                estado: 'Finalizada',
                kilometraje_salida: 0,
                datos_chequeo: {
                    registro_manual: true,
                    sin_app: (!inicio_app || inicio_app.trim() === ''),
                    conductor_manual: conductor_manual || null,
                    inicio_app_manual: formatearHora24Colombia(inicio_app),
                    fin_app_manual: formatearHora24Colombia(fin_app),
                    inicio_gps: formatearHora24Colombia(inicio_gps),
                    fin_gps: formatearHora24Colombia(fin_gps),
                    distancia_gps: distancia_gps ? parseFloat(distancia_gps) : 0
                }
            }
        });

        res.json({ success: true });
    } catch (error) {
        console.error("Error creando registro manual:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 9.3 GUARDAR EDICIÓN RÁPIDA DE HORAS (GPS Y APP) EN LA TABLA
app.post('/admin/auditoria-horas/actualizar-fila', verificarRol(['admin']), async (req, res) => {
    try {
        const { id, placa, fecha, inicio_app, fin_app, inicio_gps, fin_gps, distancia_gps } = req.body;

        if (id && id !== 'nuevo') {
            const insp = await prisma.inspeccion.findUnique({ where: { id: parseInt(id) } });
            if (!insp) return res.status(404).json({ success: false, error: 'Registro no encontrado' });

            let datos = insp.datos_chequeo || {};
            datos.inicio_gps = formatearHora24Colombia(inicio_gps);
            datos.fin_gps = formatearHora24Colombia(fin_gps);
            if (inicio_app !== undefined) {
                datos.inicio_app_manual = formatearHora24Colombia(inicio_app);
                datos.sin_app = (inicio_app.trim() === '');
            }
            if (fin_app !== undefined) datos.fin_app_manual = formatearHora24Colombia(fin_app);
            if (distancia_gps !== undefined) datos.distancia_gps = parseFloat(distancia_gps) || 0;

            await prisma.inspeccion.update({
                where: { id: parseInt(id) },
                data: { datos_chequeo: datos }
            });
        } else {
            const placaFinal = placa.toUpperCase().trim();
            await prisma.vehiculo.upsert({
                where: { placa: placaFinal },
                update: {},
                create: { placa: placaFinal, tipo: 'Otro', modelo: '2025' }
            });

            const horaRef = inicio_app || inicio_gps || '06:00';
            const fechaObj = new Date(`${fecha}T${horaRef}:00-05:00`);

            await prisma.inspeccion.create({
                data: {
                    vehiculo_placa: placaFinal,
                    conductor_id: req.usuario.id,
                    fecha_apertura: fechaObj,
                    fecha_cierre: fechaObj,
                    estado: 'Finalizada',
                    kilometraje_salida: 0,
                    datos_chequeo: {
                        registro_manual: true,
                        sin_app: (!inicio_app || inicio_app.trim() === ''),
                        inicio_app_manual: formatearHora24Colombia(inicio_app),
                        fin_app_manual: formatearHora24Colombia(fin_app),
                        inicio_gps: formatearHora24Colombia(inicio_gps),
                        fin_gps: formatearHora24Colombia(fin_gps),
                        distancia_gps: parseFloat(distancia_gps) || 0
                    }
                }
            });
        }

        res.json({ success: true });
    } catch (error) {
        console.error("Error actualizando fila:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 9.4 EXTRAER DATOS PARA UNA FILA ESPECÍFICA (SOPORTA TRACCAR Y PLASPY POR PLACA)
app.post('/admin/auditoria-horas/sincronizar-fila', verificarRol(['admin']), async (req, res) => {
    try {
        const { id, placa, deviceId, fecha } = req.body;
        let datosDia = null;

        if (deviceId && deviceId.toString().startsWith('PLASPY:')) {
            const rawId = deviceId.toString().replace('PLASPY:', '');
            const { devices } = await obtenerDispositivosPlaspy();
            const devPlaspy = devices.find(d => d.rawId == rawId || d.id === deviceId);
            if (!devPlaspy) {
                return res.json({ success: false, error: 'No se encontró la unidad en las cuentas configuradas de Plaspy.' });
            }
            datosDia = await extraerDiaCompletoPlaspy(devPlaspy.token, devPlaspy.rawId, fecha);
        } else {
            const { serverUrl, token } = await obtenerDispositivosTraccar();
            datosDia = await extraerDiaCompletoTraccar(serverUrl, token, parseInt(deviceId), fecha);
        }

        if (!datosDia) {
            return res.json({ success: false, error: `El vehículo no registra viajes ni posiciones en el GPS el día ${fecha}.` });
        }

        const inicio_gps = formatearHora24Colombia(datosDia.inicio);
        const fin_gps = formatearHora24Colombia(datosDia.fin);
        const distTotalKm = (datosDia.distancia / 1000).toFixed(2);
        const durMins = Math.floor(datosDia.duracion / 60000);
        const horasMotor = `${Math.floor(durMins / 60)}h ${durMins % 60}m`;

        if (id && id !== 'nuevo') {
            const insp = await prisma.inspeccion.findUnique({ where: { id: parseInt(id) } });
            let datos = insp ? (insp.datos_chequeo || {}) : {};
            datos.inicio_gps = inicio_gps;
            datos.fin_gps = fin_gps;
            datos.distancia_gps = parseFloat(distTotalKm);
            datos.horas_motor_gps = horasMotor;
            datos.traccar_device_id = deviceId;

            await prisma.inspeccion.update({
                where: { id: parseInt(id) },
                data: { datos_chequeo: datos }
            });
        }

        res.json({ success: true, inicio_gps, fin_gps, distancia: distTotalKm });
    } catch (error) {
        console.error("Error sincronizando fila con GPS:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 9.5 RUTA LABORATORIO TRACCAR (TAMBIÉN CON MOTOR HÍBRIDO TRIPS + POSITIONS)
app.get('/test-traccar', verificarRol(['admin']), async (req, res) => {
    const placaSeleccionada = req.query.placa || '';
    const fechaFiltro = req.query.fecha || new Date().toISOString().split('T')[0];
    let devices = [];
    let errorConexion = null;
    let resultado = null;

    try {
        const conn = await obtenerDispositivosTraccar();
        devices = conn.devices;
        if (devices.length === 0) throw new Error('No se encontraron dispositivos o el servidor no respondió.');

        if (placaSeleccionada && fechaFiltro) {
            const dev = devices.find(d => limpiarPlaca(d.name) === limpiarPlaca(placaSeleccionada));
            if (dev) {
                const datosDia = await extraerDiaCompletoTraccar(conn.serverUrl, conn.token, dev.id, fechaFiltro);
                if (datosDia) {
                    resultado = {
                        encontrado: true,
                        placa: placaSeleccionada,
                        inicio: formatearHora12Colombia(datosDia.inicio),
                        fin: formatearHora12Colombia(datosDia.fin),
                        distancia: (datosDia.distancia / 1000).toFixed(2),
                        totalViajes: datosDia.totalViajes
                    };
                } else {
                    resultado = { encontrado: false, mensaje: `El vehículo ${placaSeleccionada} no registra viajes ni posiciones en la fecha ${fechaFiltro}.` };
                }
            }
        }
    } catch (err) {
        errorConexion = `No se pudo conectar con el servidor GPS: ${err.message}`;
    }

    res.render('test-traccar', { errorConexion, devices, placaSeleccionada, fechaFiltro, resultado });
});

// 9.6 RUTA LABORATORIO PLASPY (UNIFICA TODAS LAS APIS DE PLASPY SIN CAMBIAR LA VISTA)
app.get('/test-plaspy', verificarRol(['admin']), async (req, res) => {
    const fecha_viaje = req.query.fecha_viaje || new Date().toISOString().split('T')[0];
    const dispositivo_id = req.query.dispositivo_id || '';
    let devices = [];
    let errorConexion = null;
    let resumenActividad = null;

    try {
        const { devices: listaPlaspy, errores } = await obtenerDispositivosPlaspy();
        devices = listaPlaspy.map(d => ({
            id: d.rawId,
            name: d.name,
            token: d.token
        }));

        if (errores.length > 0 && devices.length === 0) {
            errorConexion = errores.join(' | ');
        }

        if (dispositivo_id && fecha_viaje && devices.length > 0) {
            const devInfo = devices.find(d => d.id == dispositivo_id);
            if (devInfo) {
                const datosDia = await extraerDiaCompletoPlaspy(devInfo.token, devInfo.id, fecha_viaje);
                if (datosDia) {
                    resumenActividad = {
                        placa: devInfo.name,
                        fecha: fecha_viaje,
                        kilometraje: (datosDia.distancia / 1000).toFixed(2),
                        velMaxima: datosDia.velMaxima.toFixed(1),
                        velPromedio: datosDia.velPromedio.toFixed(1),
                        primerMovimiento: formatearHora12Colombia(datosDia.inicio),
                        ultimoMovimiento: formatearHora12Colombia(datosDia.fin)
                    };
                } else {
                    resumenActividad = {
                        placa: devInfo.name,
                        fecha: fecha_viaje,
                        kilometraje: '0.00',
                        velMaxima: '0',
                        velPromedio: '0',
                        primerMovimiento: 'Sin movimiento',
                        ultimoMovimiento: 'Sin movimiento'
                    };
                }
            }
        }
    } catch (err) {
        errorConexion = `Aviso de conexión Plaspy: ${err.message}`;
    }

    res.render('test-plaspy', { errorConexion, devices, dispositivo_id, fecha_viaje, resumenActividad });
});

/**
 * ============================================================================
 * 10. INICIO DEL SERVIDOR
 * ============================================================================
 */
app.listen(PORT, () => {
    console.log(`🚀 Servidor OmegaGroup corriendo en puerto ${PORT}`);
});