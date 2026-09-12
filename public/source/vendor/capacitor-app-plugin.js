/*!
 * Vendored, unmodified build of @capacitor/app v8.1.1's browser plugin bridge
 * (https://github.com/ionic-team/capacitor-plugins), wrapped in a guard.
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
 * script tag and nothing else. This is what makes it safe to always
 * include in index.html rather than conditionally injecting it.
 */
if (typeof capacitorExports !== "undefined") {
  var capacitorApp = (function (exports, core) {
    'use strict';

    const App = core.registerPlugin('App', {
        web: () => Promise.resolve().then(function () { return web; }).then(m => new m.AppWeb()),
    });

    class AppWeb extends core.WebPlugin {
        constructor() {
            super();
            this.handleVisibilityChange = () => {
                const data = {
                    isActive: document.hidden !== true,
                };
                this.notifyListeners('appStateChange', data);
                if (document.hidden) {
                    this.notifyListeners('pause', null);
                }
                else {
                    this.notifyListeners('resume', null);
                }
            };
            document.addEventListener('visibilitychange', this.handleVisibilityChange, false);
        }
        exitApp() {
            throw this.unimplemented('Not implemented on web.');
        }
        async getInfo() {
            throw this.unimplemented('Not implemented on web.');
        }
        async getLaunchUrl() {
            return { url: '' };
        }
        async getState() {
            return { isActive: document.hidden !== true };
        }
        async minimizeApp() {
            throw this.unimplemented('Not implemented on web.');
        }
    }

    var web = /*#__PURE__*/Object.freeze({
        __proto__: null,
        AppWeb: AppWeb
    });

    exports.App = App;

    Object.defineProperty(exports, '__esModule', { value: true });

    return exports;

  })({}, capacitorExports);
}
