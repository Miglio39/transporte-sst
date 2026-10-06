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

/**
 * ============================================================================
 * 2. RUTAS PÚBLICAS Y DE AUTENTICACIÓN (SESIÓN DE 365 DÍAS)
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

        const token = jwt.sign(
            { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol }, 
            process.env.JWT_SECRET || 'llave_de_respaldo_omega_2026', 
            { expiresIn: '365d' } 
        );

        const tiempoUnAno = 365 * 24 * 60 * 60 * 1000; 
        
        res.cookie('jwt', token, { 
            httpOnly: true, 
            secure: true,      
            path: '/',         
            sameSite: 'lax',   
            maxAge: tiempoUnAno,
            expires: new Date(Date.now() + tiempoUnAno) 
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

app.get('/setup-admin', async (req, res) => {
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash('Rosalbamoreno27.', salt);
    
    await prisma.usuario.upsert({
        where: { documento: 'operaciones.omegagroupsas@gmail.com' },
        update: { password: hash, nombre: 'Admin Operaciones' },
        create: { nombre: 'Admin Operaciones', documento: 'operaciones.omegagroupsas@gmail.com', password: hash, rol: 'admin' }
    });

    res.send('✅ Administrador configurado exitosamente. <br><br> Usuario: operaciones.omegagroupsas@gmail.com <br> Contraseña: Rosalbamoreno27. <br><br> <a href="/login">Ir a Iniciar Sesión</a>');
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
 * 5. MÓDULO ADMINISTRATIVO: GESTIÓN DE INSPECCIONES Y REPORTE MAESTRO
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

app.get('/admin/inspeccion/reporte-maestro', verificarRol(['admin']), async (req, res) => {
    let browser = null;
    try {
        const { fechaInicio, fechaFin, placa } = req.query;
        if (!fechaInicio || !fechaFin) return res.status(400).send("Debe seleccionar las fechas.");

        const startDate = new Date(fechaInicio + 'T00:00:00');
        const endDate = new Date(fechaFin + 'T23:59:59');

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
            orderBy: { fecha_apertura: 'asc' }
        });

        if(inspecciones.length === 0) {
            return res.send('<h2 style="text-align:center; margin-top:50px; font-family:sans-serif;">No hay registros en estas fechas.</h2>');
        }

        let total = inspecciones.length;
        let aprobadas = 0;
        let conDefectos = 0;
        let tablaEjecutiva = [];
        let inspeccionesConDefectos = [];

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

        let logoSrc = '';
        try {
            const logoPath = path.join(__dirname, 'public/images/logo.png');
            if (fs.existsSync(logoPath)) {
                logoSrc = `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`;
            }
        } catch (logoError) {}

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

/**
 * ============================================================================
 * 6. MÓDULO EXPORTACIÓN PDF (INSPECCIONES DIARIAS)
 * ============================================================================
 */
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



// ============================================================================
// MÓDULO DE PRUEBAS: EXTRACCIÓN PURA DE TRACCAR (SANDBOX)
// ============================================================================
app.get('/test-traccar', async (req, res) => {
    // ACTUALIZADO: Nuevo servidor Traccar y Nuevo Token
    const TRACCAR_URL = 'https://api.globalmonitorgps.com'; 
    const TRACCAR_TOKEN = 'RzBFAiEAtDXlCJ0WnZ_XAG5xqrA-8SeIlkWsmTFdsaTUk_-DCC8CIGxpnyl_suINh63nvf4xWosnaqanlFCfSfyujnp17SxjeyJpIjo5MTM3MzU3NTY1NzM5MDM1ODAzLCJ1IjoxLCJlIjoiMjAzMC0xMi0zMVQwNTowMDowMC4wMDArMDA6MDAifQ';

    let devices = [];
    let errorConexion = null;
    let resultado = null;
    const placaSeleccionada = req.query.placa;
    const fechaFiltro = req.query.fecha || new Date().toISOString().split('T')[0];

    try {
        const resDevices = await fetch(`${TRACCAR_URL}/api/devices`, {
            headers: { 
                'Authorization': `Bearer ${TRACCAR_TOKEN}`,
                'Accept': 'application/json' 
            },
            signal: AbortSignal.timeout(8000) 
        });
        
        if (!resDevices.ok) {
            const errorText = await resDevices.text();
            throw new Error(`Error ${resDevices.status}: ${errorText || 'Acceso denegado (Token inválido o mal configurado)'}`);
        }
        
        devices = await resDevices.json();

        if (placaSeleccionada && devices.length > 0) {
            const device = devices.find(d => d.name === placaSeleccionada || d.uniqueId === placaSeleccionada);
            
            if (device) {
                const fromStr = encodeURIComponent(new Date(`${fechaFiltro}T00:00:00-05:00`).toISOString());
                const toStr = encodeURIComponent(new Date(`${fechaFiltro}T23:59:59-05:00`).toISOString());

                const tripsRes = await fetch(`${TRACCAR_URL}/api/reports/trips?deviceId=${device.id}&from=${fromStr}&to=${toStr}`, {
                    headers: { 
                        'Authorization': `Bearer ${TRACCAR_TOKEN}`,
                        'Accept': 'application/json' 
                    }
                });

                if (tripsRes.ok) {
                    const trips = await tripsRes.json();
                    
                    if (trips.length > 0) {
                        const primerViaje = trips[0];
                        const ultimoViaje = trips[trips.length - 1];

                        resultado = {
                            encontrado: true,
                            placa: placaSeleccionada,
                            inicio: new Date(primerViaje.startTime).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: true }),
                            fin: new Date(ultimoViaje.endTime).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: true }),
                            totalViajes: trips.length,
                            distancia: (trips.reduce((acc, t) => acc + t.distance, 0) / 1000).toFixed(2)
                        };
                    } else {
                        resultado = { encontrado: false, mensaje: "La plataforma satelital no registró movimiento para este vehículo en la fecha seleccionada." };
                    }
                } else {
                    const errorTrips = await tripsRes.text();
                    throw new Error(`Error obteniendo recorridos: ${errorTrips}`);
                }
            }
        }
    } catch (error) {
        errorConexion = `Fallo de conexión: El servidor GPS respondió con error: ${error.message}`;
    }

    res.render('test-traccar', { devices, errorConexion, resultado, placaSeleccionada, fechaFiltro });
});

// ============================================================================
// MÓDULO DE PRUEBAS: LABORATORIO PLASPY (MODO RESUMEN DE ACTIVIDAD)
// ============================================================================
app.get('/test-plaspy', verificarRol(['admin']), async (req, res) => {
    const { plaspy_user, plaspy_cred, tipo_cred, dispositivo_id, fecha_viaje } = req.query;

    let devices = [];
    let errorConexion = null;
    let resumenActividad = null; // Variable para la tabla tipo Plaspy

    const usuarioFijo = plaspy_user || 'oscarf07@hotmail.com';
    const credencialFija = plaspy_cred || '9aspvD6qw+S5Ba3o12S0BEkI04R8HlZBgcW5qPMDcVQ=';
    const tipoCredFijo = tipo_cred || 'apikey';

    if (usuarioFijo && credencialFija) {
        try {
            const PLASPY_URL = 'https://api.plaspy.com';
            
            // 1. AUTENTICACIÓN
            let bodyDataAuth = { UserName: usuarioFijo };
            if (tipoCredFijo === 'password') bodyDataAuth.Password = credencialFija;
            else bodyDataAuth.ApiKey = credencialFija;

            const authResponse = await fetch(`${PLASPY_URL}/api/Auth/Token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify(bodyDataAuth),
                signal: AbortSignal.timeout(8000)
            });

            if (!authResponse.ok) throw new Error(`HTTP ${authResponse.status}`);
            const authData = await authResponse.json();
            const token = authData.token || authData.access_token || authData.ApiKey;

            // 2. DESCARGAR VEHÍCULOS
            const resDevices = await fetch(`${PLASPY_URL}/api/devices`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
            });
            const data = await resDevices.json();
            devices = Array.isArray(data) ? data : (data.devices || []);

            // 3. DESCARGAR PUNTOS GPS Y CALCULAR RESUMEN
            if (dispositivo_id && fecha_viaje) {
                const dateFrom = `${fecha_viaje}T00:00:00`;
                const dateTo = `${fecha_viaje}T23:59:59`;

                const ruta = `${PLASPY_URL}/api/devices/${dispositivo_id}/locations`;
                const tripsRes = await fetch(ruta, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ from: dateFrom, to: dateTo }),
                    signal: AbortSignal.timeout(8000)
                });

                if (tripsRes.ok) {
                    const tempText = await tripsRes.text();
                    if (!tempText.includes('<!DOCTYPE html>')) {
                        const dataTrips = JSON.parse(tempText);
                        const locs = Array.isArray(dataTrips) ? dataTrips : (dataTrips.locations || []);
                        
                        const vehiculoEncontrado = devices.find(d => (d.id || d.Id) == dispositivo_id);
                        const nombreVehiculo = vehiculoEncontrado ? (vehiculoEncontrado.name || vehiculoEncontrado.Name) : 'Desconocido';

                        if (locs.length > 0) {
                            // Algoritmo matemático para emular el reporte de Plaspy
                            let maxSpeed = 0;
                            let sumSpeed = 0;
                            let movingCount = 0;
                            let firstMove = null;
                            let lastMove = null;

                            for (let loc of locs) {
                                // Buscar Velocidad Máxima
                                if (loc.speed > maxSpeed) maxSpeed = loc.speed;
                                
                                // Filtrar solo los momentos en movimiento para el promedio
                                if (loc.speed > 2) {
                                    sumSpeed += loc.speed;
                                    movingCount++;
                                    if (!firstMove) firstMove = loc;
                                    lastMove = loc;
                                }
                            }

                            const minMilleage = locs[0].milleage || 0;
                            const maxMilleage = locs[locs.length - 1].milleage || 0;
                            const dist = maxMilleage - minMilleage;
                            const avgSpeed = movingCount > 0 ? (sumSpeed / movingCount) : 0;

                            resumenActividad = {
                                placa: nombreVehiculo,
                                fecha: new Date(`${fecha_viaje}T12:00:00`).toLocaleDateString('es-CO'),
                                kilometraje: dist > 0 ? dist.toFixed(3).replace('.', ',') : '0,000',
                                velMaxima: maxSpeed > 0 ? maxSpeed.toFixed(2).replace('.', ',') : '0,00',
                                velPromedio: avgSpeed > 0 ? avgSpeed.toFixed(3).replace('.', ',') : '0,000',
                                primerMovimiento: firstMove ? new Date(firstMove.dateTime).toLocaleTimeString('es-CO', {hour: '2-digit', minute:'2-digit'}) : 'Sin mov.',
                                ultimoMovimiento: lastMove ? new Date(lastMove.dateTime).toLocaleTimeString('es-CO', {hour: '2-digit', minute:'2-digit'}) : 'Sin mov.'
                            };
                        } else {
                            resumenActividad = {
                                placa: nombreVehiculo, fecha: fecha_viaje,
                                kilometraje: '0,000', velMaxima: '0,00', velPromedio: '0,000',
                                primerMovimiento: 'N/A', ultimoMovimiento: 'N/A'
                            };
                        }
                    }
                } else {
                    errorConexion = "Error al descargar telemetría.";
                }
            }

        } catch (error) {
            errorConexion = error.message;
        }
    }

    res.render('test-plaspy', { 
        devices, errorConexion, resumenActividad,
        plaspy_user: usuarioFijo, plaspy_cred: credencialFija, tipo_cred: tipoCredFijo,
        dispositivo_id: dispositivo_id || '',
        fecha_viaje: fecha_viaje || new Date().toISOString().split('T')[0]
    });
});


/**
 * ============================================================================
 * 9. INICIO DEL SERVIDOR
 * ============================================================================
 */
app.listen(PORT, () => {
    console.log(`🚀 Servidor OmegaGroup corriendo en puerto ${PORT}`);
});