import type { ReviewAction } from '../src/review-action.js';

/** The native modal binds explicit consent to the exact server-prepared payload, not just a PR URL. */
export async function confirmCodeDisclosure(
  request: Extract<ReviewAction, { action: 'review' }>,
): Promise<string | null> {
  const response = await fetch('/api/review/disclosure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  const dialog = document.createElement('dialog');
  dialog.className = 'code-disclosure';
  dialog.setAttribute('aria-labelledby', 'disclosure-title');
  const title = document.createElement('h2');
  title.id = 'disclosure-title';
  title.textContent = 'Send this code to TypeSafe?';
  const description = document.createElement('p');
  description.textContent =
    'Live Jev sends the code and context below to TypeSafe (api.typesafe.ai). GitHub access and model-provider disclosure are separate decisions. The evidence bundle also keeps this code on this machine. Cancel and choose manual inputs to avoid model export.';
  const details = document.createElement('details'),
    summary = document.createElement('summary'),
    payload = document.createElement('pre');
  summary.textContent = 'Inspect the exact payload';
  payload.textContent = JSON.stringify(result.payload, null, 2);
  details.append(summary, payload);
  const identity = document.createElement('p');
  identity.textContent = `Payload SHA-256: ${result.hash}`;
  const form = document.createElement('form');
  form.method = 'dialog';
  const cancel = document.createElement('button'),
    send = document.createElement('button');
  cancel.value = 'cancel';
  cancel.textContent = 'Cancel';
  cancel.className = 'quiet';
  cancel.autofocus = true;
  send.value = 'send';
  send.textContent = 'Send this payload to TypeSafe';
  send.className = 'primary';
  form.append(cancel, send);
  dialog.append(title, description, details, identity, form);
  document.body.append(dialog);
  return new Promise(resolve => {
    dialog.addEventListener(
      'close',
      () => {
        const approved = dialog.returnValue === 'send';
        dialog.remove();
        resolve(approved ? (result.hash as string) : null);
      },
      { once: true },
    );
    dialog.showModal();
  });
}
