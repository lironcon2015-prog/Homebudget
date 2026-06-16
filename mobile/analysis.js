// ===== MOBILE ANALYSIS (Dark Glass) =====
// Builds a native, stacked/accordion layout for #screen-analysis that hosts the
// SAME canonical container IDs the desktop uses (pnlStats, expensePieChart,
// expenseBreakdown, incomeBreakdown, trendChart, yoyTable, yoyChart,
// cashFlowStatement, topVendors, chatMessages, chatInput). It then calls the
// shared _drawAnalysis() — so every analysis computation/handler is reused as-is.
function M_renderAnalysis() {
  const host = document.getElementById('screen-analysis')
  if (!host) return

  host.innerHTML = `
    ${M_topbar('ניתוח ותזרים')}
    <div id="mAnPeriod" class="m-period"></div>
    <span id="analysisPeriodLabel" hidden></span>

    <div id="pnlStats" class="m-stat-grid"></div>

    ${M_sectionHead('הוצאות לפי קטגוריה')}
    <div class="m-card m-card-chart"><div class="m-chart-wrap m-chart-tall"><canvas id="expensePieChart"></canvas></div></div>
    <div class="m-card" id="expenseBreakdown"></div>

    ${M_sectionHead('הכנסות לפי קטגוריה')}
    <div class="m-card" id="incomeBreakdown"></div>

    ${M_sectionHead('מגמה חודשית')}
    <div class="m-card m-card-chart"><div class="m-chart-wrap"><canvas id="trendChart"></canvas></div></div>

    ${M_accordion('השוואה לשנה קודמת', `
      <div id="yoyTable"></div>
      <div class="m-chart-wrap" style="margin-top:.8rem"><canvas id="yoyChart"></canvas></div>`)}

    ${M_accordion('דוח תזרים מזומנים', `<div id="cashFlowStatement"></div>`)}

    ${M_accordion('ספקים מובילים', `<div id="topVendors"></div>`)}

    ${M_accordion('שאל את ה-AI 🤖', `
      <div id="chatMessages" class="m-chat-messages"></div>
      <label class="m-check" style="margin:.5rem 0"><input type="checkbox" onchange="toggleChatDeep(this)"> ניתוח מעמיק</label>
      <div class="m-chat-input-row">
        <input id="chatInput" placeholder="שאל על הנתונים…" onkeydown="if(event.key==='Enter')sendChat()">
        <button class="btn-primary" onclick="sendChat()">שלח</button>
      </div>`)}
  `

  M_renderPeriodBar('mAnPeriod', () => _drawAnalysis())
  _drawAnalysis()
  if (typeof _renderChat === 'function') _renderChat()
  if (typeof M_syncTabs === 'function') M_syncTabs('analysis')
  if (typeof M_repaintSync === 'function') M_repaintSync()
}

// Collapsible section (native <details>); resizes analysis charts on open so a
// chart created while collapsed (0-width) lays out correctly once visible.
function M_accordion(title, innerHTML) {
  return `<details class="m-acc" ontoggle="M_anResizeCharts()">
    <summary class="m-acc-summary">${title}<span class="m-acc-chev">›</span></summary>
    <div class="m-acc-body">${innerHTML}</div>
  </details>`
}

function M_anResizeCharts() {
  try { if (typeof _pieChart !== 'undefined' && _pieChart) _pieChart.resize() } catch (e) {}
  try { if (typeof _trendChart !== 'undefined' && _trendChart) _trendChart.resize() } catch (e) {}
  try { if (typeof _yoyChart !== 'undefined' && _yoyChart) _yoyChart.resize() } catch (e) {}
}
