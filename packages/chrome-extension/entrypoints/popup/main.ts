async function init() {
  const checkbox = document.getElementById('enabled') as HTMLInputElement;

  checkbox.addEventListener('change', async () => {
    await browser.storage.local.set({ enabled: checkbox.checked });
  });

  const { enabled = true } = await browser.storage.local.get('enabled');
  checkbox.checked = enabled as boolean;
}

init();
