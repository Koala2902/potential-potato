(function () {
  var machineSelect = document.getElementById('machineSelect');
  var modeWrap = document.getElementById('modeWrap');
  var modeSelect = document.getElementById('modeSelect');
  var scanForm = document.getElementById('scanForm');
  var scanInput = document.getElementById('scanInput');
  var submitBtn = document.getElementById('submitBtn');
  var statusText = document.getElementById('statusText');
  var resultBox = document.getElementById('resultBox');
  var apiBaseInput = document.getElementById('apiBaseInput');
  var settingsToggleBtn = document.getElementById('settingsToggleBtn');
  var settingsPanel = document.getElementById('settingsPanel');

  var state = {
    machines: [],
    schedulerModes: [],
    catalogOps: [],
    isScanning: false,
    scanBuffer: '',
    scanTimer: null
  };

  function defaultApiBase() {
    var protocol = window.location.protocol || 'http:';
    var host = window.location.hostname || 'localhost';
    return protocol + '//' + host + ':3001/api';
  }

  function getApiBase() {
    var raw = (apiBaseInput.value || '').trim();
    if (!raw) return defaultApiBase();
    return raw.replace(/\/+$/, '');
  }

  function setStatus(message, type) {
    statusText.className = 'status';
    if (type === 'error') statusText.className += ' error';
    if (type === 'success') statusText.className += ' success';
    statusText.textContent = message;
  }

  function setResult(value) {
    if (typeof value === 'string') {
      resultBox.textContent = value;
      return;
    }
    try {
      resultBox.textContent = JSON.stringify(value, null, 2);
    } catch (e) {
      resultBox.textContent = String(value);
    }
  }

  function request(method, url, payload, done) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var data = null;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch (e) {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        done(null, data);
        return;
      }
      var message = (data && data.error) ? data.error : ('HTTP ' + xhr.status);
      done(new Error(message), data);
    };
    xhr.onerror = function () {
      done(new Error('Network error'));
    };
    xhr.send(payload ? JSON.stringify(payload) : null);
  }

  function catalogOpInMode(op, mode) {
    if (!op || !mode || !mode.operationIds) return false;
    var wanted = {};
    for (var i = 0; i < mode.operationIds.length; i += 1) {
      wanted[String(mode.operationIds[i]).toLowerCase()] = true;
    }
    var sched = String(op.scheduler_operation_id || '').toLowerCase();
    var planner = op.planner_operation_id ? String(op.planner_operation_id).toLowerCase() : '';
    return !!wanted[sched] || (!!planner && !!wanted[planner]);
  }

  function selectedMode() {
    var selectedId = modeSelect.value;
    for (var i = 0; i < state.schedulerModes.length; i += 1) {
      if (state.schedulerModes[i].id === selectedId) return state.schedulerModes[i];
    }
    return null;
  }

  function operationsForScan() {
    if (!state.schedulerModes.length) return state.catalogOps.slice();
    var mode = selectedMode();
    if (!mode) return [];
    var out = [];
    for (var i = 0; i < state.catalogOps.length; i += 1) {
      if (catalogOpInMode(state.catalogOps[i], mode)) out.push(state.catalogOps[i]);
    }
    return out;
  }

  function resolvePayloadOperationId() {
    var ops = operationsForScan();
    var first = ops.length ? ops[0] : null;
    if (!first) return null;
    var planner = first.planner_operation_id ? String(first.planner_operation_id).trim() : '';
    if (planner) return planner;
    return String(first.scheduler_operation_id || '').trim() || null;
  }

  function renderMachines() {
    machineSelect.innerHTML = '';
    var base = document.createElement('option');
    base.value = '';
    base.textContent = 'Select machine (' + state.machines.length + ' available)';
    machineSelect.appendChild(base);

    for (var i = 0; i < state.machines.length; i += 1) {
      var m = state.machines[i];
      var opt = document.createElement('option');
      opt.value = m.machine_id;
      opt.textContent = m.machine_name + (m.machine_type ? ' (' + m.machine_type + ')' : '');
      machineSelect.appendChild(opt);
    }
  }

  function renderModes() {
    if (!state.schedulerModes.length) {
      modeWrap.className = 'hidden';
      modeSelect.innerHTML = '<option value="">Select mode</option>';
      return;
    }
    modeWrap.className = '';
    modeSelect.innerHTML = '';
    var base = document.createElement('option');
    base.value = '';
    base.textContent = 'Select mode (' + state.schedulerModes.length + ' available)';
    modeSelect.appendChild(base);
    for (var i = 0; i < state.schedulerModes.length; i += 1) {
      var mode = state.schedulerModes[i];
      var opt = document.createElement('option');
      opt.value = mode.id;
      opt.textContent = mode.name;
      modeSelect.appendChild(opt);
    }
  }

  function loadMachines() {
    setStatus('Loading machines...', '');
    request('GET', getApiBase() + '/machines', null, function (err, data) {
      if (err) {
        setStatus('Failed to load machines: ' + err.message, 'error');
        return;
      }
      state.machines = data || [];
      renderMachines();
      setStatus('Ready.', '');
    });
  }

  function onMachineChange() {
    var machineId = machineSelect.value;
    state.schedulerModes = [];
    state.catalogOps = [];
    modeSelect.value = '';
    renderModes();
    if (!machineId) return;

    setStatus('Loading machine operations...', '');
    request('GET', getApiBase() + '/scheduler-modes?machineId=' + encodeURIComponent(machineId), null, function (modesErr, modesData) {
      if (modesErr) {
        setStatus('Failed to load modes: ' + modesErr.message, 'error');
        return;
      }
      request('GET', getApiBase() + '/operations?machineId=' + encodeURIComponent(machineId), null, function (opsErr, opsData) {
        if (opsErr) {
          setStatus('Failed to load operations: ' + opsErr.message, 'error');
          return;
        }
        state.schedulerModes = modesData || [];
        state.catalogOps = opsData || [];
        renderModes();
        setStatus('Machine ready for scan.', '');
      });
    });
  }

  function canSubmitScan(scanValue) {
    if (!scanValue) {
      setStatus('Scan value is required.', 'error');
      return false;
    }
    if (!machineSelect.value) {
      setStatus('Select a machine before scanning.', 'error');
      return false;
    }
    if (state.schedulerModes.length && !modeSelect.value) {
      setStatus('Select a mode before scanning.', 'error');
      return false;
    }
    var opId = resolvePayloadOperationId();
    if (!opId) {
      setStatus('No operation available for this machine/mode.', 'error');
      return false;
    }
    return true;
  }

  function submitScanValue(scanValue) {
    if (state.isScanning) return;
    if (!canSubmitScan(scanValue)) return;

    var payloadOpId = resolvePayloadOperationId();
    var payload = {
      scan: scanValue,
      machineId: machineSelect.value || null,
      operations: payloadOpId ? [payloadOpId] : null
    };

    state.isScanning = true;
    submitBtn.disabled = true;
    setStatus('Submitting scan...', '');

    request('POST', getApiBase() + '/scan', payload, function (err, data) {
      state.isScanning = false;
      submitBtn.disabled = false;
      if (err) {
        setStatus('Scan failed: ' + err.message, 'error');
        setResult(data || err.message);
        return;
      }
      setStatus('Scan recorded successfully.', 'success');
      setResult(data || {});
      scanInput.value = '';
      scanInput.focus();
    });
  }

  function onSubmitScan(e) {
    e.preventDefault();
    submitScanValue((scanInput.value || '').trim());
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
    if (isTypingTarget(e.target) && e.target !== scanInput) {
      resetScanBuffer();
      return;
    }

    if (e.key === 'Enter') {
      var buffered = (state.scanBuffer || '').trim();
      if (buffered && !state.isScanning) {
        e.preventDefault();
        resetScanBuffer();
        scanInput.value = buffered;
        submitScanValue(buffered);
      } else {
        resetScanBuffer();
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
      if (/^[a-zA-Z0-9_-]$/.test(e.key)) {
        state.scanBuffer += e.key;
        if (state.scanTimer) clearTimeout(state.scanTimer);
        state.scanTimer = setTimeout(function () {
          resetScanBuffer();
        }, 500);
      }
    }
  }

  function onToggleSettings() {
    var isHidden = settingsPanel.className.indexOf('hidden') !== -1;
    if (isHidden) {
      settingsPanel.className = settingsPanel.className.replace(/\bhidden\b/g, '').trim();
      settingsToggleBtn.textContent = 'Hide API/Port Settings';
      settingsToggleBtn.setAttribute('aria-expanded', 'true');
      return;
    }
    settingsPanel.className = (settingsPanel.className + ' hidden').trim();
    settingsToggleBtn.textContent = 'Show API/Port Settings';
    settingsToggleBtn.setAttribute('aria-expanded', 'false');
  }

  apiBaseInput.value = defaultApiBase();
  machineSelect.onchange = onMachineChange;
  scanForm.onsubmit = onSubmitScan;
  settingsToggleBtn.onclick = onToggleSettings;
  window.addEventListener('keydown', onGlobalKeyDown, true);
  loadMachines();
})();
