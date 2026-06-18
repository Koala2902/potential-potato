/* global window */
var LegacyApi = (function () {
    var STORAGE_KEY = 'legacy.apiBaseOverride';
    var SESSION_WORKING_KEY = 'legacy.apiBaseWorking';

    function isTabletVitePort() {
        var port = window.location.port;
        return port === '5175' || port === '5173';
    }

    function hostApiBase(port) {
        var protocol = window.location.protocol || 'http:';
        var host = window.location.hostname || 'localhost';
        return protocol + '//' + host + ':' + port + '/api';
    }

    function defaultApiBase() {
        if (isTabletVitePort()) {
            return '/api';
        }
        if (window.location.port === '5174') {
            return hostApiBase('3001');
        }
        return '/api';
    }

    function proxyApiBase() {
        return '/api';
    }

    function directApiBase() {
        return hostApiBase('3001');
    }

    function getOverrideFromStorage() {
        try {
            var v = window.localStorage.getItem(STORAGE_KEY);
            return v ? String(v).trim() : '';
        } catch (e) {
            return '';
        }
    }

    function setOverrideInStorage(value) {
        try {
            var trimmed = (value || '').trim();
            if (!trimmed) {
                window.localStorage.removeItem(STORAGE_KEY);
            } else {
                window.localStorage.setItem(STORAGE_KEY, trimmed.replace(/\/+$/, ''));
            }
        } catch (e) {
            /* ignore */
        }
    }

    function getWorkingBaseFromSession() {
        try {
            return window.sessionStorage.getItem(SESSION_WORKING_KEY) || '';
        } catch (e) {
            return '';
        }
    }

    function setWorkingBaseInSession(base) {
        try {
            if (base) {
                window.sessionStorage.setItem(SESSION_WORKING_KEY, base);
            } else {
                window.sessionStorage.removeItem(SESSION_WORKING_KEY);
            }
        } catch (e) {
            /* ignore */
        }
    }

    function normalizeApiBase(raw) {
        var base = String(raw || '').trim().replace(/\/+$/, '');
        if (!base) return defaultApiBase();
        if (base.indexOf('http://') !== 0 && base.indexOf('https://') !== 0) {
            return base;
        }
        var loc = window.location;
        var a = document.createElement('a');
        a.href = base;
        if (a.hostname && loc.hostname && a.hostname !== loc.hostname) {
            return defaultApiBase();
        }
        if (storedOverrideLooksStale(base)) {
            return defaultApiBase();
        }
        if (a.hostname === loc.hostname && loc.port && loc.port !== '3001' && a.port === '3001') {
            return defaultApiBase();
        }
        return base;
    }

    function storedOverrideLooksStale(stored) {
        if (!stored) return false;
        if (stored.indexOf(':5174') !== -1) return true;
        return false;
    }

    function getApiBase() {
        var working = getWorkingBaseFromSession();
        if (working) {
            return normalizeApiBase(working);
        }
        return getApiBaseFromInput();
    }

    function getApiBaseFromInput() {
        var el = document.getElementById('apiBaseInput');
        if (el && el.value && String(el.value).trim()) {
            return normalizeApiBase(el.value);
        }
        var stored = getOverrideFromStorage();
        if (stored) return normalizeApiBase(stored);
        return defaultApiBase();
    }

    function apiBasesToTry() {
        var primary = getApiBase();
        var list = [primary];
        var proxy = proxyApiBase();
        var direct = directApiBase();
        if (proxy !== primary && list.indexOf(proxy) === -1) list.push(proxy);
        if (direct !== primary && list.indexOf(direct) === -1) list.push(direct);
        return list;
    }

    function shouldTryNextBase(err, status) {
        if (!err) return false;
        if (status === 404 || status === 0) return true;
        var msg = String(err.message || err);
        if (msg.indexOf('Network error') !== -1) return true;
        if (msg.indexOf('HTTP 404') !== -1) return true;
        return false;
    }

    function initApiBaseInput() {
        var el = document.getElementById('apiBaseInput');
        if (!el) return;
        var stored = getOverrideFromStorage();
        if (stored && storedOverrideLooksStale(stored)) {
            setOverrideInStorage('');
            stored = '';
        }
        var resolved = normalizeApiBase(stored || defaultApiBase());
        if (stored && resolved !== normalizeApiBase(stored)) {
            setOverrideInStorage('');
        }
        el.value = resolved;
        el.onchange = function () {
            setWorkingBaseInSession('');
            var next = normalizeApiBase(el.value);
            el.value = next;
            if (next === defaultApiBase()) {
                setOverrideInStorage('');
            } else {
                setOverrideInStorage(next);
            }
        };
        el.onblur = el.onchange;
    }

    function request(method, url, payload, done) {
        var xhr = new XMLHttpRequest();
        var finished = false;
        var hardTimer = null;
        function finish(err, data, status) {
            if (finished) return;
            finished = true;
            if (hardTimer) clearTimeout(hardTimer);
            done(err, data, status);
        }
        xhr.open(method, url, true);
        if (payload != null) {
            xhr.setRequestHeader('Content-Type', 'application/json');
        }
        try {
            xhr.timeout = 20000;
        } catch (e) {
            /* old browsers */
        }
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            var data = null;
            try {
                data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
            } catch (e) {
                data = null;
            }
            if (xhr.status >= 200 && xhr.status < 300) {
                finish(null, data, xhr.status);
                return;
            }
            if (xhr.status === 0) {
                finish(new Error('Network error (no response from ' + url + ')'), null, 0);
                return;
            }
            var message = data && data.error ? data.error : 'HTTP ' + xhr.status;
            finish(new Error(message), data, xhr.status);
        };
        xhr.onerror = function () {
            finish(new Error('Network error (' + url + ')'), null, 0);
        };
        xhr.ontimeout = function () {
            try { xhr.abort(); } catch (e) { /* ignore */ }
            finish(new Error('Request timed out after 20s (' + url + ')'), null, 0);
        };
        hardTimer = setTimeout(function () {
            try { xhr.abort(); } catch (e) { /* ignore */ }
            finish(new Error('Request stalled after 25s (' + url + ')'), null, 0);
        }, 25000);
        xhr.send(payload != null ? JSON.stringify(payload) : null);
    }

    function requestWithFallback(method, path, payload, done) {
        var bases = apiBasesToTry();
        var lastErr = null;
        var lastData = null;
        var lastStatus = 0;

        function tryBase(index) {
            if (index >= bases.length) {
                done(lastErr || new Error('API unreachable'), lastData, lastStatus);
                return;
            }
            var url = bases[index] + path;
            request(method, url, payload, function (err, data, status) {
                if (!err) {
                    setWorkingBaseInSession(bases[index]);
                    var input = document.getElementById('apiBaseInput');
                    if (input && !getOverrideFromStorage()) {
                        input.value = bases[index];
                    }
                    done(null, data, status);
                    return;
                }
                lastErr = err;
                lastData = data;
                lastStatus = status;
                if (shouldTryNextBase(err, status)) {
                    tryBase(index + 1);
                    return;
                }
                done(err, data, status);
            });
        }

        tryBase(0);
    }

    function get(path, done) {
        requestWithFallback('GET', path, null, done);
    }

    function patch(path, payload, done) {
        requestWithFallback('PATCH', path, payload, done);
    }

    function post(path, payload, done) {
        requestWithFallback('POST', path, payload, done);
    }

    function showApiBanner(message, isOk) {
        var el = document.getElementById('legacy-api-banner');
        if (!el) return;
        if (!message) {
            el.className = 'legacy-api-banner hidden';
            el.textContent = '';
            return;
        }
        el.className = isOk ? 'legacy-api-banner legacy-api-banner--ok' : 'legacy-api-banner';
        el.textContent = message;
    }

    function probeConnection(done) {
        var loc = window.location;
        if (loc.port === '5174' && document.querySelector && document.querySelector('.legacy-app')) {
            done(
                new Error(
                    'Wrong port 5174 for tablet UI — redirecting to :5175…'
                )
            );
            window.location.replace(
                loc.protocol +
                    '//' +
                    loc.hostname +
                    ':5175' +
                    loc.pathname +
                    loc.search +
                    (loc.hash || '#/production')
            );
            return;
        }
        get('/machines', function (err, data) {
            if (err) {
                done(
                    new Error(
                        (err.message || 'API unreachable') +
                            '. Run npm run dev (:3001) then npm run dev:tablet (:5175). Tried ' +
                            apiBasesToTry().join(' and ') +
                            '.'
                    )
                );
                return;
            }
            showApiBanner('');
            done(null);
        });
    }

    return {
        defaultApiBase: defaultApiBase,
        getApiBase: getApiBase,
        initApiBaseInput: initApiBaseInput,
        probeConnection: probeConnection,
        showApiBanner: showApiBanner,
        request: request,
        get: get,
        patch: patch,
        post: post
    };
})();
