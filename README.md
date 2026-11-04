# jesusiniCORD

Chat web propio inspirado en las aplicaciones de comunidades: canales, mensajes en tiempo real, cuentas de usuario y lista de usuarios conectados.

## Incluye
- Registro e inicio de sesión.
- Contraseñas protegidas con bcrypt.
- Base de datos SQLite propia (`jesusinicord.sqlite`).
- Mensajes guardados en la base de datos.
- Chat en tiempo real con Socket.IO.
- Canales `general`, `memes`, `gaming` y `music`.
- El primer usuario registrado (ID 1) puede crear canales.
- Diseño adaptable para PC y móvil.
- Perfiles con avatar GIF, banner, biografía, estado y color personalizable.
- Solicitudes de amistad y aceptación de solicitudes.
- Mensajes privados entre amigos.
- Reacciones rápidas en mensajes (👍 ❤️ 😂 🔥).
- Creación de servidores comunitarios y roles básicos asignados por su dueño.

## Ejecutar en tu PC
Necesitas Node.js 22 (el proyecto incluye `.node-version` para fijar esta versión en Render).

```bash
npm install
npm start
```

Abre http://localhost:3000

## Publicar gratis en Render
1. Descomprime el ZIP.
2. Sube **todo el contenido** de la carpeta `jesusinicord` a un repositorio nuevo de GitHub.
3. En Render elige **New + → Blueprint** y conecta ese repositorio. El archivo `.node-version` fija Node.js 22 para evitar el error de compilación de `better-sqlite3` con Node.js 26.
4. Render leerá `render.yaml`, instalará dependencias y arrancará la app.
5. Cuando termine, abre la URL que Render te asigne.

### Importante sobre la base de datos
El archivo `render.yaml` configura un disco persistente en `/var/data` para guardar SQLite entre reinicios y despliegues. El disco persistente puede no estar incluido en el nivel gratuito de Render y Render puede cobrar por él. Si Render no permite crear el disco en tu plan, la app puede arrancar con almacenamiento temporal, pero **los mensajes y cuentas podrían perderse** al reiniciar o desplegar. No prometas almacenamiento permanente sin un disco persistente o una base de datos externa.

## Seguridad y administración
- El primer usuario registrado se convierte en administrador y puede crear canales.
- Usa contraseñas únicas y difíciles de adivinar.
- Configura `JWT_SECRET` como una cadena larga y aleatoria si ejecutas fuera de Render.
- Los mensajes privados y servidores son una primera implementación básica; los MD se abren desde la lista de amigos mediante un cuadro de diálogo. Los servidores todavía no tienen canales propios ni invitaciones con enlace.
- Todavía no incluye llamadas de voz/vídeo, subida de archivos, moderación avanzada, permisos granulares, ni recuperación de contraseña. No se puede considerar un reemplazo completo de Discord todavía.
- Para una comunidad pública grande, añade límites de registro, moderación, reportes y copias de seguridad.

## Estructura
```
jesusinicord/
├── public/
│   ├── app.js
│   ├── index.html
│   ├── logo.svg
│   └── style.css
├── package.json
├── render.yaml
├── server.js
└── README.md
```
