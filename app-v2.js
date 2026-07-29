// app-v2.js
// Entry point for the v2 UI. Same engine and same persistence key as app.js —
// only the presentation layer differs, so both shells read the same portfolio.

import { LocalStoragePersistence } from './src/state/LocalStoragePersistence.js';
import { StateManager } from './src/state/StateManager.js';
import { UIv2 } from './src/ui-v2.js';

const sm = new StateManager(new LocalStoragePersistence());
const ui = new UIv2(sm);
ui.init();

// Console handle for debugging
window.JI = { sm, ui };
