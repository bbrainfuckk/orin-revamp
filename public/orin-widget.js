(function () {
  'use strict';

  var script = document.currentScript;
  var widgetKey = script && script.getAttribute('data-orin-widget');
  if (!widgetKey || !/^ow_[A-Za-z0-9_-]{20,80}$/.test(widgetKey)) return;
  if (document.getElementById('orin-ai-widget-' + widgetKey)) return;

  var base = 'https://www.orin.work';
  var position = script.getAttribute('data-position') === 'left' ? 'left' : 'right';
  var sessionUrl = base + '/api/widget/session?key=' + encodeURIComponent(widgetKey);

  fetch(sessionUrl, { method: 'POST', mode: 'cors', credentials: 'omit', referrerPolicy: 'strict-origin-when-cross-origin' })
    .then(function (response) {
      if (!response.ok) throw new Error('ORIN AI widget session was rejected');
      return response.json();
    })
    .then(function (payload) {
      if (!payload || typeof payload.token !== 'string') throw new Error('ORIN AI widget session is unavailable');
      var frame = document.createElement('iframe');
      frame.id = 'orin-ai-widget-' + widgetKey;
      frame.title = 'Chat with ORIN AI';
      frame.src = base + '/widget/' + encodeURIComponent(widgetKey) + '#' + encodeURIComponent(payload.token);
      frame.setAttribute('aria-label', 'Chat with ORIN AI');
      frame.setAttribute('allow', 'clipboard-write');
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.style.position = 'fixed';
      frame.style.bottom = '14px';
      frame.style[position] = '14px';
      frame.style.width = '70px';
      frame.style.height = '70px';
      frame.style.maxWidth = 'calc(100vw - 20px)';
      frame.style.maxHeight = 'calc(100dvh - 20px)';
      frame.style.border = '0';
      frame.style.background = 'transparent';
      frame.style.colorScheme = 'normal';
      frame.style.zIndex = '2147483000';
      frame.style.transition = 'width 180ms ease, height 180ms ease';

      window.addEventListener('message', function (event) {
        if (event.origin !== base || event.source !== frame.contentWindow || !event.data || event.data.type !== 'orin:widget:resize') return;
        if (event.data.open) {
          frame.style.width = Math.min(410, window.innerWidth - 20) + 'px';
          frame.style.height = Math.min(650, window.innerHeight - 20) + 'px';
        } else {
          frame.style.width = '70px';
          frame.style.height = '70px';
        }
      });

      document.body.appendChild(frame);
    })
    .catch(function (error) {
      if (window.console && typeof window.console.warn === 'function') window.console.warn('ORIN AI widget:', error.message);
    });
}());
