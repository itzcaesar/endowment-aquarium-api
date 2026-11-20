'use strict';

/*
 * Management views for the operations dashboard: fish, donors (with inventory) and the audit
 * log. Every write goes through /api/v1/admin/* with the admin token and is recorded server-side
 * in admin_audit_log. All API data is inserted with textContent, never innerHTML.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const numberFormat = new Intl.NumberFormat();
  const rupiah = new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  });
  const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  const TIER_LABELS = { COMMON: 'Common', RARE: 'Rare', EPIC: 'Epic', LEGENDARY: 'Legendary' };
  const NAMED_COLORS = {
    DEFAULT: 'var(--neutral)',
    OCEAN_BLUE: '#2a78d6',
    CORAL_PINK: '#e87ba4',
    GOLDEN: '#eda100',
  };
  const ACCESSORY_LABELS = {
    NONE: 'None',
    TELU_CAP: 'Tel-U cap',
    GRADUATION_HAT: 'Graduation hat',
  };

  let catalog = null;
  let lastFocus = null;
  let drawerCleanup = null;

  // ------------------------------------------------------------------ helpers
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else if (key === 'style') Object.assign(node.style, value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }

  function relative(iso) {
    if (!iso) return '—';
    const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
    return dateTime.format(new Date(iso));
  }

  function shortId(id) {
    return String(id).slice(0, 8);
  }

  function debounce(fn, ms) {
    let handle = 0;
    return (...args) => {
      clearTimeout(handle);
      handle = setTimeout(() => fn(...args), ms);
    };
  }

  function toast(message, kind = 'good') {
    const node = $('toast');
    node.replaceChildren(
      el('span', { className: `toast-mark ${kind}`, 'aria-hidden': 'true' }),
      el('span', { text: message }),
    );
    node.hidden = false;
    clearTimeout(toast.handle);
    toast.handle = setTimeout(() => (node.hidden = true), 4000);
  }

  class ApiError extends Error {
    constructor(message, code, details) {
      super(message);
      this.code = code;
      this.details = details;
    }
  }

  async function api(method, path, body) {
    const token = window.AquariumDashboard && window.AquariumDashboard.token();
    if (!token) {
      window.AquariumDashboard.unauthorized();
      throw new ApiError('Not signed in', 'UNAUTHORIZED');
    }
    const response = await fetch(`/api/v1/admin${path}`, {
      method,
      headers: {
        'x-admin-token': token,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 401) {
      window.AquariumDashboard.unauthorized('That token was rejected.');
      throw new ApiError('Unauthorized', 'UNAUTHORIZED');
    }
    if (!response.ok) {
      const error = payload && payload.error;
      let message = error ? error.message : `Request failed (${response.status})`;
      if (error && Array.isArray(error.details) && error.details[0] && error.details[0].message) {
        message = `${message}: ${error.details[0].message}`;
      }
      throw new ApiError(message, error && error.code, error && error.details);
    }
    return payload.data;
  }

  /** Fetches an export with the admin header and saves it via a temporary object URL. */
  async function downloadExport(kind, button) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Exporting…';
    try {
      const token = window.AquariumDashboard.token();
      const response = await fetch(`/api/v1/admin/export/${kind}`, {
        headers: { 'x-admin-token': token },
        cache: 'no-store',
      });
      if (response.status === 401) return window.AquariumDashboard.unauthorized();
      if (!response.ok) throw new Error(`Export failed (${response.status})`);
      const disposition = response.headers.get('content-disposition') || '';
      const match = /filename="([^"]+)"/.exec(disposition);
      const url = URL.createObjectURL(await response.blob());
      const link = el('a', { href: url, download: match ? match[1] : kind });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Export downloaded (recorded in the audit log)');
    } catch (error) {
      toast(error.message, 'critical');
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  async function loadCatalog() {
    if (!catalog) catalog = await api('GET', '/catalog');
    return catalog;
  }

  function query(params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : '';
  }

  // ------------------------------------------------------------ small widgets
  function statusPill(active) {
    return el('span', { className: `pill-tag ${active ? 'is-good' : 'is-muted'}` }, [
      el('span', { className: 'dot', 'aria-hidden': 'true' }),
      active ? 'Active' : 'Inactive',
    ]);
  }

  function tierTag(code) {
    if (!code) return el('span', { className: 'muted', text: 'No tier' });
    return el('span', {
      className: `tier-tag tier-${code.toLowerCase()}`,
      text: TIER_LABELS[code] || code,
    });
  }

  function colorSwatch(code) {
    const color = code && code.startsWith('#') ? code : NAMED_COLORS[code] || 'var(--neutral)';
    return el('span', { className: 'pill' }, [
      el('span', { className: 'swatch', style: { background: color }, 'aria-hidden': 'true' }),
      el('span', { className: 'mono', text: code }),
    ]);
  }

  function hungerMeter(value) {
    const level = value >= 70 ? 'good' : value >= 30 ? 'warning' : 'critical';
    return el('span', { className: 'meter-wrap', title: `${value}% fed` }, [
      el(
        'span',
        {
          className: 'meter',
          role: 'meter',
          'aria-valuenow': String(value),
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-label': 'Hunger',
        },
        [el('span', { className: `meter-fill ${level}`, style: { width: `${value}%` } })],
      ),
      el('span', { className: 'mono', text: `${value}%` }),
    ]);
  }

  function emptyRow(colspan, message) {
    return el('tr', {}, [
      el('td', { colspan: String(colspan), className: 'empty', text: message }),
    ]);
  }

  function dataTable(headers, rows, emptyMessage) {
    return el('div', { className: 'table-wrap' }, [
      el('table', { className: 'data-table' }, [
        el('thead', {}, [
          el(
            'tr',
            {},
            headers.map((header) =>
              el('th', { scope: 'col', className: header.num ? 'num' : '', text: header.label }),
            ),
          ),
        ]),
        el('tbody', {}, rows.length ? rows : [emptyRow(headers.length, emptyMessage)]),
      ]),
    ]);
  }

  function pager(page, onChange) {
    const from = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
    const to = Math.min(page.page * page.pageSize, page.total);
    return el('div', { className: 'pager' }, [
      el('span', {
        className: 'muted',
        text: `${numberFormat.format(from)}–${numberFormat.format(to)} of ${numberFormat.format(page.total)}`,
      }),
      el('div', { className: 'pager-buttons' }, [
        el('button', {
          type: 'button',
          className: 'ghost small',
          text: 'Previous',
          disabled: page.page <= 1,
          onclick: () => onChange(page.page - 1),
        }),
        el('span', { className: 'muted', text: `Page ${page.page} of ${page.pageCount}` }),
        el('button', {
          type: 'button',
          className: 'ghost small',
          text: 'Next',
          disabled: page.page >= page.pageCount,
          onclick: () => onChange(page.page + 1),
        }),
      ]),
    ]);
  }

  function field(label, control, hint) {
    const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
    control.id = id;
    return el('div', { className: 'field' }, [
      el('label', { for: id, text: label }),
      control,
      hint ? el('p', { className: 'hint', text: hint }) : null,
    ]);
  }

  function select(options, value, attrs = {}) {
    return el(
      'select',
      attrs,
      options.map(([optionValue, label]) =>
        el('option', { value: optionValue, text: label, selected: optionValue === value }),
      ),
    );
  }

  /** Two-step destructive confirmation, built into the page (no window.confirm). */
  function confirmButton(label, confirmLabel, onConfirm, className = 'danger') {
    const wrap = el('span', { className: 'confirm-wrap' });
    const start = el('button', { type: 'button', className: `ghost ${className}`, text: label });
    const render = (confirming) => {
      if (!confirming) return wrap.replaceChildren(start);
      const yes = el('button', {
        type: 'button',
        className: className,
        text: confirmLabel,
        onclick: async () => {
          yes.disabled = true;
          try {
            await onConfirm();
          } finally {
            render(false);
          }
        },
      });
      wrap.replaceChildren(
        yes,
        el('button', {
          type: 'button',
          className: 'ghost',
          text: 'Cancel',
          onclick: () => render(false),
        }),
      );
      yes.focus();
    };
    start.addEventListener('click', () => render(true));
    render(false);
    return wrap;
  }

  function formError() {
    return el('p', { className: 'error', role: 'alert' });
  }

  async function submitting(button, errorNode, action) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Saving…';
    errorNode.textContent = '';
    try {
      await action();
    } catch (error) {
      if (error.code !== 'UNAUTHORIZED') errorNode.textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  // -------------------------------------------------------------------- drawer
  function openDrawer(title, body) {
    if (!$('drawer').hidden && drawerCleanup) drawerCleanup();
    lastFocus = lastFocus || document.activeElement;
    $('drawer-title').textContent = title;
    $('drawer-body').replaceChildren(body);
    $('drawer').hidden = false;
    $('drawer-backdrop').hidden = false;
    document.body.classList.add('drawer-open');
    const first = $('drawer-body').querySelector('input, select, textarea, button');
    (first || $('drawer-close')).focus();
  }

  function closeDrawer() {
    $('drawer').hidden = true;
    $('drawer-backdrop').hidden = true;
    document.body.classList.remove('drawer-open');
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    lastFocus = null;
  }

  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('drawer').hidden) closeDrawer();
  });

  // ---------------------------------------------------------------- color input
  function colorControl(value) {
    const isHex = typeof value === 'string' && value.startsWith('#');
    const mode = select(
      [...Object.keys(NAMED_COLORS).map((code) => [code, code]), ['HEX', 'Custom HEX…']],
      isHex ? 'HEX' : value,
    );
    const picker = el('input', {
      type: 'color',
      value: isHex ? value.toLowerCase() : '#00e5ff',
      'aria-label': 'Pick a color',
    });
    const hex = el('input', {
      type: 'text',
      value: isHex ? value : '#00E5FF',
      pattern: '^#[0-9A-Fa-f]{6}$',
      maxlength: '7',
      'aria-label': 'HEX color',
      className: 'mono',
    });
    const custom = el('span', { className: 'inline' }, [picker, hex]);
    custom.hidden = !isHex;
    mode.addEventListener('change', () => (custom.hidden = mode.value !== 'HEX'));
    picker.addEventListener('input', () => (hex.value = picker.value.toUpperCase()));
    hex.addEventListener('input', () => {
      if (/^#[0-9A-Fa-f]{6}$/.test(hex.value)) picker.value = hex.value.toLowerCase();
    });
    const wrap = el('div', { className: 'stack' }, [mode, custom]);
    return {
      node: wrap,
      control: mode,
      value: () => (mode.value === 'HEX' ? hex.value.toUpperCase() : mode.value),
    };
  }

  // ----------------------------------------------------------------- fish view
  const fishState = { page: 1, search: '', tier: '', species: '', status: 'active' };

  async function renderFishView() {
    const view = $('view-fish');
    const cat = await loadCatalog();
    const searchInput = el('input', {
      type: 'search',
      placeholder: 'Search name, aquarium slug, NIK or fish ID',
      value: fishState.search,
      'aria-label': 'Search fish',
    });
    const tierSelect = select(
      [['', 'All tiers'], ...cat.tiers.map((t) => [t.code, t.name])],
      fishState.tier,
      {
        'aria-label': 'Tier',
      },
    );
    const speciesSelect = select(
      [['', 'All species'], ...cat.species.map((s) => [s.code, s.name])],
      fishState.species,
      { 'aria-label': 'Species' },
    );
    const statusSelect = select(
      [
        ['active', 'Active'],
        ['inactive', 'Inactive'],
        ['all', 'All statuses'],
      ],
      fishState.status,
      { 'aria-label': 'Status' },
    );
    const results = el('div', { className: 'results', 'aria-live': 'polite' });

    const refresh = async () => {
      results.classList.add('loading');
      try {
        const page = await api(
          'GET',
          `/fish${query({
            page: fishState.page,
            pageSize: 20,
            search: fishState.search,
            tier: fishState.tier,
            species: fishState.species,
            status: fishState.status,
          })}`,
        );
        const rows = page.items.map((fish) =>
          el(
            'tr',
            {
              className: 'clickable',
              tabindex: '0',
              onclick: () => openFishEditor(fish.id, refresh),
              onkeydown: (e) => {
                if (e.key === 'Enter') openFishEditor(fish.id, refresh);
              },
            },
            [
              el('td', {}, [
                el('strong', { text: fish.displayName || fish.species.name }),
                el('div', { className: 'muted mono', text: shortId(fish.id) }),
              ]),
              el('td', { text: fish.species.name }),
              el('td', {}, [tierTag(fish.tierCode)]),
              el('td', {}, [
                el('div', { text: fish.donor.name || 'Anonymous donor' }),
                el('div', {
                  className: 'muted mono',
                  text: fish.donor.nikMasked || fish.publicSlug,
                }),
              ]),
              el('td', {}, [
                colorSwatch(fish.colorCode),
                el('div', {
                  className: 'muted',
                  text: ACCESSORY_LABELS[fish.accessoryCode] || fish.accessoryCode,
                }),
              ]),
              el('td', {}, [hungerMeter(fish.hunger)]),
              el('td', {}, [statusPill(fish.isActive)]),
              el('td', { text: relative(fish.createdAt) }),
            ],
          ),
        );
        results.replaceChildren(
          dataTable(
            [
              { label: 'Fish' },
              { label: 'Species' },
              { label: 'Tier' },
              { label: 'Owner' },
              { label: 'Appearance' },
              { label: 'Hunger' },
              { label: 'Status' },
              { label: 'Created' },
            ],
            rows,
            'No fish match these filters.',
          ),
          pager(page, (next) => {
            fishState.page = next;
            refresh();
          }),
        );
      } catch (error) {
        results.replaceChildren(el('p', { className: 'error', text: error.message }));
      } finally {
        results.classList.remove('loading');
      }
    };

    const onFilter = () => {
      fishState.page = 1;
      fishState.search = searchInput.value.trim();
      fishState.tier = tierSelect.value;
      fishState.species = speciesSelect.value;
      fishState.status = statusSelect.value;
      refresh();
    };
    searchInput.addEventListener('input', debounce(onFilter, 300));
    for (const control of [tierSelect, speciesSelect, statusSelect])
      control.addEventListener('change', onFilter);

    view.replaceChildren(
      el('div', { className: 'card' }, [
        el('header', { className: 'card-head' }, [
          el('div', {}, [
            el('h3', { text: 'Fish' }),
            el('p', {
              className: 'muted',
              text: 'Every fish in every aquarium. Click a row to edit it.',
            }),
          ]),
          el('div', { className: 'actions' }, [
            el('button', {
              type: 'button',
              className: 'ghost',
              text: 'Export CSV',
              onclick: (event) => downloadExport('fish.csv', event.currentTarget),
            }),
            el('button', {
              type: 'button',
              text: 'New fish',
              onclick: () => openFishCreator(null, refresh),
            }),
          ]),
        ]),
        el('div', { className: 'filters' }, [searchInput, tierSelect, speciesSelect, statusSelect]),
        results,
      ]),
    );
    await refresh();
  }

  async function openFishEditor(fishId, onSaved) {
    const [cat, fish] = await Promise.all([loadCatalog(), api('GET', `/fish/${fishId}`)]).catch(
      (error) => {
        toast(error.message, 'critical');
        return [];
      },
    );
    if (!fish) return;

    const name = el('input', {
      type: 'text',
      value: fish.displayName || '',
      maxlength: '100',
      placeholder: fish.species.name,
    });
    const species = select(
      cat.species.map((s) => [
        s.code,
        `${s.name} (${TIER_LABELS[s.defaultTierCode] || s.defaultTierCode})`,
      ]),
      fish.species.code,
    );
    const tier = select(
      cat.tiers.map((t) => [t.code, t.name]),
      fish.tierCode,
    );
    const color = colorControl(fish.colorCode);
    const accessory = select(
      cat.accessoryCodes.map((code) => [code, ACCESSORY_LABELS[code] || code]),
      fish.accessoryCode,
    );
    const hungerValue = el('output', { text: `${fish.hunger}%` });
    const hunger = el('input', {
      type: 'range',
      min: '0',
      max: '100',
      step: '5',
      value: String(fish.hunger),
    });
    hunger.addEventListener('input', () => (hungerValue.textContent = `${hunger.value}%`));
    const reason = el('textarea', {
      rows: '2',
      maxlength: '500',
      placeholder: 'Why are you making this change? (saved in the audit log)',
    });
    const error = formError();
    const save = el('button', { type: 'submit', text: 'Save changes' });

    const form = el('form', { className: 'form' }, [
      el('div', { className: 'summary' }, [
        statusPill(fish.isActive),
        tierTag(fish.tierCode),
        el('span', { className: 'muted mono', text: fish.assetCode }),
      ]),
      el('p', { className: 'muted' }, [
        `Owner: ${fish.donor.name || 'Anonymous donor'} · `,
        el('a', {
          href: '#donors',
          text: 'Open donor',
          onclick: (event) => {
            event.preventDefault();
            openDonorPanel(fish.donor.id);
          },
        }),
        ` · Created ${relative(fish.createdAt)} · From ${fish.source}`,
      ]),
      field(
        'Display name',
        name,
        'Shown as the fish label in the game. Leave empty to use the species name.',
      ),
      el('div', { className: 'two-col' }, [field('Species', species), field('Tier', tier)]),
      el('div', { className: 'two-col' }, [
        field('Color', color.node),
        field('Accessory', accessory),
      ]),
      el('div', { className: 'field' }, [
        el('label', { for: 'fish-hunger' }, ['Hunger ', hungerValue]),
        Object.assign(hunger, { id: 'fish-hunger' }),
        el('p', {
          className: 'hint',
          text: 'Changing hunger restarts decay now and starts the donor’s 4-hour feed cooldown.',
        }),
      ]),
      field('Reason', reason),
      error,
      el('div', { className: 'actions' }, [
        save,
        confirmButton(
          fish.isActive ? 'Deactivate fish' : 'Reactivate fish',
          fish.isActive ? 'Yes, deactivate' : 'Yes, reactivate',
          async () => {
            try {
              await api('PATCH', `/fish/${fish.id}`, {
                isActive: !fish.isActive,
                reason: reason.value.trim() || undefined,
              });
              toast(fish.isActive ? 'Fish deactivated' : 'Fish reactivated');
              if (onSaved) onSaved();
              openFishEditor(fish.id, onSaved);
            } catch (err) {
              error.textContent = err.message;
            }
          },
          fish.isActive ? 'danger' : 'primary',
        ),
      ]),
    ]);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const changes = {};
      const nextName = name.value.trim() || null;
      if (nextName !== (fish.displayName || null)) changes.displayName = nextName;
      if (species.value !== fish.species.code) changes.speciesCode = species.value;
      if (tier.value !== fish.tierCode) changes.tierCode = tier.value;
      const nextColor = color.value();
      if (nextColor !== fish.colorCode) changes.colorCode = nextColor;
      if (accessory.value !== fish.accessoryCode) changes.accessoryCode = accessory.value;
      if (Number(hunger.value) !== fish.hunger) changes.hunger = Number(hunger.value);
      if (Object.keys(changes).length === 0) {
        error.textContent = 'Nothing changed yet.';
        return;
      }
      if (reason.value.trim()) changes.reason = reason.value.trim();
      submitting(save, error, async () => {
        await api('PATCH', `/fish/${fish.id}`, changes);
        toast('Fish updated');
        if (onSaved) onSaved();
        openFishEditor(fish.id, onSaved);
      });
    });

    const historyList = el('ol', { className: 'timeline' }, [
      el('li', { className: 'muted', text: 'Loading history…' }),
    ]);
    api('GET', `/fish/${fish.id}/history`)
      .then(({ items }) => {
        historyList.replaceChildren(
          ...(items.length
            ? items.map((item) =>
                el('li', { className: item.kind === 'admin' ? 'is-admin' : '' }, [
                  el('div', { className: 'timeline-head' }, [
                    el('strong', { className: 'mono', text: item.type }),
                    el('span', {
                      className: 'muted',
                      title: dateTime.format(new Date(item.at)),
                      text: relative(item.at),
                    }),
                  ]),
                  el('div', {
                    className: 'muted',
                    text:
                      item.kind === 'admin'
                        ? `Admin · ${describeChanges(item.details)}`
                        : describeChanges(item.details),
                  }),
                  item.reason
                    ? el('div', { className: 'muted', text: `Reason: ${item.reason}` })
                    : null,
                ]),
              )
            : [el('li', { className: 'muted', text: 'No history yet.' })]),
        );
      })
      .catch((err) =>
        historyList.replaceChildren(el('li', { className: 'error', text: err.message })),
      );

    openDrawer(
      fish.displayName || `${fish.species.name} · ${shortId(fish.id)}`,
      el('div', {}, [
        form,
        el('section', { className: 'section history' }, [
          el('h3', { text: 'History' }),
          historyList,
        ]),
      ]),
    );
  }

  async function openFishCreator(presetDonor, onSaved) {
    const cat = await loadCatalog().catch((error) => {
      toast(error.message, 'critical');
      return null;
    });
    if (!cat) return;
    let donor = presetDonor;

    const donorSearch = el('input', {
      type: 'search',
      placeholder: 'Search donor by name, slug or NIK',
      autocomplete: 'off',
    });
    const donorResults = el('ul', { className: 'picker', role: 'listbox', 'aria-label': 'Donors' });
    const donorChosen = el('div', { className: 'chosen' });
    const renderChosen = () => {
      donorChosen.replaceChildren(
        donor
          ? el('span', { className: 'pill-tag is-good' }, [
              el('span', { className: 'dot', 'aria-hidden': 'true' }),
              `${donor.name || 'Anonymous donor'} · ${donor.nikMasked || donor.publicSlug || shortId(donor.id)}`,
            ])
          : el('span', { className: 'muted', text: 'No donor selected yet.' }),
      );
    };
    const searchDonors = debounce(async () => {
      const term = donorSearch.value.trim();
      if (term.length < 2) return donorResults.replaceChildren();
      try {
        const page = await api('GET', `/donors${query({ search: term, pageSize: 8 })}`);
        donorResults.replaceChildren(
          ...(page.items.length
            ? page.items.map((item) =>
                el('li', {}, [
                  el(
                    'button',
                    {
                      type: 'button',
                      className: 'ghost picker-item',
                      role: 'option',
                      onclick: () => {
                        donor = item;
                        donorResults.replaceChildren();
                        donorSearch.value = '';
                        renderChosen();
                      },
                    },
                    [
                      el('strong', { text: item.name || 'Anonymous donor' }),
                      el('span', {
                        className: 'muted mono',
                        text: ` ${item.nikMasked || item.publicSlug || ''}`,
                      }),
                    ],
                  ),
                ]),
              )
            : [el('li', { className: 'muted', text: 'No donors found.' })]),
        );
      } catch (error) {
        donorResults.replaceChildren(el('li', { className: 'error', text: error.message }));
      }
    }, 250);
    donorSearch.addEventListener('input', searchDonors);
    renderChosen();

    const activeSpecies = cat.species.filter((s) => s.active);
    const species = select(
      activeSpecies.map((s) => [s.code, s.name]),
      activeSpecies[0] && activeSpecies[0].code,
    );
    const tier = select([['', 'Species default'], ...cat.tiers.map((t) => [t.code, t.name])], '');
    const name = el('input', { type: 'text', maxlength: '100', placeholder: 'Optional label' });
    const color = colorControl('DEFAULT');
    const accessory = select(
      cat.accessoryCodes.map((code) => [code, ACCESSORY_LABELS[code] || code]),
      'NONE',
    );
    const reason = el('textarea', {
      rows: '2',
      maxlength: '500',
      placeholder: 'e.g. event reward, manual correction',
    });
    const error = formError();
    const save = el('button', { type: 'submit', text: 'Create fish' });

    const form = el('form', { className: 'form' }, [
      presetDonor ? null : field('Donor', donorSearch),
      presetDonor ? null : donorResults,
      donorChosen,
      el('div', { className: 'two-col' }, [
        field('Species', species),
        field('Tier', tier, 'Defaults to the species’ tier.'),
      ]),
      field('Display name', name),
      el('div', { className: 'two-col' }, [
        field('Color', color.node),
        field('Accessory', accessory),
      ]),
      field('Reason', reason),
      error,
      el('div', { className: 'actions' }, [save]),
    ]);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!donor) {
        error.textContent = 'Choose a donor first.';
        donorSearch.focus();
        return;
      }
      submitting(save, error, async () => {
        const created = await api('POST', '/fish', {
          donorId: donor.id,
          speciesCode: species.value,
          tierCode: tier.value || undefined,
          displayName: name.value.trim() || undefined,
          colorCode: color.value(),
          accessoryCode: accessory.value,
          reason: reason.value.trim() || undefined,
        });
        toast('Fish created');
        if (onSaved) onSaved();
        openFishEditor(created.id, onSaved);
      });
    });
    openDrawer('New fish', form);
  }

  // --------------------------------------------------------------- donor view
  const donorState = { page: 1, search: '', source: 'all' };
  let donorRefresh = null;

  async function renderDonorView() {
    const view = $('view-donors');
    const searchInput = el('input', {
      type: 'search',
      placeholder: 'Search name, aquarium slug, full NIK or donor ID',
      value: donorState.search,
      'aria-label': 'Search donors',
    });
    const sourceSelect = select(
      [
        ['all', 'All sources'],
        ['nik', 'Linked by NIK'],
        ['webhook', 'Webhook only'],
      ],
      donorState.source,
      { 'aria-label': 'Source' },
    );
    const results = el('div', { className: 'results', 'aria-live': 'polite' });

    const refresh = async () => {
      results.classList.add('loading');
      try {
        const page = await api(
          'GET',
          `/donors${query({ page: donorState.page, pageSize: 20, search: donorState.search, source: donorState.source })}`,
        );
        const rows = page.items.map((donor) =>
          el(
            'tr',
            {
              className: 'clickable',
              tabindex: '0',
              onclick: () => openDonorPanel(donor.id),
              onkeydown: (e) => {
                if (e.key === 'Enter') openDonorPanel(donor.id);
              },
            },
            [
              el('td', {}, [
                el('strong', { text: donor.name || 'Anonymous donor' }),
                el('div', {
                  className: 'muted',
                  text: donor.showNamePublicly ? 'Name shown publicly' : 'Name hidden publicly',
                }),
              ]),
              el('td', { className: 'mono', text: donor.nikMasked || '—' }),
              el('td', { text: donor.source === 'nik' ? 'NIK' : 'Webhook' }),
              el('td', {}, [tierTag(donor.tierCode)]),
              el('td', { className: 'num', text: rupiah.format(donor.totalDonation) }),
              el('td', { className: 'num', text: numberFormat.format(donor.activeFish) }),
              el('td', { className: 'num', text: numberFormat.format(donor.points) }),
              el('td', { text: relative(donor.lastSyncedAt) }),
            ],
          ),
        );
        results.replaceChildren(
          dataTable(
            [
              { label: 'Donor' },
              { label: 'NIK' },
              { label: 'Source' },
              { label: 'Tier' },
              { label: 'Total donation', num: true },
              { label: 'Active fish', num: true },
              { label: 'Points', num: true },
              { label: 'Last synced' },
            ],
            rows,
            'No donors match.',
          ),
          pager(page, (next) => {
            donorState.page = next;
            refresh();
          }),
        );
      } catch (error) {
        results.replaceChildren(el('p', { className: 'error', text: error.message }));
      } finally {
        results.classList.remove('loading');
      }
    };
    donorRefresh = refresh;

    const onFilter = () => {
      donorState.page = 1;
      donorState.search = searchInput.value.trim();
      donorState.source = sourceSelect.value;
      refresh();
    };
    searchInput.addEventListener('input', debounce(onFilter, 300));
    sourceSelect.addEventListener('change', onFilter);

    view.replaceChildren(
      el('div', { className: 'card' }, [
        el('header', { className: 'card-head' }, [
          el('div', {}, [
            el('h3', { text: 'Donors' }),
            el('p', {
              className: 'muted',
              text: 'Donors cached from Endowment and webhooks. NIKs are masked; search with a full NIK to find one.',
            }),
          ]),
          el('button', {
            type: 'button',
            className: 'ghost',
            text: 'Export CSV',
            onclick: (event) => downloadExport('donors.csv', event.currentTarget),
          }),
        ]),
        el('div', { className: 'filters' }, [searchInput, sourceSelect]),
        results,
      ]),
    );
    await refresh();
  }

  async function openDonorPanel(donorId) {
    let donor;
    let cat;
    try {
      [donor, cat] = await Promise.all([api('GET', `/donors/${donorId}`), loadCatalog()]);
    } catch (error) {
      toast(error.message, 'critical');
      return;
    }
    const reopen = () => {
      if (donorRefresh) donorRefresh();
      openDonorPanel(donorId);
    };

    // Profile
    const name = el('input', {
      type: 'text',
      value: donor.name || '',
      maxlength: '150',
      required: true,
    });
    const isPublic = el('input', { type: 'checkbox', checked: donor.showNamePublicly });
    const profileReason = el('input', {
      type: 'text',
      maxlength: '500',
      placeholder: 'Reason (optional)',
    });
    const profileError = formError();
    const profileSave = el('button', { type: 'submit', text: 'Save profile' });
    const profile = el('form', { className: 'form section' }, [
      el('h3', { text: 'Profile' }),
      field(
        'Display name',
        name,
        donor.source === 'nik'
          ? 'A re-sync from Endowment overwrites this with the official name.'
          : undefined,
      ),
      el('label', { className: 'toggle' }, [isPublic, 'Show name publicly in the Big Aquarium']),
      field('Reason', profileReason),
      profileError,
      el('div', { className: 'actions' }, [profileSave]),
    ]);
    profile.addEventListener('submit', (event) => {
      event.preventDefault();
      const changes = {};
      if (name.value.trim() !== (donor.name || '')) changes.displayName = name.value.trim();
      if (isPublic.checked !== donor.showNamePublicly) changes.showNamePublicly = isPublic.checked;
      if (!Object.keys(changes).length) {
        profileError.textContent = 'Nothing changed yet.';
        return;
      }
      if (profileReason.value.trim()) changes.reason = profileReason.value.trim();
      submitting(profileSave, profileError, async () => {
        await api('PATCH', `/donors/${donor.id}`, changes);
        toast('Donor updated');
        reopen();
      });
    });

    // Inventory
    const delta = el('input', { type: 'number', step: '1', value: '0', inputmode: 'numeric' });
    const preview = el('output', { className: 'muted' });
    const updatePreview = () => {
      const next = donor.inventory.points + (Number(delta.value) || 0);
      preview.textContent = `New balance: ${numberFormat.format(next)}${next < 0 ? ' (not allowed)' : ''}`;
    };
    delta.addEventListener('input', updatePreview);
    updatePreview();
    const ownable = cat.accessoryCodes.filter((code) => code !== 'NONE');
    const checks = ownable.map((code) => {
      const box = el('input', {
        type: 'checkbox',
        value: code,
        checked: donor.inventory.ownedAccessories.includes(code),
      });
      return {
        code,
        box,
        node: el('label', { className: 'toggle' }, [box, ACCESSORY_LABELS[code] || code]),
      };
    });
    const invReason = el('input', {
      type: 'text',
      maxlength: '500',
      placeholder: 'Reason (optional)',
    });
    const invError = formError();
    const invSave = el('button', { type: 'submit', text: 'Save inventory' });
    const inventory = el('form', { className: 'form section' }, [
      el('h3', { text: 'Inventory' }),
      el('div', { className: 'mini-stats' }, [
        el('div', {}, [
          el('span', { className: 'muted', text: 'Points' }),
          el('strong', { text: numberFormat.format(donor.inventory.points) }),
        ]),
        el('div', {}, [
          el('span', { className: 'muted', text: 'Accessories owned' }),
          el('strong', { text: String(donor.inventory.ownedAccessories.length) }),
        ]),
      ]),
      field(
        'Adjust points by',
        delta,
        'Use a negative number to deduct. The balance can never go below zero.',
      ),
      preview,
      el('fieldset', { className: 'checks' }, [
        el('legend', { text: 'Owned accessories' }),
        ...checks.map((c) => c.node),
      ]),
      field('Reason', invReason),
      invError,
      el('div', { className: 'actions' }, [invSave]),
    ]);
    inventory.addEventListener('submit', (event) => {
      event.preventDefault();
      const pointsDelta = Number(delta.value) || 0;
      const grant = checks
        .filter((c) => c.box.checked && !donor.inventory.ownedAccessories.includes(c.code))
        .map((c) => c.code);
      const revoke = checks
        .filter((c) => !c.box.checked && donor.inventory.ownedAccessories.includes(c.code))
        .map((c) => c.code);
      if (!pointsDelta && !grant.length && !revoke.length) {
        invError.textContent = 'Nothing changed yet.';
        return;
      }
      submitting(invSave, invError, async () => {
        await api('PATCH', `/donors/${donor.id}/inventory`, {
          pointsDelta: pointsDelta || undefined,
          grantAccessories: grant.length ? grant : undefined,
          revokeAccessories: revoke.length ? revoke : undefined,
          reason: invReason.value.trim() || undefined,
        });
        toast('Inventory updated');
        reopen();
      });
    });

    // Fish
    const fishRows = donor.fish.map((fish) =>
      el(
        'tr',
        {
          className: 'clickable',
          tabindex: '0',
          onclick: () => openFishEditor(fish.id, reopen),
          onkeydown: (e) => {
            if (e.key === 'Enter') openFishEditor(fish.id, reopen);
          },
        },
        [
          el('td', { text: fish.displayName || fish.species.name }),
          el('td', {}, [tierTag(fish.tierCode)]),
          el('td', {}, [hungerMeter(fish.hunger)]),
          el('td', {}, [statusPill(fish.isActive)]),
        ],
      ),
    );
    const fishSection = el('section', { className: 'section' }, [
      el('header', { className: 'card-head' }, [
        el('h3', { text: `Fish (${donor.fish.length})` }),
        el('button', {
          type: 'button',
          className: 'small',
          text: 'Add fish',
          onclick: () => openFishCreator(donor, reopen),
        }),
      ]),
      dataTable(
        [{ label: 'Fish' }, { label: 'Tier' }, { label: 'Hunger' }, { label: 'Status' }],
        fishRows,
        'This donor has no fish yet.',
      ),
    ]);

    // Donations
    const donationSection = el('section', { className: 'section' }, [
      el('h3', { text: 'Donations from webhooks' }),
      dataTable(
        [{ label: 'Date' }, { label: 'Status' }, { label: 'Amount', num: true }],
        donor.donations.map((d) =>
          el('tr', {}, [
            el('td', { text: dateTime.format(new Date(d.donatedAt)) }),
            el('td', { text: d.status }),
            el('td', { className: 'num', text: rupiah.format(d.amount) }),
          ]),
        ),
        donor.source === 'nik'
          ? 'NIK donors get their total from the Endowment lookup instead.'
          : 'No donations recorded.',
      ),
    ]);

    // Header + resync
    const resyncError = formError();
    const header = el('section', { className: 'section' }, [
      el('div', { className: 'summary' }, [
        tierTag(donor.tierCode),
        el('span', { className: 'mono', text: donor.nikMasked || 'No NIK (webhook donor)' }),
        donor.aquarium
          ? el('span', { className: 'muted mono', text: donor.aquarium.publicSlug })
          : null,
      ]),
      el('div', { className: 'mini-stats' }, [
        el('div', {}, [
          el('span', { className: 'muted', text: 'Total donation' }),
          el('strong', { text: rupiah.format(donor.totalDonation) }),
        ]),
        el('div', {}, [
          el('span', { className: 'muted', text: 'Last synced' }),
          el('strong', { text: relative(donor.lastSyncedAt) }),
        ]),
        el('div', {}, [
          el('span', { className: 'muted', text: 'Created' }),
          el('strong', { text: relative(donor.createdAt) }),
        ]),
      ]),
      donor.canResync
        ? el('div', { className: 'actions' }, [
            confirmButton(
              'Re-sync from Endowment',
              'Yes, fetch latest data',
              async () => {
                try {
                  await api('POST', `/donors/${donor.id}/resync`, {});
                  toast('Donor re-synced from Endowment');
                  reopen();
                } catch (error) {
                  resyncError.textContent = error.message;
                }
              },
              'primary',
            ),
            el('span', {
              className: 'hint',
              text: 'Fetches the latest name and total, then adjusts tier, fish and points.',
            }),
          ])
        : null,
      resyncError,
    ]);

    openDrawer(
      donor.name || 'Anonymous donor',
      el('div', {}, [header, profile, inventory, fishSection, donationSection]),
    );
  }

  // --------------------------------------------------------------- audit view
  const auditState = { page: 1, targetType: '' };

  function describeChanges(changes) {
    const parts = [];
    for (const [key, value] of Object.entries(changes || {})) {
      if (key === 'after') {
        parts.push('created');
        continue;
      }
      if (value && typeof value === 'object' && 'from' in value && 'to' in value) {
        const fmt = (v) => (Array.isArray(v) ? `[${v.join(', ')}]` : v === null ? '—' : String(v));
        parts.push(`${key}: ${fmt(value.from)} → ${fmt(value.to)}`);
      } else {
        parts.push(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
      }
    }
    return parts.length ? parts.join(' · ') : 'no field changes';
  }

  async function renderAuditView() {
    const view = $('view-audit');
    const typeSelect = select(
      [
        ['', 'All targets'],
        ['fish', 'Fish'],
        ['donor', 'Donors'],
        ['inventory', 'Inventory'],
        ['export', 'Exports'],
      ],
      auditState.targetType,
      { 'aria-label': 'Target type' },
    );
    const results = el('div', { className: 'results', 'aria-live': 'polite' });
    const refresh = async () => {
      results.classList.add('loading');
      try {
        const page = await api(
          'GET',
          `/audit${query({ page: auditState.page, pageSize: 25, targetType: auditState.targetType })}`,
        );
        const rows = page.items.map((entry) =>
          el('tr', {}, [
            el('td', {
              title: dateTime.format(new Date(entry.createdAt)),
              text: relative(entry.createdAt),
            }),
            el('td', { className: 'mono', text: entry.action }),
            el('td', {}, [
              entry.targetType === 'export'
                ? el('span', { className: 'mono', text: entry.targetId })
                : el('button', {
                    type: 'button',
                    className: 'link',
                    text: `${entry.targetType} ${shortId(entry.targetId)}`,
                    onclick: () =>
                      entry.targetType === 'fish'
                        ? openFishEditor(entry.targetId, refresh)
                        : openDonorPanel(entry.targetId),
                  }),
            ]),
            el('td', { className: 'wrap', text: describeChanges(entry.changes) }),
            el('td', { className: 'wrap', text: entry.reason || '—' }),
            el('td', { className: 'mono muted', text: entry.actorIp || '—' }),
          ]),
        );
        results.replaceChildren(
          dataTable(
            [
              { label: 'When' },
              { label: 'Action' },
              { label: 'Target' },
              { label: 'Changes' },
              { label: 'Reason' },
              { label: 'IP' },
            ],
            rows,
            'No admin changes recorded yet.',
          ),
          pager(page, (next) => {
            auditState.page = next;
            refresh();
          }),
        );
      } catch (error) {
        results.replaceChildren(el('p', { className: 'error', text: error.message }));
      } finally {
        results.classList.remove('loading');
      }
    };
    typeSelect.addEventListener('change', () => {
      auditState.page = 1;
      auditState.targetType = typeSelect.value;
      refresh();
    });
    view.replaceChildren(
      el('div', { className: 'card' }, [
        el('header', { className: 'card-head' }, [
          el('div', {}, [
            el('h3', { text: 'Audit log' }),
            el('p', {
              className: 'muted',
              text: 'Every change made from this dashboard, newest first. Entries cannot be edited.',
            }),
          ]),
        ]),
        el('div', { className: 'filters' }, [typeSelect]),
        results,
      ]),
    );
    await refresh();
  }

  // ------------------------------------------------------------------- routing
  const views = {
    overview: null,
    fish: renderFishView,
    donors: renderDonorView,
    audit: renderAuditView,
  };

  function show(name) {
    const target = name in views ? name : 'overview';
    for (const key of Object.keys(views)) {
      $(`view-${key}`).hidden = key !== target;
    }
    for (const tab of document.querySelectorAll('[data-view]')) {
      const selected = tab.dataset.view === target;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    // Auto-refresh controls only apply to the overview.
    for (const id of ['auto-refresh', 'refresh']) {
      const node = $(id);
      const holder = node.closest('label') || node;
      holder.hidden = target !== 'overview';
    }
    if (views[target]) {
      views[target]().catch((error) => {
        if (error.code !== 'UNAUTHORIZED') {
          $(`view-${target}`).replaceChildren(
            el('p', { className: 'banner', text: error.message }),
          );
        }
      });
    }
  }

  const tabs = [...document.querySelectorAll('[data-view]')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      if (location.hash !== `#${tab.dataset.view}`) location.hash = tab.dataset.view;
      else show(tab.dataset.view);
    });
    tab.addEventListener('keydown', (event) => {
      const index = tabs.indexOf(tab);
      const next =
        event.key === 'ArrowRight'
          ? tabs[(index + 1) % tabs.length]
          : event.key === 'ArrowLeft'
            ? tabs[(index - 1 + tabs.length) % tabs.length]
            : null;
      if (!next) return;
      event.preventDefault();
      next.focus();
      next.click();
    });
  }
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));

  // Wait until the overview has authenticated before opening a deep-linked view.
  const appRoot = $('app');
  const start = () => show(location.hash.slice(1));
  if (!appRoot.hidden) start();
  else {
    const observer = new MutationObserver(() => {
      if (!appRoot.hidden) {
        observer.disconnect();
        start();
      }
    });
    observer.observe(appRoot, { attributes: true, attributeFilter: ['hidden'] });
  }
})();
