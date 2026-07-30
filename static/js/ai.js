/* ==========================================================================
   AI assistant: chat panel and admin settings.

   Talks to /api/ai/*, which the dashboard gates and forwards to the zer0space
   AI service. Nothing here knows which model is behind it; that is configured
   in the settings pane below and stored server-side.

   Two conventions from the rest of this codebase apply and are easy to miss:

   * Everything that reaches innerHTML goes through ZS_UI.esc() first. Chat
     content is model output and conversation titles are user input, and the CSP
     blocks inline <script> but not an injected <img onerror>.
   * Markup built here carries no data-i18n attributes, so applyI18n() cannot
     reach it. render() redraws the JS-owned parts and app.js calls it on the
     languagechange:zs event.

   Defines window.ZS_AI.
   ========================================================================== */
(function () {
  'use strict';

  var UI = window.ZS_UI;
  var API = window.API;
  var t = window.t;
  var esc = UI.esc;

  var state = {
    booted: false,
    status: null,
    conversationId: null,
    conversations: [],
    messages: [],
    streaming: false,
    controller: null,
    config: null,
    providers: []
  };

  var el = {};

  function $(id) { return document.getElementById(id); }

  function cache() {
    ['ai-panel', 'ai-log', 'ai-form', 'ai-input', 'ai-send', 'ai-stop', 'ai-notice',
     'ai-conversation', 'ai-new', 'ai-clear', 'ai-subtitle',
     'ai-cfg-state', 'ai-cfg-error', 'ai-cfg-ok', 'ai-cfg-enabled', 'ai-cfg-provider',
     'ai-cfg-provider-hint', 'ai-cfg-key', 'ai-cfg-key-state', 'ai-cfg-test',
     'ai-cfg-key-clear', 'ai-cfg-base-field', 'ai-cfg-base', 'ai-cfg-model',
     'ai-cfg-models', 'ai-cfg-prompt', 'ai-cfg-max-tokens', 'ai-cfg-history',
     'ai-cfg-ctx-cluster', 'ai-cfg-ctx-hosts', 'ai-cfg-ctx-backups', 'ai-cfg-ctx-services',
     'ai-cfg-tools', 'ai-cfg-save', 'ai-cfg-updated'
    ].forEach(function (id) { el[id] = $(id); });
  }

  /* --- Rendering --------------------------------------------------------- */

  /* Minimal formatting for model output. Everything is escaped FIRST and only
     then are the three patterns below turned back into markup, so no amount of
     HTML in the model's answer can escape into the page. Deliberately not a
     markdown library: three patterns cover what a status answer actually uses,
     and a parser would be a dependency and a much larger attack surface for the
     sake of nested lists nobody asked for. */
  function format(text) {
    var out = esc(text);
    out = out.replace(/```([\s\S]*?)```/g, function (whole, code) {
      return '<pre class="ai-code">' + code.replace(/^\n/, '') + '</pre>';
    });
    out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    return out.replace(/\n/g, '<br>');
  }

  function bubble(message) {
    var who = message.role === 'user' ? t('ai.you') : t('ai.assistant');
    var tools = '';
    if (message.tools && message.tools.length) {
      tools = '<div class="ai-tools">' +
        message.tools.map(function (name) {
          return '<span class="ai-tool">' + esc(t('ai.tool.' + name)) + '</span>';
        }).join('') +
        '</div>';
    }
    var body = message.content
      ? format(message.content)
      : '<span class="ai-typing"><i></i><i></i><i></i></span>';

    return '<article class="ai-msg is-' + esc(message.role) + '">' +
             '<div class="ai-who">' + esc(who) +
               (message.model ? ' <span class="ai-model">' + esc(message.model) + '</span>' : '') +
             '</div>' +
             tools +
             '<div class="ai-text">' + body + '</div>' +
           '</article>';
  }

  function renderLog() {
    if (!el['ai-log']) return;
    if (!state.messages.length) {
      el['ai-log'].innerHTML =
        '<div class="ai-empty">' +
          '<p>' + esc(t('ai.emptyTitle')) + '</p>' +
          '<ul>' +
            ['ai.example1', 'ai.example2', 'ai.example3'].map(function (key) {
              return '<li><button type="button" class="ai-example" data-ai-example="' +
                     esc(t(key)) + '">' + esc(t(key)) + '</button></li>';
            }).join('') +
          '</ul>' +
        '</div>';
      return;
    }
    el['ai-log'].innerHTML = state.messages.map(bubble).join('');
    scroll();
  }

  /* Only follow the stream when the reader is already at the bottom. Yanking
     the viewport down while somebody is reading an earlier answer is the most
     annoying thing a chat panel can do. */
  function scroll(force) {
    var log = el['ai-log'];
    if (!log) return;
    var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    if (force || atBottom) log.scrollTop = log.scrollHeight;
  }

  function notice(message, kind) {
    if (!el['ai-notice']) return;
    if (!message) { el['ai-notice'].hidden = true; return; }
    el['ai-notice'].className = 'alert alert-' + (kind || 'warn');
    el['ai-notice'].textContent = message;
    el['ai-notice'].hidden = false;
  }

  function renderConversations() {
    var select = el['ai-conversation'];
    if (!select) return;
    var options = ['<option value="">' + esc(t('ai.newConversation')) + '</option>'];
    state.conversations.forEach(function (item) {
      options.push('<option value="' + item.id + '">' + esc(item.title || t('ai.untitled')) + '</option>');
    });
    select.innerHTML = options.join('');
    select.value = state.conversationId ? String(state.conversationId) : '';
  }

  function setBusy(busy) {
    state.streaming = busy;
    if (el['ai-send']) el['ai-send'].hidden = busy;
    if (el['ai-stop']) el['ai-stop'].hidden = !busy;
    if (el['ai-input']) el['ai-input'].disabled = busy;
  }

  /* --- Status ------------------------------------------------------------ */

  async function loadStatus() {
    try {
      state.status = await API.get('/api/ai/status');
    } catch (err) {
      state.status = { enabled: false, ready: false, reason: err.code || 'AI_UNREACHABLE' };
    }
    var ready = state.status && state.status.ready;
    if (el['ai-form']) el['ai-form'].classList.toggle('is-disabled', !ready);
    if (el['ai-input']) el['ai-input'].disabled = !ready;
    if (el['ai-send']) el['ai-send'].disabled = !ready;

    if (!ready) {
      notice(t('aiState.' + ((state.status && state.status.reason) || 'AI_NOT_CONFIGURED')), 'warn');
    } else {
      notice(null);
      if (el['ai-subtitle'] && state.status.model) {
        el['ai-subtitle'].textContent = t('ai.subModel', { model: state.status.model });
      }
    }
    return ready;
  }

  /* --- Conversations ----------------------------------------------------- */

  async function loadConversations() {
    try {
      var data = await API.get('/api/ai/conversations');
      state.conversations = data.conversations || [];
      renderConversations();
    } catch (err) {
      // A failure here costs the history dropdown, not the chat box. Say nothing
      // and let the user carry on typing.
      console.warn('[ai] conversations unavailable:', err.message);
    }
  }

  async function openConversation(id) {
    state.conversationId = id || null;
    state.messages = [];
    if (!id) { renderLog(); renderConversations(); return; }
    try {
      var data = await API.get('/api/ai/conversations/' + id);
      state.messages = data.messages || [];
    } catch (err) {
      notice(err.message, 'error');
    }
    renderLog();
    renderConversations();
    scroll(true);
  }

  /* --- Streaming --------------------------------------------------------- */

  /* Reads the SSE stream by hand rather than with EventSource, because
     EventSource can only issue GET requests and cannot send the CSRF header.
     Same framing, one event per blank-line-separated block. */
  async function send(text) {
    if (state.streaming) return;
    var message = (text || '').trim();
    if (!message) return;

    state.messages.push({ role: 'user', content: message });
    var reply = { role: 'assistant', content: '', tools: [], model: '' };
    state.messages.push(reply);
    renderLog();
    scroll(true);

    if (el['ai-input']) { el['ai-input'].value = ''; autoGrow(); }
    setBusy(true);
    notice(null);

    state.controller = new AbortController();
    var body = { message: message };
    if (state.conversationId) body.conversationId = state.conversationId;

    try {
      var response = await fetch('/api/ai/chat', {
        method: 'POST',
        credentials: 'same-origin',
        signal: state.controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': API.getCsrfToken() || ''
        },
        body: JSON.stringify(body)
      });

      if (!response.ok || !response.body) {
        var payload = null;
        try { payload = await response.json(); } catch (e) { payload = null; }
        reply.content = window.I18N.tError(payload || { code: 'AI_UNREACHABLE' });
        renderLog();
        return;
      }

      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });

        var split;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          var block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          block.split('\n').forEach(function (line) {
            if (line.indexOf('data:') !== 0) return;
            handleEvent(line.slice(5).trim(), reply);
          });
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        reply.content += (reply.content ? '\n\n' : '') + t('ai.stopped');
      } else {
        reply.content = reply.content || t('err.NETWORK');
      }
      renderLog();
    } finally {
      setBusy(false);
      state.controller = null;
      // The title of a brand new conversation is derived from the first message
      // server-side, so the dropdown only becomes correct after the round trip.
      loadConversations();
    }
  }

  function handleEvent(payload, reply) {
    if (!payload) return;
    var event;
    try { event = JSON.parse(payload); } catch (e) { return; }

    if (event.type === 'start') {
      state.conversationId = event.conversationId || state.conversationId;
      reply.model = event.model || '';
      renderLog();
    } else if (event.type === 'text') {
      reply.content += event.text || '';
      // Redraw only the last bubble: rebuilding the whole log on every token
      // makes a long conversation visibly stutter as it streams.
      var last = el['ai-log'] && el['ai-log'].lastElementChild;
      if (last) {
        var body = last.querySelector('.ai-text');
        if (body) { body.innerHTML = format(reply.content); scroll(); return; }
      }
      renderLog();
    } else if (event.type === 'tool') {
      if (event.phase === 'start' && reply.tools.indexOf(event.name) === -1) {
        reply.tools.push(event.name);
        renderLog();
      }
    } else if (event.type === 'error') {
      notice(window.I18N.tError({ code: event.code, error: event.message }), 'error');
    } else if (event.type === 'done') {
      state.conversationId = event.conversationId || state.conversationId;
    }
  }

  /* --- Composer ---------------------------------------------------------- */

  function autoGrow() {
    var input = el['ai-input'];
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }

  function wireChat() {
    if (!el['ai-form']) return;

    el['ai-form'].addEventListener('submit', function (event) {
      event.preventDefault();
      send(el['ai-input'].value);
    });

    el['ai-input'].addEventListener('input', autoGrow);
    el['ai-input'].addEventListener('keydown', function (event) {
      // Enter sends, Shift+Enter breaks the line. Checking isComposing keeps an
      // IME's confirm-selection Enter from firing off a half-typed message.
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send(el['ai-input'].value);
      }
    });

    if (el['ai-stop']) {
      el['ai-stop'].addEventListener('click', function () {
        if (state.controller) state.controller.abort();
      });
    }

    if (el['ai-new']) {
      el['ai-new'].addEventListener('click', function () { openConversation(null); });
    }

    if (el['ai-conversation']) {
      el['ai-conversation'].addEventListener('change', function (event) {
        var value = event.target.value;
        openConversation(value ? Number(value) : null);
      });
    }

    if (el['ai-clear']) {
      el['ai-clear'].addEventListener('click', async function () {
        if (!window.confirm(t('ai.confirmClear'))) return;
        try {
          await API.del('/api/ai/conversations');
          state.conversations = [];
          await openConversation(null);
        } catch (err) { notice(err.message, 'error'); }
      });
    }

    el['ai-log'].addEventListener('click', function (event) {
      var example = event.target.closest('[data-ai-example]');
      if (example) send(example.dataset.aiExample);
    });
  }

  /* --- Settings ---------------------------------------------------------- */

  function currentProvider() {
    return (el['ai-cfg-provider'] && el['ai-cfg-provider'].value) || 'anthropic';
  }

  function providerMeta(id) {
    return state.providers.find(function (p) { return p.id === id; }) || null;
  }

  function cfgError(message) {
    if (!el['ai-cfg-error']) return;
    if (!message) { el['ai-cfg-error'].hidden = true; return; }
    el['ai-cfg-error'].textContent = message;
    el['ai-cfg-error'].hidden = false;
    if (el['ai-cfg-ok']) el['ai-cfg-ok'].hidden = true;
  }

  function cfgOk(message) {
    if (!el['ai-cfg-ok']) return;
    el['ai-cfg-ok'].textContent = message;
    el['ai-cfg-ok'].hidden = false;
    if (el['ai-cfg-error']) el['ai-cfg-error'].hidden = true;
  }

  function renderProviderFields() {
    var id = currentProvider();
    var meta = providerMeta(id);
    var stored = (state.config && state.config.providers && state.config.providers[id]) || {};

    if (el['ai-cfg-provider-hint']) {
      el['ai-cfg-provider-hint'].textContent = meta ? meta.configHint : '';
    }
    if (el['ai-cfg-key']) {
      el['ai-cfg-key'].placeholder = meta ? meta.keyHint : '';
      // Never pre-filled: the server does not return keys, only whether one is
      // set. An empty box next to "a key is stored" is the honest rendering.
      el['ai-cfg-key'].value = '';
    }
    if (el['ai-cfg-key-state']) {
      el['ai-cfg-key-state'].textContent = stored.keySet
        ? t('settings.aiKeySet', { fingerprint: stored.keyFingerprint })
        : (meta && meta.needsKey ? t('settings.aiKeyMissing') : t('settings.aiKeyOptional'));
    }
    if (el['ai-cfg-base-field']) {
      el['ai-cfg-base-field'].hidden = id !== 'local';
    }
    if (el['ai-cfg-base']) el['ai-cfg-base'].value = stored.baseUrl || '';

    var models = (meta && meta.models) ? meta.models.slice() : [];
    if (stored.model && models.indexOf(stored.model) === -1) models.unshift(stored.model);
    fillModels(models, stored.model || (meta ? meta.defaultModel : ''));
  }

  function fillModels(models, selected) {
    var select = el['ai-cfg-model'];
    if (!select) return;
    if (!models.length) {
      select.innerHTML = '<option value="">' + esc(t('settings.aiNoModels')) + '</option>';
      return;
    }
    select.innerHTML = models.map(function (id) {
      return '<option value="' + esc(id) + '"' + (id === selected ? ' selected' : '') + '>' +
             esc(id) + '</option>';
    }).join('');
  }

  function renderConfig() {
    var config = state.config;
    if (!config) return;

    if (el['ai-cfg-state']) {
      el['ai-cfg-state'].textContent = config.ready
        ? t('settings.aiReady')
        : t('aiState.' + (config.readyReason || 'AI_NOT_CONFIGURED'));
      el['ai-cfg-state'].className = 'badge ' + (config.ready ? 'badge-ok' : 'badge-warn');
    }
    if (el['ai-cfg-enabled']) el['ai-cfg-enabled'].checked = !!config.enabled;
    if (el['ai-cfg-prompt']) el['ai-cfg-prompt'].value = config.systemPrompt || '';
    if (el['ai-cfg-max-tokens']) el['ai-cfg-max-tokens'].value = config.maxTokens;
    if (el['ai-cfg-history']) el['ai-cfg-history'].value = config.historyWindow;
    if (el['ai-cfg-tools']) el['ai-cfg-tools'].checked = !!config.tools;

    ['cluster', 'hosts', 'backups', 'services'].forEach(function (name) {
      var box = el['ai-cfg-ctx-' + name];
      if (box) box.checked = !!(config.context && config.context[name]);
    });

    if (el['ai-cfg-provider']) {
      el['ai-cfg-provider'].innerHTML = state.providers.map(function (p) {
        return '<option value="' + esc(p.id) + '"' +
               (p.id === config.provider ? ' selected' : '') + '>' + esc(p.label) + '</option>';
      }).join('');
    }
    if (el['ai-cfg-updated']) {
      el['ai-cfg-updated'].textContent = config.updatedAt
        ? t('settings.aiUpdated', {
            when: UI.dateTime(config.updatedAt),
            who: config.updatedBy || '?'
          })
        : '';
    }
    renderProviderFields();
  }

  async function loadConfig() {
    cfgError(null);
    try {
      if (!state.providers.length) {
        var meta = await API.get('/api/ai/providers');
        state.providers = meta.providers || [];
      }
      state.config = await API.get('/api/ai/config');
      renderConfig();
    } catch (err) {
      cfgError(err.message);
      if (el['ai-cfg-state']) {
        el['ai-cfg-state'].textContent = t('aiState.AI_UNREACHABLE');
        el['ai-cfg-state'].className = 'badge badge-crit';
      }
    }
  }

  function collectPatch() {
    var id = currentProvider();
    var providers = {};
    providers[id] = {
      model: el['ai-cfg-model'] ? el['ai-cfg-model'].value : '',
      baseUrl: el['ai-cfg-base'] ? el['ai-cfg-base'].value : ''
    };
    // An untouched key field must not wipe the stored key, so the sentinel is
    // sent rather than an empty string. Clearing is its own button.
    var typed = el['ai-cfg-key'] ? el['ai-cfg-key'].value : '';
    providers[id].apiKey = typed ? typed : '__keep__';

    return {
      enabled: el['ai-cfg-enabled'] ? el['ai-cfg-enabled'].checked : false,
      provider: id,
      systemPrompt: el['ai-cfg-prompt'] ? el['ai-cfg-prompt'].value : '',
      maxTokens: Number(el['ai-cfg-max-tokens'] ? el['ai-cfg-max-tokens'].value : 4096),
      historyWindow: Number(el['ai-cfg-history'] ? el['ai-cfg-history'].value : 12),
      tools: el['ai-cfg-tools'] ? el['ai-cfg-tools'].checked : true,
      context: {
        cluster: !!(el['ai-cfg-ctx-cluster'] && el['ai-cfg-ctx-cluster'].checked),
        hosts: !!(el['ai-cfg-ctx-hosts'] && el['ai-cfg-ctx-hosts'].checked),
        backups: !!(el['ai-cfg-ctx-backups'] && el['ai-cfg-ctx-backups'].checked),
        services: !!(el['ai-cfg-ctx-services'] && el['ai-cfg-ctx-services'].checked)
      },
      providers: providers
    };
  }

  function wireSettings() {
    if (!el['ai-cfg-save']) return;

    el['ai-cfg-provider'].addEventListener('change', function () {
      // Reflect the newly chosen provider's stored values without saving yet.
      renderProviderFields();
    });

    el['ai-cfg-save'].addEventListener('click', async function () {
      cfgError(null);
      try {
        state.config = await API.put('/api/ai/config', collectPatch());
        renderConfig();
        cfgOk(t('common.saved'));
        // The chat panel's header shows the active model, so it is now stale.
        loadStatus();
      } catch (err) { cfgError(err.message); }
    });

    el['ai-cfg-key-clear'].addEventListener('click', async function () {
      if (!window.confirm(t('settings.aiConfirmKeyClear'))) return;
      var patch = collectPatch();
      patch.providers[currentProvider()].apiKey = '';
      cfgError(null);
      try {
        state.config = await API.put('/api/ai/config', patch);
        renderConfig();
        cfgOk(t('settings.aiKeyCleared'));
      } catch (err) { cfgError(err.message); }
    });

    el['ai-cfg-test'].addEventListener('click', async function (event) {
      var button = event.currentTarget;
      button.disabled = true;
      cfgError(null);
      try {
        // Save first: the key the admin just typed is not on the server yet, and
        // testing the previous one would answer a question nobody asked.
        state.config = await API.put('/api/ai/config', collectPatch());
        renderConfig();
        var result = await API.post('/api/ai/config/test', { provider: currentProvider() });
        if (result.ok) cfgOk(result.message);
        else cfgError(result.message);
      } catch (err) {
        cfgError(err.message);
      } finally {
        button.disabled = false;
      }
    });

    el['ai-cfg-models'].addEventListener('click', async function (event) {
      var button = event.currentTarget;
      button.disabled = true;
      cfgError(null);
      try {
        state.config = await API.put('/api/ai/config', collectPatch());
        var data = await API.get('/api/ai/models?provider=' + encodeURIComponent(currentProvider()));
        fillModels(data.models || [], data.selected || '');
        if (!(data.models || []).length) cfgError(t('settings.aiNoModels'));
      } catch (err) {
        cfgError(err.message);
      } finally {
        button.disabled = false;
      }
    });
  }

  /* --- Public surface ---------------------------------------------------- */

  function boot() {
    if (state.booted) return;
    cache();
    if (!el['ai-panel'] && !el['ai-cfg-save']) return;
    wireChat();
    wireSettings();
    state.booted = true;
  }

  window.ZS_AI = {
    boot: boot,

    /* Called by app.js when the AI view opens. Cheap on repeat visits: the
       status and the conversation list are refreshed, the transcript is not. */
    openView: function () {
      boot();
      if (!el['ai-panel']) return;
      loadStatus();
      loadConversations();
      if (!state.messages.length) renderLog();
    },

    /* Called by app.js when the AI settings tab opens (admins only). */
    openSettings: function () {
      boot();
      if (el['ai-cfg-save']) loadConfig();
    },

    /* Called on languagechange:zs. Everything above is built in JS and has no
       data-i18n attributes, so applyI18n() cannot reach any of it. */
    render: function () {
      if (!state.booted) return;
      renderLog();
      renderConversations();
      if (state.config) renderConfig();
      if (state.status && !state.status.ready) {
        notice(t('aiState.' + (state.status.reason || 'AI_NOT_CONFIGURED')), 'warn');
      }
    }
  };
})();
