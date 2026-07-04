interface RequestPasswordOptions {
  autocomplete?: AutoFill;
  validate?: (password: string) => string | null;
}

function makePromptId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function requestPassword(title: string, options: RequestPasswordOptions = {}): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:rgba(15,23,42,.45)',
      'padding:16px',
    ].join(';');

    const panel = document.createElement('form');
    panel.style.cssText = [
      'width:min(380px,100%)',
      'background:#fff',
      'color:#111827',
      'border:1px solid rgba(0,0,0,.12)',
      'border-radius:8px',
      'box-shadow:0 16px 48px rgba(0,0,0,.24)',
      'padding:16px',
    ].join(';');

    const inputId = makePromptId('password-prompt');
    const label = document.createElement('label');
    label.htmlFor = inputId;
    label.textContent = title;
    label.style.cssText = 'display:block;font-size:14px;font-weight:600;margin-bottom:10px;line-height:1.45;color:#111827';

    const input = document.createElement('input');
    input.id = inputId;
    input.type = 'password';
    input.autocomplete = options.autocomplete ?? 'current-password';
    input.style.cssText = [
      'width:100%',
      'box-sizing:border-box',
      'border:1px solid rgba(0,0,0,.18)',
      'border-radius:6px',
      'padding:8px 10px',
      'font-size:14px',
      'margin-bottom:10px',
      'background:#fff',
      'color:#111827',
    ].join(';');

    const errorText = document.createElement('div');
    errorText.setAttribute('role', 'alert');
    errorText.style.cssText = [
      'display:none',
      'margin:-2px 0 12px',
      'color:#b91c1c',
      'font-size:12px',
      'line-height:1.4',
    ].join(';');

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';

    const confirm = document.createElement('button');
    confirm.type = 'submit';
    confirm.textContent = '确认';

    for (const button of [cancel, confirm]) {
      button.style.cssText = 'border:1px solid rgba(0,0,0,.18);border-radius:6px;padding:7px 12px;background:#fff;color:#111827;cursor:pointer';
    }
    confirm.style.background = '#2563eb';
    confirm.style.color = '#fff';

    const close = (value: string | null) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onDocumentKeyDown);
      overlay.remove();
      resolve(value);
    };
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(null);
    };

    cancel.addEventListener('click', () => close(null));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(null);
    });
    panel.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!input.value) {
        close(null);
        return;
      }
      const validationError = options.validate?.(input.value) || null;
      if (validationError) {
        errorText.textContent = validationError;
        errorText.style.display = 'block';
        input.focus();
        return;
      }
      close(input.value);
    });
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close(null);
    });

    actions.append(cancel, confirm);
    panel.append(label, input, errorText, actions);
    overlay.append(panel);
    document.body.append(overlay);
    document.addEventListener('keydown', onDocumentKeyDown);
    input.focus();
  });
}
