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

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());

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
 * 2. RUTAS PÚBLICAS Y DE AUTENTICACIÓN
 * ============================================================================
 */
app.get('/', (req, res) => { res.redirect('/login'); });

app.get('/login', (req, res) => { res.render('login'); });

app.post('/login', async (req, res) => {
    try {
        const { documento, password } = req.body;
        const usuario = await prisma.usuario.findUnique({ where: { documento } });
        if (!usuario) return res.render('login', { error: 'Documento o contraseña incorrectos' });

        const esValida = await bcrypt.compare(password, usuario.password);
        if (!esValida) return res.render('login', { error: 'Documento o contraseña incorrectos' });

        const token = jwt.sign(
            { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol }, 
            process.env.JWT_SECRET || 'llave_de_respaldo_omega_2026', 
            { expiresIn: '12h' }
        );

        const tiempo12Horas = 12 * 60 * 60 * 1000;
        
        res.cookie('jwt', token, { 
            httpOnly: true, secure: true, path: '/', sameSite: 'lax',
            maxAge: tiempo12Horas, expires: new Date(Date.now() + tiempo12Horas)
        });
        
        if (usuario.rol === 'admin') return res.redirect('/admin');
        else return res.redirect('/panel-conductor');
    } catch (error) {
        res.render('login', { error: 'Error interno del servidor' });
    }
});

app.get('/logout', (req, res) => {
    res.clearCookie('jwt');
    res.redirect('/login');
});

app.get('/setup-admin', async (req, res) => {
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash('Omega2026*', salt);
    
    await prisma.usuario.upsert({ where: { documento: '1122141007' }, update: { password: hash }, create: { nombre: 'Yeison Uriel Vargas Vesga', documento: '1122141007', password: hash, rol: 'admin' } });
    await prisma.usuario.upsert({ where: { documento: '1123087694' }, update: { password: hash }, create: { nombre: 'Maria Fernanda Ladino Vega', documento: '1123087694', password: hash, rol: 'admin' } });
    await prisma.usuario.upsert({ where: { documento: '1000723660' }, update: { password: hash }, create: { nombre: 'Laura Camila Quintero', documento: '1000723660', password: hash, rol: 'admin' } });

    res.send(`<div style="text-align: center; padding: 50px; font-family: Arial;"><h1 style="color: #27ae60;">✅ Cuentas Configuradas</h1><br><a href="/login">Ir a Iniciar Sesión</a></div>`);
});

/**
 * ============================================================================
 * 3. MÓDULO ADMINISTRATIVO (PANEL Y CONDUCTORES)
 * ============================================================================
 */
app.get('/admin', verificarRol(['admin']), async (req, res) => {
    try {
        const inspecciones = await prisma.inspeccion.findMany({
            where: { eliminado: false }, include: { conductor: true, vehiculo: true }, orderBy: { fecha_apertura: 'desc' }
        });

        const inspeccionesProcesadas = inspecciones.map(insp => {
            let estadoBadge = 'Pendiente'; let badgeClass = 'bg-warning text-dark'; 
            if (insp.estado === 'Finalizada') {
                const datos = insp.datos_chequeo || {};
                const items = datos.chequeo_items || {};
                const tieneDefectos = Object.values(items).includes('MALO') || (datos.descripcion_defecto && datos.descripcion_defecto.trim() !== '');
                if (tieneDefectos) { estadoBadge = 'Con defectos'; badgeClass = 'bg-danger text-white'; } 
                else { estadoBadge = 'Aprobado'; badgeClass = 'bg-success text-white'; }
            }
            return { ...insp, estadoBadge, badgeClass, km_inicio: insp.kilometraje_salida, km_fin: insp.datos_chequeo?.kilometraje_final || '---' };
        });
        res.render('admin', { title: 'Panel Administrativo', inspecciones: inspeccionesProcesadas });
    } catch (error) {
        res.status(500).send('Error al cargar el panel de administración');
    }
});

app.get('/admin/conductores', verificarRol(['admin']), async (req, res) => {
    try {
        const conductores = await prisma.usuario.findMany({ where: { rol: 'conductor' }, orderBy: { nombre: 'asc' } });
        res.render('conductores', { title: 'Gestión de Conductores', conductores, error: req.query.error });
    } catch (error) { res.status(500).send('Error al cargar conductores'); }
});

app.get('/admin/conductores/nuevo', verificarRol(['admin']), (req, res) => { res.render('crear-conductor', { title: 'Crear Conductor' }); });

app.post('/admin/conductores/nuevo', verificarRol(['admin']), async (req, res) => {
    try {
        const { nombre, documento, password } = req.body;
        const existe = await prisma.usuario.findUnique({ where: { documento } });
        if (existe) return res.render('crear-conductor', { title: 'Crear Conductor', error: 'Ese número de documento ya está registrado.' });
        
        const salt = await bcrypt.genSalt(10);
        const hashPassword = await bcrypt.hash(password, salt);
        await prisma.usuario.create({ data: { nombre, documento, password: hashPassword, rol: 'conductor' } });
        res.redirect('/admin/conductores');
    } catch (error) { res.render('crear-conductor', { title: 'Crear Conductor', error: 'Error interno.' }); }
});

app.get('/admin/conductores/editar/:id', verificarRol(['admin']), async (req, res) => {
    try {
        const conductor = await prisma.usuario.findUnique({ where: { id: parseInt(req.params.id) } });
        if (!conductor) return res.redirect('/admin/conductores');
        res.render('editar-conductor', { title: 'Editar Conductor', conductor });
    } catch (error) { res.status(500).send('Error al cargar formulario'); }
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
    } catch (error) { res.redirect('/admin/conductores?error=Error+al+actualizar'); }
});

app.post('/admin/conductores/eliminar/:id', verificarRol(['admin']), async (req, res) => {
    try {
        await prisma.usuario.delete({ where: { id: parseInt(req.params.id) } });
        res.redirect('/admin/conductores');
    } catch (error) { res.redirect('/admin/conductores?error=No+puedes+eliminar+a+este+conductor.'); }
});

/**
 * ============================================================================
 * 4. MÓDULO CONDUCTOR: PANEL E INSPECCIÓN
 * ============================================================================
 */
app.get('/panel-conductor', verificarRol(['conductor', 'admin']), async (req, res) => {
    try {
        const inspeccionActiva = await prisma.inspeccion.findFirst({
            where: { conductor_id: req.usuario.id, estado: 'En curso' }, orderBy: { fecha_apertura: 'desc' }
        });
        res.render('panel-conductor', { usuario: req.usuario, inspeccionActiva });
    } catch (error) { res.status(500).send('Error al cargar panel del conductor'); }
});

app.get('/inspeccion', verificarRol(['conductor', 'admin']), (req, res) => {
    res.render('inspeccion', {
        title: 'Inspección Preoperacional', appName: 'Transporte SST', appVersion: '1.0.0',
        today: new Date().toISOString().split('T')[0], formatoCodigo: 'SST-F-01', usuarioActual: req.usuario 
    });
});

app.post('/inspeccion/inicio', verificarRol(['conductor', 'admin']), async (req, res) => {
    try {
        const { placa, tipo_vehiculo, empresa, nombre_conductor, licencia_conductor, categoria_licencia, vigencia_licencia, modelo, kilometraje_entrada, cc_conductor, firma_conductor_base64, observaciones_generales, descripcion_defecto, ...restoDelFormulario } = req.body;
        let vehiculo = await prisma.vehiculo.findUnique({ where: { placa: placa.toUpperCase() } });
        if (!vehiculo) vehiculo = await prisma.vehiculo.create({ data: { placa: placa.toUpperCase(), tipo: tipo_vehiculo || 'Otro', modelo: modelo || '' } });
        
        let conductor = await prisma.usuario.findUnique({ where: { documento: cc_conductor } });
        if (!conductor) return res.status(400).send(`<div style="text-align:center; padding:50px; font-family:Arial;"><h1 style="color:#e74c3c;">Conductor no encontrado</h1></div>`);

        const nuevaInspeccion = await prisma.inspeccion.create({
            data: {
                estado: 'En curso', kilometraje_salida: parseInt(kilometraje_entrada), conductor_id: conductor.id, vehiculo_placa: vehiculo.placa,
                datos_chequeo: { empresa, licencia_conductor, categoria_licencia, vigencia_licencia, firma_conductor: firma_conductor_base64, observaciones_generales, descripcion_defecto, chequeo_items: restoDelFormulario }
            }
        });
        const urlDestino = req.usuario.rol === 'admin' ? '/admin' : '/panel-conductor';
        res.send(`<div style="text-align: center; padding: 50px;"><h1 style="color: #27ae60;">¡Inspección Registrada!</h1><p>ID: #${nuevaInspeccion.id}</p><br><a href="${urlDestino}">Volver a Mi Panel</a></div>`);    
    } catch (error) { res.status(500).send('Error al guardar inspección'); }
});

app.get('/inspeccion/cierre/:id', verificarRol(['conductor', 'admin']), async (req, res) => {
    try {
        const inspeccion = await prisma.inspeccion.findUnique({ where: { id: parseInt(req.params.id) }, include: { vehiculo: true, conductor: true } });
        if (!inspeccion) return res.status(404).send('Inspección no encontrada');
        if (inspeccion.estado === 'Finalizada') return res.redirect('/panel-conductor');
        res.render('cierre', { title: 'Cierre de Jornada', appName: 'Transporte SST', inspeccion });
    } catch (error) { res.status(500).send('Error al cargar la inspección'); }
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
        res.send(`<div style="text-align: center; padding: 50px;"><h1 style="color: #27ae60;">¡Jornada Cerrada!</h1><br><a href="${urlDestino}">Volver a Mi Panel</a></div>`);
    } catch (error) { res.status(500).send('Error al cerrar la jornada'); }
});

/**
 * ============================================================================
 * 5. MÓDULO ADMINISTRATIVO: DETALLES, FIRMA MASIVA Y EDICIÓN
 * ============================================================================
 */
app.get('/admin/inspeccion/detalle/:id', verificarRol(['admin']), async (req, res) => {
    try {
        const insp = await prisma.inspeccion.findUnique({ where: { id: parseInt(req.params.id) }, include: { conductor: true, vehiculo: true } });
        if (!insp) return res.redirect('/admin');
        let resumen = { buenos: 0, malos: 0, na: 0 };
        const items = insp.datos_chequeo?.chequeo_items || {};
        for (const key in items) {
            if (items[key] === 'BUENO') resumen.buenos++;
            if (items[key] === 'MALO') resumen.malos++;
            if (items[key] === 'NA') resumen.na++;
        }
        res.render('detalle-inspeccion', { title: 'Detalle Inspección', insp, resumen });
    } catch (error) { res.status(500).send('Error al cargar detalle'); }
});

app.get('/admin/inspeccion/editar/:id', verificarRol(['admin']), async (req, res) => {
    try {
        const insp = await prisma.inspeccion.findUnique({ where: { id: parseInt(req.params.id) }, include: { vehiculo: true, conductor: true } });
        if (!insp) return res.redirect('/admin');
        res.render('editar-inspeccion', { title: 'Editar Inspección', insp });
    } catch (error) { res.status(500).send('Error al cargar edición'); }
});

app.post('/admin/inspeccion/editar/:id', verificarRol(['admin']), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const inspActual = await prisma.inspeccion.findUnique({ where: { id } });
        let datos = inspActual.datos_chequeo || {};
        
        const { 
            empresa, licencia_conductor, categoria_licencia, vigencia_licencia, doc_licencia_transito, fecha_vencimiento_soat, doc_poliza_rcc, 
            doc_poliza_todo_riesgo, doc_tarjeta_operacion, fecha_revision, fecha_cambio_aceite, kilometraje_salida, kilometraje_final, observaciones_generales, descripcion_defecto, firma_coordinador_base64, ...chequeo_items 
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

        await prisma.inspeccion.update({ where: { id }, data: { kilometraje_salida: parseInt(kilometraje_salida), datos_chequeo: datos } });
        res.redirect('/admin');
    } catch (error) { res.status(500).send('Error al guardar cambios'); }
});

app.post('/admin/inspeccion/eliminar/:id', verificarRol(['admin']), async (req, res) => {
    try {
        await prisma.inspeccion.update({ where: { id: parseInt(req.params.id) }, data: { eliminado: true } });
        res.redirect('/admin');
    } catch (error) { res.status(500).send('Error al eliminar'); }
});

app.post('/admin/inspeccion/firma-masiva', verificarRol(['admin']), async (req, res) => {
    try {
        const { ids, firma_base64 } = req.body;
        if (!ids || ids.length === 0 || !firma_base64) return res.status(400).json({ success: false, message: 'Faltan datos.' });

        for (const id of ids) {
            const insp = await prisma.inspeccion.findUnique({ where: { id: parseInt(id) } });
            if (insp) {
                let datos = insp.datos_chequeo || {};
                datos.firma_coordinador_img = firma_base64;
                datos.nombre_coordinador = req.usuario.nombre;
                datos.cc_coordinador = req.usuario.documento;
                await prisma.inspeccion.update({ where: { id: parseInt(id) }, data: { datos_chequeo: datos } });
            }
        }
        res.json({ success: true, message: `${ids.length} inspecciones firmadas exitosamente.` });
    } catch (error) { res.status(500).json({ success: false, message: 'Error interno al firmar.' }); }
});

/**
 * ============================================================================
 * 6. MÓDULO EXPORTACIÓN PDF
 * ============================================================================
 */
app.get('/admin/inspeccion/pdf/:id', verificarRol(['admin']), async (req, res) => {
    let browser = null; 
    try {
        const insp = await prisma.inspeccion.findUnique({ where: { id: parseInt(req.params.id) }, include: { conductor: true, vehiculo: true } });
        if (!insp || insp.eliminado) return res.status(404).send('La inspección no existe.');
        res.status(200).send("Endpoint PDF de Inspección"); 
    } catch (error) {
        if (browser) await browser.close(); 
        res.status(500).send('Error al generar PDF.');
    }
});

/**
 * ============================================================================
 * 7. MÓDULO AUDITORÍA DE PATIO
 * ============================================================================
 */
app.get('/admin/patio/historial', verificarRol(['admin']), async (req, res) => {
    try {
        const inspecciones = await prisma.inspeccionPatio.findMany({ orderBy: { fecha_registro: 'desc' }, include: { admin: true } });
        res.render('historial-patio', { title: 'Historial de Patio', inspecciones });
    } catch (error) { res.status(500).send('Error al cargar historial.'); }
});

/**
 * ============================================================================
 * 9. MÓDULO SATELITAL GPS: MOTOR HÍBRIDO (TRACCAR + PLASPY POR PLACA) Y MANUAL
 * ============================================================================
 */

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

const APIS_PLASPY = [
    { user: 'oscarf07@hotmail.com', apiKey: '9aspvD6qw+S5Ba3o12S0BEkI04R8HlZBgcW5qPMDcVQ=', placaExclusiva: null },
    { user: 'jhonser28@hotmail.com', apiKey: '9GOpyysGrwWq8/qatFJ02bQoMRC6UyVv4/di0mzKZKs=', placaExclusiva: null }
];

function limpiarPlaca(str) { return (str || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function formatearHora24Colombia(fechaInput) {
    if (!fechaInput) return '';
    if (typeof fechaInput === 'string' && /^\d{1,2}:\d{2}/.test(fechaInput.trim())) {
        const partes = fechaInput.trim().split(':'); return `${partes[0].padStart(2, '0')}:${partes[1].slice(0, 2)}`;
    }
    const d = new Date(fechaInput);
    if (isNaN(d.getTime())) return '';
    const colTime = new Date(d.getTime() - (5 * 3600000));
    return `${String(colTime.getUTCHours()).padStart(2, '0')}:${String(colTime.getUTCMinutes()).padStart(2, '0')}`;
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
            const res = await fetchConTimeout(`${srv.url}/api/devices?token=${srv.token}`, {
                headers: { 'Accept': 'application/json' }
            }, 6000);
            if (res.ok) {
                const devices = await res.json();
                if (Array.isArray(devices) && devices.length > 0) return { devices, serverUrl: srv.url, token: srv.token };
            }
        } catch (e) {}
    }
    return { devices: [], serverUrl: TRACCAR_SERVERS[0].url, token: TRACCAR_SERVERS[0].token };
}

async function obtenerTokenPlaspyUnico(cuenta) {
    const authRes = await fetchConTimeout('https://api.plaspy.com/api/Auth/Token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ userName: cuenta.user.trim(), apiKey: cuenta.apiKey.trim() })
    }, 6000);
    const authData = await authRes.json();
    return authData.token || authData.Token || authData.access_token;
}

async function obtenerDispositivosPlaspy() {
    let dispositivos = [];
    let errores = [];
    await Promise.all(APIS_PLASPY.map(async (cuenta) => {
        if (!cuenta.user || !cuenta.apiKey) return;
        try {
            const token = await obtenerTokenPlaspyUnico(cuenta);
            if (!token) return;

            const devRes = await fetchConTimeout('https://api.plaspy.com/api/devices', {
                headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
            }, 6000);

            if (devRes.ok) {
                const devData = await devRes.json();
                const lista = Array.isArray(devData) ? devData : (devData.data || devData.devices || []);
                lista.forEach(d => {
                    const realId = d.id || d.Id;
                    const realName = (d.name || d.Name || '').toUpperCase().trim();
                    dispositivos.push({ id: `PLASPY:${cuenta.alias}:${realId}`, rawId: realId, name: realName, alias: cuenta.alias, token: token, plataforma: 'PLASPY' });
                });
            }
        } catch (err) {}
    }));
    return { devices: dispositivos, errores };
}

function distanciaHaversineMetros(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calcularResumenPostPlanilla(fechaStr, finApp24, finGPS24, listaViajes = [], kmExtraManual = null) {
    let diffFinMin = 0; let tiempoExtraStr = ''; let rangoExtra12h = '';
    let diffCobroExtraMin = 0; let tiempoCobroExtraStr = '';
    let kmExtra = (kmExtraManual !== null && kmExtraManual !== undefined && kmExtraManual !== '') ? parseFloat(kmExtraManual) : 0;

    if (finApp24 && finGPS24) {
        const [hApp, mApp] = finApp24.split(':').map(Number);
        const [hGps, mGps] = finGPS24.split(':').map(Number);
        const minApp = hApp * 60 + mApp; const minGps = hGps * 60 + mGps;

        if (minGps > minApp) {
            diffFinMin = minGps - minApp;
            const hExtra = Math.floor(diffFinMin / 60); const mExtra = diffFinMin % 60;
            tiempoExtraStr = hExtra > 0 ? `${hExtra}h ${mExtra}m` : `${mExtra}m`;
            rangoExtra12h = `${formatearHora12Colombia(finApp24)} - ${formatearHora12Colombia(finGPS24)}`;

            if ((kmExtraManual === null || kmExtraManual === undefined || kmExtraManual === '') && Array.isArray(listaViajes) && listaViajes.length > 0) {
                const tsFinApp = new Date(`${fechaStr}T${finApp24}:00-05:00`).getTime();
                const tsFinGps = new Date(`${fechaStr}T${finGPS24}:59-05:00`).getTime();
                let metrosExtra = 0;
                listaViajes.forEach(viaje => {
                    const vStart = new Date(viaje.startTime).getTime();
                    const vEnd = new Date(viaje.endTime).getTime();
                    const dist = Number(viaje.distance || 0);
                    if (vEnd > tsFinApp && vStart <= tsFinGps && dist > 0) {
                        if (vStart >= tsFinApp) metrosExtra += dist;
                        else if (vEnd > vStart) {
                            const fraccion = (Math.min(vEnd, tsFinGps) - tsFinApp) / (vEnd - vStart);
                            metrosExtra += dist * Math.max(0, Math.min(1, fraccion));
                        }
                    }
                });
                kmExtra = metrosExtra / 1000;
            }
        } else if (minApp > minGps) {
            diffCobroExtraMin = minApp - minGps;
            const hExtra = Math.floor(diffCobroExtraMin / 60); const mExtra = diffCobroExtraMin % 60;
            tiempoCobroExtraStr = hExtra > 0 ? `${hExtra}h ${mExtra}m` : `${mExtra}m`;
        }
    }
    return { diffFinMin, tiempoExtraStr, diffCobroExtraMin, tiempoCobroExtraStr, rangoExtra12h, rangoClave: (finApp24 && finGPS24) ? `${finApp24}-${finGPS24}` : '', kmExtra: Math.max(0, kmExtra).toFixed(2) };
}

async function extraerKmIntervaloTraccar(serverUrl, token, deviceId, fechaYYYYMMDD, horaInicio24, horaFin24, viajesFallback = []) {
    const base = calcularResumenPostPlanilla(fechaYYYYMMDD, horaInicio24, horaFin24, viajesFallback, null);
    if (base.diffFinMin <= 0 || !deviceId) return '0.00';

    let kmDesdePositions = 0;
    try {
        const fromStr = encodeURIComponent(new Date(`${fechaYYYYMMDD}T${horaInicio24}:00-05:00`).toISOString());
        const toStr = encodeURIComponent(new Date(`${fechaYYYYMMDD}T${horaFin24}:59-05:00`).toISOString());
        const posRes = await fetchConTimeout(`${serverUrl}/api/positions?deviceId=${deviceId}&from=${fromStr}&to=${toStr}&token=${token}`, { headers: { 'Accept': 'application/json' } }, 6500);

        if (posRes.ok) {
            const positions = await posRes.json();
            if (Array.isArray(positions) && positions.length >= 2) {
                const conTotalDist = positions.filter(p => p.attributes && typeof p.attributes.totalDistance === 'number' && p.attributes.totalDistance > 0);
                let metrosOdo = 0;
                if (conTotalDist.length >= 2) metrosOdo = conTotalDist[conTotalDist.length - 1].attributes.totalDistance - conTotalDist[0].attributes.totalDistance;

                let metrosHaversine = 0;
                for (let i = 1; i < positions.length; i++) {
                    const p1 = positions[i - 1]; const p2 = positions[i];
                    const d = distanciaHaversineMetros(p1.latitude, p1.longitude, p2.latitude, p2.longitude);
                    if (d >= 5 && d < 50000) metrosHaversine += d;
                }
                kmDesdePositions = (metrosOdo > 0 ? metrosOdo : metrosHaversine) / 1000;
            }
        }
    } catch (e) { }

    return Math.max(kmDesdePositions, parseFloat(base.kmExtra)).toFixed(2);
}

async function extraerDiaCompletoPlaspy(token, rawDeviceId, fechaYYYYMMDD) {
    try {
        const locRes = await fetchConTimeout(`https://api.plaspy.com/api/devices/${encodeURIComponent(rawDeviceId)}/locations`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ from: `${fechaYYYYMMDD}T00:00:00`, to: `${fechaYYYYMMDD}T23:59:59` })
        }, 8000);

        if (!locRes.ok) return null;
        const locData = await locRes.json();
        const puntos = Array.isArray(locData) ? locData : (locData.data || locData.locations || []);
        if (puntos.length === 0) return null;

        const enMovimiento = puntos.filter(p => (p.speed || p.Speed || 0) > 0 || (Array.isArray(p.inputs) && p.inputs[0] === true));
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

        const odoIni = puntos[0].milleage || puntos[0].mileage || 0;
        const odoFin = puntos[puntos.length - 1].milleage || puntos[puntos.length - 1].mileage || 0;
        let distanciaMetros = 0;
        if (odoFin > odoIni) {
            distanciaMetros = (odoFin - odoIni) * 1000;
        } else {
            const sumaDist = puntos.reduce((acc, p) => acc + (p.distance || p.Distance || 0), 0);
            distanciaMetros = sumaDist > 1000 ? sumaDist : sumaDist * 1000;
        }

        const duracionMs = pFin > pInicio ? (pFin.getTime() - pInicio.getTime()) : 0;
        return {
            inicio: pInicio, fin: pFin || pInicio, distancia: distanciaMetros, duracion: duracionMs,
            totalViajes: enMovimiento.length
        };
    } catch (e) { return null; }
}

async function extraerDiaCompletoTraccar(serverUrl, token, deviceId, fechaYYYYMMDD) {
    const fromStr = encodeURIComponent(new Date(`${fechaYYYYMMDD}T00:00:00-05:00`).toISOString());
    const toStr = encodeURIComponent(new Date(`${fechaYYYYMMDD}T23:59:59-05:00`).toISOString());
    let inicioDate = null; let finDate = null; let distanciaMetros = 0; let duracionMs = 0; let totalEventos = 0; let listaTrips = [];

    try {
        const tripsRes = await fetchConTimeout(`${serverUrl}/api/reports/trips?deviceId=${deviceId}&from=${fromStr}&to=${toStr}&token=${token}`, { headers: { 'Accept': 'application/json' } }, 7000);
        if (tripsRes.ok) {
            const trips = await tripsRes.json();
            if (Array.isArray(trips) && trips.length > 0) {
                listaTrips = trips;
                inicioDate = new Date(trips[0].startTime);
                finDate = new Date(trips[trips.length - 1].endTime);
                distanciaMetros = trips.reduce((acc, t) => acc + (t.distance || 0), 0);
                duracionMs = trips.reduce((acc, t) => acc + (t.duration || 0), 0);
                totalEventos = trips.length;
            }
        }
    } catch (e) {}

    const mismoMinuto = inicioDate && finDate && formatearHora24Colombia(inicioDate) === formatearHora24Colombia(finDate);
    if (!inicioDate || mismoMinuto || distanciaMetros < 50) {
        try {
            const posRes = await fetchConTimeout(`${serverUrl}/api/positions?deviceId=${deviceId}&from=${fromStr}&to=${toStr}&token=${token}`, { headers: { 'Accept': 'application/json' } }, 8000);
            if (posRes.ok) {
                const positions = await posRes.json();
                if (Array.isArray(positions) && positions.length > 0) {
                    const activos = positions.filter(p => (p.speed && p.speed > 0) || p.attributes?.ignition === true || p.attributes?.motion === true);
                    const listaUsar = activos.length > 0 ? activos : positions;
                    const pInicio = new Date(listaUsar[0].fixTime || listaUsar[0].deviceTime || listaUsar[0].serverTime);
                    const pFin = new Date(listaUsar[listaUsar.length - 1].fixTime || listaUsar[listaUsar.length - 1].deviceTime || listaUsar[listaUsar.length - 1].serverTime);

                    if (!inicioDate || pInicio < inicioDate) inicioDate = pInicio;
                    if (!finDate || pFin > finDate) finDate = pFin;

                    const distOdo = (positions[positions.length - 1].attributes?.totalDistance || 0) - (positions[0].attributes?.totalDistance || 0);
                    if (distOdo > distanciaMetros) distanciaMetros = distOdo;
                    if (finDate > inicioDate) duracionMs = Math.max(duracionMs, finDate.getTime() - inicioDate.getTime());
                    totalEventos = Math.max(totalEventos, listaUsar.length);
                }
            }
        } catch (e) {}
    }

    if (!inicioDate) return null;
    return { inicio: inicioDate, fin: finDate || inicioDate, distancia: distanciaMetros, duracion: duracionMs, totalViajes: totalEventos, viajes: listaTrips };
}

// 9.1 DASHBOARD PRINCIPAL DE AUDITORÍA GPS
app.get('/admin/auditoria-horas', verificarRol(['admin']), async (req, res) => {
    try {
        const mesActual = req.query.mes || new Date().toISOString().slice(0, 7); 
        const placaSeleccionada = req.query.placa || 'TODOS';
        
        const vehiculosDB = await prisma.vehiculo.findMany({ orderBy: { placa: 'asc' } });
        const conductoresDB = await prisma.usuario.findMany({ where: { rol: 'conductor' }, orderBy: { nombre: 'asc' } });

        const [traccarConn, plaspyConn] = await Promise.all([obtenerDispositivosTraccar(), obtenerDispositivosPlaspy()]);

        const traccarDevices = traccarConn.devices;
        const serverUrl = traccarConn.serverUrl;
        const token = traccarConn.token;
        const plaspyDevices = plaspyConn.devices;
        const dispositivosCombinados = [...traccarDevices, ...plaspyDevices];

        const mapaPlacas = new Map();
        vehiculosDB.forEach(v => mapaPlacas.set(limpiarPlaca(v.placa), v.placa.toUpperCase()));
        dispositivosCombinados.forEach(d => {
            const limpia = limpiarPlaca(d.name);
            if (limpia && !mapaPlacas.has(limpia)) mapaPlacas.set(limpia, d.name.toUpperCase());
        });
        const listaPlacasUnificada = Array.from(mapaPlacas.values()).sort().map(p => ({ placa: p }));

        const [yearStr, monthStr] = mesActual.split('-');
        const year = parseInt(yearStr); const month = parseInt(monthStr) - 1;
        const ultimoDiaNum = new Date(year, month + 1, 0).getDate();
        const startDateISO = new Date(`${mesActual}-01T00:00:00-05:00`);
        const endDateISO = new Date(`${mesActual}-${String(ultimoDiaNum).padStart(2, '0')}T23:59:59-05:00`);
        const ahora = new Date(); const toDateConsulta = endDateISO > ahora ? ahora : endDateISO;

        const inspecciones = await prisma.inspeccion.findMany({
            where: { eliminado: false, fecha_apertura: { gte: startDateISO, lte: endDateISO } },
            include: { conductor: true }, orderBy: { fecha_apertura: 'desc' }
        });

        let inspDataTodas = {}; let inspData = {}; let ultimoConductorPorPlaca = {};

        inspecciones.forEach(insp => {
            const clavePlaca = limpiarPlaca(insp.vehiculo_placa);
            const dateStr = obtenerFechaColombiaYYYYMMDD(insp.fecha_apertura);
            const nombreCond = (insp.datos_chequeo?.conductor_manual || insp.conductor?.nombre || '').trim();

            if (nombreCond && !ultimoConductorPorPlaca[clavePlaca]) ultimoConductorPorPlaca[clavePlaca] = nombreCond;
            if (!inspDataTodas[clavePlaca]) inspDataTodas[clavePlaca] = { nombreOriginal: insp.vehiculo_placa.toUpperCase(), dias: {} };
            
            const existenteGlobal = inspDataTodas[clavePlaca].dias[dateStr];
            if (!existenteGlobal || (!existenteGlobal.datos_chequeo?.inicio_gps && insp.datos_chequeo?.inicio_gps) || new Date(insp.fecha_apertura) < new Date(existenteGlobal.fecha_apertura)) {
                inspDataTodas[clavePlaca].dias[dateStr] = insp;
            }

            if (placaSeleccionada !== 'TODOS' && clavePlaca !== limpiarPlaca(placaSeleccionada)) return;
            
            if (!inspData[clavePlaca]) inspData[clavePlaca] = { nombreOriginal: insp.vehiculo_placa.toUpperCase(), dias: {} };
            inspData[clavePlaca].dias[dateStr] = inspDataTodas[clavePlaca].dias[dateStr];
        });

        if (!req.query.placa && !req.query.mes) {
            return res.render('auditoria-horas', { title: 'Dashboard Auditoría GPS', registros: [], topConductoresMes: [], mesActual, placaSeleccionada, vehiculos: listaPlacasUnificada, conductores: conductoresDB, traccarDevices: dispositivosCombinados, usuario: req.usuario });
        }

        let traccarDays = {};
        if (traccarDevices.length > 0) {
            const placaLimpiaSel = limpiarPlaca(placaSeleccionada);
            const placasConInspSet = new Set(Object.keys(inspDataTodas));
            let devicesToQuery = traccarDevices.filter(d => {
                const lp = limpiarPlaca(d.name); const lu = limpiarPlaca(d.uniqueId);
                const esSeleccionada = (placaSeleccionada !== 'TODOS') && (lp === placaLimpiaSel || lu === placaLimpiaSel || lp.includes(placaLimpiaSel));
                return esSeleccionada || placasConInspSet.has(lp);
            });
            if (devicesToQuery.length === 0 && placaSeleccionada === 'TODOS') devicesToQuery = traccarDevices.slice(0, 15);
            else devicesToQuery = devicesToQuery.slice(0, 20);

            if (devicesToQuery.length > 0) {
                const deviceIdsParam = devicesToQuery.map(d => `deviceId=${d.id}`).join('&');
                const rangosSemanales = [ { d1: 1, d2: 8 }, { d1: 9, d2: 16 }, { d1: 17, d2: 24 }, { d1: 25, d2: ultimoDiaNum } ];

                await Promise.all(rangosSemanales.map(async (rango) => {
                    const fInicio = new Date(`${mesActual}-${String(rango.d1).padStart(2, '0')}T00:00:00-05:00`);
                    const fFin = new Date(`${mesActual}-${String(rango.d2).padStart(2, '0')}T23:59:59-05:00`);
                    if (fInicio > toDateConsulta) return;
                    const fFinReal = fFin > toDateConsulta ? toDateConsulta : fFin;
                    const url = `${serverUrl}/api/reports/trips?${deviceIdsParam}&from=${encodeURIComponent(fInicio.toISOString())}&to=${encodeURIComponent(fFinReal.toISOString())}&token=${token}`;
                    try {
                        const resTrips = await fetchConTimeout(url, { headers: { 'Accept': 'application/json' } }, 8500);
                        if (resTrips.ok) {
                            const trips = await resTrips.json();
                            trips.forEach(trip => {
                                const dev = traccarDevices.find(d => d.id === trip.deviceId);
                                const placaNombre = dev ? dev.name.toUpperCase() : placaSeleccionada.toUpperCase();
                                const clavePlaca = limpiarPlaca(placaNombre);
                                const tStart = new Date(trip.startTime); const tEnd = new Date(trip.endTime);
                                const dateStr = obtenerFechaColombiaYYYYMMDD(tStart);
                                const distPositiva = Math.max(0, Number(trip.distance || 0));

                                if (!traccarDays[clavePlaca]) traccarDays[clavePlaca] = { nombreOriginal: placaNombre, dias: {} };
                                if (!traccarDays[clavePlaca].dias[dateStr]) {
                                    traccarDays[clavePlaca].dias[dateStr] = { inicio: tStart, fin: tEnd, distancia: distPositiva, duracion: Math.max(0, Number(trip.duration || 0)), deviceId: dev ? dev.id : '', viajes: [trip] };
                                } else {
                                    if (tStart < traccarDays[clavePlaca].dias[dateStr].inicio) traccarDays[clavePlaca].dias[dateStr].inicio = tStart;
                                    if (tEnd > traccarDays[clavePlaca].dias[dateStr].fin) traccarDays[clavePlaca].dias[dateStr].fin = tEnd;
                                    traccarDays[clavePlaca].dias[dateStr].distancia += distPositiva;
                                    traccarDays[clavePlaca].dias[dateStr].duracion += Math.max(0, Number(trip.duration || 0));
                                    traccarDays[clavePlaca].dias[dateStr].viajes.push(trip);
                                }
                            });
                        }
                    } catch (e) {}
                }));

                // RESCATE TRACCAR PARA DÍAS EN BLANCO Y SIN APP (CUANDO SE FILTRA UNA PLACA)
                if (placaSeleccionada !== 'TODOS') {
                    const devPrincipal = devicesToQuery.find(d => limpiarPlaca(d.name).includes(placaLimpiaSel)) || devicesToQuery[0];
                    if (devPrincipal) {
                        const clavePlaca = limpiarPlaca(placaSeleccionada);
                        let diasAFetch = [];
                        for(let i=1; i<=ultimoDiaNum; i++) {
                            const diaCheck = new Date(year, month, i);
                            if (diaCheck > toDateConsulta) break;
                            const dStr = diaCheck.toISOString().split('T')[0];
                            if(!traccarDays[clavePlaca]?.dias?.[dStr]) diasAFetch.push(dStr);
                        }
                        await Promise.all(diasAFetch.map(async (dateStr) => {
                            const datosRescate = await extraerDiaCompletoTraccar(serverUrl, token, devPrincipal.id, dateStr);
                            if (datosRescate) {
                                if (!traccarDays[clavePlaca]) traccarDays[clavePlaca] = { nombreOriginal: devPrincipal.name.toUpperCase(), dias: {} };
                                traccarDays[clavePlaca].dias[dateStr] = { ...datosRescate, distancia: Math.max(0, Number(datosRescate.distancia || 0)), deviceId: devPrincipal.id };
                            }
                        }));
                    }
                }
            }
        }

        // RESCATE PLASPY PARA DÍAS EN BLANCO Y SIN APP (CUANDO SE FILTRA UNA PLACA)
        if (placaSeleccionada !== 'TODOS' && plaspyDevices.length > 0) {
            const clavePlaca = limpiarPlaca(placaSeleccionada);
            const devPlaspy = plaspyDevices.find(d => limpiarPlaca(d.name) === clavePlaca || limpiarPlaca(d.name).includes(clavePlaca));

            if (devPlaspy) {
                let diasAFetch = [];
                for(let i=1; i<=ultimoDiaNum; i++) {
                    const diaCheck = new Date(year, month, i);
                    if (diaCheck > toDateConsulta) break;
                    diasAFetch.push(diaCheck.toISOString().split('T')[0]);
                }
                
                await Promise.all(diasAFetch.map(async (dateStr) => {
                    if (traccarDays[clavePlaca]?.dias?.[dateStr]) return;
                    const datosPlaspy = await extraerDiaCompletoPlaspy(devPlaspy.token, devPlaspy.rawId, dateStr);
                    if (datosPlaspy) {
                        if (!traccarDays[clavePlaca]) traccarDays[clavePlaca] = { nombreOriginal: devPlaspy.name.toUpperCase(), dias: {} };
                        traccarDays[clavePlaca].dias[dateStr] = { ...datosPlaspy, deviceId: devPlaspy.id };
                    }
                }));
            }
        }

        let auditoria = [];
        let promesasGuardarCacheGps = [];
        const clavesPlacasTabla = new Set([...Object.keys(traccarDays), ...Object.keys(inspData)]);

        clavesPlacasTabla.forEach(clavePlaca => {
            if (placaSeleccionada !== 'TODOS' && clavePlaca !== limpiarPlaca(placaSeleccionada)) return;

            const infoTraccar = traccarDays[clavePlaca]?.dias || {};
            const infoApp = inspData[clavePlaca]?.dias || {};
            const placaMostrar = inspData[clavePlaca]?.nombreOriginal || traccarDays[clavePlaca]?.nombreOriginal || clavePlaca;
            const devAsociado = dispositivosCombinados.find(d => limpiarPlaca(d.name) === clavePlaca || limpiarPlaca(d.name).includes(clavePlaca));

            const todosLosDias = new Set([...Object.keys(infoTraccar), ...Object.keys(infoApp)]);
            const diasOrdenados = Array.from(todosLosDias).sort((a, b) => b.localeCompare(a));

            diasOrdenados.forEach(dateStr => {
                const trData = infoTraccar[dateStr];
                const inData = infoApp[dateStr];
                const datosJSON = inData?.datos_chequeo || {};
                const sinAppManual = datosJSON.sin_app === true;

                let inicioApp24 = ''; let finApp24 = '';
                if (inData && !sinAppManual) {
                    inicioApp24 = datosJSON.inicio_app_manual ? formatearHora24Colombia(datosJSON.inicio_app_manual) : formatearHora24Colombia(inData.fecha_apertura);
                    if (datosJSON.fin_app_manual) finApp24 = formatearHora24Colombia(datosJSON.fin_app_manual);
                    else if (inData.fecha_cierre) finApp24 = formatearHora24Colombia(inData.fecha_cierre);
                }

                let inicioGPS24 = datosJSON.inicio_gps ? formatearHora24Colombia(datosJSON.inicio_gps) : '';
                let finGPS24 = datosJSON.fin_gps ? formatearHora24Colombia(datosJSON.fin_gps) : '';

                if (!inicioGPS24 && trData) inicioGPS24 = formatearHora24Colombia(trData.inicio);
                if (!finGPS24 && trData) finGPS24 = formatearHora24Colombia(trData.fin);

                let distNum = (datosJSON.distancia_gps !== undefined && datosJSON.distancia_gps !== '' && Number(datosJSON.distancia_gps) >= 0)
                    ? parseFloat(datosJSON.distancia_gps)
                    : (trData ? Math.max(0, trData.distancia / 1000) : 0);
                let distKm = Math.max(0, distNum).toFixed(2);

                let horasMotorStr = datosJSON.horas_motor_gps || '0h 0m';
                if (inicioGPS24 && finGPS24) {
                    const [h1, m1] = inicioGPS24.split(':').map(Number);
                    const [h2, m2] = finGPS24.split(':').map(Number);
                    const diffM = (h2 * 60 + m2) - (h1 * 60 + m1);
                    if (diffM > 0) horasMotorStr = `${Math.floor(diffM / 60)}h ${diffM % 60}m`;
                    else if (trData && trData.duracion > 0) {
                        const mins = Math.floor(trData.duracion / 60000);
                        horasMotorStr = `${Math.floor(mins / 60)}h ${mins % 60}m`;
                    }
                }

                const traccarDevIdFinal = datosJSON.traccar_device_id || (trData ? trData.deviceId : (devAsociado ? devAsociado.id : ''));

                if (inData && (!datosJSON.inicio_gps || !datosJSON.fin_gps) && inicioGPS24 && finGPS24) {
                    const nuevosDatos = { ...datosJSON, inicio_gps: inicioGPS24, fin_gps: finGPS24, distancia_gps: parseFloat(distKm), horas_motor_gps: horasMotorStr, traccar_device_id: traccarDevIdFinal };
                    inData.datos_chequeo = nuevosDatos;
                    promesasGuardarCacheGps.push(prisma.inspeccion.update({ where: { id: inData.id }, data: { datos_chequeo: nuevosDatos } }).catch(() => {}));
                }

                const rangoActual = (finApp24 && finGPS24) ? `${finApp24}-${finGPS24}` : '';
                const kmGuardadoValido = (datosJSON.km_extra_rango === rangoActual && datosJSON.km_extra_gps !== undefined) ? datosJSON.km_extra_gps : null;
                const infoPostPlanilla = calcularResumenPostPlanilla(dateStr, finApp24, finGPS24, trData?.viajes || [], kmGuardadoValido);

                let diffMinutos = '-'; let detalleDiffInicio = ''; let estadoNumero = 5; let estadoTexto = 'INSPECCIÓN SIN GPS';

                if (inicioGPS24 && inicioApp24) {
                    const [hApp, mApp] = inicioApp24.split(':').map(Number); const [hGps, mGps] = inicioGPS24.split(':').map(Number);
                    const deltaMin = (hGps * 60 + mGps) - (hApp * 60 + mApp);
                    const diffInicio = Math.round(Math.abs(deltaMin));
                    diffMinutos = diffInicio;

                    if (deltaMin > 0) detalleDiffInicio = `GPS inició +${diffInicio} min después`;
                    else if (deltaMin < 0) detalleDiffInicio = `GPS inició ${diffInicio} min antes`;
                    else detalleDiffInicio = 'Sincronizado (0 min)';

                    if (diffInicio > 30) { estadoNumero = 3; estadoTexto = 'CRÍTICO'; } 
                    else if (diffInicio >= 20) { estadoNumero = 2; estadoTexto = 'REVISAR'; } 
                    else { estadoNumero = 1; estadoTexto = 'ÓPTIMO'; }
                } else if (inicioGPS24 && !inicioApp24) {
                    estadoNumero = 4; estadoTexto = 'MOVIMIENTO SIN APP'; diffMinutos = 'Fuga Detectada';
                } else if (!inicioGPS24 && inicioApp24) {
                    estadoNumero = 5; estadoTexto = 'INSPECCIÓN SIN GPS'; diffMinutos = 'Sin GPS';
                } else {
                    estadoNumero = 5; estadoTexto = 'REGISTRO MANUAL'; diffMinutos = 'Pendiente Horas';
                }

                auditoria.push({
                    id: inData ? inData.id : 'nuevo', fecha: dateStr, placa: placaMostrar,
                    conductor: inData ? (datosJSON.conductor_manual || inData.conductor.nombre) : (ultimoConductorPorPlaca[clavePlaca] ? `${ultimoConductorPorPlaca[clavePlaca]} (Sin App)` : 'N/A (Sin App)'),
                    inicioApp: inicioApp24, finApp: finApp24, inicioGPS: inicioGPS24, finGPS: finGPS24,
                    distancia: distKm, horasMotor: horasMotorStr, diffMinutos, detalleDiffInicio,
                    diffFinMin: infoPostPlanilla.diffFinMin, tiempoExtraStr: infoPostPlanilla.tiempoExtraStr,
                    diffCobroExtraMin: infoPostPlanilla.diffCobroExtraMin, tiempoCobroExtraStr: infoPostPlanilla.tiempoCobroExtraStr, 
                    rangoExtra12h: infoPostPlanilla.rangoExtra12h, kmExtra: infoPostPlanilla.kmExtra,
                    necesitaCalculoExactoPos: (infoPostPlanilla.diffFinMin > 0 && kmGuardadoValido === null && !!traccarDevIdFinal),
                    estadoNumero, estadoTexto, traccarDeviceId: traccarDevIdFinal
                });
            });
        });

        const rankingConductoresMap = {};
        Object.keys(inspDataTodas).forEach(clavePlaca => {
            const diasPlaca = inspDataTodas[clavePlaca].dias;
            Object.keys(diasPlaca).forEach(dateStr => {
                const inData = diasPlaca[dateStr];
                const datosJSON = inData?.datos_chequeo || {};
                if (datosJSON.sin_app === true) return;

                const nombreCond = (datosJSON.conductor_manual || inData?.conductor?.nombre || '').trim();
                if (!nombreCond || nombreCond === 'N/A (Sin App)') return;

                if (!rankingConductoresMap[nombreCond]) {
                    rankingConductoresMap[nombreCond] = { conductor: nombreCond, optimos: 0, revisar: 0, criticos: 0, totalInspecciones: 0, sumaDiffMin: 0, conGps: 0 };
                }
                const statsCond = rankingConductoresMap[nombreCond];
                statsCond.totalInspecciones++;

                const inicioApp24 = datosJSON.inicio_app_manual ? formatearHora24Colombia(datosJSON.inicio_app_manual) : formatearHora24Colombia(inData.fecha_apertura);
                const trData = traccarDays[clavePlaca]?.dias?.[dateStr];
                const inicioGPS24 = datosJSON.inicio_gps ? formatearHora24Colombia(datosJSON.inicio_gps) : (trData ? formatearHora24Colombia(trData.inicio) : '');

                if (!datosJSON.inicio_gps && inicioGPS24 && trData) {
                    const finGPS24 = formatearHora24Colombia(trData.fin);
                    const nuevosDatosGlobal = { ...datosJSON, inicio_gps: inicioGPS24, fin_gps: finGPS24, traccar_device_id: trData.deviceId || '' };
                    promesasGuardarCacheGps.push(prisma.inspeccion.update({ where: { id: inData.id }, data: { datos_chequeo: nuevosDatosGlobal } }).catch(() => {}));
                }

                if (inicioApp24 && inicioGPS24) {
                    const [hApp, mApp] = inicioApp24.split(':').map(Number); const [hGps, mGps] = inicioGPS24.split(':').map(Number);
                    const diffInicio = Math.round(Math.abs((hGps * 60 + mGps) - (hApp * 60 + mApp)));
                    statsCond.conGps++; statsCond.sumaDiffMin += diffInicio;
                    if (diffInicio < 20) statsCond.optimos++; else if (diffInicio <= 30) statsCond.revisar++; else statsCond.criticos++;
                }
            });
        });

        if (promesasGuardarCacheGps.length > 0) await Promise.all(promesasGuardarCacheGps);

        let listaConductoresMes = Object.values(rankingConductoresMap);
        listaConductoresMes.sort((a, b) => {
            if (b.optimos !== a.optimos) return b.optimos - a.optimos;
            if (b.revisar !== a.revisar) return b.revisar - a.revisar;
            if (b.conGps !== a.conGps) return b.conGps - a.conGps;
            const promA = a.conGps > 0 ? (a.sumaDiffMin / a.conGps) : 9999;
            const promB = b.conGps > 0 ? (b.sumaDiffMin / b.conGps) : 9999;
            if (promA !== promB) return promA - promB;
            return b.totalInspecciones - a.totalInspecciones;
        });

        const topConductoresMes = listaConductoresMes.slice(0, 5).map(c => ({
            conductor: c.conductor, optimos: c.optimos, revisar: c.revisar, criticos: c.criticos, totalInspecciones: c.totalInspecciones,
            promedioDiff: c.conGps > 0 ? Math.round(c.sumaDiffMin / c.conGps) : null
        }));

        const filasPorRefinar = auditoria.filter(r => r.necesitaCalculoExactoPos).slice(0, 15);
        if (filasPorRefinar.length > 0) {
            await Promise.all(filasPorRefinar.map(async (reg) => {
                const clavePlaca = limpiarPlaca(reg.placa);
                const viajesDia = traccarDays[clavePlaca]?.dias?.[reg.fecha]?.viajes || [];
                const kmExacto = await extraerKmIntervaloTraccar(serverUrl, token, reg.traccarDeviceId, reg.fecha, reg.finApp, reg.finGPS, viajesDia);
                reg.kmExtra = kmExacto;

                if (reg.id && reg.id !== 'nuevo') {
                    try {
                        const insp = await prisma.inspeccion.findUnique({ where: { id: parseInt(reg.id) } });
                        if (insp) {
                            let d = insp.datos_chequeo || {};
                            d.km_extra_gps = parseFloat(kmExacto); d.km_extra_rango = `${reg.finApp}-${reg.finGPS}`;
                            await prisma.inspeccion.update({ where: { id: insp.id }, data: { datos_chequeo: d } });
                        }
                    } catch (e) {}
                }
            }));
        }

        auditoria.sort((a, b) => b.fecha.localeCompare(a.fecha));

        res.render('auditoria-horas', {
            title: 'Dashboard Auditoría GPS', registros: auditoria, topConductoresMes, mesActual, placaSeleccionada, vehiculos: listaPlacasUnificada, conductores: conductoresDB, traccarDevices: dispositivosCombinados, usuario: req.usuario
        });
    } catch (error) {
        res.status(500).send('Error generando análisis: ' + error.message);
    }
});

app.post('/admin/auditoria-horas/crear-manual', verificarRol(['admin']), async (req, res) => {
    try {
        const { placa_select, placa_nueva, conductor_id, conductor_manual, fecha, inicio_app, fin_app, inicio_gps, fin_gps, distancia_gps } = req.body;
        const placaFinal = (placa_nueva && placa_nueva.trim() !== '' ? placa_nueva : placa_select).toUpperCase().trim();
        if (!placaFinal || !fecha) return res.status(400).json({ success: false, error: 'La placa y la fecha son obligatorias.' });

        await prisma.vehiculo.upsert({ where: { placa: placaFinal }, update: {}, create: { placa: placaFinal, tipo: 'Otro', modelo: '2025' } });
        let idConductorFinal = conductor_id ? parseInt(conductor_id) : req.usuario.id;
        const horaApertura = inicio_app && inicio_app.trim() !== '' ? inicio_app : (inicio_gps || '06:00');
        const fechaAperturaObj = new Date(`${fecha}T${horaApertura}:00-05:00`);
        const fechaCierreObj = fin_app && fin_app.trim() !== '' ? new Date(`${fecha}T${fin_app}:00-05:00`) : fechaAperturaObj;

        await prisma.inspeccion.create({
            data: {
                vehiculo_placa: placaFinal, conductor_id: idConductorFinal, fecha_apertura: fechaAperturaObj, fecha_cierre: fechaCierreObj, estado: 'Finalizada', kilometraje_salida: 0,
                datos_chequeo: { registro_manual: true, sin_app: (!inicio_app || inicio_app.trim() === ''), conductor_manual: conductor_manual || null, inicio_app_manual: formatearHora24Colombia(inicio_app), fin_app_manual: formatearHora24Colombia(fin_app), inicio_gps: formatearHora24Colombia(inicio_gps), fin_gps: formatearHora24Colombia(fin_gps), distancia_gps: distancia_gps ? parseFloat(distancia_gps) : 0 }
            }
        });
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/admin/auditoria-horas/actualizar-fila', verificarRol(['admin']), async (req, res) => {
    try {
        const { id, placa, fecha, inicio_app, fin_app, inicio_gps, fin_gps, distancia_gps } = req.body;
        if (id && id !== 'nuevo') {
            const insp = await prisma.inspeccion.findUnique({ where: { id: parseInt(id) } });
            if (!insp) return res.status(404).json({ success: false, error: 'Registro no encontrado' });

            let datos = insp.datos_chequeo || {};
            datos.inicio_gps = formatearHora24Colombia(inicio_gps); datos.fin_gps = formatearHora24Colombia(fin_gps);
            if (inicio_app !== undefined) { datos.inicio_app_manual = formatearHora24Colombia(inicio_app); datos.sin_app = (inicio_app.trim() === ''); }
            if (fin_app !== undefined) datos.fin_app_manual = formatearHora24Colombia(fin_app);
            if (distancia_gps !== undefined) datos.distancia_gps = parseFloat(distancia_gps) || 0;

            await prisma.inspeccion.update({ where: { id: parseInt(id) }, data: { datos_chequeo: datos } });
        } else {
            const placaFinal = placa.toUpperCase().trim();
            await prisma.vehiculo.upsert({ where: { placa: placaFinal }, update: {}, create: { placa: placaFinal, tipo: 'Otro', modelo: '2025' } });
            const horaRef = inicio_app || inicio_gps || '06:00';
            const fechaObj = new Date(`${fecha}T${horaRef}:00-05:00`);

            await prisma.inspeccion.create({
                data: {
                    vehiculo_placa: placaFinal, conductor_id: req.usuario.id, fecha_apertura: fechaObj, fecha_cierre: fechaObj, estado: 'Finalizada', kilometraje_salida: 0,
                    datos_chequeo: { registro_manual: true, sin_app: (!inicio_app || inicio_app.trim() === ''), inicio_app_manual: formatearHora24Colombia(inicio_app), fin_app_manual: formatearHora24Colombia(fin_app), inicio_gps: formatearHora24Colombia(inicio_gps), fin_gps: formatearHora24Colombia(fin_gps), distancia_gps: parseFloat(distancia_gps) || 0 }
                }
            });
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/admin/auditoria-horas/sincronizar-fila', verificarRol(['admin']), async (req, res) => {
    try {
        const { id, placa, deviceId, fecha } = req.body;
        let datosDia = null;

        if (deviceId && deviceId.toString().startsWith('PLASPY:')) {
            const [prefix, alias, rawId] = deviceId.toString().split(':');
            const cuenta = CUENTAS_PLASPY.find(c => c.alias === alias);
            const token = await obtenerTokenPlaspyUnico(cuenta);
            datosDia = await extraerDiaCompletoPlaspy(token, rawId, fecha);
        } else {
            const { serverUrl, token } = await obtenerDispositivosTraccar();
            datosDia = await extraerDiaCompletoTraccar(serverUrl, token, parseInt(deviceId), fecha);
        }

        if (!datosDia) return res.json({ success: false, error: `El vehículo no registra viajes el día ${fecha}.` });

        const inicio_gps = formatearHora24Colombia(datosDia.inicio);
        const fin_gps = formatearHora24Colombia(datosDia.fin);
        const distTotalKm = (datosDia.distancia / 1000).toFixed(2);
        const durMins = Math.floor(datosDia.duracion / 60000);
        const horasMotor = `${Math.floor(durMins / 60)}h ${durMins % 60}m`;

        if (id && id !== 'nuevo') {
            const insp = await prisma.inspeccion.findUnique({ where: { id: parseInt(id) } });
            let datos = insp ? (insp.datos_chequeo || {}) : {};
            datos.inicio_gps = inicio_gps; datos.fin_gps = fin_gps; datos.distancia_gps = parseFloat(distTotalKm);
            datos.horas_motor_gps = horasMotor; datos.traccar_device_id = deviceId;
            await prisma.inspeccion.update({ where: { id: parseInt(id) }, data: { datos_chequeo: datos } });
        }
        res.json({ success: true, inicio_gps, fin_gps, distancia: distTotalKm });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// MAPA TRAMO INTEGRADO PARA TRACCAR (CON BEARER TOKEN) Y PLASPY
app.get('/admin/auditoria-horas/mapa-tramo', verificarRol(['admin']), async (req, res) => {
    try {
        const { deviceId, placa, fecha, desde, hasta } = req.query;
        if (!fecha || !desde || !hasta) return res.status(400).json({ success: false, error: 'Faltan parámetros.' });

        const isPlaspy = deviceId && deviceId.toString().startsWith('PLASPY:');
        const fromISO = new Date(`${fecha}T${desde}:00-05:00`).toISOString();
        const toISO = new Date(`${fecha}T${hasta}:59-05:00`).toISOString();

        let coordenadas = [];
        let paradas = [];
        let kmTramo = '0.00';

        if (isPlaspy) {
            const [prefix, alias, rawId] = deviceId.toString().split(':');
            const cuenta = CUENTAS_PLASPY.find(c => c.alias === alias);
            if (!cuenta) throw new Error('Cuenta Plaspy no encontrada.');
            const token = await obtenerTokenPlaspyUnico(cuenta);

            const locRes = await fetchConTimeout(`https://api.plaspy.com/api/devices/${encodeURIComponent(rawId)}/locations`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ from: fromISO.replace('.000Z', ''), to: toISO.replace('.000Z', '') })
            }, 10000);

            if (!locRes.ok) throw new Error(`Plaspy HTTP ${locRes.status}`);
            const locData = await locRes.json();
            let puntosValidos = Array.isArray(locData) ? locData : (locData.data || locData.locations || []);
            
            puntosValidos = puntosValidos.filter(p => p.latitude || p.Latitude);
            puntosValidos.sort((a, b) => new Date(a.dateTime || a.DateTime) - new Date(b.dateTime || b.DateTime));
            
            if (puntosValidos.length === 0) return res.json({ success: false, error: 'Sin coordenadas en ese horario en Plaspy.' });

            const odoIni = puntosValidos[0].milleage || puntosValidos[0].mileage || 0;
            const odoFin = puntosValidos[puntosValidos.length - 1].milleage || puntosValidos[puntosValidos.length - 1].mileage || 0;
            if (odoFin > odoIni) kmTramo = (odoFin - odoIni).toFixed(2);
            else {
                let sumaDist = puntosValidos.reduce((acc, p) => acc + (p.distance || p.Distance || 0), 0);
                kmTramo = (sumaDist > 1000 ? sumaDist / 1000 : sumaDist).toFixed(2);
            }

            let inicioParada = null; let ultimoPuntoParada = null;

            puntosValidos.forEach((p) => {
                const lat = p.latitude || p.Latitude; const lng = p.longitude || p.Longitude;
                const velKmh = (p.speed || p.Speed || 0).toFixed(1);
                coordenadas.push({ lat: lat, lng: lng, hora: formatearHora12Colombia(p.dateTime || p.DateTime), vel: velKmh, ign: (Array.isArray(p.inputs) && p.inputs[0] === true) });

                if (parseFloat(velKmh) < 1.0) {
                    if (!inicioParada) inicioParada = p; ultimoPuntoParada = p;
                } else {
                    if (inicioParada && ultimoPuntoParada) {
                        const durMin = Math.round((new Date(ultimoPuntoParada.dateTime || ultimoPuntoParada.DateTime) - new Date(inicioParada.dateTime || inicioParada.DateTime)) / 60000);
                        if (durMin >= 2) paradas.push({ lat: inicioParada.latitude || inicioParada.Latitude, lng: inicioParada.longitude || inicioParada.Longitude, desde: formatearHora12Colombia(inicioParada.dateTime || inicioParada.DateTime), hasta: formatearHora12Colombia(ultimoPuntoParada.dateTime || ultimoPuntoParada.DateTime), duracionMin: durMin });
                    }
                    inicioParada = null; ultimoPuntoParada = null;
                }
            });
            
            if (inicioParada && ultimoPuntoParada) {
                const durMin = Math.round((new Date(ultimoPuntoParada.dateTime || ultimoPuntoParada.DateTime) - new Date(inicioParada.dateTime || inicioParada.DateTime)) / 60000);
                if (durMin >= 2) paradas.push({ lat: inicioParada.latitude || inicioParada.Latitude, lng: inicioParada.longitude || inicioParada.Longitude, desde: formatearHora12Colombia(inicioParada.dateTime || inicioParada.DateTime), hasta: formatearHora12Colombia(ultimoPuntoParada.dateTime || ultimoPuntoParada.DateTime), duracionMin: durMin });
            }
        } else {
            // LÓGICA TRACCAR RESTAURADA Y PROBADA CON BEARER TOKEN EN HEADERS
            const { devices, serverUrl, token } = await obtenerDispositivosTraccar();
            let idDispositivo = deviceId ? parseInt(deviceId) : null;
            if (!idDispositivo && placa) {
                const dev = devices.find(d => limpiarPlaca(d.name) === limpiarPlaca(placa) || limpiarPlaca(d.name).includes(limpiarPlaca(placa)));
                if (dev) idDispositivo = dev.id;
            }
            if (!idDispositivo) throw new Error('Unidad Traccar no encontrada.');

            const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
            const posUrl = `${serverUrl}/api/positions?deviceId=${idDispositivo}&from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}`;
            const posRes = await fetchConTimeout(posUrl, { headers }, 10000);
            
            if (!posRes.ok) throw new Error(`Traccar HTTP ${posRes.status}`);

            const positions = await posRes.json();
            let puntosValidos = positions.filter(p => p.latitude && p.longitude);
            if (puntosValidos.length === 0) return res.json({ success: false, error: 'Sin coordenadas en ese horario en Traccar.' });

            puntosValidos.sort((a, b) => new Date(a.fixTime || a.deviceTime) - new Date(b.fixTime || b.deviceTime));
            const conOdo = puntosValidos.filter(p => p.attributes && typeof p.attributes.totalDistance === 'number' && p.attributes.totalDistance > 0);
            let metrosOdo = 0;
            if (conOdo.length >= 2) metrosOdo = conOdo[conOdo.length - 1].attributes.totalDistance - conOdo[0].attributes.totalDistance;

            let metrosHaversine = 0; let inicioParada = null; let ultimoPuntoParada = null;

            for (let i = 0; i < puntosValidos.length; i++) {
                const p = puntosValidos[i];
                if (i > 0) {
                    const d = distanciaHaversineMetros(puntosValidos[i - 1].latitude, puntosValidos[i - 1].longitude, p.latitude, p.longitude);
                    if (d >= 5 && d < 50000) metrosHaversine += d;
                }
                const velKmh = ((p.speed || 0) * 1.852).toFixed(1);
                coordenadas.push({ lat: p.latitude, lng: p.longitude, hora: formatearHora12Colombia(p.fixTime || p.deviceTime), vel: velKmh, ign: p.attributes?.ignition });

                if (parseFloat(velKmh) < 0.5) {
                    if (!inicioParada) inicioParada = p; ultimoPuntoParada = p;
                } else {
                    if (inicioParada && ultimoPuntoParada) {
                        const durMin = Math.round((new Date(ultimoPuntoParada.fixTime || ultimoPuntoParada.deviceTime) - new Date(inicioParada.fixTime || inicioParada.deviceTime)) / 60000);
                        if (durMin >= 2) paradas.push({ lat: inicioParada.latitude, lng: inicioParada.longitude, desde: formatearHora12Colombia(inicioParada.fixTime || inicioParada.deviceTime), hasta: formatearHora12Colombia(ultimoPuntoParada.fixTime || ultimoPuntoParada.deviceTime), duracionMin: durMin });
                    }
                    inicioParada = null; ultimoPuntoParada = null;
                }
            }
            if (inicioParada && ultimoPuntoParada) {
                const durMin = Math.round((new Date(ultimoPuntoParada.fixTime || ultimoPuntoParada.deviceTime) - new Date(inicioParada.fixTime || inicioParada.deviceTime)) / 60000);
                if (durMin >= 2) paradas.push({ lat: inicioParada.latitude, lng: inicioParada.longitude, desde: formatearHora12Colombia(inicioParada.fixTime || inicioParada.deviceTime), hasta: formatearHora12Colombia(ultimoPuntoParada.fixTime || ultimoPuntoParada.deviceTime), duracionMin: durMin });
            }

            kmTramo = ((metrosOdo > 0 ? metrosOdo : metrosHaversine) / 1000).toFixed(2);
        }

        res.json({
            success: true, placa, fecha,
            rango12h: `${formatearHora12Colombia(desde)} - ${formatearHora12Colombia(hasta)}`,
            kmTramo, totalPuntos: coordenadas.length, coordenadas, paradas
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Error al generar mapa: ' + error.message });
    }
});

app.get('/test-traccar', verificarRol(['admin']), async (req, res) => {
    const placaSeleccionada = req.query.placa || '';
    const fechaFiltro = req.query.fecha || new Date().toISOString().split('T')[0];
    let devices = []; let errorConexion = null; let resultado = null;

    try {
        const conn = await obtenerDispositivosTraccar();
        devices = conn.devices;
        if (devices.length === 0) throw new Error('No se encontraron dispositivos o el servidor no respondió.');

        if (placaSeleccionada && fechaFiltro) {
            const dev = devices.find(d => limpiarPlaca(d.name) === limpiarPlaca(placaSeleccionada));
            if (dev) {
                const datosDia = await extraerDiaCompletoTraccar(conn.serverUrl, conn.token, dev.id, fechaFiltro);
                if (datosDia) resultado = { encontrado: true, placa: placaSeleccionada, inicio: formatearHora12Colombia(datosDia.inicio), fin: formatearHora12Colombia(datosDia.fin), distancia: (datosDia.distancia / 1000).toFixed(2), totalViajes: datosDia.totalViajes };
                else resultado = { encontrado: false, mensaje: `El vehículo no registra viajes en la fecha ${fechaFiltro}.` };
            }
        }
    } catch (err) { errorConexion = `Error: ${err.message}`; }

    res.render('test-traccar', { errorConexion, devices, placaSeleccionada, fechaFiltro, resultado });
});

app.get('/test-plaspy', verificarRol(['admin']), async (req, res) => {
    const fecha_viaje = req.query.fecha_viaje || new Date().toISOString().split('T')[0];
    const dispositivo_id = req.query.dispositivo_id || '';
    let devices = []; let errorConexion = null; let resumenActividad = null;

    try {
        const { devices: listaPlaspy, errores } = await obtenerDispositivosPlaspy();
        devices = listaPlaspy.map(d => ({ id: d.rawId, name: d.name, token: d.token }));

        if (errores.length > 0 && devices.length === 0) errorConexion = errores.join(' | ');

        if (dispositivo_id && fecha_viaje && devices.length > 0) {
            const devInfo = devices.find(d => d.id == dispositivo_id);
            if (devInfo) {
                const datosDia = await extraerDiaCompletoPlaspy(devInfo.token, devInfo.id, fecha_viaje);
                if (datosDia) resumenActividad = { placa: devInfo.name, fecha: fecha_viaje, kilometraje: (datosDia.distancia / 1000).toFixed(2), velMaxima: datosDia.velMaxima.toFixed(1), velPromedio: datosDia.velPromedio.toFixed(1), primerMovimiento: formatearHora12Colombia(datosDia.inicio), ultimoMovimiento: formatearHora12Colombia(datosDia.fin) };
                else resumenActividad = { placa: devInfo.name, fecha: fecha_viaje, kilometraje: '0.00', velMaxima: '0', velPromedio: '0', primerMovimiento: 'Sin movimiento', ultimoMovimiento: 'Sin movimiento' };
            }
        }
    } catch (err) { errorConexion = `Aviso: ${err.message}`; }

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