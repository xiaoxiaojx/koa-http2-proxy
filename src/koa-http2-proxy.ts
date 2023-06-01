import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';

import * as finalhandler from 'finalhandler';
import * as proxy from 'http2-proxy';
import * as url from 'url';

import { createConfig } from './config-factory';
import * as contextMatcher from './context-matcher';
import { getArrow, getInstance, silentInstance } from './logger';
import * as PathRewriter from './path-rewriter';
import * as Router from './router';
// @ts-ignore
const Common = require('./common');

export class KoaHttp2Proxy {
  private logger = getInstance();
  private config;
  private proxyOptions;
  private pathRewriter;

  constructor(context, opts, getServer) {
    this.config = createConfig(context, opts);
    this.proxyOptions = this.config.options;

    this.pathRewriter = PathRewriter.createPathRewriter(
      this.proxyOptions.pathRewrite
    ); // returns undefined when "pathRewrite" is not provided

    // @ts-ignore
    const targetUrlObj = new URL(this.proxyOptions.target);
    this.proxyOptions.useHttpsRequest = Common.isSSL.test(targetUrlObj.protocol)

    if (!this.proxyOptions.logs) {
      this.logger = silentInstance();
    }

    this.logger.info(
      `[HPM] Proxy created: ${this.config.context}  -> ${this.proxyOptions.target}`
    );

    if (typeof getServer === 'function') {
      getServer().then(server => {
        server.on('upgrade', (req, socket, head) => {
          this.handleUpgrade(req, socket, head);
        });
      });
    }
  }

  // https://github.com/Microsoft/TypeScript/wiki/'this'-in-TypeScript#red-flags-for-this
  public middleware = async (ctx, next) => {
    if (!this.shouldProxy(this.config.context, ctx.req)) {
      return next();
    }
    if (this.proxyOptions.ws === true) {
      // use initial request to access the server object to subscribe to http upgrade event
      return next();
    }

    return new Promise((resolve, reject) =>
      proxy.web(
        ctx.req,
        ctx.res,
        // @ts-ignore
        this.prepareProxyRequest(ctx, resolve),
        this.defaultWebHandler(ctx, resolve, reject)
      )
    );
  };

  private handleReq = ctx => (req, options) => {
    const request = this.proxyOptions.useHttpsRequest
      ? httpsRequest
      : httpRequest;
    const proxyReq = request(options);

    if (!this.proxyOptions.changeOrigin) {
      proxyReq.setHeader('host', req.headers.host);
    }

    if (this.proxyOptions.headers) {
      for (const k of Object.keys(this.proxyOptions.headers)) {
        proxyReq.setHeader(k, this.proxyOptions.headers[k]);
      }
    }
    if (this.proxyOptions.xfwd) {
      proxyReq.setHeader('x-forwarded-for', req.socket.remoteAddress);
      const proto =
        req.headers['x-forwarded-proto'] ||
        (req.socket.encrypted ? 'https' : 'http');
      proxyReq.setHeader('x-forwarded-proto', proto);
      proxyReq.setHeader('x-forwarded-host', req.headers.host);
    }

    if (this.proxyOptions.onProxyReq) {
      this.proxyOptions.onProxyReq(proxyReq, ctx);
    }

    if (this.proxyOptions.logs) {
      this.logger.info(
        '[HPM] Headers: %o',
        JSON.stringify(proxyReq.getHeaders())
      );
    }

    return proxyReq;
  };

  private handleRes = (ctx, resolve) => (_, __, proxyRes) => {
    if (this.proxyOptions.onProxyRes) {
      this.proxyOptions.onProxyRes(proxyRes, ctx);
    }

    ctx.response.status = proxyRes.statusCode;
    ctx.response.set(proxyRes.headers);
    ctx.response.body = proxyRes;

    if (resolve) {
      resolve();
    }
  };

  private handleUpgrade = async (req, socket, head) => {
    if (this.shouldProxy(this.config.context, req)) {
      Common.ws(req, socket, head, this.proxyOptions);
    }
  };

  /**
   * Determine whether request should be proxied.
   *
   * @private
   * @param  {String} context [description]
   * @param  {Object} req     [description]
   * @return {Boolean}
   */
  private shouldProxy = (context, req) => {
    const path = url.parse(req.originalUrl || req.url).pathname;

    return contextMatcher.match(context, path, req);
  };

  /**
   * Apply option.router and option.pathRewrite
   * Order matters:
   *    Router uses original path for routing;
   *    NOT the modified path, after it has been rewritten by pathRewrite
   * @param {Object} req
   * @return {Object} proxy options
   */
  private prepareProxyRequest = (ctx, resolve) => {
    // https://github.com/chimurai/http-proxy-middleware/issues/17
    // https://github.com/chimurai/http-proxy-middleware/issues/94
    ctx.req.url = ctx.req.originalUrl || ctx.req.url;

    // store uri before it gets rewritten for logging
    const originalPath = ctx.req.url;

    // Apply in order:
    // 1. option.router
    // 2. option.pathRewrite
    const target = this.applyRouter(ctx.req, this.proxyOptions);
    this.applyPathRewrite(ctx.req, this.pathRewriter);

    // debug logging for both http(s) and websockets
    if (this.proxyOptions.logLevel === 'debug') {
      const arrow = getArrow(
        originalPath,
        ctx.req.url,
        this.proxyOptions.target,
        target
      );
      this.logger.debug(
        '[HPM] %s %s %s %s',
        ctx.req.method,
        originalPath,
        arrow,
        target
      );
    }

    const uri = url.parse(target);

    return {
      hostname: uri.hostname,
      onReq: this.handleReq(ctx),
      onRes: this.handleRes(ctx, resolve),
      path: ctx.req.url,
      port: uri.port,
      protocol: uri.protocol,
      proxyName: this.proxyOptions.proxyName,
      proxyTimeout: this.proxyOptions.proxyTimeout,
      target
    };
  };

  // Modify option.target when router present.
  private applyRouter = (req, options) => {
    let newTarget;

    if (options.router) {
      newTarget = Router.getTarget(req, options);

      if (newTarget) {
        this.logger.debug(
          '[HPM] Router new target: %s -> "%s"',
          options.target,
          newTarget
        );
        return newTarget;
      }
    }

    return options.target;
  };

  // rewrite path
  private applyPathRewrite = (req, pathRewriter) => {
    if (pathRewriter) {
      const path = pathRewriter(req.url, req);

      if (typeof path === 'string') {
        req.url = path;
      } else {
        this.logger.info(
          '[HPM] pathRewrite: No rewritten path found. (%s)',
          req.url
        );
      }
    }
  };

  private defaultWebHandler = (ctx, resolve, reject) => (err, req, res) => {
    if (err) {
      this.logError(err, req);

      if (this.proxyOptions.onError) {
        this.proxyOptions.onError(err, ctx);
        resolve();
      } else {
        finalhandler(req, res)(err);
        reject();
      }
    } else {
      resolve();
    }
  };

  private defaultWSHandler = (err, req, socket) => {
    if (err) {
      this.logError(err, req);
      try {
        socket.destroy();
      } catch (e) {
        this.logError(e, req);
      }
    }
  };

  private logError = (err, req) => {
    const hostname =
      (req.headers && req.headers.host) || (req.hostname || req.host); // (websocket) || (node0.10 || node 4/5)
    const target = this.proxyOptions.target.host || this.proxyOptions.target;
    const errorMessage =
      '[HPM] Error occurred while trying to proxy request %s from %s to %s (%s) (%s)';
    const errReference =
      'https://nodejs.org/api/errors.html#errors_common_system_errors'; // link to Node Common Systems Errors page

    this.logger.error(
      errorMessage,
      req.url,
      hostname,
      target,
      err.code || err,
      errReference
    );
  };
}

function middleware(context, opts, getServer) {
  return new KoaHttp2Proxy(context, opts, getServer).middleware;
}

export default middleware;
