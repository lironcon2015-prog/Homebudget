// app.js
// Entry point. Wires StateManager + persistence + UI.

import { LocalStoragePersistence } from './src/state/LocalStoragePersistence.js';
import { StateManager } from './src/state/StateManager.js';
import { UI } from './src/ui.js';

const sm = new StateManager(new LocalStoragePersistence());
const ui = new UI(sm);
ui.init();

// Console handle for debugging
window.JI = { sm, ui };
