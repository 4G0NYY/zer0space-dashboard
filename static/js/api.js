/* Thin fetch wrapper.

   Two jobs, both of which were previously duplicated in every caller and
   therefore previously wrong somewhere:

   1. Attach the CSRF token to every state-changing request. The token comes
      from /api/me and is held here, so adding a new POST anywhere in the app
      is automatically covered.
   2. Turn a failure into one predictable shape. Callers get an ApiError with a
      `.code`, a `.status` and an already-translated `.message`, whether the
      failure was an HTTP error, a network drop, or a body that was not JSON.

   Defines window.API and must load before the page script that uses it. */
(function () {
  'use strict';

  var csrfToken = null;

  function ApiError(status, code, message, data) {
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.message = message;
    this.data = data || {};
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  var SAFE = { GET: 1, HEAD: 1, OPTIONS: 1 };

  async function request(method, path, body) {
    var options = { method: method, headers: {}, credentials: 'same-origin' };

    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    if (!SAFE[method]) {
      /* Fail closed. Sending the request without the header just earns a 403
         from the server middleware, which surfaces to the user as an
         unexplained failure — the real cause is almost always a click that
         landed before /api/me resolved and set the token. Say so instead. */
      if (!csrfToken) {
        throw new ApiError(0, 'CSRF_NOT_READY', window.I18N.t('err.CSRF_NOT_READY'), {});
      }
      options.headers['X-CSRF-Token'] = csrfToken;
    }

    var response;
    try {
      response = await fetch(path, options);
    } catch (err) {
      // Server unreachable, DNS failure, offline. Deliberately not retried
      // here: a retry loop on a dead backend makes an outage look like a hang.
      throw new ApiError(0, 'NETWORK', window.I18N.t('err.NETWORK'), {});
    }

    if (response.status === 204) return null;

    var data = null;
    try {
      data = await response.json();
    } catch (err) {
      data = null;
    }

    if (!response.ok) {
      var payload = data || { code: 'INTERNAL' };
      throw new ApiError(
        response.status,
        payload.code || 'INTERNAL',
        window.I18N.tError(payload),
        payload
      );
    }
    return data;
  }

  window.API = {
    ApiError: ApiError,
    get: function (path) { return request('GET', path); },
    post: function (path, body) { return request('POST', path, body === undefined ? {} : body); },
    put: function (path, body) { return request('PUT', path, body === undefined ? {} : body); },
    del: function (path) { return request('DELETE', path); },
    setCsrfToken: function (token) { csrfToken = token; },
    getCsrfToken: function () { return csrfToken; }
  };
})();
