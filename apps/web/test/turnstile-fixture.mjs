export async function installTurnstileFixture(context) {
  await context.route('https://challenges.cloudflare.com/turnstile/v0/api.js*', async route => {
    await route.fulfill({
      contentType: 'application/javascript',
      body: `
      let options;
      let tokenNumber = 0;
      window.challenge = {
        solve() { options.callback('browser-token-' + ++tokenNumber); },
        expire() { options['expired-callback'](); },
        fail() { options['error-callback']('300000'); },
        timeout() { options['timeout-callback'](); },
        interact() { options['before-interactive-callback'](); }
      };
      window.turnstile = {
        ready(callback) { callback(); },
        render(container, params) { options = params; window.challengeAction = params.action; container.textContent = 'Test verification widget'; return 'widget'; },
        reset() { window.challengeResets = (window.challengeResets || 0) + 1; },
        remove() {},
        getResponse() { return ''; },
        isExpired() { return false; }
      };
      const callback = new URL(document.currentScript.src).searchParams.get('onload');
      window[callback]?.();
    `,
    });
  });
}
