# Astral Arena

Astral Arena es un prototipo de *arena shooter* 3D para navegador, inspirado en el ritmo de combate, los escudos recargables, el control de armas del mapa y los modos competitivos de los shooters de consola de principios de los 2000. Su identidad propia, **Arctic Orbital Dusk**, combina astronautas *hard-surface*, un campus científico extraterrestre de cerámica blanca/grafito/lima y un bosque frío que invade la instalación. Conserva una composición atmosférica estilizada, pero usa materiales PBR, vegetación densa y una iluminación de sol cálido contra sombras cian.

El diseño se concentra en dos formatos:

- **Duelo:** 1 contra 1.
- **Escuadras:** 4 contra 4.

Las plazas vacías pueden llenarse con bots. El modo local significa **un humano en un navegador contra bots**; no hay pantalla dividida.

## Estado del vertical

El repositorio contiene una **primera vertical jugable completa**, no una versión terminada ni preparada todavía para partidas públicas. Actualmente incluye:

- simulación determinista del combate, movimiento, colisiones, escudos, reapariciones, proyectiles, granadas, cuerpo a cuerpo, puntuación y objetivos;
- un mapa inicial, **Cresta del Cráter**, de 104 × 84 m, con tres rutas, dos edificios base con interiores, torre central, puestos logísticos, relay meteorológico, laboratorio hidropónico, terrazas, bermas físicas, coberturas y armas recogibles;
- seis armas, bots con tres dificultades moderadas, controles de teclado/ratón y mando, hitboxes anatómicos ampliados y audio procedural multicapa por arma;
- una capa de presentación Three.js con terreno PBR húmedo de barro, musgo, raíces, piedras, relieve, césped denso y charcos; bosque instanciado, niebla local, haces solares, puertas, cristales, rampas, barandillas, cajas, iluminación interior, sombras, bloom moderado, profundidad de campo, aberración cromática, astronautas articulados y seis armas *hard-surface* con fogonazo, trazadoras e impactos;
- animación procedural compartida entre primera y tercera persona: locomoción ligada a la distancia recorrida y diferenciada por dirección, respiración, salto, caída, aterrizaje, muerte/reaparición, retroceso, recarga, cambio de arma, cuerpo a cuerpo y lanzamiento de granada, con rodillas, pies, manos y piezas de arma móviles;
- menús, configuración 1v1/4v4, lobby manual P2P, HUD, marcador, kill feed, audio y pantalla de resultado integrados;
- transporte WebRTC P2P nativo con señalización manual, mensajes tipados y un host con hasta siete invitados;
- 125 pruebas automatizadas para combate, movimiento, auto-step de rampas y deslizamiento por paredes, hitboxes, perfiles de bots, balance inicial, objetivos, regresiones, navegación e interiores del mapa, pads de salto, acceso a la torre, puntuación, determinismo, audio, curvas de animación, texturas procedurales, arquitectura y piezas móviles de armamento.

El proyecto pasa `typecheck`, tests y build de producción. Aun así, el flujo WebRTC debe probarse con varios navegadores y redes reales antes de declarar soporte público 4v4; tampoco hay matchmaking, persistencia, cuentas, backend, migración de host ni anti-cheat.

## Requisitos e instalación

- Node.js `20.19+` o `22.12+` (requisito de Vite 7).
- npm.
- Un navegador moderno con ES2022, WebGL, Pointer Lock, Web Audio y WebRTC DataChannels. El mando es opcional.

```bash
npm install
npm run dev
```

El servidor de desarrollo escucha en todas las interfaces y usa el puerto `4173`. La URL habitual es `http://localhost:4173`.

### Scripts

| Comando | Uso |
| --- | --- |
| `npm run dev` | Inicia Vite en `0.0.0.0:4173` para desarrollo. |
| `npm run typecheck` | Comprueba TypeScript estricto sin emitir archivos. |
| `npm test` | Ejecuta una vez la suite de Vitest. La cobertura aún es incompleta. |
| `npm run test:watch` | Ejecuta Vitest en modo interactivo. |
| `npm run build` | Ejecuta TypeScript y genera el sitio estático en `dist/`. |
| `npm run preview` | Sirve localmente el contenido construido en el puerto `4173`. |

Comprobación mínima antes de integrar cambios:

```bash
npm run typecheck
npm test
npm run build
```

## Controles

Haz clic sobre el área de juego para capturar el puntero. `Esc` libera el puntero mediante el comportamiento estándar del navegador.

### Teclado y ratón

| Acción | Control |
| --- | --- |
| Moverse | `W`, `A`, `S`, `D` |
| Mirar | Movimiento del ratón |
| Disparar | Botón izquierdo |
| Apuntar | Botón derecho |
| Saltar | `Espacio` |
| Recargar | `R` |
| Cambiar de arma | `Q`, `1`, `2` o botón central |
| Golpe cuerpo a cuerpo | `F` |
| Lanzar granada | `G` |
| Ver marcador | Mantener `Tab` |
| Liberar ratón / menú | `Esc` |

En el vertical actual, `1` y `2` recorren el inventario igual que `Q`; no seleccionan todavía una ranura concreta.

### Mando estándar

Se lee el primer mando que exponga el navegador. La nomenclatura siguiente corresponde a un mando tipo Xbox con mapeo estándar:

| Acción | Control |
| --- | --- |
| Moverse | Stick izquierdo |
| Mirar | Stick derecho |
| Disparar | Gatillo derecho (`RT`) |
| Apuntar | Gatillo izquierdo (`LT`) |
| Saltar | `A` |
| Recargar | `X` |
| Cambiar de arma | `Y` |
| Golpe cuerpo a cuerpo | Bumper derecho (`RB`) |
| Lanzar granada | Bumper izquierdo (`LB`) |

El soporte se basa en la API Gamepad del navegador; nombres, orden de botones y disponibilidad pueden variar en mandos sin mapeo estándar.

## Formatos, bots y modos

Una partida admite como máximo dos participantes en **Duelo** y ocho en **Escuadras**. Con el relleno de bots activo, la simulación ocupa automáticamente las plazas libres. Cuando entra un jugador remoto, sustituye a un bot; al salir, puede volver a ocupar su plaza un bot. Las dificultades disponibles son Recluta, Veterano y Leyenda.

Los cinco modos están modelados en la simulación:

- **Deathmatch:** todos contra todos; cada eliminación válida suma un punto personal.
- **Team Deathmatch:** Aurora contra Nova; las eliminaciones alimentan la puntuación del equipo.
- **Capture the Flag:** roba la bandera rival y llévala a tu base mientras tu propia bandera esté en casa. Una bandera caída puede devolverse y también retorna por tiempo.
- **Juggernaut / Coloso:** un jugador recibe escudo reforzado. El Coloso puntúa eliminando y quien elimina al Coloso hereda el rol.
- **Towah of Powah:** combate por equipos sin escudos, con escopeta y pistola como equipamiento inicial. Ocupar la plataforma central concede el control de su torreta automática; las eliminaciones deciden la puntuación.

Los límites recomendados de puntos y tiempo cambian según modo y formato. El host mantiene el estado autoritativo de la partida.

## Armas y combate

El equipamiento inicial normal es rifle de pulso y pistola. Las armas de poder aparecen en el mapa y reaparecen después de un tiempo:

| Arma | Función |
| --- | --- |
| Rifle de pulso | Automático equilibrado de corto y medio alcance. |
| Pistola Vector | Semiautomática precisa. |
| Rifle de batalla | Ráfaga de tres proyectiles para media distancia. |
| Rifle de precisión | Cuatro disparos por cargador y gran daño a larga distancia. |
| Escopeta de brecha | Doce perdigones, fuerte a corta distancia. |
| Lanzacohetes Nova | Proyectil lento con daño explosivo de área. |

También hay granadas con fusible y rebote: nunca detonan suspendidas en el aire, explotan inmediatamente al impactar a un personaje y, una vez agotado el fusible, al siguiente contacto con suelo o escenario. Hay golpe cuerpo a cuerpo —incluido daño elevado por la espalda—, munición, sobreescudo y recarga automática de escudo tras dejar de recibir daño. Los valores son de prototipo y necesitan *playtesting* y balance competitivo.

Los dos accesos laterales a la torre son pads de salto físicos. Al pisarlos aplican un arco balístico continuo, conservan el impulso hacia la cubierta y permiten corrección lateral en vuelo; no trasladan instantáneamente al jugador.

## Multijugador P2P con señalización manual

La red usa WebRTC en topología de estrella. El host abre una conexión independiente con cada invitado y actúa como autoridad de simulación. Los DataChannels son ordenados y fiables; las ofertas y respuestas esperan a que termine la recopilación ICE para incluir los candidatos en el propio SDP.

No existe servidor de señalización. Los códigos base64 se intercambian por un canal externo elegido por los jugadores —por ejemplo, un mensaje privado— siguiendo exactamente este flujo:

1. El host crea la partida y genera **una oferta nueva para un invitado** con `hostCreateOffer()`.
2. El host copia ese código base64 completo y se lo envía únicamente a ese invitado.
3. El invitado crea su instancia, pega la oferta y llama a `guestAcceptOffer(oferta)`. Tras recopilar ICE obtiene un código de respuesta.
4. El invitado copia la respuesta base64 completa y la devuelve al mismo host.
5. El host pega esa respuesta y llama a `hostAcceptAnswer(respuesta)`.
6. Ambos esperan el evento `connection` con estado `connected` antes de intercambiar datos de juego.
7. Para cada invitado adicional, el host vuelve al paso 1 y genera **otra oferta**. No se reutilizan ofertas ni respuestas entre jugadores.

Cada oferta pendiente reserva una plaza. El botón **Nueva invitación** cancela las ofertas anteriores que aún no tengan respuesta, sin tocar conexiones abiertas. El límite es de siete invitados, es decir, ocho participantes contando al host. El host puede enviar con `sendToPeer()` o `broadcast()` y cada invitado envía al host con `sendToHost()`.

Los códigos contienen candidatos ICE y pueden revelar direcciones de red. Deben tratarse como datos de sesión, compartirse por un canal de confianza y no publicarse. Cerrar la instancia invalida el flujo pendiente.

### LAN estricta, STUN opcional y TURN

La configuración por defecto es:

```ts
const network = new P2PNetwork({
  rtcConfiguration: { iceServers: [] },
});
```

Este es el modo **estrictamente sin servidores**. Depende de candidatos directos y está pensado principalmente para una LAN compatible. Incluso dentro de una LAN, políticas corporativas, aislamiento Wi-Fi, firewalls o diferencias de navegador pueden impedir la conexión.

La casilla **Compatibilidad Internet** del menú configura opcionalmente el STUN público `stun.l.google.com:19302`. La misma capacidad puede inyectarse por código:

```ts
const network = new P2PNetwork({
  rtcConfiguration: {
    iceServers: [{ urls: 'stun:stun.example.net:3478' }],
  },
});
```

STUN ayuda a descubrir la dirección pública, pero **sí contacta con un servidor externo**, no retransmite la partida y no garantiza atravesar NAT simétrica o firewalls restrictivos. Para esos casos suele hacer falta TURN. TURN retransmite tráfico, requiere infraestructura y credenciales, y por tanto deja de cumplir la variante estricta “sin servidor”. El proyecto no incluye ni opera servicios STUN/TURN propios.

## Límites conocidos del modelo P2P

- **Sin migración de host:** si el host cierra la pestaña, pierde la conexión o abandona, la partida termina.
- **NAT no garantizado:** sin TURN no se puede prometer conexión a través de cualquier red doméstica, móvil, escolar o corporativa.
- **Confianza en el host:** el host ejecuta el estado autoritativo y podría modificar el cliente, la simulación o los resultados. No hay anti-cheat ni servidor de arbitraje.
- **Clientes manipulados:** la validación de mensajes reduce errores de protocolo, pero no sustituye controles exhaustivos contra inputs maliciosos.
- **Pestañas en segundo plano:** el navegador puede limitar temporizadores, render y CPU, degradando la cadencia del host y la sincronización.
- **Sin reconexión transparente:** una conexión fallida no migra ni recompone automáticamente la sesión.
- **Señalización manual:** no hay descubrimiento de partidas, códigos de sala, matchmaking ni lista pública de servidores.
- **Privacidad y autenticidad:** WebRTC cifra el transporte, pero la autenticidad del emparejamiento depende del canal usado para copiar oferta y respuesta.
- **Una persona por navegador:** no hay multijugador local a pantalla partida.

## Plan de implementación

La vertical se construyó en seis capas verificables, actualmente completadas:

1. **Base técnica:** Vite, TypeScript estricto, estado serializable y simulación fija a 60 Hz.
2. **Arena shooter:** movimiento, colisiones, escudos, salud, respawn, dos armas, pickups, melee, granadas, hitscan y proyectiles.
3. **Contenido competitivo:** mapa Cresta del Cráter, seis armas, formatos de 2/8 plazas y reglas de los cinco modos.
4. **Oponentes:** percepción limitada, memoria, dificultad, navegación, desatasco y conducta específica por objetivo.
5. **Presentación y red:** arte 3D procedural, astronautas, cámara FPS, HUD/audio, host autoritativo y señalización WebRTC manual.
6. **Endurecimiento de la vertical:** validación de inputs, backpressure de snapshots, regresiones y simulaciones largas de bots.

Para convertir la vertical en un lanzamiento público, el orden recomendado es: pruebas reales Chrome/Firefox/Safari; sesiones sostenidas de ocho navegadores sobre varias redes; snapshots no fiables y predicción/reconciliación del cliente; segundo mapa específico de duelo; captura de movimiento y audio finales; opciones de accesibilidad; y, solo si se acepta infraestructura, señalización automática, TURN y/o migración de host.

## Arquitectura

```text
.
├── index.html                 # Documento de entrada de Vite
├── package.json               # Scripts y dependencias
├── vite.config.ts             # Desarrollo y preview en el puerto 4173
├── tsconfig.json              # TypeScript estricto para navegador
└── src
    ├── app
    │   └── AstralArenaApp.ts  # Menús, lobby, sesión, HUD y bucle principal
    ├── audio
    │   ├── GameAudio.ts       # Efectos procedurales mediante Web Audio
    │   └── GameAudio.test.ts  # Perfiles por arma y contratos de audio
    ├── game
    │   ├── bots.ts            # Decisiones, puntería y objetivos de bots
    │   ├── bots.test.ts       # Perfiles de dificultad y ritmo de combate
    │   ├── collision.ts       # Movimiento, colisiones y raycasts
    │   ├── collision.test.ts  # Deslizamiento, esquinas y límites del arena
    │   ├── map.ts             # Cresta del Cráter, spawns y pickups
    │   ├── map.test.ts        # Simetría, rutas, escalones y pads de salto
    │   ├── math.ts            # Vectores, límites y aleatoriedad
    │   ├── regressions.test.ts # Regresiones y simulaciones largas de bots
    │   ├── simulation.ts      # Estado autoritativo y reglas de partida
    │   ├── simulation.mechanics.test.ts # Pads físicos y fusible de granadas
    │   ├── simulation.test.ts # Pruebas de combate, modos y determinismo
    │   ├── types.ts           # Contratos de juego y mensajes de red
    │   ├── weapons.ts         # Definiciones, cargadores y equipamientos
    │   └── weapons.test.ts    # Breakpoints, equipamientos y acceso a torre
    ├── input
    │   └── InputController.ts # Teclado, ratón, pointer lock y gamepad
    ├── network
    │   └── P2PNetwork.ts      # WebRTC, señalización base64 y DataChannels
    ├── render
    │   ├── animationMath.ts   # Curvas puras y pesos de acciones animadas
    │   ├── animationMath.test.ts # Continuidad y estabilidad de las curvas
    │   ├── ArenaRenderer.ts   # Escena Three.js, iluminación, cámara y efectos
    │   ├── baseArchitecture.ts # Interiores y detalle funcional de la base
    │   ├── baseArchitecture.test.ts # Arquitectura PBR y lifecycle
    │   ├── DepthFocusPass.ts  # Profundidad de campo ligera por depth buffer
    │   ├── facilityEnvironment.test.ts # Contratos del entorno instanciado
    │   ├── facilityEnvironment.ts # Bosque y arquitectura modular procedural
    │   ├── landscapeGeometry.ts # Crestas y vegetación procedural
    │   ├── visualTextures.ts  # Entorno, terreno y máscaras procedurales
    │   ├── visualTextures.test.ts # Determinismo y rangos PBR del terreno
    │   ├── weaponModels.test.ts # Contratos de piezas móviles y anclajes
    │   └── weaponModels.ts    # Modelos PBR y poses de las seis armas
    ├── main.ts                # Entrada de la aplicación
    ├── styles.css             # Dirección visual, menús y HUD responsive
    └── vite-env.d.ts          # Tipos de Vite
```

La intención es mantener la simulación separada de render, entrada y transporte. El host aplica inputs a `GameSimulation`; los invitados reciben instantáneas y presentan el estado. Esta separación facilita probar las reglas sin WebGL y evita que la capa visual se convierta en fuente de verdad.

## Despliegue estático

La aplicación no necesita Node.js en producción. El resultado de `npm run build` es un conjunto de archivos estáticos en `dist/`. Un despliegue aceptable debe cumplir estos criterios:

1. `npm run typecheck`, `npm test` y `npm run build` terminan correctamente en CI.
2. Se publica **el contenido de `dist/`**, no `src/` ni el servidor de desarrollo.
3. El sitio se sirve por HTTPS. `localhost` es la excepción útil para desarrollo; HTTPS evita restricciones de APIs sensibles y manipulación de los códigos durante la carga de la aplicación.
4. El servidor entrega `index.html` y los módulos JavaScript con MIME correcto. `index.html` no debe quedar cacheado indefinidamente; los assets con hash sí pueden usar caché inmutable.
5. Con la configuración actual de Vite, la aplicación se publica en la raíz del dominio. Para un subdirectorio hay que configurar `base` y volver a construir.
6. El navegador objetivo dispone de WebGL, Pointer Lock, Web Audio, `RTCPeerConnection` y RTCDataChannel. La ausencia de Gamepad no debe bloquear teclado y ratón.
7. Se realiza un *smoke test* local contra bots y otro con dos navegadores/dispositivos usando el flujo completo oferta/respuesta. Si se declara soporte fuera de LAN, se prueba explícitamente sobre varias topologías NAT y se documenta la infraestructura STUN/TURN utilizada.
8. No se afirma compatibilidad pública 4v4 hasta comprobar una sesión real de ocho participantes, pérdida de paquetes, pestaña en segundo plano, desconexión y carga sostenida del host.

GitHub Pages, Cloudflare Pages, Netlify, Vercel estático o cualquier servidor HTTPS equivalente pueden alojar los archivos. El alojamiento web no actúa como servidor de partida: la conexión de juego sigue siendo directa entre navegadores salvo que se configure TURN.

## Alcance e identidad

Astral Arena toma referencias de un género y una época, no pretende ser una recreación de una propiedad existente. Nombres, personajes, mapa, código, arte y audio deben mantenerse originales; no deben incorporarse modelos, sonidos, marcas ni otros recursos extraídos de juegos comerciales.
