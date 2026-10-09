// Reads the chosen file, base64-encodes it, and sends it to this sample's
// server, which passes it to Batiyao. The file never goes anywhere else.
document.querySelectorAll('button[data-upload]').forEach((button) => {
  button.addEventListener('click', async () => {
    const input = document.getElementById(button.dataset.file);
    const out = document.getElementById(button.dataset.file.replace('-file', '-result'));
    const file = input.files[0];
    if (!file) { out.textContent = 'Choose a file first.'; return; }
    if (button.dataset.confirm && !document.getElementById(button.dataset.confirm).checked) {
      out.textContent = 'Confirm it is suitable for everyone first.';
      return;
    }
    button.disabled = true;
    out.textContent = 'Uploading…';
    try {
      const dataBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const res = await fetch(button.dataset.upload, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.CSRF },
        body: JSON.stringify({ filename: file.name, content_type: file.type, data_base64: dataBase64 }),
      });
      const body = await res.json();
      if (!body.ok) throw new Error(body.error || 'Upload failed');
      out.textContent = '';
      if (body.reference) {
        out.append('Reference: ');
        const code = document.createElement('code');
        code.textContent = body.reference;
        const link = document.createElement('a');
        link.href = body.attach;
        link.textContent = ' Attach it to a new post';
        out.append(code, link);
      } else {
        out.textContent = body.message || 'Done.';
      }
    } catch (err) {
      out.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
});
