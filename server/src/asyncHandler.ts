import type { NextFunction, Request, Response } from "express";

/** Express 4 no atrapa promesas rechazadas de handlers async por sí solo —
 *  sin esto, cualquier error no capturado a mano (timeout de Postgres, un
 *  fetch que falla) termina como unhandledRejection, y Node 22 por default
 *  MATA EL PROCESO entero — no solo la request que falló, afecta a todos
 *  los usuarios conectados en ese momento. Envuelve el handler y manda
 *  cualquier rechazo a next(err), que cae en el error handler de index.ts. */
export const asyncHandler = <Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
) => (req: Req, res: Response, next: NextFunction): void => {
  fn(req, res, next).catch(next);
};
