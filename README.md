# כספים – ניהול פיננסי

מערכת PWA לניהול הוצאות והכנסות עם ייבוא חכם של דוחות בנק באמצעות Gemini AI.

## הפעלה מיידית

1. פתח `index.html` בדפדפן
2. עבור להגדרות → מפתח API → הזן מפתח Gemini
3. עבור להגדרות → חשבונות → צור חשבון
4. עבור לייבוא קובץ → העלה דוח בנק

## Deploy ב-GitHub Pages

1. צור ריפו חדש ב-GitHub
2. העלה את כל הקבצים
3. Settings → Pages → Branch: main → Save
4. האפליקציה תהיה זמינה ב-`https://[שם-משתמש].github.io/[שם-ריפו]`

## מבנה הקבצים

```
finance-app/
├── index.html        ← כל המסכים
├── css/style.css     ← עיצוב RTL עברי
├── js/
│   ├── app.js        ← ניווט, storage, utils
│   ├── dashboard.js  ← לוח בקרה
│   ├── transactions.js
│   ├── import.js     ← Gemini parsing
│   ├── analysis.js   ← P&L + AI chat
│   └── settings.js   ← חשבונות, קטגוריות
├── manifest.json     ← PWA
├── sw.js             ← Service Worker
└── version.json
```

## מסכים

- **לוח בקרה** – סיכום חודשי, גרפים, עסקאות אחרונות
- **עסקאות** – רשימה מלאה עם פילטרים ועריכה
- **ייבוא קובץ** – PDF / Excel / CSV עם Gemini 2.5 Pro
- **ניתוח P&L** – הוצאות/הכנסות לפי קטגוריה + AI Chat
- **הגדרות** – חשבונות, קטגוריות, מפתח API, גיבוי

## טכנולוגיות

- Vanilla JS, HTML5, CSS3 – ללא frameworks
- LocalStorage – אחסון מקומי
- Gemini 2.5 Pro API – פרסינג ו-AI
- Chart.js – גרפים
- PWA – ניתן להתקנה על מובייל

## בדיקות

- **יחידה** (ללא תלויות, `node:test`): `node --test tests/*.test.mjs` — מכסה את ליבת החישובים (core/detect/templates).
- **Smoke בדפדפן** (דורש `playwright-core` ו-Chromium): שרת מקומי על 8000 ואז `node tests/smoke.mjs`. הקובץ `tests/smoke-baseline.json` הוא snapshot התנהגותי — אם ערכי P&L/יתרות משתנים בכוונה, מחקו אותו כדי לחדש baseline.
- CI מריץ את בדיקות היחידה על כל push‏ (`.github/workflows/tests.yml`).

