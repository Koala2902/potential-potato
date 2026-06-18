/* global document, LegacyApi */
var LegacyProduction = (function () {
    var SORT_ORDER_GROUPS = [
        ['INDIGO', '6900'],
        ['DIGICON'],
        ['BLADERUNNER', 'DIGITAL CUT', 'DIGITAL_CUT'],
        ['SLITTER', 'SLITTER_LINE']
    ];

    var state = {
        productionStatus: [],
        machines: [],
        historyMachineId: null,
        loading: true,
        error: null,
        hasLoadedOnce: false
    };

    var els = {};

    function cacheElements() {
        els.root = document.getElementById('view-production');
        els.grid = document.getElementById('production-grid');
        els.loading = document.getElementById('production-loading');
        els.error = document.getElementById('production-error');
        els.overlay = document.getElementById('production-history-overlay');
        els.history = document.getElementById('production-history');
        els.historyTitle = document.getElementById('production-history-title');
        els.historyProcessing = document.getElementById('production-history-processing');
        els.historyCompleted = document.getElementById('production-history-completed');
        els.historyClose = document.getElementById('production-history-close');
    }

    function ranked(machineStatus) {
        var name = '';
        for (var i = 0; i < state.machines.length; i += 1) {
            if (state.machines[i].machine_id === machineStatus.machine_id) {
                name = state.machines[i].machine_name || '';
                break;
            }
        }
        var hay = (machineStatus.machine_id + ' ' + name).toUpperCase();
        for (var g = 0; g < SORT_ORDER_GROUPS.length; g += 1) {
            var group = SORT_ORDER_GROUPS[g];
            for (var t = 0; t < group.length; t += 1) {
                if (hay.indexOf(group[t]) !== -1) return g;
            }
        }
        return SORT_ORDER_GROUPS.length;
    }

    function sortStatus(statusData, machinesData) {
        var sorted = statusData.slice();
        sorted.sort(function (a, b) {
            var aRank = ranked(a);
            var bRank = ranked(b);
            if (aRank !== bRank) return aRank - bRank;
            var an = a.machine_id;
            var bn = b.machine_id;
            for (var i = 0; i < machinesData.length; i += 1) {
                if (machinesData[i].machine_id === a.machine_id) an = machinesData[i].machine_name || an;
                if (machinesData[i].machine_id === b.machine_id) bn = machinesData[i].machine_name || bn;
            }
            return String(an).localeCompare(String(bn));
        });
        return sorted;
    }

    function getMachineName(machineId) {
        for (var i = 0; i < state.machines.length; i += 1) {
            if (state.machines[i].machine_id === machineId) {
                return state.machines[i].machine_name || machineId;
            }
        }
        return machineId;
    }

    function isPrintbeatPressDisconnected(pressState) {
        var s = pressState ? String(pressState).trim().toLowerCase() : '';
        return s.indexOf('disconnect') !== -1 || s.indexOf('disconect') !== -1 || /\boffline\b/.test(s);
    }

    function isPrintbeatPressBusy(pressState, metersPerHour) {
        if (isPrintbeatPressDisconnected(pressState)) return false;
        if (metersPerHour != null && Number(metersPerHour) === metersPerHour && metersPerHour > 0.5) {
            return true;
        }
        var s = pressState ? String(pressState).trim().toLowerCase() : '';
        if (!s) return false;
        if (/\b(idle|standby|ready|stopped|wait(ing)?|paused?|offline|sleep|maint|service)\b/.test(s)) {
            if (!/\b(print|production|impress|imprinting|running)\b/.test(s)) return false;
        }
        if (/\b(print|printing|production|impress|imprinting|running)\b/.test(s)) return true;
        if (s.indexOf('production') !== -1) return true;
        return false;
    }

    function humanizePressState(raw) {
        var t = String(raw || '').trim();
        if (!t) return t;
        var parts = t.split(/[\s_]+/).filter(Boolean);
        var out = [];
        for (var i = 0; i < parts.length; i += 1) {
            var w = parts[i];
            if (w.length > 1 && w === w.toUpperCase()) {
                out.push(w.charAt(0) + w.slice(1).toLowerCase());
            } else {
                out.push(w);
            }
        }
        return out.join(' ');
    }

    function cardStatus(machineStatus) {
        var hasProcessing = machineStatus.processing && machineStatus.processing.length > 0;
        var printbeatLive = machineStatus.printbeat_live;
        var pressDisconnected =
            printbeatLive != null && isPrintbeatPressDisconnected(printbeatLive.press_state);
        var printbeatBusy =
            printbeatLive != null &&
            !pressDisconnected &&
            (hasProcessing ||
                isPrintbeatPressBusy(printbeatLive.press_state, printbeatLive.meters_per_hour));

        var statusLabel;
        var statusModifier;
        if (printbeatLive != null) {
            if (pressDisconnected) {
                statusLabel = 'Disconnected';
                statusModifier = 'disconnected';
            } else {
                var ps = printbeatLive.press_state ? String(printbeatLive.press_state).trim() : '';
                if (ps) {
                    statusLabel = humanizePressState(ps);
                    statusModifier = printbeatBusy ? 'active' : 'idle';
                } else if (printbeatBusy) {
                    statusLabel = 'Printing';
                    statusModifier = 'active';
                } else {
                    statusLabel = hasProcessing ? 'Active' : 'Idle';
                    statusModifier = hasProcessing ? 'active' : 'idle';
                }
            }
        } else {
            statusLabel = hasProcessing ? 'Active' : 'Idle';
            statusModifier = hasProcessing ? 'active' : 'idle';
        }
        return { statusLabel: statusLabel, statusModifier: statusModifier };
    }

    function formatJobRelativeTime(job) {
        if (job.time_ago && String(job.time_ago).trim()) {
            return String(job.time_ago).trim();
        }
        var raw = job.seconds_ago;
        var s = typeof raw === 'string' ? Number(raw) : raw;
        if (typeof s === 'number' && s === s) {
            if (s < 0) return '—';
            if (s < 10) return 'Just now';
            if (s < 60) return s + 's ago';
            var minutes = Math.floor(s / 60);
            if (minutes < 60) return minutes + 'm ago';
            var hours = Math.floor(s / 3600);
            if (hours < 24) return hours + 'h ago';
            return Math.floor(s / 86400) + 'd ago';
        }
        return '—';
    }

    function renderGrid() {
        if (!els.grid) return;
        els.grid.innerHTML = '';
        var touchMachines = state.productionStatus.slice(0, 4);
        if (!touchMachines.length) {
            var empty = document.createElement('p');
            empty.className = 'legacy-empty';
            empty.textContent = state.hasLoadedOnce
                ? 'No production machines returned from the API.'
                : 'Loading…';
            els.grid.appendChild(empty);
            return;
        }
        for (var i = 0; i < touchMachines.length; i += 1) {
            (function (machineStatus) {
                var st = cardStatus(machineStatus);
                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className =
                    'production-touch-card production-touch-card--' + st.statusModifier;
                btn.onclick = function () {
                    openHistory(machineStatus.machine_id);
                };
                var nameEl = document.createElement('span');
                nameEl.className = 'production-touch-card__name';
                nameEl.textContent = getMachineName(machineStatus.machine_id);
                var statusEl = document.createElement('span');
                statusEl.className = 'production-touch-card__status';
                statusEl.textContent = st.statusLabel;
                btn.appendChild(nameEl);
                btn.appendChild(statusEl);
                els.grid.appendChild(btn);
            })(touchMachines[i]);
        }
    }

    function findMachineStatus(machineId) {
        for (var i = 0; i < state.productionStatus.length; i += 1) {
            if (state.productionStatus[i].machine_id === machineId) {
                return state.productionStatus[i];
            }
        }
        return null;
    }

    function renderJobList(container, jobs, emptyText) {
        container.innerHTML = '';
        if (!jobs || !jobs.length) {
            var p = document.createElement('p');
            p.className = 'production-touch-history__empty';
            p.textContent = emptyText;
            container.appendChild(p);
            return;
        }
        var ul = document.createElement('ul');
        for (var i = 0; i < jobs.length; i += 1) {
            var job = jobs[i];
            var li = document.createElement('li');
            var strong = document.createElement('strong');
            strong.textContent = job.job_id || '—';
            var span = document.createElement('span');
            span.textContent = formatJobRelativeTime(job);
            li.appendChild(strong);
            li.appendChild(span);
            ul.appendChild(li);
        }
        container.appendChild(ul);
    }

    function openHistory(machineId) {
        state.historyMachineId = machineId;
        var ms = findMachineStatus(machineId);
        if (!ms || !els.overlay) return;
        els.overlay.className = 'production-touch-history-overlay is-open';
        if (els.historyTitle) {
            els.historyTitle.textContent = getMachineName(machineId);
        }
        var procSection = document.getElementById('production-history-processing-wrap');
        if (procSection) {
            procSection.style.display = ms.processing && ms.processing.length ? '' : 'none';
        }
        if (els.historyProcessing) {
            renderJobList(els.historyProcessing, ms.processing, '');
        }
        if (els.historyCompleted) {
            renderJobList(els.historyCompleted, ms.completed, 'No recent jobs');
        }
    }

    function closeHistory() {
        state.historyMachineId = null;
        if (els.overlay) {
            els.overlay.className = 'production-touch-history-overlay';
        }
    }

    function setLoading(show) {
        if (els.loading) els.loading.className = show ? 'legacy-state legacy-state--loading' : 'legacy-state hidden';
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

    function render() {
        setLoading(false);
        renderGrid();
        if (state.historyMachineId) {
            openHistory(state.historyMachineId);
        }
    }

    function refresh(isFirst) {
        if (isFirst) {
            setLoading(true);
            setError(null);
        }

        LegacyApi.get('/machines', function (err, data) {
            if (err) {
                if (isFirst) {
                    setLoading(false);
                    setError('Machines: ' + (err.message || 'failed'));
                }
                return;
            }
            state.machines = data || [];
            if (!state.productionStatus.length) {
                state.productionStatus = stubStatusFromMachines(state.machines);
            }
            state.productionStatus = sortStatus(state.productionStatus, state.machines);
            setLoading(false);
            state.hasLoadedOnce = true;
            setError(null);
            render();
            if (isFirst) {
                setError('Loading live status… (production-status can take 10–20s)');
            }
        });

        LegacyApi.get('/production-status?lite=1', function (err, data) {
            if (err) {
                if (state.productionStatus.length) {
                    setError('Live status failed: ' + (err.message || ''));
                } else {
                    setLoading(false);
                    setError('Production status: ' + (err.message || 'failed'));
                }
                return;
            }
            state.productionStatus = sortStatus(data || [], state.machines);
            state.loading = false;
            state.hasLoadedOnce = true;
            setError(null);
            render();
        });
    }

    function stubStatusFromMachines(machines) {
        var out = [];
        for (var i = 0; i < machines.length; i += 1) {
            out.push({
                machine_id: machines[i].machine_id,
                processing: [],
                completed: [],
                printbeat_live: null
            });
        }
        return out;
    }

    function bindOverlay() {
        if (els.overlay) {
            els.overlay.onclick = function (e) {
                if (e.target === els.overlay) closeHistory();
            };
        }
        if (els.history) {
            els.history.onclick = function (e) {
                e.stopPropagation();
            };
        }
        if (els.historyClose) {
            els.historyClose.onclick = function () {
                closeHistory();
            };
        }
    }

    function start() {
        cacheElements();
        bindOverlay();
        refresh(true);
    }

    function stop() {
        closeHistory();
    }

    return {
        start: start,
        stop: stop,
        refresh: refresh
    };
})();
