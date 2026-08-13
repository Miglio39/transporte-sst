const jwt = require('jsonwebtoken');

function verificarRol(rolesPermitidos = []) {
    return (req, res, next) => {
        // 1. Buscamos el "pase de entrada" (token) en las cookies del navegador
        const token = req.cookies.jwt;
        
        // Si no hay token, lo mandamos a iniciar sesión
        if (!token) {
            return res.redirect('/login');
        }

        try {
            // 2. Desencriptamos el token para saber quién es
            const decodificado = jwt.verify(token, process.env.JWT_SECRET);
            req.usuario = decodificado; // Guardamos los datos del usuario en la petición

            // 3. Verificamos si su rol está en la lista de permitidos
            if (rolesPermitidos.length && !rolesPermitidos.includes(req.usuario.rol)) {
                return res.status(403).send(`
                    <div style="text-align:center; padding:50px; font-family:Arial;">
                        <h1 style="color:#e74c3c;">Acceso Denegado</h1>
                        <p>No tienes los permisos necesarios para ver esta página.</p>
                        <a href="/login" style="padding:10px 20px; background:#3498db; color:white; text-decoration:none; border-radius:5px;">Volver</a>
                    </div>
                `);
            }

            // Si todo está bien, lo dejamos pasar
            next();
        } catch (error) {
            // Si el token es falso o expiró, borramos la cookie
            res.clearCookie('jwt');
            return res.redirect('/login');
        }
    };
}

module.exports = { verificarRol };