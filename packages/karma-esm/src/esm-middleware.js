/* eslint-disable no-inner-declarations, no-console */
const path = require('path');
const request = require('request');
const { virtualFilePrefix } = require('es-dev-server');
const { createEsmConfig } = require('./esm-config.js');
const setupDevServer = require('./setup-es-dev-server');

function esmMiddlewareFactory(config, karmaEmitter) {
  try {
    const karmaConfig = config;
    const watch = karmaConfig.autoWatch;

    const { esmConfig, babelConfig } = createEsmConfig(karmaConfig);

    // setting up the server is async, but we need to synchronously return a middleware.
    // set up the server and keep a promise that can be awaited
    let devServerHost;
    let setupServerPromise = setupDevServer(
      karmaConfig,
      esmConfig,
      watch,
      babelConfig,
      karmaEmitter,
    )
      .then(host => {
        devServerHost = host;
        setupServerPromise = null;
      })
      .catch(console.error);

    /**
     * Karma middleware to proxy requests to es-dev-server. This way, es-dev-server
     * can resolve module imports and/or run babel/compatibility transforms on the files.
     *
     * @type {import('connect').NextHandleFunction}
     */
    async function esmMiddleware(req, res, next) {
      try {
        // wait for server to be set up if it hasn't yet
        if (!setupServerPromise) {
          await setupServerPromise;
        }

        const urlsForDevServer = [
          // context and debug are the HTML entrypoints for karma, they are
          // proxied to es-dev-server in order to run compatibility mode on them
          // from es-dev-server, they are requested again using the "bypass-es-dev-server"
          // query param, so that karma can serve the original file. they are processed
          // by es-dev-server afterwards
          '/context.html',
          '/debug.html',
          // all relative requests are prefixed with /base
          '/base',
          // files generated by es-dev-server
          '/polyfills',
          '/inline-module-',
          virtualFilePrefix,
        ];

        // snapshot files should be served from karma
        let snapshotPath = '/base/__snapshots__';
        // if we have a snapshot config which lets us resolve paths, use it instead of the default
        if (karmaConfig.snapshot && karmaConfig.snapshot.pathResolver) {
          snapshotPath = path.dirname(karmaConfig.snapshot.pathResolver('/base', 'fake-suite'));
        }

        // some files we need to overwrite and serve from karma instead
        const urlsForKarma = [snapshotPath];

        const [url, params] = req.url.split('?');

        const proxyToDevServer =
          (!params || !params.includes('bypass-es-dev-server')) &&
          urlsForDevServer.some(u => url.startsWith(u)) &&
          !urlsForKarma.some(u => url.startsWith(u));

        if (proxyToDevServer) {
          const proxyUrl = `${devServerHost}${req.url.replace('/base', '')}`;
          const forwardRequest = request(proxyUrl).on('error', () => {
            // don't log proxy errors
          });
          req.pipe(forwardRequest);
          forwardRequest.pipe(res);
        } else {
          next();
        }
      } catch (error) {
        console.error('Error while proxying to es-dev-server', error);
        throw error;
      }
    }

    return esmMiddleware;
  } catch (error) {
    // karma swallows stack traces, so log them here manually
    console.error('Error while setting up es-dev-server middleware', error);
    throw error;
  }
}

esmMiddlewareFactory.$inject = ['config', 'emitter'];

module.exports = esmMiddlewareFactory;
