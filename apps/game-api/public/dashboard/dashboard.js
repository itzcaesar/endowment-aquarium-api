'use strict';

(() => {
  const STATS_URL = '/api/v1/admin/stats';
  const TOKEN_KEY = 'aquarium-admin-token';
  const REFRESH_MS = 30_000;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const $ = (id) => document.getElementById(id);
  const numberFormat = new Intl.NumberFormat();
  const compactFormat = new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  const hourFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

  const STATUS = {
    good: { label: 'Healthy', color: 'var(--good)' },
    warning: { label: 'Degraded', color: 'var(--warning)' },
    critical: { label: 'Failing', color: 'var(--critical)' },
    unknown: { label: 'No traffic yet', color: 'var(--neutral)' },
  };
  const TIER_LABELS = { COMMON: 'Common', RARE: 'Rare', EPIC: 'Epic', LEGENDARY: 'Legendary' };

  let timer = null;
  let lastData = null;

  // ---------- storage (may be unavailable: private mode, blocked storage) ----------
  const storage = {
    get() {
      try {
        return sessionStorage.getItem(TOKEN_KEY);
      } catch {
        return null;
      }
    },
    set(value) {
      try {
        sessionStorage.setItem(TOKEN_KEY, value);
      } catch {
        /* token then lives only in memory */
      }
    },
    clear() {
      try {
        sessionStorage.removeItem(TOKEN_KEY);
      } catch {
        /* ignore */
      }
    },
  };
  let memoryToken = storage.get();

  // ---------- DOM helpers (all data goes through textContent) ----------
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else if (key === 'style') Object.assign(node.style, value);
      else node.setAttribute(key, value);
    }
    for (const child of children) if (child) node.append(child);
    return node;
  }

  function svg(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'text') node.textContent = value;
      else node.setAttribute(key, String(value));
    }
    return node;
  }

  function statusIcon(status) {
    const icon = svg('svg', { viewBox: '0 0 20 20', class: 'status-icon', 'aria-hidden': 'true' });
    const color = (STATUS[status] || STATUS.unknown).color;
    if (status === 'warning') {
      icon.append(svg('path', { d: 'M10 2 L19 18 H1 Z', fill: color }));
      icon.append(
        svg('path', {
          d: 'M10 8 V12 M10 14.5 V15',
          stroke: '#0b0b0b',
          'stroke-width': 2,
          'stroke-linecap': 'round',
        }),
      );
      return icon;
    }
    icon.append(svg('circle', { cx: 10, cy: 10, r: 9, fill: color }));
    const mark =
      {
        good: 'M6 10.5 L9 13.5 L14 7.5',
        critical: 'M7 7 L13 13 M13 7 L7 13',
        unknown: 'M10 6.5 V10.5 M10 13.5 V14',
      }[status] || 'M10 6.5 V10.5 M10 13.5 V14';
    icon.append(
      svg('path', {
        d: mark,
        stroke: '#fff',
        'stroke-width': 2,
        fill: 'none',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }),
    );
    return icon;
  }

  function relativeTime(iso) {
    const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  }

  function duration(seconds) {
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function niceMax(value) {
    if (value <= 4) return 4;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    for (const step of [1, 2, 2.5, 5, 10]) {
      if (step * magnitude >= value) return step * magnitude;
    }
    return 10 * magnitude;
  }

  function table(headers, rows) {
    const head = el('thead', {}, [
      el(
        'tr',
        {},
        headers.map((header) =>
          el('th', { text: header.label, className: header.num ? 'num' : '', scope: 'col' }),
        ),
      ),
    ]);
    const body = el(
      'tbody',
      {},
      rows.map((row) =>
        el(
          'tr',
          {},
          row.map((cell, index) => {
            const td = el('td', { className: headers[index].num ? 'num' : '' });
            if (cell instanceof Node) td.append(cell);
            else td.textContent = cell;
            return td;
          }),
        ),
      ),
    );
    return el('table', {}, [head, body]);
  }

  // ---------- tooltip ----------
  const tooltip = $('tooltip');
  function showTooltip(event, value, label) {
    tooltip.replaceChildren(el('strong', { text: value }), el('span', { text: label }));
    tooltip.hidden = false;
    const rect = tooltip.getBoundingClientRect();
    const x = Math.min(event.clientX + 14, window.innerWidth - rect.width - 8);
    const y = Math.max(event.clientY - rect.height - 12, 8);
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  }
  function hideTooltip() {
    tooltip.hidden = true;
  }

  // ---------- health + KPIs ----------
  function statusCard(target, title, status, details) {
    const info = STATUS[status] || STATUS.unknown;
    target.replaceChildren(
      el('p', { className: 'muted', text: title }),
      el('div', { className: 'status-line' }, [
        statusIcon(status),
        el('span', { text: info.label }),
      ]),
      ...details.map((detail) => el('p', { className: 'status-detail', text: detail })),
    );
  }

  function renderHealth(data) {
    statusCard($('health-api'), 'Game API', 'good', [
      `Up ${duration(data.uptimeSeconds)} · Node ${data.service.node}`,
    ]);
    statusCard($('health-db'), 'PostgreSQL', data.database.status, [
      data.database.status === 'good'
        ? `Stats queries answered in ${data.database.queryMs} ms`
        : 'Stats query failed — check the API logs',
    ]);
    const endowment = data.endowment;
    const latency =
      endowment.p50Ms === null
        ? 'No latency samples yet'
        : `p50 ${endowment.p50Ms} ms · p95 ${endowment.p95Ms} ms`;
    statusCard($('health-endowment'), `Endowment API · ${endowment.host}`, endowment.status, [
      latency,
      endowment.lastError
        ? `Last error ${endowment.lastError.code} (${relativeTime(endowment.lastError.at)})`
        : 'No upstream errors recorded',
    ]);
  }

  function renderKpis(stats) {
    const activeFish = stats.fishByTier.reduce((sum, tier) => sum + tier.count, 0);
    const tiles = [
      {
        label: 'Donors',
        value: stats.donors.total,
        sub: `${numberFormat.format(stats.donors.nikSynced)} linked by NIK`,
      },
      {
        label: 'NIK syncs, 24h',
        value: stats.donors.syncedLast24h,
        sub: 'Donors refreshed from Endowment',
      },
      { label: 'Active fish', value: activeFish, sub: 'Swimming across all aquariums' },
      {
        label: 'Webhooks, 24h',
        value: stats.webhooks.last24h,
        sub:
          stats.webhooks.failed > 0
            ? `${numberFormat.format(stats.webhooks.failed)} failed in total`
            : 'No failed deliveries',
      },
      {
        label: 'Points issued',
        value: stats.inventoryPoints,
        sub: `${numberFormat.format(stats.donations.confirmed)} confirmed donations`,
      },
    ];
    $('kpis').replaceChildren(
      ...tiles.map((tile) =>
        el('article', { className: 'card kpi' }, [
          el('p', { className: 'label', text: tile.label }),
          el('p', {
            className: 'value',
            text:
              tile.value >= 100_000
                ? compactFormat.format(tile.value)
                : numberFormat.format(tile.value),
            title: numberFormat.format(tile.value),
          }),
          el('p', { className: 'sub', text: tile.sub }),
        ]),
      ),
    );
  }

  // ---------- line chart: events per hour ----------
  function renderActivity(hourly) {
    const container = $('activity-chart');
    const width = Math.max(container.clientWidth, 280);
    const height = 220;
    const margin = { top: 16, right: 44, bottom: 26, left: 36 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    const max = niceMax(Math.max(...hourly.map((point) => point.count), 0));
    const x = (index) => margin.left + (index / (hourly.length - 1)) * innerWidth;
    const y = (value) => margin.top + innerHeight - (value / max) * innerHeight;

    const root = svg('svg', {
      viewBox: `0 0 ${width} ${height}`,
      height,
      role: 'img',
      'aria-label': `Game events per hour over the last 24 hours, peak ${Math.max(...hourly.map((p) => p.count))}`,
    });

    for (let step = 0; step <= 4; step += 1) {
      const value = (max / 4) * step;
      const yPos = y(value);
      root.append(
        svg('line', {
          x1: margin.left,
          x2: width - margin.right,
          y1: yPos,
          y2: yPos,
          class: step === 0 ? 'baseline' : 'gridline',
        }),
      );
      root.append(
        svg('text', {
          x: margin.left - 8,
          y: yPos + 4,
          'text-anchor': 'end',
          class: 'axis-text',
          text: compactFormat.format(value),
        }),
      );
    }
    hourly.forEach((point, index) => {
      const tickEvery = width < 480 ? 12 : 6;
      if (index % tickEvery !== 0 && index !== hourly.length - 1) return;
      root.append(
        svg('text', {
          x: x(index),
          y: height - 6,
          'text-anchor': index === hourly.length - 1 ? 'end' : 'middle',
          class: 'axis-text',
          text: index === hourly.length - 1 ? 'Now' : hourFormat.format(new Date(point.hour)),
        }),
      );
    });

    const linePath = hourly
      .map((point, index) => `${index ? 'L' : 'M'}${x(index)},${y(point.count)}`)
      .join(' ');
    root.append(
      svg('path', {
        d: `${linePath} L${x(hourly.length - 1)},${y(0)} L${x(0)},${y(0)} Z`,
        fill: 'var(--series-wash)',
      }),
    );
    root.append(
      svg('path', {
        d: linePath,
        fill: 'none',
        stroke: 'var(--series)',
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      }),
    );
    const last = hourly[hourly.length - 1];
    root.append(
      svg('circle', {
        cx: x(hourly.length - 1),
        cy: y(last.count),
        r: 4,
        fill: 'var(--series)',
        stroke: 'var(--surface)',
        'stroke-width': 2,
      }),
    );
    root.append(
      svg('text', {
        x: x(hourly.length - 1) + 8,
        y: y(last.count) + 4,
        class: 'value-text',
        text: numberFormat.format(last.count),
      }),
    );

    // Crosshair + tooltip; keyboard reachable with arrow keys.
    const crosshair = svg('line', {
      y1: margin.top,
      y2: margin.top + innerHeight,
      class: 'baseline',
      visibility: 'hidden',
    });
    const focusDot = svg('circle', {
      r: 4,
      fill: 'var(--series)',
      stroke: 'var(--surface)',
      'stroke-width': 2,
      visibility: 'hidden',
    });
    const overlay = svg('rect', {
      x: margin.left,
      y: margin.top,
      width: innerWidth,
      height: innerHeight,
      fill: 'transparent',
      tabindex: 0,
      'aria-label': 'Hover or use arrow keys to read hourly values',
    });
    root.append(crosshair, focusDot, overlay);

    let activeIndex = hourly.length - 1;
    const show = (index, event) => {
      activeIndex = Math.max(0, Math.min(hourly.length - 1, index));
      const point = hourly[activeIndex];
      crosshair.setAttribute('x1', x(activeIndex));
      crosshair.setAttribute('x2', x(activeIndex));
      crosshair.setAttribute('visibility', 'visible');
      focusDot.setAttribute('cx', x(activeIndex));
      focusDot.setAttribute('cy', y(point.count));
      focusDot.setAttribute('visibility', 'visible');
      const start = new Date(point.hour);
      const end = new Date(start.getTime() + 3_600_000);
      const position =
        event ||
        (() => {
          const box = root.getBoundingClientRect();
          const scale = box.width / width;
          return {
            clientX: box.left + x(activeIndex) * scale,
            clientY: box.top + y(point.count) * scale,
          };
        })();
      showTooltip(
        position,
        `${numberFormat.format(point.count)} events`,
        `${hourFormat.format(start)} – ${hourFormat.format(end)}`,
      );
    };
    const hide = () => {
      crosshair.setAttribute('visibility', 'hidden');
      focusDot.setAttribute('visibility', 'hidden');
      hideTooltip();
    };
    overlay.addEventListener('pointermove', (event) => {
      const box = root.getBoundingClientRect();
      const localX = ((event.clientX - box.left) / box.width) * width;
      show(Math.round(((localX - margin.left) / innerWidth) * (hourly.length - 1)), event);
    });
    overlay.addEventListener('pointerleave', hide);
    overlay.addEventListener('blur', hide);
    overlay.addEventListener('focus', () => show(activeIndex));
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') show(activeIndex - 1);
      else if (event.key === 'ArrowRight') show(activeIndex + 1);
      else return;
      event.preventDefault();
    });

    container.replaceChildren(root);
    $('activity-table').replaceChildren(
      table(
        [{ label: 'Hour starting' }, { label: 'Events', num: true }],
        [...hourly]
          .reverse()
          .map((point) => [
            hourFormat.format(new Date(point.hour)),
            numberFormat.format(point.count),
          ]),
      ),
    );
  }

  // ---------- horizontal bars: fish by tier ----------
  function renderTiers(tiers) {
    const container = $('tiers-chart');
    const width = Math.max(container.clientWidth, 280);
    const rowHeight = 44;
    const barHeight = 20;
    const labelWidth = 84;
    const valueRoom = 48;
    const height = tiers.length * rowHeight + 8;
    const max = Math.max(...tiers.map((tier) => tier.count), 1);
    const scale = (value) => (value / max) * (width - labelWidth - valueRoom);

    const root = svg('svg', {
      viewBox: `0 0 ${width} ${height}`,
      height,
      role: 'img',
      'aria-label': tiers
        .map((tier) => `${TIER_LABELS[tier.tierCode] || tier.tierCode}: ${tier.count}`)
        .join(', '),
    });
    root.append(
      svg('line', { x1: labelWidth, x2: labelWidth, y1: 0, y2: height - 8, class: 'baseline' }),
    );

    tiers.forEach((tier, index) => {
      const top = index * rowHeight + (rowHeight - barHeight) / 2;
      const label = TIER_LABELS[tier.tierCode] || tier.tierCode;
      const barWidth = scale(tier.count);
      const group = svg('g', { tabindex: 0, 'aria-label': `${label}: ${tier.count} active fish` });
      group.append(
        svg('rect', { x: 0, y: index * rowHeight, width, height: rowHeight, fill: 'transparent' }),
      );
      group.append(
        svg('text', {
          x: labelWidth - 10,
          y: top + barHeight / 2 + 4,
          'text-anchor': 'end',
          class: 'label-text',
          text: label,
        }),
      );
      if (barWidth > 0) {
        // Square at the baseline, 4px rounded at the data end.
        const r = Math.min(4, barWidth);
        const x0 = labelWidth + 1;
        const x1 = x0 + barWidth;
        group.append(
          svg('path', {
            d: `M${x0},${top} H${x1 - r} Q${x1},${top} ${x1},${top + r} V${top + barHeight - r} Q${x1},${top + barHeight} ${x1 - r},${top + barHeight} H${x0} Z`,
            fill: 'var(--series)',
          }),
        );
      }
      group.append(
        svg('text', {
          x: labelWidth + barWidth + 8,
          y: top + barHeight / 2 + 4,
          class: 'value-text',
          text: numberFormat.format(tier.count),
        }),
      );
      const share =
        (tier.count /
          Math.max(
            tiers.reduce((sum, item) => sum + item.count, 0),
            1,
          )) *
        100;
      const tip = (event) =>
        showTooltip(
          event,
          `${numberFormat.format(tier.count)} fish`,
          `${label} · ${share.toFixed(0)}% of active`,
        );
      group.addEventListener('pointermove', tip);
      group.addEventListener('pointerleave', hideTooltip);
      group.addEventListener('focus', () => {
        const box = group.getBoundingClientRect();
        tip({ clientX: box.left + labelWidth + barWidth, clientY: box.top + 10 });
      });
      group.addEventListener('blur', hideTooltip);
      root.append(group);
    });

    container.replaceChildren(root);
    $('tiers-table').replaceChildren(
      table(
        [{ label: 'Tier' }, { label: 'Active fish', num: true }],
        tiers.map((tier) => [
          TIER_LABELS[tier.tierCode] || tier.tierCode,
          numberFormat.format(tier.count),
        ]),
      ),
    );
  }

  // ---------- Endowment lookups ----------
  function renderLookups(endowment) {
    const totals = endowment.totals;
    const all = totals.ok + totals.notFound + totals.error;
    const successRate =
      all === 0 ? '—' : `${(((totals.ok + totals.notFound) / all) * 100).toFixed(1)}%`;
    $('lookup-stats').replaceChildren(
      ...[
        ['Lookups', numberFormat.format(all)],
        ['Found', numberFormat.format(totals.ok)],
        ['Not found', numberFormat.format(totals.notFound)],
        ['Errors', numberFormat.format(totals.error)],
        ['Upstream success', successRate],
      ].map(([label, value]) =>
        el('div', {}, [
          el('span', { className: 'muted', text: label }),
          el('strong', { text: value }),
        ]),
      ),
    );
    if (endowment.recent.length === 0) {
      $('lookup-table').replaceChildren(
        el('p', { className: 'empty', text: 'No NIK logins recorded yet.' }),
      );
      return;
    }
    const outcome = {
      ok: ['good', 'Found'],
      not_found: ['unknown', 'Not found'],
      error: ['critical', 'Error'],
    };
    $('lookup-table').replaceChildren(
      table(
        [
          { label: 'When' },
          { label: 'Result' },
          { label: 'Code' },
          { label: 'Latency', num: true },
        ],
        endowment.recent.map((record) => {
          const [status, label] = outcome[record.outcome] || outcome.error;
          return [
            relativeTime(record.at),
            el('span', { className: 'pill' }, [statusIcon(status), el('span', { text: label })]),
            record.code || '—',
            `${numberFormat.format(record.latencyMs)} ms`,
          ];
        }),
      ),
    );
  }

  // ---------- webhook stacked bar (status colours, icon-free → legend carries labels) ----------
  function renderWebhooks(webhooks) {
    const parts = [
      { key: 'processed', label: 'Processed', color: 'var(--good)' },
      { key: 'duplicate', label: 'Duplicate (ignored)', color: 'var(--neutral)' },
      { key: 'received', label: 'Pending', color: 'var(--warning)' },
      { key: 'failed', label: 'Failed', color: 'var(--critical)' },
    ];
    const total = parts.reduce((sum, part) => sum + webhooks[part.key], 0);
    const bar = $('webhook-bar');
    if (total === 0) {
      bar.replaceChildren(el('p', { className: 'empty', text: 'No webhooks received yet.' }));
    } else {
      const track = el('div', {
        role: 'img',
        'aria-label': parts.map((part) => `${part.label}: ${webhooks[part.key]}`).join(', '),
        style: {
          display: 'flex',
          gap: '2px',
          height: '20px',
          borderRadius: '4px',
          overflow: 'hidden',
          marginTop: '4px',
        },
      });
      for (const part of parts) {
        const count = webhooks[part.key];
        if (count === 0) continue;
        const segment = el('div', {
          tabindex: '0',
          style: { flex: `${count} 0 0`, minWidth: '4px', background: part.color },
          'aria-label': `${part.label}: ${count}`,
        });
        const tip = (event) =>
          showTooltip(
            event,
            numberFormat.format(count),
            `${part.label} · ${((count / total) * 100).toFixed(1)}%`,
          );
        segment.addEventListener('pointermove', tip);
        segment.addEventListener('pointerleave', hideTooltip);
        segment.addEventListener('focus', () => {
          const box = segment.getBoundingClientRect();
          tip({ clientX: box.left + box.width / 2, clientY: box.top });
        });
        segment.addEventListener('blur', hideTooltip);
        track.append(segment);
      }
      bar.replaceChildren(track);
    }
    $('webhook-legend').replaceChildren(
      ...parts.map((part) =>
        el('li', {}, [
          el('span', { className: 'swatch', style: { background: part.color } }),
          el('span', { text: part.label }),
          el('strong', { text: numberFormat.format(webhooks[part.key]) }),
        ]),
      ),
    );
  }

  function renderDonations(stats) {
    const { confirmed, refunded } = stats.donations;
    const refundRate =
      confirmed + refunded === 0
        ? '—'
        : `${((refunded / (confirmed + refunded)) * 100).toFixed(1)}%`;
    $('donation-stats').replaceChildren(
      ...[
        ['Confirmed', numberFormat.format(confirmed)],
        ['Refunded', numberFormat.format(refunded)],
        ['Refund rate', refundRate],
        ['Points issued', numberFormat.format(stats.inventoryPoints)],
      ].map(([label, value]) =>
        el('div', {}, [
          el('span', { className: 'muted', text: label }),
          el('strong', { text: value }),
        ]),
      ),
    );
  }

  // ---------- recent events ----------
  function renderEvents(events) {
    if (events.length === 0) {
      $('events-table').replaceChildren(
        el('p', { className: 'empty', text: 'No game events yet.' }),
      );
      return;
    }
    $('events-table').replaceChildren(
      table(
        [
          { label: 'When' },
          { label: 'Event' },
          { label: 'Tier' },
          { label: 'Aquarium' },
          { label: '#', num: true },
        ],
        events.map((event) => [
          `${relativeTime(event.createdAt)} · ${timeFormat.format(new Date(event.createdAt))}`,
          event.eventType,
          event.tierCode ? TIER_LABELS[event.tierCode] || event.tierCode : '—',
          event.publicSlug,
          String(event.id),
        ]),
      ),
    );
  }

  // ---------- orchestration ----------
  function render(data) {
    lastData = data;
    renderHealth(data);
    if (data.stats) {
      $('banner').hidden = true;
      renderKpis(data.stats);
      renderActivity(data.stats.hourlyEvents);
      renderTiers(data.stats.fishByTier);
      renderWebhooks(data.stats.webhooks);
      renderDonations(data.stats);
      renderEvents(data.stats.recentEvents);
    } else {
      $('banner').textContent =
        'Database statistics are unavailable right now. Showing service health only.';
      $('banner').hidden = false;
    }
    renderLookups(data.endowment);
    $('updated').textContent = `Updated ${timeFormat.format(new Date(data.generatedAt))}`;
  }

  function showGate(message) {
    stopTimer();
    $('app').hidden = true;
    $('controls').hidden = true;
    $('gate').hidden = false;
    $('gate-error').textContent = message || '';
    $('token').focus();
  }

  async function load() {
    if (!memoryToken) return showGate();
    let response;
    try {
      response = await fetch(STATS_URL, {
        headers: { 'x-admin-token': memoryToken, accept: 'application/json' },
        cache: 'no-store',
      });
    } catch {
      $('banner').textContent = 'Cannot reach the Game API. Retrying automatically.';
      $('banner').hidden = false;
      return;
    }
    const body = await response.json().catch(() => null);
    if (response.status === 401) {
      memoryToken = null;
      storage.clear();
      return showGate('That token was rejected.');
    }
    if (!response.ok || !body || !body.data) {
      const message =
        body && body.error ? body.error.message : `Request failed (${response.status})`;
      if (response.status === 503) return showGate(message);
      $('banner').textContent = message;
      $('banner').hidden = false;
      return;
    }
    $('gate').hidden = true;
    $('app').hidden = false;
    $('controls').hidden = false;
    render(body.data);
    scheduleTimer();
  }

  function stopTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function scheduleTimer() {
    stopTimer();
    if ($('auto-refresh').checked && !document.hidden) timer = setTimeout(load, REFRESH_MS);
  }

  $('gate-form').addEventListener('submit', (event) => {
    event.preventDefault();
    memoryToken = $('token').value.trim();
    $('token').value = '';
    storage.set(memoryToken);
    load();
  });
  $('refresh').addEventListener('click', load);
  $('auto-refresh').addEventListener('change', scheduleTimer);
  $('sign-out').addEventListener('click', () => {
    memoryToken = null;
    storage.clear();
    showGate();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopTimer();
    else if (memoryToken && !$('app').hidden) load();
  });
  for (const button of document.querySelectorAll('[data-table-toggle]')) {
    button.addEventListener('click', () => {
      const tableEl = $(`${button.dataset.tableToggle}-table`);
      tableEl.hidden = !tableEl.hidden;
      button.textContent = tableEl.hidden ? 'Show table' : 'Hide table';
    });
  }
  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (lastData && lastData.stats) {
        renderActivity(lastData.stats.hourlyEvents);
        renderTiers(lastData.stats.fishByTier);
      }
    });
  });

  // Shared with admin.js (management views): token access and session expiry handling.
  window.AquariumDashboard = {
    token: () => memoryToken,
    unauthorized(message) {
      memoryToken = null;
      storage.clear();
      showGate(message || 'Your admin session expired. Enter the token again.');
    },
    refreshOverview: () => load(),
  };

  load();
})();
