const enabled = document.querySelector('#enabled');
const gentle = document.querySelector('#gentle');
const status = document.querySelector('#status');
const storage = globalThis.chrome?.storage?.local;
async function init() {
  try {
    if (!storage) return;
    const settings = await storage.get({ enabled: true, gentle: false });
    enabled.checked = settings.enabled; gentle.checked = settings.gentle;
  } catch { status.textContent = 'Перезагрузите расширение.'; }
}
enabled.addEventListener('change', () => storage?.set({ enabled: enabled.checked }));
gentle.addEventListener('change', () => storage?.set({ gentle: gentle.checked }));
document.querySelector('#reset').addEventListener('click', async () => {
  if (storage) await storage.set({ resetAt: Date.now() });
  status.textContent = 'Мешок возвращается на открытых страницах ChatGPT.';
});
init();
