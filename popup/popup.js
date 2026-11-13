(() => {
  'use strict';

  const api = globalThis.browser ?? globalThis.chrome;
  const DEFAULTS = { enabled: true, followSystem: false };
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

  const $enabled = document.getElementById('enabled');
  const $follow = document.getElementById('followSystem');
  const $enabledState = document.getElementById('enabled-state');
  const $status = document.getElementById('status');

  document.getElementById('version').textContent = 'v' + api.runtime.getManifest().version;

  let settings = { ...DEFAULTS };

  function render() {
    $enabled.checked = settings.enabled;
    $follow.checked = settings.followSystem;
    $follow.disabled = !settings.enabled;
    $follow.closest('.row').classList.toggle('disabled', !settings.enabled);
    $enabledState.textContent = settings.enabled ? 'Włączony' : 'Wyłączony';

    const active = settings.enabled && (!settings.followSystem || systemDark.matches);
    $status.classList.toggle('on', active);
    if (!settings.enabled) {
      $status.textContent = 'Allegro wyświetla się w oryginalnych, jasnych kolorach.';
    } else if (settings.followSystem && !systemDark.matches) {
      $status.textContent = 'System ma teraz jasny motyw — ciemny motyw czeka.';
    } else {
      $status.textContent = settings.followSystem
        ? 'Aktywny — system ma ciemny motyw.'
        : 'Aktywny na wszystkich stronach Allegro.';
    }
  }

  async function save(patch) {
    settings = { ...settings, ...patch };
    render();
    await api.storage.sync.set(patch);
  }

  $enabled.addEventListener('change', () => save({ enabled: $enabled.checked }));
  $follow.addEventListener('change', () => save({ followSystem: $follow.checked }));
  systemDark.addEventListener('change', render);

  api.storage.sync.get(DEFAULTS).then((stored) => {
    settings = { ...DEFAULTS, ...stored };
    render();
  });
})();
