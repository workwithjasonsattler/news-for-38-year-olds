/*!
 * Vendored, unmodified build of @capacitor/browser v8.0.4's browser plugin
 * bridge (https://github.com/ionic-team/capacitor-plugins), wrapped in a
 * guard. Mirrors the exact vendoring pattern used for
 * capacitor-app-plugin.js in the iOS Universal Links session.
 *
 * Why vendored instead of loaded from a CDN: this file is loaded on EVERY
 * visit to /source/ (native app or plain browser), so it shouldn't depend
 * on a third party's uptime for a site that otherwise has zero external
 * script dependencies.
 *
 * Why the guard: Capacitor's native iOS/Android runtime auto-injects its
 * own copy of the core "capacitor.js" bridge (which defines the global
 * `capacitorExports`) into the WebView before any page script runs — but
 * ONLY when running inside the native app. On a plain web visit (desktop
 * browser, mobile Safari/Chrome, the installed PWA), that global is never
 * defined, so this file is a complete no-op there — it costs one small
 * script tag and nothing else, and web.open()/web.close() fall back to a
 * plain window.open()/close() if this ever somehow got called outside a
 * native context.
 */
if (typeof capacitorExports !== "undefined") {
  var capacitorBrowser = (function (exports, core) {
    'use strict';

    const Browser = core.registerPlugin('Browser', {
        web: () => Promise.resolve().then(function () { return web; }).then((m) => new m.BrowserWeb()),
    });

    class BrowserWeb extends core.WebPlugin {
        constructor() {
            super();
            this._lastWindow = null;
        }
        async open(options) {
            this._lastWindow = window.open(options.url, options.windowName || '_blank');
        }
        async close() {
            return new Promise((resolve, reject) => {
                if (this._lastWindow != null) {
                    this._lastWindow.close();
                    this._lastWindow = null;
                    resolve();
                }
                else {
                    reject('No active window to close!');
                }
            });
        }
    }

    var web = /*#__PURE__*/Object.freeze({
        __proto__: null,
        BrowserWeb: BrowserWeb
    });

    exports.Browser = Browser;

    return exports;

  })({}, capacitorExports);
}
