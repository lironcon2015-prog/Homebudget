// ===== MOBILE UI GATE =====
// Evaluated once at load. Sets <html class="m-ui"> so that mobile.css (all rules
// scoped under html.m-ui) and the M_* render layer activate ONLY on mobile. The
// desktop DOM/renderers stay byte-identical; on mobile the M_* renderers own the
// markup of each .screen section (navigate() still toggles .screen.active).
//
// Reuses the existing 900px breakpoint so this flag and style.css never disagree.
// The flag is FIXED for the session: on resize we only PROMPT a reload rather than
// hot-swapping shells mid-session (which would force Chart.js/DOM teardown).
const IS_MOBILE_UI = matchMedia('(max-width: 900px)').matches
  || (matchMedia('(pointer: coarse)').matches && matchMedia('(max-width: 1024px)').matches)

if (IS_MOBILE_UI) document.documentElement.classList.add('m-ui')

;(function () {
  let warned = false
  const flagNow = () => matchMedia('(max-width: 900px)').matches
    || (matchMedia('(pointer: coarse)').matches && matchMedia('(max-width: 1024px)').matches)
  window.addEventListener('resize', () => {
    if (flagNow() === IS_MOBILE_UI || warned) return
    warned = true
    if (typeof toast === 'function') {
      toast('שינוי גודל מסך — רענן/י את הדף לטעינת הפריסה המתאימה', { type: 'info', duration: 5000 })
    }
  })
})()
