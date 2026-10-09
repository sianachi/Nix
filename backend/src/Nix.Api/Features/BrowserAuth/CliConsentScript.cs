namespace Nix.Features.BrowserAuth;

/// <summary>Fixed progressive enhancement for the server-owned browser consent form.</summary>
internal static class CliConsentScript
{
    internal const string Content = """
        (() => {
          const form = document.querySelector('form[data-nix-cli-consent]');
          const status = document.getElementById('cli-consent-status');
          if (!(form instanceof HTMLFormElement) || !(status instanceof HTMLElement)) return;
          const userCode = form.elements.namedItem('userCode');
          if (!(userCode instanceof HTMLInputElement)) return;
          const buttons = Array.from(form.querySelectorAll('button[name="decision"]'));
          let attempted = false;

          async function decide(decision) {
            if (attempted || (decision !== 'approve' && decision !== 'deny')) return;
            attempted = true;
            for (const button of buttons) button.disabled = true;
            status.textContent = 'Submitting your decision...';
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            try {
              const body = new URLSearchParams({ userCode: userCode.value, decision });
              const response = await fetch(new URL('/auth/cli/approve', window.location.origin), {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                body,
                credentials: 'same-origin',
                cache: 'no-store',
                redirect: 'error',
                signal: controller.signal,
              });
              if (response.status !== 200) {
                status.textContent = 'Sign-in was not confirmed. Check your terminal; if it is still waiting, start a new nixctl login.';
                return;
              }
              const title = decision === 'approve' ? 'CLI sign-in approved' : 'CLI sign-in denied';
              const heading = document.querySelector('main h1');
              if (heading instanceof HTMLElement) heading.textContent = title;
              document.title = title;
              form.remove();
              status.textContent = 'You can close this page and return to your terminal.';
            } catch {
              status.textContent = 'The result could not be confirmed. Check your terminal before starting a new login; your decision may have been saved.';
            } finally {
              clearTimeout(timeout);
            }
          }

          for (const button of buttons) {
            button.addEventListener('click', (event) => {
              event.preventDefault();
              void decide(button.value);
            });
          }
          form.addEventListener('submit', (event) => {
            event.preventDefault();
            const button = event.submitter;
            if (!(button instanceof HTMLButtonElement) || button.form !== form || button.name !== 'decision') {
              status.textContent = 'Choose Approve nixctl or Deny to submit your decision.';
              return;
            }
            void decide(button.value);
          });
        })();
        """;
}
