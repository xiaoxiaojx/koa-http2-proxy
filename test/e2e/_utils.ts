import * as Koa from 'koa';
import * as Router from 'koa-router';

// tslint:disable-next-line: no-var-requires
export const proxyMiddleware = require('../../dist/index');

export function createServer(portNumber, middleware, path?) {
  const app = new Koa();

  if (middleware && path) {
    const router = new Router();
    router.get(path, middleware);
    app.use(router.routes());
  } else if (middleware) {
    app.use(middleware);
  }

  const server = app.listen(portNumber);

  return server;
}
