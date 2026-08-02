// app-v2.js
// Entry point for the v2 UI. Same engine and same persistence key as app.js —
// only the presentation layer differs, so both shells read the same portfolio.

import { LocalStoragePersistence } from './src/state/LocalStoragePersistence.js';
import { StateManager } from './src/state/StateManager.js';
import { DriveSync } from './src/io/DriveSync.js';
import { UIv2 } from './src/ui-v2.js';

const sm = new StateManager(new LocalStoragePersistence());

// Sharing an origin with the budget app already makes this one database per
// device. Sync is what extends that between devices — an edit on the phone
// reaching the desktop shell, and back.
// The single-file offline build runs from file://, where Google's OAuth flow
// cannot work at all. Better to show no sync controls there than controls that
// always fail. The UI treats a null here as "local only".
const drive = location.protocol.startsWith('http')
  ? new DriveSync(sm, {
      onStatus: (status, detail) => ui.setSyncStatus(status, detail),
      onConflict: async (message) => confirm(message),
    })
  : null;

const ui = new UIv2(sm, drive);
ui.init();

// Every committed change schedules a debounced upload. Wired here rather than
// inside StateManager so the engine keeps no notion of networks or Google.
sm.onCommit = () => drive?.schedulePush();

// After first paint: a cold start must not wait on Google's script, or on a
// token refresh, before the portfolio is on screen.
setTimeout(() => drive?.init(), 600);

// Console handle for debugging
window.JI = { sm, ui, drive };
