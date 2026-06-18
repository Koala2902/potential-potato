/* global window, document, LegacyProduction, LegacyStock, LegacyScan */
var LegacyRouter = (function () {
    var ROUTES = ['production', 'stock', 'scan'];
    var currentRoute = null;
    var pollTimer = null;

    function normalizeHash() {
        var hash = (window.location.hash || '').replace(/^#/, '');
        if (!hash) return 'production';
        if (hash.charAt(0) === '/') hash = hash.slice(1);
        var route = hash.split('/')[0].toLowerCase();
        for (var i = 0; i < ROUTES.length; i += 1) {
            if (ROUTES[i] === route) return route;
        }
        return 'production';
    }

    function setActiveNav(route) {
        var tabs = document.querySelectorAll('.legacy-nav-tab');
        for (var i = 0; i < tabs.length; i += 1) {
            var tab = tabs[i];
            var r = tab.getAttribute('data-route');
            if (r === route) {
                tab.className = 'legacy-nav-tab is-active';
                tab.setAttribute('aria-current', 'page');
            } else {
                tab.className = 'legacy-nav-tab';
                tab.removeAttribute('aria-current');
            }
        }
    }

    function showView(route) {
        var views = document.querySelectorAll('.legacy-view');
        for (var i = 0; i < views.length; i += 1) {
            var v = views[i];
            if (v.getAttribute('data-view') === route) {
                v.className = 'legacy-view is-active';
            } else {
                v.className = 'legacy-view';
            }
        }
    }

    function stopPoll() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        if (typeof LegacyProduction !== 'undefined' && LegacyProduction.stop) {
            LegacyProduction.stop();
        }
        if (typeof LegacyStock !== 'undefined' && LegacyStock.stop) {
            LegacyStock.stop();
        }
    }

    function startRoute(route) {
        stopPoll();
        if (route === 'production' && typeof LegacyProduction !== 'undefined') {
            LegacyProduction.start();
            pollTimer = setInterval(function () {
                LegacyProduction.refresh(false);
            }, 15000);
        } else if (route === 'stock' && typeof LegacyStock !== 'undefined') {
            LegacyStock.start();
        } else if (route === 'scan' && typeof LegacyScan !== 'undefined') {
            LegacyScan.start();
        }
    }

    function navigate(route, replace) {
        var target = '#' + route;
        if (replace) {
            window.location.replace(target);
            onHashChange();
        } else if (window.location.hash !== target) {
            window.location.hash = route;
        } else {
            onHashChange();
        }
    }

    function onHashChange() {
        var route = normalizeHash();
        if (route === currentRoute) {
            return;
        }
        currentRoute = route;
        setActiveNav(route);
        showView(route);
        startRoute(route);
    }

    function init() {
        var tabs = document.querySelectorAll('.legacy-nav-tab');
        for (var i = 0; i < tabs.length; i += 1) {
            (function (tab) {
                tab.onclick = function () {
                    var r = tab.getAttribute('data-route');
                    if (r) navigate(r, false);
                };
            })(tabs[i]);
        }

        window.addEventListener('hashchange', onHashChange);

        if (!window.location.hash) {
            window.location.hash = 'production';
        }
        onHashChange();
    }

    return {
        init: init,
        navigate: navigate
    };
})();
