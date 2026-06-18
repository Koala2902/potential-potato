/* global document, window, LegacyApi */
var LegacyStock = (function () {
    var DEBOUNCE_MS = 300;

    var state = {
        companyScope: 'NL Material',
        groupFilterIds: [],
        q: '',
        materials: [],
        catalogGroups: [],
        loading: true,
        error: null,
        touchQtyId: null,
        touchQtyValue: '',
        touchQtySaving: false,
        scanBuffer: '',
        scanTimer: null,
        debounceTimer: null,
        barcodeAmbiguousIds: null
    };

    var els = {};

    function cacheElements() {
        els.root = document.getElementById('view-stock');
        els.nlBtn = document.getElementById('stock-company-nl');
        els.npBtn = document.getElementById('stock-company-np');
        els.groupFilters = document.getElementById('stock-group-filters');
        els.search = document.getElementById('stock-search');
        els.tbody = document.getElementById('stock-tbody');
        els.loading = document.getElementById('stock-page-loading');
        els.error = document.getElementById('stock-error');
        els.notice = document.getElementById('stock-notice');
        els.ambiguous = document.getElementById('stock-ambiguous');
        els.qtyOverlay = document.getElementById('stock-qty-overlay');
        els.qtyName = document.getElementById('stock-qty-name');
        els.qtyInput = document.getElementById('stock-qty-input');
        els.qtyCancel = document.getElementById('stock-qty-cancel');
        els.qtyTakeOut = document.getElementById('stock-qty-takeout');
        els.qtyStockIn = document.getElementById('stock-qty-stockin');
    }

    function strVal(v) {
        if (v == null || v === '') return '';
        return String(v);
    }

    function formatNum(v) {
        if (v == null || v === '') return '—';
        var n = typeof v === 'number' ? v : Number(v);
        if (n !== n) return '—';
        return String(n);
    }

    function companyShort(company) {
        return company === 'NP Material' ? 'NP' : 'NL';
    }

    function materialGroupLabel(row) {
        if (row.substrate_groups && row.substrate_groups.length) {
            var names = [];
            for (var i = 0; i < row.substrate_groups.length; i += 1) {
                var g = row.substrate_groups[i];
                if (g && g.group_name) names.push(g.group_name);
            }
            if (names.length) return names.join(', ');
        }
        if (row.substrate_group_name) return row.substrate_group_name;
        return '—';
    }

    function setNotice(msg) {
        if (!els.notice) return;
        if (msg) {
            els.notice.className = 'stock-notice';
            els.notice.textContent = msg;
        } else {
            els.notice.className = 'stock-notice hidden';
            els.notice.textContent = '';
        }
    }

    function setError(msg) {
        if (!els.error) return;
        if (msg) {
            els.error.className = 'legacy-state legacy-state--error';
            els.error.textContent = msg;
        } else {
            els.error.className = 'legacy-state hidden';
            els.error.textContent = '';
        }
    }

    function setLoading(show) {
        if (els.loading) {
            els.loading.className = show ? 'legacy-state legacy-state--loading' : 'legacy-state hidden';
        }
    }

    function buildMaterialsQuery() {
        var params = [];
        params.push('activeOnly=true');
        params.push('company=' + encodeURIComponent(state.companyScope));
        if (state.q) params.push('q=' + encodeURIComponent(state.q));
        if (state.groupFilterIds.length) {
            params.push('groupIds=' + encodeURIComponent(state.groupFilterIds.join(',')));
        }
        return '/stock/materials?' + params.join('&');
    }

    function buildCatalogGroupsQuery() {
        var params = ['catalog=true', 'activeOnly=true'];
        params.push('company=' + encodeURIComponent(state.companyScope));
        if (state.q) params.push('q=' + encodeURIComponent(state.q));
        return '/stock/material-groups?' + params.join('&');
    }

    function loadMain() {
        setLoading(true);
        setError(null);
        var pending = 2;
        var materials = null;
        var groups = null;
        var errMsg = null;

        function done() {
            pending -= 1;
            if (pending > 0) return;
            setLoading(false);
            if (errMsg) {
                setError(errMsg);
                return;
            }
            state.materials = materials || [];
            state.catalogGroups = groups || [];
            renderGroupFilters();
            renderTable();
        }

        LegacyApi.get(buildMaterialsQuery(), function (err, data) {
            if (err) errMsg = err.message || 'Failed to load materials';
            else materials = data || [];
            done();
        });
        LegacyApi.get(buildCatalogGroupsQuery(), function (err, data) {
            if (err && !errMsg) errMsg = err.message || 'Failed to load groups';
            else groups = data || [];
            done();
        });
    }

    function scheduleReload() {
        if (state.debounceTimer) clearTimeout(state.debounceTimer);
        state.debounceTimer = setTimeout(function () {
            state.debounceTimer = null;
            loadMain();
        }, DEBOUNCE_MS);
    }

    function toggleGroupFilter(groupId) {
        var ids = state.groupFilterIds.slice();
        var idx = -1;
        for (var i = 0; i < ids.length; i += 1) {
            if (ids[i] === groupId) {
                idx = i;
                break;
            }
        }
        if (idx === -1) ids.push(groupId);
        else ids.splice(idx, 1);
        state.groupFilterIds = ids;
        loadMain();
    }

    function renderGroupFilters() {
        if (!els.groupFilters) return;
        els.groupFilters.innerHTML = '';

        var allBtn = document.createElement('button');
        allBtn.type = 'button';
        allBtn.className =
            'stock-touch-group-btn' + (state.groupFilterIds.length === 0 ? ' is-active' : '');
        allBtn.textContent = 'All groups';
        allBtn.setAttribute('aria-pressed', state.groupFilterIds.length === 0 ? 'true' : 'false');
        allBtn.onclick = function () {
            state.groupFilterIds = [];
            loadMain();
        };
        els.groupFilters.appendChild(allBtn);

        for (var i = 0; i < state.catalogGroups.length; i += 1) {
            (function (g) {
                var active = false;
                for (var j = 0; j < state.groupFilterIds.length; j += 1) {
                    if (state.groupFilterIds[j] === g.group_id) {
                        active = true;
                        break;
                    }
                }
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'stock-touch-group-btn' + (active ? ' is-active' : '');
                btn.setAttribute('aria-pressed', active ? 'true' : 'false');
                if (g.group_color) {
                    var dot = document.createElement('span');
                    dot.className = 'stock-group-dot';
                    dot.style.backgroundColor = g.group_color;
                    dot.setAttribute('aria-hidden', 'true');
                    btn.appendChild(dot);
                }
                btn.appendChild(document.createTextNode(g.group_name || g.group_id));
                btn.onclick = function () {
                    toggleGroupFilter(g.group_id);
                };
                els.groupFilters.appendChild(btn);
            })(state.catalogGroups[i]);
        }
    }

    function renderTable() {
        if (!els.tbody) return;
        els.tbody.innerHTML = '';
        if (!state.materials.length) {
            var tr = document.createElement('tr');
            var td = document.createElement('td');
            td.colSpan = 6;
            td.className = 'stock-muted';
            td.textContent = 'No materials match your filters.';
            tr.appendChild(td);
            els.tbody.appendChild(tr);
            return;
        }

        for (var i = 0; i < state.materials.length; i += 1) {
            (function (row) {
                var tr = document.createElement('tr');
                tr.setAttribute('data-material-id', row.material_id);
                if (row.is_active === false) tr.className = 'inactive';

                var low = Boolean(row.low_stock);
                var inactive = row.is_active === false;

                function addCell(content, className) {
                    var td = document.createElement('td');
                    if (className) td.className = className;
                    if (typeof content === 'string') td.textContent = content;
                    else td.appendChild(content);
                    tr.appendChild(td);
                }

                var badge = document.createElement('span');
                badge.className = 'stock-badge ' + (low ? 'stock-badge--low' : 'stock-badge--ok');
                badge.textContent = low ? 'Low' : 'OK';
                addCell(badge);

                var co = document.createElement('span');
                co.className =
                    'stock-company-badge ' +
                    ((row.company || 'NL Material') === 'NP Material'
                        ? 'stock-company-badge--np'
                        : 'stock-company-badge--nl');
                co.textContent = companyShort(row.company);
                addCell(co);

                var nameBtn = document.createElement('button');
                nameBtn.type = 'button';
                nameBtn.className = 'stock-material-name-btn';
                nameBtn.textContent = row.material_name || '—';
                nameBtn.onclick = function (e) {
                    if (e && e.stopPropagation) e.stopPropagation();
                    openTouchQty(row);
                };
                addCell(nameBtn, 'stock-material-name-cell');
                addCell((row.location && String(row.location).trim()) || '—');
                addCell(materialGroupLabel(row));
                addCell(formatNum(row.stock), 'stock-num');

                tr.onclick = function () {
                    openTouchQty(row);
                };

                els.tbody.appendChild(tr);
            })(state.materials[i]);
        }
    }

    function findMaterial(id) {
        for (var i = 0; i < state.materials.length; i += 1) {
            if (state.materials[i].material_id === id) return state.materials[i];
        }
        return null;
    }

    function scrollToMaterial(id) {
        if (!els.tbody) return;
        var row = els.tbody.querySelector('tr[data-material-id="' + id + '"]');
        if (row && row.scrollIntoView) {
            row.scrollIntoView({ block: 'nearest' });
        }
    }

    function openTouchQty(row) {
        state.touchQtyId = row.material_id;
        state.touchQtyValue = '1';
        setError(null);
        if (els.qtyOverlay) els.qtyOverlay.className = 'stock-touch-qty-overlay is-open';
        if (els.qtyName) {
            els.qtyName.textContent = (row.material_name || row.material_id) + ' (stock: ' + formatNum(row.stock) + ')';
        }
        if (els.qtyInput) {
            els.qtyInput.value = state.touchQtyValue;
        }
        updateQtyButtons();
    }

    function closeTouchQty() {
        state.touchQtyId = null;
        state.touchQtyValue = '';
        if (els.qtyOverlay) els.qtyOverlay.className = 'stock-touch-qty-overlay';
        updateQtyButtons();
    }

    function updateQtyButtons() {
        var saving = state.touchQtySaving;
        if (els.qtyCancel) els.qtyCancel.disabled = saving;
        if (els.qtyTakeOut) {
            els.qtyTakeOut.disabled = saving;
            els.qtyTakeOut.textContent = saving ? 'Saving…' : 'Take out (-)';
        }
        if (els.qtyStockIn) {
            els.qtyStockIn.disabled = saving;
            els.qtyStockIn.textContent = saving ? 'Saving…' : 'Stock in (+)';
        }
        if (els.qtyInput) els.qtyInput.disabled = saving;
    }

    function applyTouchQty(direction) {
        if (!state.touchQtyId || state.touchQtySaving) return;
        var trimmed = String(state.touchQtyValue).trim();
        var qty = Number(trimmed);
        if (!trimmed || qty !== qty || qty <= 0) {
            setError('Enter a valid quantity above 0.');
            if (els.qtyInput) els.qtyInput.focus();
            return;
        }
        var delta = direction === 'out' ? -Math.abs(qty) : Math.abs(qty);
        state.touchQtySaving = true;
        setError(null);
        updateQtyButtons();
        var path = '/stock/materials/' + encodeURIComponent(state.touchQtyId) + '/adjust';
        LegacyApi.post(path, { delta: delta }, function (err) {
            state.touchQtySaving = false;
            updateQtyButtons();
            if (err) {
                setError(err.message || 'Failed to update stock movement');
                return;
            }
            setNotice(direction === 'out' ? 'Stock taken out.' : 'Stock added.');
            closeTouchQty();
            loadMain();
        });
    }

    function renderAmbiguous() {
        if (!els.ambiguous) return;
        if (!state.barcodeAmbiguousIds || !state.barcodeAmbiguousIds.length) {
            els.ambiguous.className = 'stock-ambiguous hidden';
            els.ambiguous.innerHTML = '';
            return;
        }
        els.ambiguous.className = 'stock-ambiguous';
        els.ambiguous.innerHTML = '';
        var label = document.createElement('span');
        label.className = 'stock-muted';
        label.textContent = 'Ambiguous barcode — pick material:';
        els.ambiguous.appendChild(label);
        for (var i = 0; i < state.barcodeAmbiguousIds.length; i += 1) {
            (function (id) {
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'stock-btn-secondary';
                btn.textContent = id;
                btn.onclick = function () {
                    state.barcodeAmbiguousIds = null;
                    renderAmbiguous();
                    LegacyApi.get('/stock/materials/' + encodeURIComponent(id), function (err, row) {
                        if (err || !row) {
                            setError(err ? err.message : 'Failed to load material');
                            return;
                        }
                        if (row.company === 'NP Material') state.companyScope = 'NP Material';
                        else state.companyScope = 'NL Material';
                        updateCompanyButtons();
                        state.q = '';
                        if (els.search) els.search.value = '';
                        loadMain();
                        setTimeout(function () {
                            var m = findMaterial(id);
                            if (m) openTouchQty(m);
                            else scrollToMaterial(id);
                        }, 400);
                    });
                };
                els.ambiguous.appendChild(btn);
            })(state.barcodeAmbiguousIds[i]);
        }
        var cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'stock-btn-secondary';
        cancel.textContent = 'Cancel';
        cancel.onclick = function () {
            state.barcodeAmbiguousIds = null;
            renderAmbiguous();
        };
        els.ambiguous.appendChild(cancel);
    }

    function lookupBarcode(code) {
        var path = '/stock/material-by-barcode?code=' + encodeURIComponent(code);
        LegacyApi.get(path, function (err, data, status) {
            if (status === 200 && data && data.material) {
                var m = data.material;
                state.barcodeAmbiguousIds = null;
                renderAmbiguous();
                if (m.company === 'NP Material') state.companyScope = 'NP Material';
                else state.companyScope = 'NL Material';
                updateCompanyButtons();
                state.q = '';
                if (els.search) els.search.value = '';
                loadMain();
                setTimeout(function () {
                    var row = findMaterial(m.material_id);
                    if (row) openTouchQty(row);
                    else {
                        LegacyApi.get(
                            '/stock/materials/' + encodeURIComponent(m.material_id),
                            function (e2, full) {
                                if (!e2 && full) openTouchQty(full);
                            }
                        );
                    }
                }, 400);
                return;
            }
            if (status === 409 && data && data.materialIds) {
                state.barcodeAmbiguousIds = data.materialIds;
                renderAmbiguous();
                return;
            }
            if (status === 404) {
                setError('No material for barcode: ' + code);
                return;
            }
            setError(err ? err.message : 'Barcode lookup failed');
        });
    }

    function updateCompanyButtons() {
        if (els.nlBtn) {
            els.nlBtn.className =
                'stock-company-btn' +
                (state.companyScope === 'NL Material' ? ' is-active' : '');
        }
        if (els.npBtn) {
            els.npBtn.className =
                'stock-company-btn' +
                (state.companyScope === 'NP Material' ? ' is-active' : '');
        }
    }

    function isTypingTarget(el) {
        if (!el || !el.tagName) return false;
        var tag = String(el.tagName).toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (el.isContentEditable) return true;
        return false;
    }

    function resetScanBuffer() {
        state.scanBuffer = '';
        if (state.scanTimer) {
            clearTimeout(state.scanTimer);
            state.scanTimer = null;
        }
    }

    function onGlobalKeyDown(e) {
        if (state.touchQtyId && els.qtyInput && e.target === els.qtyInput) {
            return;
        }
        if (isTypingTarget(e.target)) {
            resetScanBuffer();
            return;
        }

        if (e.key === 'Enter') {
            var buffered = (state.scanBuffer || '').trim();
            resetScanBuffer();
            if (buffered) {
                e.preventDefault();
                lookupBarcode(buffered);
            }
            return;
        }

        if (e.key === 'Backspace' || e.key === 'Delete') {
            if (state.scanBuffer.length > 0) {
                state.scanBuffer = state.scanBuffer.slice(0, -1);
            }
            return;
        }

        if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            var charToAdd = e.key === '-' && e.shiftKey ? '_' : e.key;
            if (/^[a-zA-Z0-9_\-]$/.test(charToAdd)) {
                state.scanBuffer += charToAdd;
                if (state.scanTimer) clearTimeout(state.scanTimer);
                state.scanTimer = setTimeout(function () {
                    resetScanBuffer();
                }, 500);
            }
        }
    }

    function bindEvents() {
        if (els.nlBtn) {
            els.nlBtn.onclick = function () {
                state.companyScope = 'NL Material';
                updateCompanyButtons();
                loadMain();
            };
        }
        if (els.npBtn) {
            els.npBtn.onclick = function () {
                state.companyScope = 'NP Material';
                updateCompanyButtons();
                loadMain();
            };
        }
        if (els.search) {
            els.search.oninput = function () {
                state.q = (els.search.value || '').trim();
                scheduleReload();
            };
        }
        if (els.qtyOverlay) {
            els.qtyOverlay.onclick = function (e) {
                if (e.target === els.qtyOverlay && !state.touchQtySaving) closeTouchQty();
            };
        }
        var qtyPanel = document.getElementById('stock-qty-panel');
        if (qtyPanel) {
            qtyPanel.onclick = function (e) {
                e.stopPropagation();
            };
        }
        if (els.qtyInput) {
            els.qtyInput.oninput = function () {
                state.touchQtyValue = els.qtyInput.value;
            };
        }
        if (els.qtyCancel) {
            els.qtyCancel.onclick = function () {
                if (!state.touchQtySaving) closeTouchQty();
            };
        }
        if (els.qtyTakeOut) {
            els.qtyTakeOut.onclick = function () {
                applyTouchQty('out');
            };
        }
        if (els.qtyStockIn) {
            els.qtyStockIn.onclick = function () {
                applyTouchQty('in');
            };
        }
    }

    var keyListenerBound = false;

    function start() {
        cacheElements();
        bindEvents();
        updateCompanyButtons();
        if (!keyListenerBound) {
            window.addEventListener('keydown', onGlobalKeyDown, true);
            keyListenerBound = true;
        }
        loadMain();
    }

    function stop() {
        closeTouchQty();
        resetScanBuffer();
        if (state.debounceTimer) {
            clearTimeout(state.debounceTimer);
            state.debounceTimer = null;
        }
    }

    return {
        start: start,
        stop: stop
    };
})();
