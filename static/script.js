/**
 * ZLD SCADA Telemetry & Dashboard Engine
 * Real-time monitoring, Canvas charts, Web Audio alerts, and hardware simulation
 */

// Global State
let chartHistoryLimit = 12;
let cachedHistory = [];
let audioMuted = localStorage.getItem('zld_audio_muted') === 'true';
let lastAlarmState = false;
let audioCtx = null;
let currentTableFilter = '';

// DOM Cache
const dom = {
  // Metric values
  ph: document.getElementById('phValue'),
  phNeedle: document.getElementById('phNeedle'),
  phLevel: document.getElementById('phLevel'),
  phMirror: document.getElementById('phMirror'),

  turbidity: document.getElementById('turbidityValue'),
  turbidityLevel: document.getElementById('turbidityLevel'),
  clarityFill: document.getElementById('clarityFill'),
  turbidityEstimatedNtu: document.getElementById('turbidityEstimatedNtu'),
  turbidityMirror: document.getElementById('turbidityMirror'),

  recoveryRateValue: document.getElementById('recoveryRateValue'),
  recoveryRateBadge: document.getElementById('recoveryRateBadge'),
  recoveryProgressBar: document.getElementById('recoveryProgressBar'),
  massBalanceDelta: document.getElementById('massBalanceDelta'),
  zldComplianceStatus: document.getElementById('zldComplianceStatus'),

  tankPercentage: document.getElementById('tankPercentageValue'),
  tankPercentageMirror: document.getElementById('tankPercentageMirror'),
  tankStatusTag: document.getElementById('tankStatusTag'),
  waterLevel: document.getElementById('waterLevelValue'),
  waterLevelMirror: document.getElementById('waterLevelMirror'),
  tankFill: document.getElementById('tankFill'),

  inletFlow: document.getElementById('inletFlowValue'),
  recoveryFlow: document.getElementById('recoveryFlowValue'),
  rejectFlow: document.getElementById('rejectFlowValue'),

  inletTotal: document.getElementById('inletTotalValue'),
  recoveryTotal: document.getElementById('recoveryTotalValue'),
  rejectTotal: document.getElementById('rejectTotalValue'),

  pumpStatus: document.getElementById('pumpStatusValue'),
  pumpStatusMirror: document.getElementById('pumpStatusMirror'),
  pumpImpellerCasing: document.getElementById('pumpImpellerCasing'),

  esp32Status: document.getElementById('esp32StatusValue'),
  esp32StatusMirror: document.getElementById('esp32StatusMirror'),
  lastUpdate: document.getElementById('lastUpdateText'),
  sensorUpdateTime: document.getElementById('sensorUpdateTime'),
  sensorUpdateMirror: document.getElementById('sensorUpdateMirror'),

  connectionBadge: document.getElementById('connectionBadge'),
  liveModeText: document.getElementById('liveModeText'),
  headerPulseDot: document.getElementById('headerPulseDot'),
  espDiscoveredPill: document.getElementById('espDiscoveredPill'),

  flowMismatchAlert: document.getElementById('flowMismatchAlert'),
  flowMismatchDetails: document.getElementById('flowMismatchDetails'),
  massBalancePill: document.getElementById('massBalancePill'),
  massBalanceText: document.getElementById('massBalanceText'),

  tableBody: document.getElementById('sensorTableBody'),
  tableFilterInput: document.getElementById('tableFilterInput'),

  alertsList: document.getElementById('alertsList'),
  systemNotifications: document.getElementById('systemNotifications'),
  testEmailButton: document.getElementById('testEmailButton'),
  testEmailMessage: document.getElementById('testEmailMessage'),
  refreshButton: document.getElementById('refreshButton'),

  simFeedback: document.getElementById('simFeedback'),
  systemClock: document.getElementById('systemClock'),

  themeToggle: document.getElementById('themeToggle'),
  themeIconSun: document.getElementById('themeIconSun'),
  themeIconMoon: document.getElementById('themeIconMoon'),

  audioAlarmToggle: document.getElementById('audioAlarmToggle'),
  audioIconOn: document.getElementById('audioIconOn'),
  audioIconOff: document.getElementById('audioIconOff'),

  qualityChart: document.getElementById('qualityChart'),
  flowChart: document.getElementById('flowChart'),
  qualityTooltip: document.getElementById('qualityTooltip'),
  flowTooltip: document.getElementById('flowTooltip'),
};

const sensorStatusElements = {
  ph: document.getElementById('phConnection'),
  turbidity: document.getElementById('turbidityConnection'),
  inlet_flow: document.getElementById('inletFlowConnection'),
  recovery_flow: document.getElementById('recoveryFlowConnection'),
  reject_flow: document.getElementById('rejectFlowConnection'),
  water_level: document.getElementById('waterLevelConnection'),
};

// ==========================================================================
// UTILITY FUNCTIONS
// ==========================================================================
function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '--';
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(digits) : value;
}

function formatSimpleDate(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatFullDate(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' ' + date.toLocaleDateString();
}

// Web Audio Beep Alert
function playAlarmChime() {
  if (audioMuted) return;
  try {
    const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
    if (!audioCtx) audioCtx = new AudioCtxClass();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';

    const now = audioCtx.currentTime;
    osc.frequency.setValueAtTime(587.33, now); // D5
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.12); // A5

    gain.gain.setValueAtTime(0.01, now);
    gain.gain.linearRampToValueAtTime(0.18, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.36);
  } catch (err) {
    console.warn('Audio alert unavailable:', err);
  }
}

// ==========================================================================
// CLOCK & THEME
// ==========================================================================
function updateClock() {
  if (!dom.systemClock) return;
  const now = new Date();
  const utc = now.toUTCString().slice(17, 25);
  dom.systemClock.textContent = utc;
}

function initPalette() {
  const saved = localStorage.getItem('zld_palette') || 'ocean';
  document.documentElement.setAttribute('data-palette', saved);
  updatePaletteOptions(saved);

  const btn = document.getElementById('paletteBtn');
  const dropdown = document.getElementById('paletteDropdown');
  if (btn && dropdown) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('hidden');
    });

    document.querySelectorAll('.palette-option').forEach((opt) => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const pal = opt.getAttribute('data-palette');
        if (pal) {
          document.documentElement.setAttribute('data-palette', pal);
          localStorage.setItem('zld_palette', pal);
          updatePaletteOptions(pal);
          dropdown.classList.add('hidden');
          if (cachedHistory.length) {
            updateCharts(cachedHistory);
          }
        }
      });
    });

    document.addEventListener('click', () => {
      dropdown.classList.add('hidden');
    });
  }
}

function updatePaletteOptions(activePal) {
  document.querySelectorAll('.palette-option').forEach((opt) => {
    if (opt.getAttribute('data-palette') === activePal) {
      opt.classList.add('active');
    } else {
      opt.classList.remove('active');
    }
  });
}

function initTheme() {
  const saved = localStorage.getItem('zld_theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcons(saved);

  if (dom.themeToggle) {
    dom.themeToggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const next = current === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('zld_theme', next);
      updateThemeIcons(next);
      if (cachedHistory.length) {
        updateCharts(cachedHistory);
      }
    });
  }
}

function updateThemeIcons(theme) {
  if (!dom.themeIconSun || !dom.themeIconMoon) return;
  if (theme === 'light') {
    dom.themeIconMoon.classList.remove('hidden');
    dom.themeIconSun.classList.add('hidden');
  } else {
    dom.themeIconSun.classList.remove('hidden');
    dom.themeIconMoon.classList.add('hidden');
  }
}

function initAudio() {
  updateAudioIcon();
  if (dom.audioAlarmToggle) {
    dom.audioAlarmToggle.addEventListener('click', () => {
      audioMuted = !audioMuted;
      localStorage.setItem('zld_audio_muted', audioMuted ? 'true' : 'false');
      updateAudioIcon();
      if (!audioMuted) playAlarmChime();
    });
  }
}

function updateAudioIcon() {
  if (!dom.audioIconOn || !dom.audioIconOff) return;
  if (audioMuted) {
    dom.audioIconOn.classList.add('hidden');
    dom.audioIconOff.classList.remove('hidden');
  } else {
    dom.audioIconOn.classList.remove('hidden');
    dom.audioIconOff.classList.add('hidden');
  }
}

// ==========================================================================
// TELEMETRY DISPLAY & DASHBOARD UPDATES
// ==========================================================================
function updateSensorStatuses(data) {
  const statuses = data.sensor_status || {};
  Object.entries(sensorStatusElements).forEach(([field, element]) => {
    if (!element) return;
    const status = statuses[field] || (data[field] === null || data[field] === undefined ? 'unknown' : 'connected');
    const labels = {
      connected: 'Connected',
      unplugged: 'Unplugged',
      unknown: 'Unknown',
      not_configured: 'Not Configured',
      stale: 'Offline',
    };
    element.textContent = labels[status] || 'Unknown';
    element.className = `sensor-status ${status}`;
  });
}

function updateSystemDisplay(data) {
  const timestamp = data.timestamp || null;
  const lastUpdateTime = timestamp ? new Date(timestamp) : null;
  const now = new Date();
  const elapsedSeconds = lastUpdateTime ? (now - lastUpdateTime) / 1000 : Infinity;
  const isOnline = data.source === 'esp32' && lastUpdateTime && elapsedSeconds <= 20;

  if (isOnline) {
    dom.connectionBadge.textContent = 'ESP32 Online';
    dom.connectionBadge.className = 'status-badge online';
    dom.esp32Status.textContent = 'Linked (HTTP/UDP)';
    if (dom.headerPulseDot) dom.headerPulseDot.style.background = 'var(--green)';
  } else if (data.source === 'sample') {
    dom.connectionBadge.textContent = 'Demo Mode';
    dom.connectionBadge.className = 'status-badge offline';
    dom.esp32Status.textContent = 'Simulated Data';
    if (dom.headerPulseDot) dom.headerPulseDot.style.background = 'var(--amber)';
  } else {
    dom.connectionBadge.textContent = 'Offline';
    dom.connectionBadge.className = 'status-badge critical';
    dom.esp32Status.textContent = 'Disconnected';
    if (dom.headerPulseDot) dom.headerPulseDot.style.background = 'var(--red)';
  }

  if (dom.esp32StatusMirror) dom.esp32StatusMirror.textContent = dom.esp32Status.textContent;

  const formattedTime = lastUpdateTime ? formatSimpleDate(lastUpdateTime) : '--';
  dom.lastUpdate.textContent = formattedTime;
  dom.sensorUpdateTime.textContent = formattedTime;
  if (dom.sensorUpdateMirror) dom.sensorUpdateMirror.textContent = formattedTime;

  if (data.source === 'sample') {
    dom.liveModeText.textContent = 'Simulation Mode';
    dom.liveModeText.className = 'mini-badge warning';
  } else {
    dom.liveModeText.textContent = 'Live SCADA Stream';
    dom.liveModeText.className = 'mini-badge good';
  }
}

function updateMetricTag(element, value, config) {
  if (!element) return;
  if (value === null || value === undefined || !Number.isFinite(value)) {
    element.textContent = 'Unknown';
    element.className = 'level-tag warning';
    return;
  }
  if (value > config.critical || (config.criticalLow && value < config.criticalLow)) {
    element.textContent = 'Critical';
    element.className = 'level-tag critical';
  } else if (value > config.warning || (config.warningLow && value < config.warningLow)) {
    element.textContent = 'Deviation';
    element.className = 'level-tag warning';
  } else {
    element.textContent = 'Optimal';
    element.className = 'level-tag good';
  }
}

function updateLatestReadings(data) {
  // 1. pH Sensor
  const phVal = data.ph !== null && data.ph !== undefined ? Number(data.ph) : null;
  dom.ph.textContent = phVal !== null ? phVal.toFixed(2) : '--';
  if (dom.phMirror) dom.phMirror.textContent = dom.ph.textContent;

  if (phVal !== null && dom.phNeedle) {
    const clampedPh = Math.max(0, Math.min(14, phVal));
    const percent = (clampedPh / 14) * 100;
    dom.phNeedle.style.left = `${percent}%`;
  }
  updateMetricTag(dom.phLevel, phVal, { warning: 8.5, warningLow: 6.5, critical: 9.5, criticalLow: 5.5 });

  // 2. Turbidity Sensor
  const turbVal = data.turbidity_raw_adc !== null && data.turbidity_raw_adc !== undefined
    ? Number(data.turbidity_raw_adc)
    : (data.turbidity !== null ? Math.round(Number(data.turbidity) * 115) : null);
  dom.turbidity.textContent = turbVal !== null ? Math.round(turbVal) : '--';
  if (dom.turbidityMirror) dom.turbidityMirror.textContent = dom.turbidity.textContent;

  if (turbVal !== null && dom.clarityFill) {
    const clarityPercent = Math.max(5, Math.min(100, (turbVal / 1023) * 100));
    dom.clarityFill.style.width = `${clarityPercent}%`;
  }
  if (dom.turbidityEstimatedNtu) {
    const estNtu = data.turbidity ? Number(data.turbidity).toFixed(1) : (turbVal ? (turbVal / 100).toFixed(1) : '--');
    dom.turbidityEstimatedNtu.textContent = `~${estNtu} NTU est.`;
  }
  updateMetricTag(dom.turbidityLevel, turbVal, { warning: 500, critical: 800 });

  // 3. Recovery Efficiency & Mass Balance
  const inlet = Number(data.inlet_flow || 0);
  const recovery = Number(data.recovery_flow || 0);
  const reject = Number(data.reject_flow || 0);

  let recoveryRate = data.recovery_rate !== undefined ? Number(data.recovery_rate) : 0;
  if (inlet > 0 && !recoveryRate) {
    recoveryRate = (recovery / inlet) * 100;
  }
  if (dom.recoveryRateValue) dom.recoveryRateValue.textContent = recoveryRate > 0 ? recoveryRate.toFixed(1) : '--';

  if (dom.recoveryProgressBar) {
    dom.recoveryProgressBar.style.width = `${Math.max(0, Math.min(100, recoveryRate))}%`;
  }
  if (dom.recoveryRateBadge) {
    dom.recoveryRateBadge.textContent = recoveryRate >= 75 ? 'Optimal' : (recoveryRate >= 50 ? 'Warning' : 'Low');
    dom.recoveryRateBadge.className = recoveryRate >= 75 ? 'level-tag good' : (recoveryRate >= 50 ? 'level-tag warning' : 'level-tag critical');
  }

  const delta = Math.abs(inlet - (recovery + reject));
  if (dom.massBalanceDelta) {
    dom.massBalanceDelta.textContent = `Δ ${delta.toFixed(2)} L/m`;
  }
  if (dom.zldComplianceStatus) {
    const compliant = !data.flow_mismatch && recoveryRate >= 70;
    dom.zldComplianceStatus.textContent = compliant ? 'ZLD Compliant' : 'Tolerance Alert';
    dom.zldComplianceStatus.className = `kpi-meta-hint ${compliant ? 'text-success' : 'text-danger'}`;
  }

  // 4. Tank Water Level
  const tankPercent = Number(data.tank_percentage || 0);
  dom.tankPercentage.textContent = formatNumber(tankPercent, 0);
  if (dom.tankPercentageMirror) dom.tankPercentageMirror.textContent = `${dom.tankPercentage.textContent}%`;

  const waterLevelCm = Number(data.water_level || 0);
  dom.waterLevel.textContent = `${formatNumber(waterLevelCm, 1)} cm`;
  if (dom.waterLevelMirror) dom.waterLevelMirror.textContent = `${formatNumber(waterLevelCm, 1)} cm`;

  if (dom.tankStatusTag) {
    dom.tankStatusTag.textContent = tankPercent < 20 ? 'Low Level' : (tankPercent > 85 ? 'High Level' : 'Normal');
    dom.tankStatusTag.className = (tankPercent < 20 || tankPercent > 85) ? 'level-tag warning' : 'level-tag good';
  }

  if (dom.tankFill) {
    dom.tankFill.style.height = `${Math.max(0, Math.min(100, tankPercent))}%`;
    if (tankPercent < 20) {
      dom.tankFill.style.background = 'linear-gradient(180deg, #f43f5e 0%, #be123c 100%)';
    } else if (tankPercent > 85) {
      dom.tankFill.style.background = 'linear-gradient(180deg, #f59e0b 0%, #b45309 100%)';
    } else {
      dom.tankFill.style.background = 'linear-gradient(180deg, #38bdf8 0%, #0369a1 100%)';
    }
  }

  // 5. Flow monitoring readouts
  dom.inletFlow.textContent = formatNumber(data.inlet_flow, 2);
  dom.recoveryFlow.textContent = formatNumber(data.recovery_flow, 2);
  dom.rejectFlow.textContent = formatNumber(data.reject_flow, 2);

  dom.inletTotal.textContent = `${formatNumber(data.inlet_total_liters, 1)} L`;
  dom.recoveryTotal.textContent = `${formatNumber(data.recovery_total_liters, 1)} L`;
  dom.rejectTotal.textContent = `${formatNumber(data.reject_total_liters, 1)} L`;

  // 6. Pump Status
  const pumpOn = (data.pump_status || '').toUpperCase() === 'ON';
  dom.pumpStatus.textContent = pumpOn ? 'RUNNING' : 'STANDBY';
  dom.pumpStatus.style.color = pumpOn ? 'var(--green)' : 'var(--amber)';
  if (dom.pumpStatusMirror) {
    dom.pumpStatusMirror.textContent = pumpOn ? 'RUNNING' : 'STOPPED';
    dom.pumpStatusMirror.style.color = pumpOn ? 'var(--green)' : 'var(--amber)';
    dom.pumpStatusMirror.style.background = pumpOn ? 'rgba(16, 185, 129, 0.2)' : 'rgba(245, 158, 11, 0.2)';
  }
  if (dom.pumpImpellerCasing) {
    dom.pumpImpellerCasing.style.borderColor = pumpOn ? 'var(--green)' : 'var(--amber)';
    dom.pumpImpellerCasing.style.color = pumpOn ? 'var(--green)' : 'var(--amber)';
    const svg = dom.pumpImpellerCasing.querySelector('.impeller-svg');
    if (svg) svg.style.animationPlayState = pumpOn ? 'running' : 'paused';
  }

  // 7. Mass Balance & Mismatch Alert
  const hasMismatch = Boolean(data.flow_mismatch);
  dom.flowMismatchAlert.hidden = !hasMismatch;
  if (hasMismatch) {
    dom.flowMismatchDetails.textContent = data.flow_mismatch_details || 'Inlet vs Recovery flow discrepancy detected.';
    if (!lastAlarmState) {
      playAlarmChime();
    }
  }
  lastAlarmState = hasMismatch;

  if (dom.massBalancePill && dom.massBalanceText) {
    if (hasMismatch) {
      dom.massBalancePill.className = 'balance-status mismatch';
      dom.massBalanceText.textContent = 'Mismatch Alert Active';
    } else {
      dom.massBalancePill.className = 'balance-status';
      dom.massBalanceText.textContent = 'Mass Balance Balanced';
    }
  }

  updateSensorStatuses(data);
  updateSystemDisplay(data);
}

function updateNotifications(data) {
  const timestamp = formatSimpleDate(data.timestamp);
  const alerts = [];

  if (data.flow_mismatch) {
    alerts.push(`
      <div class="notification danger">
        <b>Mass Balance Mismatch</b>
        <span>${data.flow_mismatch_details}</span>
        <time>${timestamp}</time>
      </div>
    `);
  }

  if (data.ph === null || data.ph === undefined) {
    alerts.push(`
      <div class="notification warning">
        <b>pH Probe Disconnected</b>
        <span>Open-circuit or UART handshake timeout on GPIO 34.</span>
        <time>${timestamp}</time>
      </div>
    `);
  }

  const turbVal = data.turbidity_raw_adc !== null ? Number(data.turbidity_raw_adc) : null;
  if (turbVal && turbVal > 750) {
    alerts.push(`
      <div class="notification danger">
        <b>Turbidity Exceeds Critical Threshold</b>
        <span>Elevated solids detected in influent stream: ${turbVal} ADC.</span>
        <time>${timestamp}</time>
      </div>
    `);
  }

  if (data.source !== 'esp32') {
    alerts.push(`
      <div class="notification info">
        <b>Simulation / Demo Mode Active</b>
        <span>Operating without physical ESP32 hardware packet stream.</span>
        <time>${timestamp}</time>
      </div>
    `);
  }

  if (!alerts.length) {
    alerts.push(`
      <div class="notification success">
        <b>All Process Parameters Nominal</b>
        <span>Continuous closed-loop ZLD treatment running within configured boundaries.</span>
        <time>${timestamp}</time>
      </div>
    `);
  }

  dom.alertsList.innerHTML = alerts.join('');

  dom.systemNotifications.innerHTML = [
    `<div><span class="dot success-dot"></span>Telemetry packet parsed <time>${timestamp}</time></div>`,
    `<div><span class="dot success-dot"></span>Mass balance calculation sync <time>${timestamp}</time></div>`,
    `<div><span class="dot ${data.source === 'esp32' ? 'success-dot' : 'warning-dot'}"></span>ESP32 Link ${data.source === 'esp32' ? 'Stream Live' : 'Demo State'} <time>${timestamp}</time></div>`,
  ].join('');
}

function buildSensorTable(data) {
  const statuses = data.sensor_status || {};
  const items = [
    ['Effluent pH Probe', data.ph !== null ? Number(data.ph).toFixed(2) : '--', 'pH', 'ph', data.timestamp],
    ['Turbidity Raw ADC', data.turbidity_raw_adc !== null && data.turbidity_raw_adc !== undefined ? data.turbidity_raw_adc : (data.turbidity ? Math.round(data.turbidity * 115) : '--'), 'ADC', 'turbidity', data.timestamp],
    ['Inlet Feed Flow', formatNumber(data.inlet_flow, 2), 'L/min', 'inlet_flow', data.timestamp],
    ['Permeate Recovery Flow', formatNumber(data.recovery_flow, 2), 'L/min', 'recovery_flow', data.timestamp],
    ['Concentrate Reject Flow', formatNumber(data.reject_flow, 2), 'L/min', 'reject_flow', data.timestamp],
    ['Ultrasonic Liquid Depth', formatNumber(data.water_level, 1), 'cm', 'water_level', data.timestamp],
    ['Buffer Tank Capacity', formatNumber(data.tank_percentage, 0), '%', 'water_level', data.timestamp],
    ['High-Pressure Booster Pump', (data.pump_status || 'OFF').toUpperCase(), 'STATE', null, data.timestamp],
  ];

  const filterText = (dom.tableFilterInput ? dom.tableFilterInput.value : '').toLowerCase().trim();

  const filtered = items.filter(([label]) => {
    return !filterText || label.toLowerCase().includes(filterText);
  });

  if (!filtered.length) {
    dom.tableBody.innerHTML = '<tr><td colspan="6" class="table-loading">No matching parameters found.</td></tr>';
    return;
  }

  dom.tableBody.innerHTML = filtered
    .map(([label, value, unit, sensor, timestamp]) => {
      const status = sensor ? (statuses[sensor] || 'unknown') : 'connected';
      const statusLabel = {
        connected: 'Connected',
        unplugged: 'Unplugged',
        unknown: 'Unknown',
        not_configured: 'Not Configured',
      }[status] || 'Active';

      const assessment = data.flow_mismatch && label.includes('Flow')
        ? '<span class="level-tag critical">Mismatch</span>'
        : '<span class="level-tag good">Normal</span>';

      return `
        <tr>
          <td><strong>${label}</strong></td>
          <td class="mono-text">${value}</td>
          <td><span class="unit-tag">${unit}</span></td>
          <td><span class="sensor-status ${status}">${statusLabel}</span></td>
          <td>${assessment}</td>
          <td class="mono-text">${timestamp ? formatFullDate(timestamp) : '--'}</td>
        </tr>
      `;
    })
    .join('');
}

// ==========================================================================
// HIGH-DPI RETINA CANVAS CHARTS
// ==========================================================================
function setupCanvasDpi(canvas) {
  if (!canvas) return null;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width || canvas.width;
  const height = rect.height || canvas.height;

  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const ctx = canvas.getContext('2d');
  ctx.resetTransform?.();
  ctx.scale(dpr, dpr);
  return { ctx, width, height };
}

function drawHighPrecisionChart(canvas, labels, datasets, tooltipEl) {
  const setup = setupCanvasDpi(canvas);
  if (!setup) return;
  const { ctx, width, height } = setup;

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const padding = { top: 22, right: 24, bottom: 32, left: 44 };
  const graphWidth = width - padding.left - padding.right;
  const graphHeight = height - padding.top - padding.bottom;

  ctx.clearRect(0, 0, width, height);

  if (!datasets.length || !labels.length) {
    ctx.fillStyle = isDark ? '#475569' : '#94a3b8';
    ctx.font = '13px Inter, sans-serif';
    ctx.fillText('Waiting for telemetry stream...', width / 2 - 90, height / 2);
    return;
  }

  // Value Ranges
  const allValues = datasets.flatMap(d => d.data);
  const rawMax = Math.max(...allValues, 1);
  const rawMin = Math.min(...allValues, 0);
  const paddingMargin = (rawMax - rawMin) * 0.1 || 1;
  const maxValue = rawMax + paddingMargin;
  const minValue = Math.max(0, rawMin - paddingMargin);
  const valueRange = Math.max(maxValue - minValue, 0.01);

  // Background Grid Lines
  ctx.strokeStyle = isDark ? 'rgba(148, 163, 184, 0.08)' : 'rgba(203, 213, 225, 0.6)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);

  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const y = padding.top + (graphHeight / gridSteps) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    // Y Axis labels
    const val = maxValue - (valueRange / gridSteps) * i;
    ctx.fillStyle = isDark ? '#64748b' : '#94a3b8';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(val.toFixed(1), padding.left - 8, y + 3);
  }
  ctx.setLineDash([]);

  // Plot Lines and Areas
  const pointPositions = [];

  datasets.forEach((ds) => {
    const coords = [];
    const count = labels.length;

    ds.data.forEach((val, idx) => {
      const x = padding.left + (count > 1 ? (graphWidth / (count - 1)) * idx : graphWidth / 2);
      const normalized = (val - minValue) / valueRange;
      const y = padding.top + graphHeight - normalized * graphHeight;
      coords.push({ x, y, value: val, label: labels[idx], name: ds.name, color: ds.color });
    });

    pointPositions.push(coords);

    if (coords.length > 1) {
      // Gradient Fill Area
      const grad = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
      grad.addColorStop(0, ds.fillColor || `${ds.color}33`);
      grad.addColorStop(1, 'transparent');

      ctx.beginPath();
      ctx.moveTo(coords[0].x, coords[0].y);
      for (let i = 0; i < coords.length - 1; i++) {
        const xc = (coords[i].x + coords[i + 1].x) / 2;
        const yc = (coords[i].y + coords[i + 1].y) / 2;
        ctx.quadraticCurveTo(coords[i].x, coords[i].y, xc, yc);
      }
      ctx.lineTo(coords[coords.length - 1].x, coords[coords.length - 1].y);
      ctx.lineTo(coords[coords.length - 1].x, height - padding.bottom);
      ctx.lineTo(coords[0].x, height - padding.bottom);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // Stroke Curve
      ctx.beginPath();
      ctx.moveTo(coords[0].x, coords[0].y);
      for (let i = 0; i < coords.length - 1; i++) {
        const xc = (coords[i].x + coords[i + 1].x) / 2;
        const yc = (coords[i].y + coords[i + 1].y) / 2;
        ctx.quadraticCurveTo(coords[i].x, coords[i].y, xc, yc);
      }
      ctx.lineTo(coords[coords.length - 1].x, coords[coords.length - 1].y);
      ctx.strokeStyle = ds.color;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // Point Markers
    coords.forEach((pt) => {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = ds.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = isDark ? '#111a2c' : '#ffffff';
      ctx.stroke();
    });
  });

  // X Axis Timestamps
  ctx.fillStyle = isDark ? '#64748b' : '#94a3b8';
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  const labelInterval = Math.max(1, Math.floor(labels.length / 5));

  labels.forEach((lbl, idx) => {
    if (idx % labelInterval === 0 || idx === labels.length - 1) {
      const x = padding.left + (labels.length > 1 ? (graphWidth / (labels.length - 1)) * idx : graphWidth / 2);
      ctx.fillText(lbl, x, height - 10);
    }
  });

  // Attach hover crosshair tooltip
  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    let closestIndex = -1;
    let minDistance = Infinity;

    labels.forEach((_, idx) => {
      const x = padding.left + (labels.length > 1 ? (graphWidth / (labels.length - 1)) * idx : graphWidth / 2);
      const dist = Math.abs(mouseX - x);
      if (dist < minDistance) {
        minDistance = dist;
        closestIndex = idx;
      }
    });

    if (closestIndex !== -1 && minDistance < 40 && tooltipEl) {
      const info = datasets.map(d => `<span style="color:${d.color}">${d.name}: <b>${Number(d.data[closestIndex]).toFixed(2)}</b></span>`).join('<br>');
      tooltipEl.innerHTML = `<strong>${labels[closestIndex]}</strong><br>${info}`;
      tooltipEl.hidden = false;
    } else if (tooltipEl) {
      tooltipEl.hidden = true;
    }
  };

  canvas.onmouseleave = () => {
    if (tooltipEl) tooltipEl.hidden = true;
  };
}

function getThemeColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    cyan: s.getPropertyValue('--cyan').trim() || '#2dd4bf',
    inlet: s.getPropertyValue('--stream-inlet').trim() || '#38bdf8',
    recovery: s.getPropertyValue('--stream-recovery').trim() || '#10b981',
    reject: s.getPropertyValue('--stream-reject').trim() || '#f97316',
    amber: s.getPropertyValue('--amber').trim() || '#f59e0b',
    red: s.getPropertyValue('--red').trim() || '#f43f5e',
  };
}

function updateCharts(history) {
  if (!history || !history.length) return;
  cachedHistory = history;

  const sliced = history.slice(-chartHistoryLimit);
  const labels = sliced.map(row => {
    const date = new Date(row.timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  });

  const c = getThemeColors();

  // 1. Water Quality Trends (pH and Turbidity)
  const qualityDatasets = [
    {
      name: 'Effluent pH',
      color: c.cyan,
      fillColor: `${c.cyan}25`,
      data: sliced.map(r => Number(r.ph ?? 7.0)),
    },
    {
      name: 'Turbidity (ADC/100)',
      color: c.amber,
      fillColor: `${c.amber}25`,
      data: sliced.map(r => {
        const adc = r.turbidity_raw_adc !== null && r.turbidity_raw_adc !== undefined
          ? r.turbidity_raw_adc
          : (r.turbidity ? r.turbidity * 115 : 0);
        return Number((adc / 100).toFixed(2));
      }),
    },
  ];
  drawHighPrecisionChart(dom.qualityChart, labels, qualityDatasets, dom.qualityTooltip);

  // 2. Flow Dynamics Trends
  const flowDatasets = [
    {
      name: 'Inlet Flow',
      color: c.inlet,
      fillColor: `${c.inlet}25`,
      data: sliced.map(r => Number(r.inlet_flow ?? 0)),
    },
    {
      name: 'Recovery Flow',
      color: c.recovery,
      fillColor: `${c.recovery}25`,
      data: sliced.map(r => Number(r.recovery_flow ?? 0)),
    },
    {
      name: 'Reject Flow',
      color: c.reject,
      fillColor: `${c.reject}25`,
      data: sliced.map(r => Number(r.reject_flow ?? 0)),
    },
  ];
  drawHighPrecisionChart(dom.flowChart, labels, flowDatasets, dom.flowTooltip);
}

// ==========================================================================
// SIMULATION BENCHMARK CONTROLS
// ==========================================================================
async function runSimulationPreset(preset) {
  if (dom.simFeedback) {
    dom.simFeedback.hidden = false;
    dom.simFeedback.textContent = `Injecting "${preset}" scenario into SCADA engine...`;
  }
  try {
    const res = await fetch('/api/simulate-preset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset }),
    });
    const result = await res.json();
    if (result.status === 'ok') {
      if (dom.simFeedback) {
        dom.simFeedback.textContent = `Injected "${preset}" scenario successfully.`;
        setTimeout(() => { if (dom.simFeedback) dom.simFeedback.hidden = true; }, 3500);
      }
      await refreshDashboard();
    }
  } catch (err) {
    console.error('Simulation fault injection failed:', err);
    if (dom.simFeedback) {
      dom.simFeedback.textContent = `Injection failed: ${err.message}`;
    }
  }
}

function initSimulationButtons() {
  document.querySelectorAll('.btn-sim').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.getAttribute('data-preset');
      if (preset) runSimulationPreset(preset);
    });
  });
}

function initChartRangeButtons() {
  document.querySelectorAll('.chart-range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chart-range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chartHistoryLimit = Number(btn.getAttribute('data-limit') || 12);
      if (cachedHistory.length) {
        updateCharts(cachedHistory);
      }
    });
  });
}

// ==========================================================================
// EMAIL TEST DISPATCH
// ==========================================================================
async function sendTestEmail() {
  dom.testEmailButton.disabled = true;
  dom.testEmailButton.innerHTML = 'Dispatching...';
  dom.testEmailMessage.textContent = '';
  dom.testEmailMessage.className = 'test-email-message';
  try {
    const response = await fetch('/api/test-email', { method: 'POST' });
    const result = await response.json();
    if (!response.ok || result.status !== 'success') {
      throw new Error(result.message || `Request failed: ${response.status}`);
    }
    dom.testEmailMessage.textContent = `Dispatched: ${result.message} to ${result.recipient}`;
    dom.testEmailMessage.className = 'test-email-message success-message';
  } catch (error) {
    dom.testEmailMessage.textContent = `Dispatch error: ${error.message}`;
    dom.testEmailMessage.className = 'test-email-message error-message';
  } finally {
    dom.testEmailButton.disabled = false;
    dom.testEmailButton.innerHTML = `
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
      Test Dispatch
    `;
  }
}

// ==========================================================================
// DATA REFRESH CYCLE
// ==========================================================================
async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function refreshDashboard() {
  try {
    const [latest, historyResponse] = await Promise.all([
      fetchJson('/api/latest'),
      fetchJson('/api/history?limit=60'),
    ]);

    updateLatestReadings(latest);
    updateNotifications(latest);
    buildSensorTable(latest);
    updateCharts(historyResponse.data || []);
  } catch (error) {
    dom.connectionBadge.textContent = 'Server Disconnected';
    dom.connectionBadge.className = 'status-badge offline';
    dom.esp32Status.textContent = 'Backend Offline';
    dom.lastUpdate.textContent = '--';
    dom.sensorUpdateTime.textContent = '--';
    dom.liveModeText.textContent = 'Connection Interrupted';
    dom.liveModeText.className = 'mini-badge warning';
    console.error('SCADA telemetry sync failed:', error);
  }
}

async function discoverEspDevices() {
  try {
    const response = await fetchJson('/api/discover');
    const device = response.devices && response.devices[0];
    if (device && dom.espDiscoveredPill) {
      dom.espDiscoveredPill.textContent = `ESP Found: ${device.ip}`;
      dom.espDiscoveredPill.classList.remove('hidden');
    }
  } catch (error) {
    // Non-blocking UDP discovery catch
  }
}

// ==========================================================================
// INITIALIZATION
// ==========================================================================
window.addEventListener('DOMContentLoaded', () => {
  initPalette();
  initTheme();
  initAudio();
  initSimulationButtons();
  initChartRangeButtons();
  updateClock();
  window.setInterval(updateClock, 1000);

  if (dom.refreshButton) {
    dom.refreshButton.addEventListener('click', refreshDashboard);
  }
  if (dom.testEmailButton) {
    dom.testEmailButton.addEventListener('click', sendTestEmail);
  }
  if (dom.tableFilterInput) {
    dom.tableFilterInput.addEventListener('input', () => {
      fetchJson('/api/latest').then(buildSensorTable).catch(() => {});
    });
  }

  // Window resize chart re-render
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (cachedHistory.length) updateCharts(cachedHistory);
    }, 150);
  });

  refreshDashboard();
  discoverEspDevices();
  window.setInterval(refreshDashboard, 4000);
  window.setInterval(discoverEspDevices, 30000);
});
