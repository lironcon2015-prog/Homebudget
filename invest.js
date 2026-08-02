// ===== PORTFOLIO SCREEN (/invest/) =====
// The kids' portfolio is a separate app — its own codebase, ES modules, its own
// design language — that shares this origin so it can share this localStorage.
// It is embedded here rather than rewritten into a .screen: same-origin means
// the frame reads and writes exactly the same data as the standalone app the
// user installs on their phone, with no sync layer in between and no second
// copy of the ledger logic to keep in step.
//
// On mobile this screen does not exist at all — the nav entry is hidden and the
// portfolio is its own installed PWA. See mobile.css.

const INVEST_SRC = '/invest/?embed=1'

let _investMounted = false

// The frame is created on first navigation, not at page load: booting a second
// app (Tailwind, fonts, its whole module graph) on every visit to the budget
// dashboard would be paid by everyone and used by almost no one.
function mountInvest() {
  const host = document.getElementById('investFrameHost')
  if (!host) return

  if (_investMounted) {
    // Already loaded and kept alive across screen changes — which means its
    // own visibilitychange never fires, so it has no idea another device may
    // have pushed while the user was reading their budget. Returning to this
    // screen is exactly when to check.
    document.getElementById('investFrame')
      ?.contentWindow?.postMessage({ type: 'ji:pull' }, location.origin)
    return
  }
  _investMounted = true

  const frame = document.createElement('iframe')
  frame.id = 'investFrame'
  frame.className = 'invest-frame'
  frame.title = 'תיק השקעות לילדים'
  frame.src = INVEST_SRC
  // Same-origin, so no sandbox attribute: sandboxing would put the frame in an
  // opaque origin and cut it off from the very localStorage it is here to share.
  frame.setAttribute('loading', 'eager')
  host.appendChild(frame)
}

