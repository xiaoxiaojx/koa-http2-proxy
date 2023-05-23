import { KoaHttp2Proxy } from './koa-http2-proxy';

function proxy(context, opts, getServer) {
  const { middleware } = new KoaHttp2Proxy(context, opts, getServer);
  return middleware;
}

export = proxy;
