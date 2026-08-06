import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CircleOff, Gamepad2 } from "lucide-react";

const GAME_POLL_MS = 20_000;

/** ¿Warframe.x64.exe corriendo ahora? Solo mira la lista de procesos vía el
 *  endpoint /game/status del dev server — nada de leer memoria ni archivos
 *  del juego. null mientras no se hizo el primer chequeo todavía. */
export function useGameRunning(): boolean | null {
  const [running, setRunning] = useState<boolean | null>(null);
  useEffect(() => {
    let stop = false;
    const check = () => {
      fetch("/game/status").then(r => r.json()).then(d => { if (!stop) setRunning(!!d.running); })
        .catch(() => { if (!stop) setRunning(null); });
    };
    check();
    const id = setInterval(check, GAME_POLL_MS);
    return () => { stop = true; clearInterval(id); };
  }, []);
  return running;
}

/** No se puede setear el status de warframe.market automáticamente: la
 *  API no tiene endpoint REST para eso, y el WebSocket real (wss://
 *  warframe.market/socket-v2) está detrás de un challenge de Cloudflare que
 *  bloquea cualquier cliente que no sea un navegador real — confirmado con
 *  el JWT real, no es un tema de formato del pedido. Ir más allá de esto
 *  sería esquivar esa protección anti-bot, así que no lo hacemos.
 *  En cambio, solo avisamos cuando el juego abre/cierra para que lo
 *  cambies vos mismo en el sitio (un toast que se apaga solo). */
export function useGameStatusReminder(running: boolean | null): ReactNode | null {
  const [msg, setMsg] = useState<ReactNode | null>(null);
  const prev = useRef<boolean | null>(null);
  useEffect(() => {
    if (running == null || prev.current === running) { prev.current = running; return; }
    prev.current = running;
    setMsg(running
      ? <><Gamepad2 size={13} className="inline-icon" /> game just opened — update your status on warframe.market</>
      : <><CircleOff size={13} className="inline-icon" /> game closed — you may want to set yourself online/offline on warframe.market</>);
    const t = setTimeout(() => setMsg(null), 15_000);
    return () => clearTimeout(t);
  }, [running]);
  return msg;
}
