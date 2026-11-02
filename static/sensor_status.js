const sensors = [
  { key: 'ph', label: 'pH Glass Electrode Probe (UART/Analog)', unit: 'pH', valueId: 'phValue' },
  { key: 'turbidity', label: 'Optical Turbidity Sensor (TS-300B)', unit: 'ADC', valueId: 'turbidityValue' },
  { key: 'inlet_flow', label: 'Inlet Feed Transmitter (YF-S201)', unit: 'L/min', valueId: 'inletFlowValue' },
  { key: 'recovery_flow', label: 'Permeate Recovery Transmitter (YF-S201)', unit: 'L/min', valueId: 'recoveryFlowValue' },
  { key: 'reject_flow', label: 'Concentrate Reject Transmitter (YF-S201)', unit: 'L/min', valueId: 'rejectFlowValue' },
  { key: 'water_level', label: 'Ultrasonic Tank Transceiver (AJ-SR04M)', unit: 'cm', valueId: 'waterLevelValue' },
];

const statusLabels = {
  connected: 'Connected',
  unplugged: 'Unplugged',
  unknown: 'Unknown',
  not_configured: 'Not Configured',
  stale: 'ESP Offline',
};

function formatValue(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '--';
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(digits) : value;
}

function formatTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' ' + date.toLocaleDateString();
}

function renderStatus(data) {
  const timestamp = data.timestamp ? new Date(data.timestamp) : null;
  const isLive = data.source === 'esp32' && timestamp && (Date.now() - timestamp.getTime()) <= 15000;
  const statuses = data.sensor_status || {};
  const effectiveStatuses = {};

  sensors.forEach((sensor) => {
    let status = statuses[sensor.key] || 'unknown';
    if (!isLive && data.source !== 'sample') {
      status = 'stale';
    }
    effectiveStatuses[sensor.key] = status;

    const cardStatus = document.getElementById(`${sensor.key}Status`);
    const valueElement = document.getElementById(sensor.valueId);

    if (cardStatus) {
      cardStatus.textContent = statusLabels[status] || 'Unknown';
      cardStatus.className = `sensor-status-badge ${status}`;
    }
    if (valueElement) {
      const val = sensor.key === 'turbidity'
        ? (data.turbidity_raw_adc !== null && data.turbidity_raw_adc !== undefined ? data.turbidity_raw_adc : data.turbidity)
        : data[sensor.key];
      valueElement.textContent = formatValue(val, sensor.key === 'turbidity' ? 0 : 2);
    }
  });

  const modeBadge = document.getElementById('statusModeBadge');
  if (modeBadge) {
    if (isLive) {
      modeBadge.textContent = 'ESP32 Live';
      modeBadge.className = 'status-badge online';
    } else if (data.source === 'sample') {
      modeBadge.textContent = 'Demo Mode';
      modeBadge.className = 'status-badge warning';
    } else {
      modeBadge.textContent = 'ESP32 Offline';
      modeBadge.className = 'status-badge offline';
    }
  }

  const updateTimeEl = document.getElementById('statusUpdateTime');
  if (updateTimeEl) {
    updateTimeEl.textContent = formatTime(data.timestamp);
  }

  const connectedCount = Object.values(effectiveStatuses).filter((s) => s === 'connected').length;
  const countEl = document.getElementById('sensorCountText');
  if (countEl) {
    countEl.textContent = `${connectedCount}/${sensors.length} Active`;
    countEl.className = connectedCount >= 4 ? 'mini-badge good' : 'mini-badge warning';
  }

  const tbody = document.getElementById('statusTableBody');
  if (tbody) {
    tbody.innerHTML = sensors.map((sensor) => {
      const status = effectiveStatuses[sensor.key];
      const val = sensor.key === 'turbidity'
        ? (data.turbidity_raw_adc !== null && data.turbidity_raw_adc !== undefined ? data.turbidity_raw_adc : data.turbidity)
        : data[sensor.key];
      return `
        <tr>
          <td><strong>${sensor.label}</strong></td>
          <td><span class="sensor-status-badge ${status}">${statusLabels[status] || 'Unknown'}</span></td>
          <td class="mono-text">${formatValue(val, sensor.key === 'turbidity' ? 0 : 2)}</td>
          <td><span class="unit-tag">${sensor.unit}</span></td>
          <td class="mono-text">${formatTime(data.timestamp)}</td>
        </tr>
      `;
    }).join('');
  }
}

async function refreshSensorStatus() {
  try {
    const response = await fetch('/api/latest');
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    const data = await response.json();
    renderStatus(data);
  } catch (error) {
    const modeBadge = document.getElementById('statusModeBadge');
    if (modeBadge) {
      modeBadge.textContent = 'Server Offline';
      modeBadge.className = 'status-badge offline';
    }
    console.error('Sensor status refresh failed:', error);
  }
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

// Theme handling
function initTheme() {
  const saved = localStorage.getItem('zld_theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcons(saved);

  const toggle = document.getElementById('themeToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const next = current === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('zld_theme', next);
      updateThemeIcons(next);
    });
  }
}

function updateThemeIcons(theme) {
  const sun = document.getElementById('themeIconSun');
  const moon = document.getElementById('themeIconMoon');
  if (!sun || !moon) return;
  if (theme === 'light') {
    dom_sun = sun;
    moon.classList.remove('hidden');
    sun.classList.add('hidden');
  } else {
    sun.classList.remove('hidden');
    moon.classList.add('hidden');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  initPalette();
  initTheme();
  refreshSensorStatus();
  window.setInterval(refreshSensorStatus, 4000);
});
