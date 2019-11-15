import { KoaHttp2Proxy } from './koa-http2-proxy';

function proxy(context, opts) {
  const { middleware } = new KoaHttp2Proxy(context, opts);
  return middleware;
}

export = proxy;
