// ===== MOBILE SHELL =====
// Chrome + shared helpers for the native mobile layer (Dark Glass). The bottom
// tab bar / FAB live in index.html (mobile-only via CSS); this file owns the
// "More" launcher and small markup helpers reused by the M_* screen renderers.
// All state hangs off the single MOBILE namespace to keep the global surface tiny.
const MOBILE = { moreSheet: null }

// Secondary screens that don't get a primary tab — reached from the "עוד" tab.
const M_MORE_ITEMS = [
  { screen: 'budget',    icon: '🎯', label: 'תקציב' },
  { screen: 'recurring', icon: '🔁', label: 'הוצאות/הכנסות קבועות' },
  { screen: 'property',  icon: '🏠', label: 'משכנתא ונכס' },
  { screen: 'import',    icon: '📥', label: 'ייבוא קובץ' },
  { screen: 'settings',  icon: '⚙️', label: 'הגדרות' },
]

function M_openMore() {
  if (typeof UK_haptic === 'function') UK_haptic('tap')
  const rows = M_MORE_ITEMS.map(it => `
    <button class="m-more-row" onclick="M_navMore('${it.screen}')">
      <span class="m-more-ic">${it.icon}</span>
      <span class="m-more-label">${it.label}</span>
      <span class="m-more-chev">‹</span>
    </button>`).join('')
  const content = `<div class="m-more-list">${rows}</div>`
  if (typeof UK_sheet === 'function') {
    MOBILE.moreSheet = UK_sheet({ title: 'עוד', content })
  } else {
    navigate('settings')
  }
}

function M_navMore(screen) {
  if (MOBILE.moreSheet) { MOBILE.moreSheet.close(); MOBILE.moreSheet = null }
  navigate(screen)
}

// Mark the active bottom-tab. "More" screens highlight the עוד tab.
function M_syncTabs(screen) {
  const primary = ['dashboard', 'transactions', 'analysis']
  document.querySelectorAll('.bottom-nav .bnav-item').forEach(el => el.classList.remove('active'))
  const key = primary.includes(screen) ? screen : (screen === 'more' ? 'more' : null)
  if (key && key !== 'more') {
    document.querySelectorAll(`.bottom-nav .bnav-item[data-screen="${key}"]`).forEach(el => el.classList.add('active'))
  } else if (!primary.includes(screen)) {
    const more = document.querySelector('.bottom-nav .bnav-item.m-more-tab')
    if (more) more.classList.add('active')
  }
}

// ===== SHARED MARKUP HELPERS =====
// Sticky top bar for a mobile screen: title + optional right-side action buttons.
function M_topbar(title, actionsHTML = '') {
  return `<header class="m-topbar">
    <h1 class="m-topbar-title">${title}</h1>
    <div class="m-topbar-actions">${actionsHTML}</div>
  </header>`
}

// Section header with optional trailing link/control.
function M_sectionHead(title, rightHTML = '') {
  return `<div class="m-section-head"><h3>${title}</h3>${rightHTML}</div>`
}
